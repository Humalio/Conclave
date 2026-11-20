/**
 * A project's fixed task-tag list (docs/specification.md, "Task tags"): at most 7 tags set in Project settings; a task takes
 * 1 or 2 of them; a project without a list takes free tags, at most 2. Saving a list runs a map over every task of the project
 * (done ones too) without raising task versions: one audit entry and one event per changed task.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { remapTags } from '../src/teams/teams.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
type S = { cookie: string; csrf: string };
let app: App, base = '', admin: S, appKey = '';
const PW = 'taglist test password 1234';
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
  const dir = mkdtempSync(join(tmpdir(), 'ahtaglist-'));
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


const LIST = ['Console', 'Hub', 'Connector', 'Blueprint', 'Hardware', 'Security', 'Release'].map((name) => ({ tag: name.toLowerCase(), name }));
const tagsOf = (id: string) => JSON.parse((app.db.prepare('SELECT tags FROM tasks WHERE id=?').get(id) as { tags: string }).tags) as string[];
const versionOf = (id: string) => (app.db.prepare('SELECT version FROM tasks WHERE id=?').get(id) as { version: number }).version;

describe('a project without a list: free tags, at most 2', () => {
  it('refuses a third tag, in task_create, task_update and the operator edit; team_info shows no list', async () => {
    const X = await team('NoList');
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'Three', tags: ['a', 'b', 'c'] }))).toBe('invalid_argument');
    expect(text(await X.c.call('task_create', { team_id: X.id, title: 'Three', tags: ['a', 'b', 'c'] }))).toContain('at most 2');
    const t = await create(X, { tags: ['a', 'b'] });
    expect(code(await X.c.call('task_update', { task_id: t.id, version: t.version, tags: ['a', 'b', 'c'] }))).toBe('invalid_argument');
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['a', 'b', 'c'] })).status).toBe(400);
    expect(ok(await X.c.call('team_info', { team_id: X.id })).teams[0].task_tags).toEqual([]);
  });
});

describe('a project with a list', () => {
  it('takes only its tags, 1 or 2 per task, and the refusal names them; the operator edit follows the same rule', async () => {
    const X = await team('WithList');
    const put = await api('PUT', `/projects/${X.project}/task-tags`, { tags: LIST });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const r = await X.c.call('task_create', { team_id: X.id, title: 'Next', tags: ['next'] });
    expect(code(r)).toBe('invalid_argument');
    expect(text(r)).toContain('console, hub, connector, blueprint, hardware, security, release');
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'None' }))).toBe('invalid_argument');
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'Three', tags: ['console', 'hub', 'release'] }))).toBe('invalid_argument');
    const t = await create(X, { tags: ['Console', 'hub'] });
    expect(t.tags).toEqual(['console', 'hub']);
    expect(code(await X.c.call('task_update', { task_id: t.id, version: t.version, tags: [] }))).toBe('invalid_argument');
    expect(code(await X.c.call('task_update', { task_id: t.id, version: t.version, tags: ['poc'] }))).toBe('invalid_argument');
    expect(ok(await X.c.call('task_update', { task_id: t.id, version: t.version, tags: ['release'] })).task.tags).toEqual(['release']);
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['next'] })).status).toBe(400);
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: [] })).status).toBe(400);
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['security'] })).status).toBe(200);
    // team_info and the coordinator's playbook name the list; another role's playbook does not
    const info = ok(await X.c.call('team_info', { team_id: X.id })).teams[0];
    expect(info.task_tags.map((d: { tag: string }) => d.tag)).toEqual(LIST.map((d) => d.tag));
    expect(info.playbook).toContain('Task tags in this project: give every task 1 or 2 of console, hub');
    expect(ok(await X.w.call('team_info', { team_id: X.id })).teams[0].playbook).not.toContain('Task tags in this project');
  });

  it('refuses a list of eight, a duplicate and a map target outside the list; an empty list returns to free tags', async () => {
    const X = await team('Bounds');
    const eight = Array.from({ length: 8 }, (_, i) => ({ tag: `t${i}`, name: `T${i}` }));
    expect((await api('PUT', `/projects/${X.project}/task-tags`, { tags: eight })).status).toBe(400);
    expect((await api('PUT', `/projects/${X.project}/task-tags`, { tags: [{ name: 'Hub' }, { tag: 'hub', name: 'Hub 2' }] })).status).toBe(400);
    expect((await api('PUT', `/projects/${X.project}/task-tags`, { tags: LIST, map: { ux: 'nowhere' } })).status).toBe(400);
    expect((await api('PUT', `/projects/${X.project}/task-tags`, { tags: LIST })).status).toBe(200);
    expect((await api('GET', `/projects/${X.project}/task-tags`)).body.list.map((d: { name: string }) => d.name)).toEqual(LIST.map((d) => d.name));
    expect((await api('PUT', `/projects/${X.project}/task-tags`, { tags: [] })).status).toBe(200);
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'Free', tags: ['anything'] }))).toBe('ok');
    // only the operator
    expect((await call(null, 'PUT', `/projects/${X.project}/task-tags`, { tags: LIST })).status).toBe(401);
  });
});

describe('the map: preview first, then the remap over every task', () => {
  it('lists what is dropped, which tasks lose a tag and which end with none; the save changes tags only, never versions', async () => {
    const X = await team('Remap');
    const mk = async (title: string, tags: string[]) => { const t = await create(X, { title, tags }); return t.id as string; };
    const a = await mk('A', ['ux', 'next']), b = await mk('B', ['next']), c = await mk('C', ['platform', 'ux']), d = await mk('D', ['poc']);
    app.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(d); // done ones are remapped too
    const e = await mk('E', ['hub', 'poc']); // a list tag and an old one
    const before = Object.fromEntries([a, b, c, d, e].map((id) => [id, versionOf(id)]));
    const map = { ux: 'console', platform: 'hub' }; // #next and #poc stay unmapped
    const pv = await api('POST', `/projects/${X.project}/task-tags/preview`, { tags: LIST, map });
    expect(pv.status).toBe(200);
    expect(pv.body.dropped).toEqual(expect.arrayContaining([{ tag: 'next', n: 2 }, { tag: 'poc', n: 2 }]));
    expect(pv.body.lose.map((x: { id: string }) => x.id).sort()).toEqual([a, b, d, e].sort());
    expect(pv.body.none.map((x: { id: string }) => x.id).sort()).toEqual([b, d].sort());
    expect(tagsOf(a)).toEqual(['ux', 'next']); // a preview changes nothing
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='project.task_tags' AND target_id=?").get(X.project)).toEqual({ n: 0 });

    const save = await api('PUT', `/projects/${X.project}/task-tags`, { tags: LIST, map });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(tagsOf(a)).toEqual(['console']);
    expect(tagsOf(b)).toEqual([]);
    expect(tagsOf(c)).toEqual(['console', 'hub']);
    expect(tagsOf(d)).toEqual([]);
    expect(tagsOf(e)).toEqual(['hub']);
    for (const id of [a, b, c, d, e]) expect(versionOf(id), id).toBe(before[id]);
    // one audit entry, one event per changed task
    const au = app.db.prepare("SELECT details FROM audit_events WHERE action='project.task_tags' AND target_id=?").all(X.project) as { details: string }[];
    expect(au).toHaveLength(1);
    expect(JSON.parse(au[0]!.details)).toMatchObject({ remapped: 5, left_with_none: 2 });
    const ev = (id: string) => (app.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND tool='admin_tag_map'").get(id) as { n: number }).n;
    expect([a, b, c, d, e].map(ev)).toEqual([1, 1, 1, 1, 1]);
    // an agent's next update does not conflict: the version it read is still current
    const cur = ok(await X.c.call('task_list', { team_id: X.id, task_id: a })).tasks[0];
    expect(ok(await X.c.call('task_update', { task_id: a, version: cur.version, tags: ['hub'] })).task.tags).toEqual(['hub']);
    // saving the same list again changes nothing and writes no events
    await api('PUT', `/projects/${X.project}/task-tags`, { tags: LIST, map });
    expect(ev(c)).toBe(1);
  });

  it('keeps at most two tags, in list order, when a task would end with more', () => {
    expect(remapTags(['ux', 'platform', 'release'], LIST, { ux: 'console', platform: 'hub' })).toEqual({ tags: ['console', 'hub'], lost: ['release'] });
    expect(remapTags(['a', 'b'], LIST, { a: 'hub', b: 'hub' })).toEqual({ tags: ['hub'], lost: [] });
    expect(remapTags(['zzz'], LIST, {})).toEqual({ tags: [], lost: ['zzz'] });
  });
});

describe('the project view', () => {
  it('carries the list for the console', async () => {
    const X = await team('View');
    await api('PUT', `/projects/${X.project}/task-tags`, { tags: LIST });
    const list = (await api('GET', '/projects')).body.projects as { id: string; task_tags: unknown }[];
    expect(list.find((p) => p.id === X.project)!.task_tags).toEqual(LIST);
    expect((await api('GET', `/teams/${X.id}`)).body.team.task_tags).toEqual(LIST);
  });
});

describe('the backlog tag counts', () => {
  it('carry the display name of a listed tag and none for an unlisted one', async () => {
    const X = await team('Names');
    await api('PUT', `/projects/${X.project}/task-tags`, { tags: LIST });
    await create(X, { tags: ['console'] });
    const r = (await api('GET', '/tasks/backlog')).body;
    const c = r.tags.find((g: { tag: string }) => g.tag === 'console');
    expect(c.name).toBe('Console');
  });
});

describe('a project without a list: at most 7 different tags in use', () => {
  it('refuses a task that brings in an eighth, names the seven, and still lets it reuse one; an eighth list entry gets the retag message', async () => {
    const X = await team('SevenInUse');
    for (const g of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await create(X, { tags: [g] });
    const r = await X.c.call('task_create', { team_id: X.id, title: 'Eighth', tags: ['h'] });
    expect(code(r)).toBe('invalid_argument');
    expect(text(r)).toContain('a, b, c, d, e, f, g');
    expect(text(r)).toContain('tag list in Project settings');
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'Reuse', tags: ['a', 'g'] }))).toBe('ok');
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `T${i}` }));
    const put = await api('PUT', `/projects/${X.project}/task-tags`, { tags: eight });
    expect(put.status).toBe(400);
    expect(JSON.stringify(put.body)).toContain('change the list and retag the tasks');
  });
  it('leaves a project already over 7 as it is and shows the note', async () => {
    const X = await team('OverSeven');
    for (const g of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await create(X, { tags: [g] });
    const t = await create(X, { tags: ['a'] });
    app.db.prepare('UPDATE tasks SET tags=? WHERE id=?').run(JSON.stringify(['h']), t.id); // an eighth, as before this rule
    expect((await api('GET', `/projects/${X.project}/task-tags`)).body.over).toBe(true);
    expect((await api('GET', `/teams/${X.id}`)).body.team.tags_over).toBe(true);
  });
});

describe('older tasks with 3 or more tags', () => {
  it('can be saved again with the same tags but not with a new third one', async () => {
    const X = await team('OldThree');
    const t = await create(X, { tags: ['a'] });
    app.db.prepare('UPDATE tasks SET tags=? WHERE id=?').run(JSON.stringify(['a', 'b', 'c']), t.id);
    const cur = ok(await X.c.call('task_list', { team_id: X.id, task_id: t.id })).tasks[0];
    expect(ok(await X.c.call('task_update', { task_id: t.id, version: cur.version, tags: ['c', 'a', 'b'] })).task.tags).toEqual(['c', 'a', 'b']);
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['a', 'b', 'c'] })).status).toBe(200);
    expect((await api('PUT', `/teams/${X.id}/tasks/${t.id}/tags`, { tags: ['a', 'b', 'c', 'd'] })).status).toBe(400);
  });
});
