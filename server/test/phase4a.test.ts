import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { unifiedDiff } from '../src/vault/diff.js';
import { newId } from '../src/util/ids.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '', vaultDir = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
async function connect() {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
}
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const FILE_TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }];
const ALL_FS = ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.rename', 'fs.delete', 'fs.history', 'fs.restore', 'fs.conflicts'];
const mk = (label: string, rules: Rules) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [...FILE_TOOLS, ...rules], 'test', sys);
  return { agent, secret: k.secret, cred: k.credential };
};
async function login(p: ReturnType<typeof mk>) {
  const call = await connect();
  const token = (await call('session_login', { session_key: p.secret })).structuredContent.session_token as string;
  return (name: string, args: Record<string, unknown> = {}) => call(name, { session_token: token, ...args });
}
const full: Rules = [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }];
const disk = (p: string) => join(vaultDir, ...p.split('/'));
const rev = (c: { structuredContent?: any }) => c.structuredContent.revision as string;
let W: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah4a-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false,
  };
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await r.json()) as { csrf: string }).csrf;
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code' }, sys).secret;
  W = await login(mk('writer', full));
});
afterAll(async () => { await app.close(); });

describe('diff', () => {
  it('produces a unified diff', () => {
    const d = unifiedDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n', 'x', 'y');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
    expect(d).toContain('+e');
    expect(d).toContain('@@');
    expect(unifiedDiff('same\n', 'same\n', 'x', 'y')).toBe('');
    expect(unifiedDiff('', 'new\n', 'x', 'y')).toContain('+new');
  });
});

describe('create, update, CAS', () => {
  it('creates, updates with the right base and refuses a stale base with current_revision', async () => {
    const c = await W('file_create', { path: '/vault/Notes/a.md', content: 'one\n' });
    expect(c.isError).toBeFalsy();
    expect(readFileSync(disk('Notes/a.md'), 'utf8')).toBe('one\n');
    expect((await W('file_create', { path: '/vault/Notes/a.md', content: 'again' })).structuredContent.error).toBe('conflict');
    const u = await W('file_update', { path: '/vault/Notes/a.md', content: 'two\n', base_revision: rev(c) });
    expect(u.isError).toBeFalsy();
    expect(u.structuredContent.previous_revision).toBe(rev(c));
    const stale = await W('file_update', { path: '/vault/Notes/a.md', content: 'three\n', base_revision: rev(c) });
    expect(stale.structuredContent.error).toBe('conflict');
    expect(stale.structuredContent.current_revision).toBe(rev(u));
    expect(readFileSync(disk('Notes/a.md'), 'utf8')).toBe('two\n');
    expect(app.store.conflicts().some((x) => x.path === 'Notes/a.md' && x.source === 'platform_cas')).toBe(true);
    // pre-image kept; no temp files left behind
    expect((await app.store.getBlob(rev(c)))!.toString()).toBe('one\n');
    expect(readdirSync(disk('Notes')).filter((n) => n.endsWith('.hub-tmp'))).toEqual([]);
    // reads see the same revision
    expect((await W('file_read', { path: '/vault/Notes/a.md' })).structuredContent.revision).toBe(rev(u));
  });
});

describe('patch', () => {
  it('applies unique edits; rejects ambiguous, missing and stale', async () => {
    const c = await W('file_create', { path: '/vault/patch.md', content: 'alpha beta\nbeta gamma\n' });
    const amb = await W('file_patch', { path: '/vault/patch.md', base_revision: rev(c), edits: [{ old: 'beta', new: 'B' }] });
    expect(amb.structuredContent.error).toBe('ambiguous_match');
    expect((await W('file_patch', { path: '/vault/patch.md', base_revision: rev(c), edits: [{ old: 'zzz', new: 'B' }] })).structuredContent.error).toBe('no_match');
    expect(readFileSync(disk('patch.md'), 'utf8')).toBe('alpha beta\nbeta gamma\n');
    const ok = await W('file_patch', { path: '/vault/patch.md', base_revision: rev(c), edits: [{ old: 'alpha beta', new: 'ALPHA' }, { old: 'gamma', new: 'G' }] });
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(disk('patch.md'), 'utf8')).toBe('ALPHA\nbeta G\n');
    const stale = await W('file_patch', { path: '/vault/patch.md', base_revision: rev(c), edits: [{ old: 'ALPHA', new: 'x' }] });
    expect(stale.structuredContent.error).toBe('conflict');
    expect(stale.structuredContent.current_revision).toBe(rev(ok));
  });
});

