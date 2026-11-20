/**
 * Task tags: the creator files a task under up to 2 lowercase tags (the directives tag model) in task_create; the creator
 * or a coordinator changes them with task_update while the task is in the backlog; the operator edits them on any task
 * (admin API, audited). task_list, GET /api/tasks/backlog and GET /api/teams/:id/tasks filter by one tag; members see a
 * team's tasks only where their grant has the team's tasks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { normTaskTags } from '../src/teams/teams.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
type S = { cookie: string; csrf: string };
let app: App, base = '', admin: S, appKey = '';
const PW = 'tags test password 1234';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const code = (r: Res) => (r.isError ? /^(\w+)/.exec(text(r))?.[1] : 'ok');
const call = async (who: S | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
const login = async (username: string, password: string): Promise<S> => {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  expect(r.status).toBe(200);
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as { csrf: string }).csrf };
};
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
/** A running team with two coordinators and a worker, in its own project (task intake backlog, the default). */
async function team(name: string) {
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent(`${name}-coord`), c2 = agent(`${name}-coord2`), w = agent(`${name}-worker`);
  const id = app.teams.create({ name, goal: 'g', members: [
    { agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: c2.id, role: 'coordinator', credential_id: c2.cred },
    { agent_id: w.id, role: 'worker', credential_id: w.cred }] }, sys).id;
  app.teams.start(id, sys);
  const project = app.blueprint.ensureTeamProject(id).id;
  return { id, project, c: { ...c, call: await session(c.secret) }, c2: { ...c2, call: await session(c2.secret) }, w: { ...w, call: await session(w.secret) } };
}
type T = Awaited<ReturnType<typeof team>>;
const create = async (X: T, args: Record<string, unknown> = {}) => ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${Math.random().toString(36).slice(2, 7)}`, ...args })).task;
const ids = (L: { id: string }[]) => L.map((k) => k.id);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahtags-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp({ dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir: join(dir, 'vault'), vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'p',
    publicUrl: 'http://127.0.0.1', production: false, adminUsername: 'admin', adminPassword: 'admin-password-long', publicDir: join(process.cwd(), 'public'), logLevel: 'silent',
    allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0 });
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin', 'admin-password-long');
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 40 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('validation (the directives tag model)', () => {
  it('normalises like directive tags: lowercase, dashes, a-z 0-9 . _ -, cut to 24, deduplicated; more than 2 is refused', () => {
    expect(normTaskTags([' Docs ', 'UX review', 'docs', '', '   '])).toEqual(['docs', 'ux-review']);
    expect(normTaskTags(['a/b!'])).toEqual(['ab']);
    expect(normTaskTags(['x'.repeat(40)])).toEqual(['x'.repeat(24)]);
    expect(normTaskTags(['a', 'b', 'B', 'a'])).toHaveLength(2);
    expect(() => normTaskTags(['a', 'b', 'c'])).toThrow('A task takes at most 2 tags.');
  });

  it('task_create stores the creator\'s tags and shows them in task_list; too many is refused', async () => {
    const X = await team('Create');
    const t = await create(X, { tags: ['Docs', 'UX'] });
    expect(t.tags).toEqual(['docs', 'ux']);
    expect(t.status).toBe('backlog');
    const L = ok(await X.w.call('task_list', { team_id: X.id }));
    expect(L.tasks.find((k: { id: string }) => k.id === t.id).tags).toEqual(['docs', 'ux']);
    expect(text(await X.w.call('task_list', { team_id: X.id }))).toMatch(/tags=docs,ux/);
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'Nine', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }))).not.toBe('ok');
    expect((await create(X)).tags).toEqual([]);
  });
});

describe('who changes the tags', () => {
  it('the creator and another coordinator change them while in the backlog; a worker cannot', async () => {
    const X = await team('Edit');
    const t = await create(X, { tags: ['docs'] });
    const u = ok(await X.c.call('task_update', { task_id: t.id, version: t.version, tags: ['docs', 'api'] })).task;
    expect(u.tags).toEqual(['docs', 'api']);
    const u2 = ok(await X.c2.call('task_update', { task_id: t.id, version: u.version, tags: ['api'] })).task;
    expect(u2.tags).toEqual(['api']);
    const w = await X.w.call('task_update', { task_id: t.id, version: u2.version, tags: ['hack'] });
    expect(code(w)).toBe('denied');
    expect(app.db.prepare("SELECT note FROM task_events WHERE task_id=? AND tool='task_update'").all(t.id).map((e: any) => e.note)).toEqual(['tags docs, api', 'tags api']);
  });

  it('a creator who is no longer a coordinator may still change the tags alone', async () => {
    const X = await team('Former');
    const t = await create(X, { tags: ['a'] });
    app.db.prepare("UPDATE team_members SET role='worker' WHERE team_id=? AND agent_id=?").run(X.id, X.c.id);
    expect(ok(await X.c.call('task_update', { task_id: t.id, version: t.version, tags: ['b'] })).task.tags).toEqual(['b']);
    expect(code(await X.c.call('task_update', { task_id: t.id, version: t.version + 1, title: 'New title' }))).toBe('denied');
  });

  it('after the operator accepts the task, agents can no longer change its tags (same tags pass)', async () => {
    const X = await team('Accepted');
    const t = await create(X, { tags: ['docs'] });
    const a = (await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, {})).body.task;
    const r = await X.c.call('task_update', { task_id: t.id, version: a.version, tags: ['other'] });
    expect(code(r)).toBe('invalid_state');
    expect(text(r)).toMatch(/only while the task is in the backlog/);
    expect(ok(await X.c.call('task_update', { task_id: t.id, version: a.version, tags: ['docs'], title: 'Renamed' })).task).toMatchObject({ title: 'Renamed', tags: ['docs'] });
  });

  it('the operator edits tags on any task, audited, with a stale version refused', async () => {
    const X = await team('Operator');
    const t = await create(X, { tags: ['docs'] });
    await api('POST', `/teams/${X.id}/tasks/${t.id}/accept`, {});
    const cur = app.teams.task(t.id)!;
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['x'], version: cur.version - 1 })).status).toBe(409);
    const r = await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['Infra', 'docs'], version: cur.version });
    expect(r.status).toBe(200);
    expect(r.body.task.tags).toEqual(['infra', 'docs']);
    const au = app.db.prepare("SELECT actor_kind, details FROM audit_events WHERE action='task.tags' AND target_id=?").all(t.id) as { actor_kind: string; details: string }[];
    expect(au).toHaveLength(1);
    expect(au[0]!.actor_kind).toBe('admin');
    expect(JSON.parse(au[0]!.details)).toMatchObject({ from: ['docs'], to: ['infra', 'docs'] });
    // A done task too; [] clears.
    app.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(t.id);
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: [] })).body.task.tags).toEqual([]);
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] })).status).toBe(400);
    const Y = await team('Elsewhere');
    expect((await api('PUT', `/teams/${Y.id}/tasks/${t.id}/tags`, { tags: ['a'] })).status).toBe(404);
    expect((await call(null, 'PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['a'] })).status).toBe(401);
  });
});

describe('filters', () => {
  it('task_list filters by one tag (normalised), with the other filters', async () => {
    const X = await team('McpFilter');
    const a = await create(X, { tags: ['docs', 'ux'] }), b = await create(X, { tags: ['api'] }), c = await create(X);
    expect(ids(ok(await X.w.call('task_list', { team_id: X.id, tag: 'docs' })).tasks)).toEqual([a.id]);
    expect(ids(ok(await X.w.call('task_list', { team_id: X.id, tag: ' API ' })).tasks)).toEqual([b.id]);
    expect(ok(await X.w.call('task_list', { team_id: X.id, tag: 'none-such' })).tasks).toEqual([]);
    expect(ids(ok(await X.w.call('task_list', { team_id: X.id, tag: 'ux', status: 'backlog' })).tasks)).toEqual([a.id]);
    expect(ok(await X.w.call('task_list', { team_id: X.id })).tasks).toHaveLength(3);
    void c;
  });

  it('GET /api/tasks/backlog filters both lists by tag and counts the tags', async () => {
    const X = await team('BacklogFilter');
    const a = await create(X, { tags: ['zz-only'] }), b = await create(X, { tags: ['zz-other'] });
    const relayed = await create(X, { tags: ['zz-only'], operator_request: { source: 'chat with operator' } });
    const all = (await api('GET', '/tasks/backlog')).body;
    expect(all.tag).toBeNull();
    expect(all.tags).toEqual(expect.arrayContaining([{ tag: 'zz-only', n: 2 }, { tag: 'zz-other', n: 1 }]));
    const f = (await api('GET', '/tasks/backlog?tag=ZZ-only')).body;
    expect(f.tag).toBe('zz-only');
    expect(ids(f.tasks)).toEqual([a.id]);
    expect(ids(f.relayed)).toEqual([relayed.id]);
    expect(f.total).toBe(1);
    expect(f.all_total).toBe(all.total);
    expect(ids(f.tasks)).not.toContain(b.id);
  });

  it('GET /api/teams/:id/tasks filters by status and tag', async () => {
    const X = await team('TeamFilter');
    const a = await create(X, { tags: ['docs'] }), b = await create(X, { tags: ['docs', 'api'] });
    await api('POST', `/teams/${X.id}/tasks/${b.id}/discard`, {});
    const r = (await api('GET', `/teams/${X.id}/tasks?tag=docs`)).body;
    expect(ids(r.tasks)).toEqual([a.id]);
    expect(r.tags).toEqual([{ tag: 'docs', n: 1 }]);
    expect(ids((await api('GET', `/teams/${X.id}/tasks?tag=docs&status=all`)).body.tasks)).toEqual([a.id, b.id]);
    expect(ids((await api('GET', `/teams/${X.id}/tasks?tag=api&status=discarded`)).body.tasks)).toEqual([b.id]);
    expect((await api('GET', '/teams/nope/tasks')).status).toBe(404);
  });
});

describe('member scoping', () => {
  it('a member reads tagged task lists only for teams granted their tasks, and cannot edit tags or read the backlog', async () => {
    const X = await team('Granted'), Y = await team('NotGranted');
    const a = await create(X, { tags: ['docs'] }), b = await create(Y, { tags: ['docs'] });
    const u = await api('POST', '/users', { username: 'nadia' });
    const pw = u.body.password as string;
    expect((await api('PUT', `/users/${u.body.user.id}/grants`, { grants: [{ project_id: X.project, components: ['tasks'] }] })).status).toBe(200);
    const nadia = await login('nadia', pw);
    const mine = await call(nadia, 'GET', `/teams/${X.id}/tasks?tag=docs`);
    expect(mine.status).toBe(200);
    expect(ids(mine.body.tasks)).toEqual([a.id]);
    expect(mine.body.tasks[0].tags).toEqual(['docs']);
    const other = await call(nadia, 'GET', `/teams/${Y.id}/tasks?tag=docs`);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain(b.id);
    expect((await call(nadia, 'PUT', `/teams/${X.id}/tasks/${a.id}/tags`, { tags: ['x'] })).status).toBe(403);
    expect((await call(nadia, 'GET', '/tasks/backlog?tag=docs')).status).toBe(403);
    expect(app.teams.task(a.id)!.tags).toBe('["docs"]');
  });
});

describe('assignee filter', () => {
  it('task_list takes "me", a role or a member\'s name for the assignee, and refuses a value that names nobody', async () => {
    const X = await team('Assignee');
    const t = app.teams.hubTask(X.id, { title: 'Mine', description: 'd', assignee: X.w.id })!;
    expect((await api('PATCH', `/agents/${X.w.id}`, { label: 'Dev · Release Manager' })).status).toBe(200);
    for (const v of ['me', X.w.id, 'release_manager', 'Dev · Release Manager', 'WORKER']) {
      expect(ids(ok(await X.w.call('task_list', { team_id: X.id, assignee: v })).tasks), v).toContain(t.id);
    }
    expect(ok(await X.c.call('task_list', { team_id: X.id, assignee: 'me' })).tasks).toHaveLength(0);
    const r = await X.w.call('task_list', { team_id: X.id, assignee: 'nobody_here' });
    expect(code(r)).toBe('invalid_argument');
    expect(text(r)).toContain('No member of your team(s) matches');
  });
});
