/**
 * The limit of live logins per app key (docs/onboarding.md#the-app-key-and-its-onboarding-capability): a new app key allows 100;
 * migration 0137 moves an app key still at exactly 20 to 100 and leaves other values (60, 5, 100) and session keys alone; the admin
 * sets a limit from 1 to 500 with PUT /api/keys/:id/live-limit, audited with the old and the new value, admin only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sys = { kind: 'system' as const, id: null };

describe('migration 0137: the default limit is 100', () => {
  it('moves app keys at exactly 20 to 100, keeps other limits, and the column default is 100', () => {
    const before = mkdtempSync(join(tmpdir(), 'live-0137-'));
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) < 137) copyFileSync(join(MIGRATIONS, f), join(before, f));
    const db = new DatabaseSync(join(before, 'x.db'));
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, before);
    const now = Date.now();
    db.prepare("INSERT INTO machines(id,name,status,created_at) VALUES ('pc-a','pc-a','active',?)").run(now);
    db.prepare("INSERT INTO agents(id,label,created_at) VALUES ('agent-a','A',?)").run(now);
    let n = 0;
    const key = (kind: string, limit: number | null) => {
      const i = ++n;
      db.prepare("INSERT INTO permission_policies(id,kind,version,created_at,updated_at) VALUES (?, 'credential',1,?,?)").run('pol_' + i, now, now);
      const cols = limit === null ? '' : ',max_live_sessions';
      db.prepare(`INSERT INTO credentials(id,kind,agent_id,machine_id,label,key_id,verifier,policy_id,created_at${cols}) VALUES (?,?,?,?,?,?,?,?,?${limit === null ? '' : ',?'})`)
        .run(...[`crd_${i}`, kind, kind === 'session_key' ? 'agent-a' : null, kind === 'app_key' ? 'pc-a' : null, `k${i}`, `kid${i}`, 'v', 'pol_' + i, now, ...(limit === null ? [] : [limit])]);
      return `crd_${i}`;
    };
    const at20 = key('app_key', 20), at60 = key('app_key', 60), at5 = key('app_key', 5), at100 = key('app_key', 100), sess = key('session_key', 20);
    expect((db.prepare('SELECT max_live_sessions m FROM credentials WHERE id=?').get(at20) as { m: number }).m).toBe(20);
    migrate(db, MIGRATIONS);
    const lim = (id: string) => (db.prepare('SELECT max_live_sessions m FROM credentials WHERE id=?').get(id) as { m: number }).m;
    expect([lim(at20), lim(at60), lim(at5), lim(at100), lim(sess)]).toEqual([100, 60, 5, 100, 20]);
    expect(db.prepare('SELECT COUNT(*) c FROM credentials').get()).toEqual({ c: 5 });
    // A row that names no limit gets the new column default; the indexes are back.
    expect(lim(key('app_key', null))).toBe(100);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='credentials' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
    expect(idx).toEqual(['credentials_agent', 'credentials_machine']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('the limit on an app key', () => {
  type Who = { cookie: string; csrf: string };
  let app: App, base = '', admin: Who = { cookie: '', csrf: '' };
  const call = async (who: Who, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
  const audits = (id: string) => (app.db.prepare("SELECT actor_kind, details FROM audit_events WHERE action='key.live_limit' AND target_id=? ORDER BY id").all(id) as { actor_kind: string; details: string }[]);
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livelim-'));
    mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
    app = await buildApp(testConfig(dir));
    await app.store.ready;
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
    admin = await adminLogin(base);
  });
  afterAll(async () => { await app.close(); });

  it('a new app key allows 100 live logins, and one made with a limit keeps it', async () => {
    const pc = (await api('POST', '/pcs', { name: 'limit-pc' })).body.pc;
    const a = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys);
    const b = app.keys.createAppKey({ machineId: pc.id, appName: 'other', maxLiveSessions: 7 }, sys);
    expect(a.credential.max_live_sessions).toBe(100);
    expect(b.credential.max_live_sessions).toBe(7);
  });

  it('the admin sets a limit from 1 to 500; it is saved, audited with from and to, and shown by the key', async () => {
    const pc = (await api('POST', '/pcs', { name: 'limit-pc-2' })).body.pc;
    const k = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys).credential;
    const r = await api('PUT', `/keys/${k.id}/live-limit`, { max_live_sessions: 250 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.key.max_live_sessions).toBe(250);
    expect((await api('GET', `/keys/${k.id}`)).body.key.max_live_sessions).toBe(250);
    const rows = audits(k.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_kind).toBe('admin');
    expect(JSON.parse(rows[0]!.details)).toEqual({ from: 100, to: 250 });
    expect((await api('PUT', `/keys/${k.id}/live-limit`, { max_live_sessions: 1 })).status).toBe(200);
    expect((await api('PUT', `/keys/${k.id}/live-limit`, { max_live_sessions: 500 })).status).toBe(200);
    // The same value again changes and audits nothing.
    expect((await api('PUT', `/keys/${k.id}/live-limit`, { max_live_sessions: 500 })).status).toBe(200);
    expect(audits(k.id)).toHaveLength(3);
  });

  it('if the audit write fails, the limit is not saved, and a retry with the same value saves and audits it', async () => {
    const pc = (await api('POST', '/pcs', { name: 'limit-pc-5' })).body.pc;
    const k = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys).credential;
    const audit = (app.keys as unknown as { audit: { event: (...a: unknown[]) => unknown } }).audit;
    const spy = vi.spyOn(audit, 'event').mockImplementationOnce(() => { throw new Error('audit write failed'); });
    expect(() => app.keys.setLiveLimit(k.id, 300, sys)).toThrow('audit write failed');
    spy.mockRestore();
    expect(app.keys.credential(k.id)!.max_live_sessions).toBe(100);
    expect(audits(k.id)).toHaveLength(0);
    expect(app.keys.setLiveLimit(k.id, 300, sys).max_live_sessions).toBe(300);
    expect(audits(k.id).map((r) => JSON.parse(r.details))).toEqual([{ from: 100, to: 300 }]);
  });

  it('a new session key keeps the stored value of 20, also after a rotation; the column default of 100 is for app keys', async () => {
    const agent = app.keys.createAgent('Limit agent 2', null, sys);
    const sk = app.keys.createSessionKey({ agentId: agent.id, label: 'sk2' }, sys).credential;
    expect(sk.max_live_sessions).toBe(20);
    expect((await api('GET', `/keys/${sk.id}`)).body.key.max_live_sessions).toBe(20);
    const r = await api('POST', `/keys/${sk.id}/rotate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(app.keys.credential(r.body.key.id)!.max_live_sessions).toBe(20);
  });

  it('a limit outside 1 to 500, a fraction, text, a session key and an unknown key are refused and nothing changes', async () => {
    const pc = (await api('POST', '/pcs', { name: 'limit-pc-3' })).body.pc;
    const k = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys).credential;
    for (const bad of [0, -1, 501, 1.5, '100', null]) expect((await api('PUT', `/keys/${k.id}/live-limit`, { max_live_sessions: bad })).status, String(bad)).toBe(400);
    expect((await api('PUT', `/keys/${k.id}/live-limit`, {})).status).toBe(400);
    expect(app.keys.credential(k.id)!.max_live_sessions).toBe(100);
    const agent = app.keys.createAgent('Limit agent', null, sys);
    const sk = app.keys.createSessionKey({ agentId: agent.id, label: 'sk' }, sys).credential;
    expect((await api('PUT', `/keys/${sk.id}/live-limit`, { max_live_sessions: 5 })).status).toBe(409);
    expect((await api('PUT', '/keys/crd_nope/live-limit', { max_live_sessions: 5 })).status).toBe(404);
    expect(audits(k.id)).toHaveLength(0);
  });

  it('a member cannot set the limit and a signed-out caller cannot either', async () => {
    const pc = (await api('POST', '/pcs', { name: 'limit-pc-4' })).body.pc;
    const k = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys).credential;
    const c = await api('POST', '/users', { username: 'lim-member', display_name: 'Lim Member', role: 'member' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'lim-member', password: c.body.password }) });
    const m: Who = { cookie: login.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await login.json()) as any).csrf };
    expect([401, 403]).toContain((await call(m, 'PUT', `/keys/${k.id}/live-limit`, { max_live_sessions: 5 })).status);
    expect((await call({ cookie: '', csrf: '' }, 'PUT', `/keys/${k.id}/live-limit`, { max_live_sessions: 5 })).status).toBe(401);
    expect(app.keys.credential(k.id)!.max_live_sessions).toBe(100);
  });
});