describe('rename, delete, restore, history, diff', () => {
  it('walks a file through its life and keeps every version', async () => {
    const c = await W('file_create', { path: '/vault/Life/x.md', content: 'v1\n' });
    const u = await W('file_update', { path: '/vault/Life/x.md', content: 'v2\n', base_revision: rev(c) });
    const r = await W('file_rename', { from: '/vault/Life/x.md', to: '/vault/Life/Sub/y.md', base_revision: rev(u) });
    expect(r.isError).toBeFalsy();
    expect(existsSync(disk('Life/x.md'))).toBe(false);
    expect(readFileSync(disk('Life/Sub/y.md'), 'utf8')).toBe('v2\n');
    await W('file_create', { path: '/vault/Life/z.md', content: 'zz' });
    expect((await W('file_rename', { from: '/vault/Life/Sub/y.md', to: '/vault/Life/z.md', base_revision: rev(u) })).structuredContent.error).toBe('conflict');
    expect((await W('file_rename', { from: '/vault/Life/Sub/y.md', to: '/vault/.obsidian/y.md', base_revision: rev(u) })).structuredContent.error).toBe('denied');
    const del = await W('file_delete', { path: '/vault/Life/Sub/y.md', base_revision: rev(u) });
    expect(del.structuredContent.deleted).toBe(true);
    expect(existsSync(disk('Life/Sub/y.md'))).toBe(false);
    const h = await W('file_history', { path: '/vault/Life/Sub/y.md' });
    const ops = h.structuredContent.revisions.map((x: any) => x.op);
    expect(ops).toEqual(['delete', 'rename', 'update', 'create']);
    expect(h.structuredContent.deleted).toBe(true);
    expect(h.structuredContent.revisions[1].by.label).toBe('writer');
    const d = await W('file_diff', { path: '/vault/Life/Sub/y.md', from_revision: rev(c), to_revision: rev(u) });
    expect(d.structuredContent.diff).toContain('-v1');
    expect(d.structuredContent.diff).toContain('+v2');
    const back = await W('file_restore', { path: '/vault/Life/Sub/y.md', revision: rev(c), base_revision: 'absent' });
    expect(back.isError).toBeFalsy();
    expect(readFileSync(disk('Life/Sub/y.md'), 'utf8')).toBe('v1\n');
    const h2 = await W('file_history', { path: '/vault/Life/Sub/y.md' });
    expect(h2.structuredContent.revisions[0]).toMatchObject({ op: 'restore', origin: 'restore' });
    expect(h2.structuredContent.deleted).toBe(false);
  });
});

describe('hidden and reserved paths', () => {
  it('refuses writes to hidden folders and shares, whatever the case', async () => {
    for (const p of ['/vault/.obsidian/app.json', '/vault/.OBSIDIAN/app.json', '/vault/shares/x.md', '/vault/.trash/x.md', '/vault/a/.hub-tmp', '/vault/../etc/x']) {
      const r = await W('file_create', { path: p, content: 'x' });
      expect(r.isError, p).toBe(true);
      expect(['denied', 'invalid_path']).toContain(r.structuredContent.error);
    }
    expect(existsSync(disk('.obsidian'))).toBe(false);
    expect(existsSync(disk('shares'))).toBe(false);
  });
});

