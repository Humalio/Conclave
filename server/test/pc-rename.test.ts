/**
 * Rename a PC (docs/dashboard-ux.md, the PC page): PATCH /api/pcs/:id sets the name under the Add PC rules (lowercase letters,
 * digits and dashes, unique), writes a pc.rename audit row, is admin only, and touches nothing else: a PC is known by its id, so
 * its keys, an agent's binding and the PC list keep working and show the new name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Who = { cookie: string; csrf: string };
let app: App, base = '', admin: Who = { cookie: '', csrf: '' };
const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
const audits = (id: string) => app.db.prepare("SELECT actor_kind, details FROM audit_events WHERE action='pc.rename' AND target_id=? ORDER BY id").all(id) as { actor_kind: string; details: string }[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pcren-'));
  mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
});
afterAll(async () => { await app.close(); });

describe('rename a PC', () => {
  it('a free name is saved, listed, audited with the old and the new name, and the id, keys and bindings stay', async () => {
    const pc = (await api('POST', '/pcs', { name: 'gestamp-pc' })).body.pc;
    const ak = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code', maxLiveSessions: 5 }, sys);
    const agent = app.keys.createAgent('Bound worker', null, sys);
    const sk = app.keys.createSessionKey({ agentId: agent.id, label: 'bound', machineId: pc.id }, sys);
    const r = await api('PATCH', `/pcs/${pc.id}`, { name: 'gestamp-laptop' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pc).toMatchObject({ id: pc.id, name: 'gestamp-laptop' });
    const list = (await api('GET', '/pcs')).body.pcs as { id: string; name: string }[];
    expect(list.find((p) => p.id === pc.id)?.name).toBe('gestamp-laptop');
    expect(list.some((p) => p.name === 'gestamp-pc')).toBe(false);
    const rows = audits(pc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_kind).toBe('admin');
    expect(JSON.parse(rows[0]!.details)).toEqual({ from: 'gestamp-pc', to: 'gestamp-laptop' });
    // Everything points at the id: the app key and the session key's binding are the same rows, and the old name is free again.
    expect(app.keys.credential(ak.credential.id)?.machine_id).toBe(pc.id);
    expect(app.keys.credential(sk.credential.id)?.bound_machine_id).toBe(pc.id);
    expect((await api('POST', '/pcs', { name: 'gestamp-pc' })).status).toBe(200);
  });

  it('a name another PC has is refused with a conflict and nothing changes or is audited', async () => {
    const a = (await api('POST', '/pcs', { name: 'taken-a' })).body.pc, b = (await api('POST', '/pcs', { name: 'taken-b' })).body.pc;
    const r = await api('PATCH', `/pcs/${b.id}`, { name: 'taken-a' });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('taken-a');
    expect(app.keys.machine(b.id)!.name).toBe('taken-b');
    expect(app.keys.machine(a.id)!.name).toBe('taken-a');
    expect(audits(b.id)).toHaveLength(0);
  });

  it('the same name rules as Add PC apply, a PC may keep its own name (no audit), and an unknown PC is not found', async () => {
    const pc = (await api('POST', '/pcs', { name: 'rules-pc' })).body.pc;
    for (const bad of ['', 'Upper', 'has space', '-lead', 'x'.repeat(64), 'under_score']) {
      const r = await api('PATCH', `/pcs/${pc.id}`, { name: bad });
      expect(r.status, bad).toBe(400);
    }
    expect((await api('PATCH', `/pcs/${pc.id}`, { name: 'x'.repeat(63) })).status).toBe(200);
    expect((await api('PATCH', `/pcs/${pc.id}`, { name: 'x'.repeat(63) })).status).toBe(200);
    expect(audits(pc.id)).toHaveLength(1);
    expect((await api('PATCH', '/pcs/pc-nope', { name: 'fine' })).status).toBe(404);
    expect((await api('PATCH', `/pcs/${pc.id}`, {})).status).toBe(400);
  });

  it('a member cannot rename a PC and a signed-out caller cannot either', async () => {
    const pc = (await api('POST', '/pcs', { name: 'guarded-pc' })).body.pc;
    const c = await api('POST', '/users', { username: 'ren-member', display_name: 'Ren Member', role: 'member' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ren-member', password: c.body.password }) });
    const m: Who = { cookie: login.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await login.json()) as any).csrf };
    expect([401, 403]).toContain((await call(m, 'PATCH', `/pcs/${pc.id}`, { name: 'hijacked' })).status);
    expect((await call({ cookie: '', csrf: '' }, 'PATCH', `/pcs/${pc.id}`, { name: 'hijacked' })).status).toBe(401);
    expect(app.keys.machine(pc.id)!.name).toBe('guarded-pc');
  });
});