describe('permissions', () => {
  it('denies each action without its grant', async () => {
    const f = await W('file_create', { path: '/vault/perm.md', content: 'p' });
    const R = await login(mk('reader', [{ effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/**' }]));
    const calls: [string, Record<string, unknown>][] = [
      ['file_create', { path: '/vault/p1.md', content: 'x' }],
      ['file_update', { path: '/vault/perm.md', content: 'x', base_revision: rev(f) }],
      ['file_patch', { path: '/vault/perm.md', base_revision: rev(f), edits: [{ old: 'p', new: 'q' }] }],
      ['file_rename', { from: '/vault/perm.md', to: '/vault/perm2.md', base_revision: rev(f) }],
      ['file_delete', { path: '/vault/perm.md', base_revision: rev(f) }],
      ['file_history', { path: '/vault/perm.md' }],
      ['file_diff', { path: '/vault/perm.md', from_revision: rev(f) }],
      ['file_restore', { path: '/vault/perm.md', revision: rev(f), base_revision: rev(f) }],
      ['file_conflicts', {}],
    ];
    for (const [name, args] of calls) expect((await R(name, args)).structuredContent.error, name).toBe('denied');
    expect(readFileSync(disk('perm.md'), 'utf8')).toBe('p');
    expect(existsSync(disk('p1.md'))).toBe(false);
    // a write grant on one folder does not reach another
    const N = await login(mk('notes-only', [{ effect: 'allow', actions: ['fs.create', 'fs.update'], resource: 'path:/vault/Open/**' }]));
    expect((await N('file_create', { path: '/vault/Open/ok.md', content: 'ok' })).isError).toBeFalsy();
    expect((await N('file_create', { path: '/vault/Closed/no.md', content: 'no' })).structuredContent.error).toBe('denied');
    expect((await N('file_history', { path: '/vault/Open/ok.md' })).structuredContent.error).toBe('denied');
  });
});

describe('external changes and conflicts', () => {
  it('labels changes made outside the hub as external and makes stale writes conflict', async () => {
    const c = await W('file_create', { path: '/vault/ext.md', content: 'hub\n' });
    writeFileSync(disk('ext.md'), 'edited in obsidian\n');
    writeFileSync(disk('brandnew.md'), 'from sync\n');
    const res = await app.store.scan();
    expect(res.changed).toBeGreaterThanOrEqual(2);
    const h = await W('file_history', { path: '/vault/ext.md' });
    expect(h.structuredContent.revisions[0]).toMatchObject({ op: 'observe', origin: 'external_observed', by: null });
    expect(h.structuredContent.revisions[0].parent_revision).toBe(rev(c));
    const hn = await W('file_history', { path: '/vault/brandnew.md' });
    expect(hn.structuredContent.revisions[0].origin).toBe('external_observed');
    const stale = await W('file_update', { path: '/vault/ext.md', content: 'mine', base_revision: rev(c) });
    expect(stale.structuredContent.error).toBe('conflict');
    expect(readFileSync(disk('ext.md'), 'utf8')).toBe('edited in obsidian\n');
    const d = await W('file_diff', { path: '/vault/ext.md', from_revision: rev(c) });
    expect(d.structuredContent.diff).toContain('+edited in obsidian');
  });

  it('detects an external rename by content and keeps the file id', async () => {
    await W('file_create', { path: '/vault/mv/old.md', content: 'unique rename content 123\n' });
    const id = app.store.fileByPath('mv/old.md')!.id;
    const { renameSync } = await import('node:fs');
    renameSync(disk('mv/old.md'), disk('mv/new.md'));
    const res = await app.store.scan();
    expect(res.renamed).toBe(1);
    expect(app.store.fileByPath('mv/new.md')!.id).toBe(id);
  });

  it('a write racing an external change keeps both versions and records a conflict', async () => {
    const c = await W('file_create', { path: '/vault/race.md', content: 'start\n' });
    app.store.hooks.afterTmp = () => { writeFileSync(disk('race.md'), 'external wins\n'); app.store.hooks.afterTmp = undefined; };
    const r = await W('file_update', { path: '/vault/race.md', content: 'agent version\n', base_revision: rev(c) });
    expect(r.structuredContent.error).toBe('conflict');
    expect(readFileSync(disk('race.md'), 'utf8')).toBe('external wins\n');
    expect(readdirSync(vaultDir).filter((n) => n.endsWith('.hub-tmp'))).toEqual([]);
    const list = await W('file_conflicts', {});
    const cf = list.structuredContent.conflicts.find((x: any) => x.path === '/vault/race.md' && x.source === 'external_during_commit');
    expect(cf).toBeTruthy();
    const attempted = cf.revisions.find((x: any) => x.role === 'attempted').revision;
    expect((await app.store.getBlob(attempted))!.toString()).toBe('agent version\n');
    // admin resolves by keeping the agent's version
    const adminList = await api('GET', '/vault/conflicts');
    expect(adminList.body.conflicts.some((x: any) => x.id === cf.id)).toBe(true);
    const res = await api('POST', `/vault/conflicts/${cf.id}/resolve`, { keep: attempted });
    expect(res.status).toBe(200);
    expect(readFileSync(disk('race.md'), 'utf8')).toBe('agent version\n');
    expect((await api('POST', `/vault/conflicts/${cf.id}/resolve`, { keep: attempted })).status).toBe(400);
    const alerts = await api('GET', '/alerts');
    expect(alerts.body.alerts.some((a: any) => a.type === 'vault_conflict')).toBe(true);
  });
});

describe('lockdown', () => {
  it('refuses all writes while on and allows them again after', async () => {
    const c = await W('file_create', { path: '/vault/lock.md', content: 'x' });
    expect((await api('POST', '/lockdown', { writes_disabled: true })).body.writes_disabled).toBe(true);
    for (const [n, a] of [['file_create', { path: '/vault/lock2.md', content: 'x' }], ['file_update', { path: '/vault/lock.md', content: 'y', base_revision: rev(c) }], ['file_delete', { path: '/vault/lock.md', base_revision: rev(c) }]] as const) {
      expect((await W(n, a)).structuredContent.error, n).toBe('lockdown');
    }
    expect(existsSync(disk('lock2.md'))).toBe(false);
    expect((await W('file_read', { path: '/vault/lock.md' })).isError).toBeFalsy();
    expect((await api('POST', '/lockdown', { writes_disabled: false })).status).toBe(200);
    expect((await W('file_update', { path: '/vault/lock.md', content: 'y', base_revision: rev(c) })).isError).toBeFalsy();
  });
});

describe('crash recovery', () => {
  it('rolls a committed-but-unrecorded write forward and removes the temp file', async () => {
    const c = await W('file_create', { path: '/vault/crash.md', content: 'before\n' });
    // simulate: intent journalled, tmp written, rename done, process died before the DB commit
    const after = Buffer.from('after crash\n');
    const { createHash } = await import('node:crypto');
    const newRev = `sha256:${createHash('sha256').update(after).digest('hex')}`;
    const tmpName = '.crash.md.wri_dead.hub-tmp';
    writeFileSync(join(vaultDir, tmpName), 'partial');
    writeFileSync(disk('crash.md'), after);
    app.db.prepare('INSERT INTO write_intents(id,op,path,base_revision,new_revision,tmp_name,agent_id,credential_id,revision_op,origin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(newId.intent(), 'write', 'crash.md', rev(c), newRev, tmpName, null, null, 'update', 'platform', Date.now());
    // and an interrupted write that never reached the rename
    writeFileSync(join(vaultDir, '.other.hub-tmp'), 'junk');
    writeFileSync(disk('other.md'), 'untouched');
    app.db.prepare('INSERT INTO write_intents(id,op,path,base_revision,new_revision,tmp_name,created_at) VALUES (?,?,?,?,?,?,?)').run(newId.intent(), 'write', 'other.md', 'absent', 'sha256:00', '.other.hub-tmp', Date.now());
    const r = await app.store.recover();
    expect(r.recovered).toBe(1);
    expect(existsSync(join(vaultDir, tmpName))).toBe(false);
    expect(existsSync(join(vaultDir, '.other.hub-tmp'))).toBe(false);
    expect((app.db.prepare('SELECT COUNT(*) n FROM write_intents').get() as { n: number }).n).toBe(0);
    const f = app.store.fileByPath('crash.md')!;
    expect(f.current_revision).toBe(newRev);
    const top = app.store.revisions(f.id)[0]!;
    expect(top).toMatchObject({ recovered: 1, origin: 'platform', parent_revision: rev(c) });
    expect((await W('file_read', { path: '/vault/crash.md' })).structuredContent.revision).toBe(newRev);
  });
});

describe('admin vault API', () => {
  it('reports exposure counts per folder, activity and revisions', async () => {
    await W('file_create', { path: '/vault/Exp/Shared/a.md', content: 'a' });
    await W('file_create', { path: '/vault/Exp/Private/b.md', content: 'b' });
    mk('exp-reader', [{ effect: 'allow', actions: ['fs.read', 'fs.list'], resource: 'path:/vault/Exp/Shared/**' }]);
    mk('exp-writer', [{ effect: 'allow', actions: ['fs.read', 'fs.update'], resource: 'path:/vault/Exp/**' }, { effect: 'deny', actions: ['fs.read', 'fs.update'], resource: 'path:/vault/Exp/Private/**' }]);
    const t = await api('GET', '/vault/tree?path=/vault/Exp');
    expect(t.status).toBe(200);
    const shared = t.body.folders.find((f: any) => f.name === 'Shared'), priv = t.body.folders.find((f: any) => f.name === 'Private');
    expect(shared.files).toBe(1);
    // the full-access test key + exp-reader + exp-writer can read Shared; only the full-access key reaches Private
    expect(shared.exposure.read).toBeGreaterThanOrEqual(3);
    expect(shared.exposure.update).toBeGreaterThanOrEqual(2);
    expect(priv.exposure.read).toBeLessThan(shared.exposure.read);
    expect(priv.exposure.update).toBeLessThan(shared.exposure.update);
    const root = await api('GET', '/vault/tree');
    expect(root.body.folders.some((f: any) => f.name === 'Exp')).toBe(true);
    const act = await api('GET', '/vault/activity?limit=20');
    expect(act.body.revisions.length).toBeGreaterThan(0);
    expect(act.body.revisions[0]).toHaveProperty('agent_label');
    expect(act.body.access.length).toBeGreaterThan(0);
    const fid = act.body.revisions[0].file_id;
    const revs = await api('GET', `/vault/revisions/${fid}`);
    expect(revs.body.revisions.length).toBeGreaterThan(0);
    const f = app.store.fileByPath('Exp/Shared/a.md')!;
    const u = await W('file_update', { path: '/vault/Exp/Shared/a.md', content: 'a2', base_revision: f.current_revision! });
    const df = await api('GET', `/vault/diff?file=${f.id}&from=${encodeURIComponent(f.current_revision!)}&to=${encodeURIComponent(rev(u))}`);
    expect(df.body.diff).toContain('+a2');
    // writes=1 lists changes only: the update is there, initial-scan sightings are not
    const writes = (await api('GET', '/vault/activity?writes=1&limit=200')).body.revisions;
    expect(writes.some((r: any) => r.path === '/vault/Exp/Shared/a.md' && r.op === 'update')).toBe(true);
    expect(writes.every((r: any) => r.origin !== 'initial_scan')).toBe(true);
  });

  it('acknowledges and closes alerts', async () => {
    app.audit.alert('warning', 'test_alert', null, { n: 1 });
    const a = (await api('GET', '/alerts')).body.alerts.find((x: any) => x.type === 'test_alert');
    expect(a.status).toBe('open');
    expect((await api('POST', `/alerts/${a.id}/ack`)).body.alert.status).toBe('acknowledged');
    expect((await api('POST', `/alerts/${a.id}/close`)).body.alert.status).toBe('closed');
    expect((await api('POST', '/alerts/alr_nope/ack')).status).toBe(404);
  });
});
