/**
 * Postponed backlog tasks (docs/specification.md, Postponed; docs/next-release.md §4): the operator postpones a pending
 * backlog task and returns it to active. It stays in the backlog (postponed_at), out of the active list, Home's counts and
 * every agent move; both moves are admin-only, versioned and audited, with no notice. Accept or discard works from either
 * list and clears postponement; a demoted task starts active. GET /api/tasks/backlog combines list, project and tag before
 * it pages and counts; relayed open tasks keep their own group.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const code = (r: Res) => (r.isError ? /^(\w+)/.exec(text(r))?.[1] : 'ok');
const api = async (method: string, path: string, body?: unknown, auth = true) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
/** A running team (coordinator and worker) in its own project, task intake at its default (backlog). */
async function team(name: string) {
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent(`${name}-coord`), w = agent(`${name}-worker`);
  const id = app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }] }, sys).id;
  app.teams.start(id, sys);
  const project = app.blueprint.ensureTeamProject(id).id;
  return { id, project, c: { ...c, call: await session(c.secret) }, w: { ...w, call: await session(w.secret) } };
}
type T = Awaited<ReturnType<typeof team>>;
let seq = 0;
const create = async (X: T, args: Record<string, unknown> = {}) => ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${++seq}`, ...args })).task;
const u = (X: T, id: string, act: string) => `/teams/${X.id}/tasks/${id}/${act}`;
const row = (id: string) => app.db.prepare('SELECT status, postponed_at, version FROM tasks WHERE id=?').get(id) as { status: string; postponed_at: number | null; version: number };
const audits = (action: string, id: string) => app.db.prepare('SELECT actor_kind FROM audit_events WHERE action=? AND target_id=?').all(action, id) as { actor_kind: string }[];
const noticesFor = (id: string) => (app.db.prepare('SELECT COUNT(*) n FROM agent_notices WHERE ref_task_id=?').get(id) as { n: number }).n;
const backlog = async (q = '') => (await api('GET', '/tasks/backlog' + q)).body;
const ids = (L: { id: string }[]) => L.map((k) => k.id);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahpp-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 40 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('postpone and return to active', () => {
  it('postpones a pending backlog task and returns it: versioned, audited, an event each, no notice; it stays in the backlog', async () => {
    const X = await team('Postpone');
    const t = await create(X);
    const before = noticesFor(t.id);
    const p = await api('POST', u(X, t.id, 'postpone'), { version: t.version });
    expect(p.status).toBe(200);
    expect(p.body.task).toMatchObject({ status: 'backlog', version: t.version + 1 });
    expect(p.body.task.postponed_at).toBeGreaterThan(0);
    expect(audits('task.postpone', t.id)).toEqual([{ actor_kind: 'admin' }]);
    // A stale version is refused, and so is postponing twice.
    expect((await api('POST', u(X, t.id, 'restore'), { version: t.version })).status).toBe(409);
    expect((await api('POST', u(X, t.id, 'postpone'), {})).body.message).toMatch(/already postponed/);
    const r = await api('POST', u(X, t.id, 'restore'), { version: t.version + 1 });
    expect(r.body.task).toMatchObject({ status: 'backlog', postponed_at: null, version: t.version + 2 });
    expect(audits('task.restore', t.id)).toEqual([{ actor_kind: 'admin' }]);
    expect((await api('POST', u(X, t.id, 'restore'), {})).body.message).toMatch(/not postponed/);
    const ev = app.db.prepare("SELECT from_status, to_status, actor_kind, tool FROM task_events WHERE task_id=? AND tool LIKE 'admin_%' ORDER BY id").all(t.id);
    expect(ev).toEqual([{ from_status: 'backlog', to_status: 'backlog', actor_kind: 'admin', tool: 'admin_postpone' }, { from_status: 'backlog', to_status: 'backlog', actor_kind: 'admin', tool: 'admin_restore' }]);
    expect(noticesFor(t.id)).toBe(before);
  });

  it('is the operator\'s alone, and only for a backlog task', async () => {
    const X = await team('PpGuard');
    const t = await create(X);
    expect((await api('POST', u(X, t.id, 'postpone'), {}, false)).status).toBe(401);
    expect(() => app.teams.adminPostpone(X.id, t.id, null, undefined, { kind: 'agent', id: X.c.id })).toThrow(/Only the operator/);
    expect(() => app.teams.adminRestore(X.id, t.id, null, undefined, sys)).toThrow(/Only the operator/);
    expect((await api('POST', u(X, t.id, 'postpone'), { list: 'x' })).status).toBe(400);
    const Y = await team('PpOther');
    expect((await api('POST', `/teams/${Y.id}/tasks/${t.id}/postpone`, {})).status).toBe(404);
    await api('POST', u(X, t.id, 'accept'), {});
    const o = await api('POST', u(X, t.id, 'postpone'), {});
    expect(o.status).toBe(409);
    expect(o.body.message).toMatch(/Only a backlog task/);
  });

  it('a postponed task stays pending: agents still cannot assign, claim or start it, and it is not in the active list or Home\'s counts', async () => {
    const X = await team('PpPending');
    const t = await create(X, { claimable: true }), a = await create(X);
    await api('POST', u(X, t.id, 'postpone'), {});
    const v = row(t.id).version;
    expect(code(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }))).toBe('invalid_state');
    expect(code(await X.w.call('task_claim', { task_id: t.id, version: v }))).toBe('invalid_state');
    expect(code(await X.w.call('task_start', { task_id: t.id }))).toBe('invalid_state');
    expect(row(t.id)).toMatchObject({ status: 'backlog', version: v });
    // Agents still read it as a backlog task.
    expect(ok(await X.w.call('task_list', { team_id: X.id, status: 'backlog' })).tasks.map((k: { id: string }) => k.id).sort()).toEqual([t.id, a.id].sort());
    const act = await backlog(`?project=${X.project}`), pp = await backlog(`?project=${X.project}&list=postponed`);
    expect(ids(act.tasks)).toEqual([a.id]);
    expect(ids(pp.tasks)).toEqual([t.id]);
    expect(act).toMatchObject({ list: 'active', total: 1, active_total: 1, postponed_total: 1 });
    expect(pp).toMatchObject({ list: 'postponed', total: 1 });
    // Home: the team's counts and the card's whole-backlog total leave the postponed task out.
    const tm = (await api('GET', '/teams')).body.teams.find((x: { id: string }) => x.id === X.id);
    expect(tm.counts).toMatchObject({ backlog: 1, postponed: 1 });
    const all = (await backlog()).all_total;
    await api('POST', u(X, a.id, 'postpone'), {});
    expect((await backlog()).all_total).toBe(all - 1);
    // The team page's tasks carry postponed_at, so its Needs attention counts only the active backlog.
    const board = (await api('GET', `/teams/${X.id}`)).body.team.board as { id: string; postponed_at: number | null }[];
    expect(board.find((k) => k.id === t.id)!.postponed_at).toBeGreaterThan(0);
  });

  it('accept and discard work from either list and clear postponement; a demoted task starts active', async () => {
    const X = await team('PpMoves');
    const a = await create(X), d = await create(X);
    for (const k of [a, d]) await api('POST', u(X, k.id, 'postpone'), {});
    expect((await api('POST', u(X, a.id, 'accept'), {})).body.task.status).toBe('open');
    expect(row(a.id)).toMatchObject({ status: 'open', postponed_at: null });
    expect((await api('POST', u(X, d.id, 'discard'), {})).body.task.status).toBe('discarded');
    expect(row(d.id)).toMatchObject({ status: 'discarded', postponed_at: null });
    const back = await api('POST', u(X, a.id, 'demote'), {});
    expect(back.body.task).toMatchObject({ status: 'backlog', postponed_at: null });
    expect(ids((await backlog(`?project=${X.project}`)).tasks)).toEqual([a.id]);
    expect((await backlog(`?project=${X.project}&list=postponed`)).total).toBe(0);
    // Accept still works from the active list.
    const n = await create(X);
    expect((await api('POST', u(X, n.id, 'accept'), {})).body.task.status).toBe('open');
  });
});

describe('the backlog list: list, project and tag together, before paging and counting', () => {
  it('finds a postponed intake item by project plus tag, restores it and accepts it', async () => {
    const X = await team('PpFind'), Y = await team('PpElse');
    const want = await create(X, { title: 'Write the intake guide', tags: ['docs'] });
    const other = await create(X, { tags: ['ux'] }), elsewhere = await create(Y, { tags: ['docs'] });
    for (const k of [want, other]) await api('POST', u(X, k.id, 'postpone'), {});
    await api('POST', u(Y, elsewhere.id, 'postpone'), {});
    const r = await backlog(`?list=postponed&project=${X.project}&tag=docs`);
    expect(ids(r.tasks)).toEqual([want.id]);
    expect(r).toMatchObject({ list: 'postponed', project: X.project, project_name: expect.any(String), tag: 'docs', total: 1, postponed_total: 1, active_total: 0 });
    // The tag chips count the chosen list within the project (every tag, so another can be picked); the project choices
    // count it within the tag.
    expect(r.tags).toEqual([{ tag: 'docs', n: 1 }, { tag: 'ux', n: 1 }]);
    expect(r.projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: X.project, n: 1 }), expect.objectContaining({ id: Y.project, n: 1 })]));
    await api('POST', u(X, want.id, 'restore'), {});
    expect(ids((await backlog(`?project=${X.project}&tag=docs`)).tasks)).toEqual([want.id]);
    expect((await api('POST', u(X, want.id, 'accept'), {})).body.task.status).toBe('open');
    expect((await backlog(`?project=${X.project}&tag=docs`)).total).toBe(0);
  });

  it('searches the title and the brief (q) with the other filters, before paging and counting; LIKE wildcards are literal', async () => {
    const X = await team('PpSearch');
    const a = await create(X, { title: 'Rotate the relay keys', tags: ['ops'] }), b = await create(X, { title: 'Tidy the docs', description: 'Mention the relay in the intro.' });
    await create(X, { title: 'Unrelated work' }); const pct = await create(X, { title: 'Cut costs by 50% now' });
    const P = `?project=${X.project}`;
    const r = await backlog(`${P}&q=relay`);
    expect(ids(r.tasks).sort()).toEqual([a.id, b.id].sort());
    expect(r).toMatchObject({ q: 'relay', total: 2, active_total: 2 });
    expect(ids((await backlog(`${P}&q=relay&tag=ops`)).tasks)).toEqual([a.id]);
    // % and _ are matched as typed, not as wildcards.
    expect(ids((await backlog(`${P}&q=${encodeURIComponent('50%')}`)).tasks)).toEqual([pct.id]);
    expect(ids((await backlog(`${P}&q=${encodeURIComponent('%')}`)).tasks)).toEqual([pct.id]);
    expect((await backlog(`${P}&q=_`)).total).toBe(0);
    expect((await backlog(P)).q).toBeNull();
    expect((await api('GET', `/tasks/backlog?q=${'x'.repeat(201)}`)).status).toBe(400);
  });

  it('filters by team (Backlog · n on the team page): the same tasks and counts as the team backlog count', async () => {
    const X = await team('PpTeam'), Y = await team('PpTeamElse');
    const a = await create(X), b = await create(X), c = await create(X), y = await create(Y);
    await api('POST', u(X, c.id, 'postpone'), {});
    const r = await backlog(`?team=${X.id}`);
    expect(ids(r.tasks).sort()).toEqual([a.id, b.id].sort());
    expect(r).toMatchObject({ team_name: 'PpTeam', total: 2, active_total: 2, postponed_total: 1 });
    expect(r.active_total).toBe(app.teams.counts(X.id).backlog);
    expect(ids(r.tasks)).not.toContain(y.id);
    expect(ids((await backlog(`?team=${X.id}&list=postponed`)).tasks)).toEqual([c.id]);
    // With a project too, both apply: another team's project matches nothing of this team.
    expect((await backlog(`?team=${X.id}&project=${Y.project}`)).total).toBe(0);
    expect((await backlog(`?team=${Y.id}&project=${Y.project}`)).total).toBe(1);
  });

  it('pages the filtered list oldest first with a cursor, and counts the whole match', async () => {
    const X = await team('PpPage');
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await create(X, { tags: i < 4 ? ['docs'] : [] }));
    const q = `?project=${X.project}&tag=docs&limit=2`;
    const p1 = await backlog(q);
    expect(ids(p1.tasks)).toEqual([made[0]!.id, made[1]!.id]);
    expect(p1.total).toBe(4);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await backlog(`${q}&cursor=${p1.next_cursor}`);
    expect(ids(p2.tasks)).toEqual([made[2]!.id, made[3]!.id]);
    expect(p2.next_cursor).toBeNull();
    // A cursor names its list: another list's, or a made-up one, is refused.
    expect((await api('GET', `/tasks/backlog${q}&list=postponed&cursor=${p1.next_cursor}`)).status).toBe(400);
    expect((await api('GET', `/tasks/backlog${q}&cursor=bm9wZQ`)).status).toBe(400);
    expect((await api('GET', `/tasks/backlog?limit=0`)).status).toBe(400);
  });

  it('relayed open tasks keep their own group under both lists, filtered by project and tag', async () => {
    const X = await team('PpRelay');
    await api('PATCH', `/projects/${X.project}`, { task_intake: 'open' });
    const rl = ok(await X.c.call('task_create', { team_id: X.id, title: 'Asked in chat', tags: ['docs'], operator_request: { source: 'chat' } })).task;
    expect(rl.status).toBe('open');
    for (const l of ['active', 'postponed']) {
      const r = await backlog(`?list=${l}&project=${X.project}`);
      expect(ids(r.relayed)).toEqual([rl.id]);
      expect(r.tasks).toEqual([]);
    }
    expect((await backlog(`?project=${X.project}&tag=ux`)).relayed).toEqual([]);
    expect((await api('POST', u(X, rl.id, 'postpone'), {})).status).toBe(409);
  });
});

/* The console's backlog links from a team's or project's Needs you (docs/dashboard-ux.md, Needs you screen, The backlog):
   the route keeps the scope and from=needs, blQs sends the scope to the hub, and Back returns to that entrance. */
describe('backlog links keep the Needs you scope', () => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const line = (name: string) => { const i = js.indexOf(`\nconst ${name} = `) + 1; return js.slice(i, js.indexOf('\n', i) + 1); };
  const pi = js.indexOf(' backlog: { parent: ') + 1, parent = js.slice(pi, js.indexOf("label: () => 'Backlog' },", pi) + "label: () => 'Backlog' },".length);
  const ctx: Record<string, any> = { URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(`${line('blArgOf')}${line('blArg')}${line('blQs')}const homeUp = () => ['home', ''];\nthis.f = { blArgOf, blArg, blQs }; this.nav = { ${parent} };`, ctx);
  const { blArgOf, blArg, blQs } = ctx.f, up = ctx.nav.backlog.parent;

  it('a team entrance opens that team\'s backlog, and switching to Postponed keeps the scope and the way back', () => {
    const f = blArgOf('team=team_a&from=needs');
    expect(blQs(f)).toBe('?team=team_a');
    expect(blArg({ ...f, l: 'postponed' })).toBe('l=postponed&team=team_a&from=needs');
    expect(blQs(blArgOf('l=postponed&p=prj_b&from=needs'))).toBe('?list=postponed&project=prj_b');
  });

  it('Back returns to the entrance\'s Needs you; opened any other way it stays under Home', () => {
    expect(up('team=team_a&from=needs')).toEqual(['needs', 'team=team_a']);
    expect(up('l=postponed&p=prj_b&from=needs')).toEqual(['needs', 'project=prj_b']);
    expect(up('team=team_a')).toEqual(['home', '']);
    expect(up('')).toEqual(['home', '']);
  });

  it('the Needs you screen links the backlog and its postponed count with the scope', () => {
    const v = js.slice(js.indexOf('VIEWS.needs = async'), js.indexOf('\n};\n', js.indexOf('VIEWS.needs = async')));
    expect(v).toContain("api('/tasks/backlog' + blQs({ l: 'postponed', ...bs }))");
    expect(v).toContain("nyBacklogCard(bl, blTo(''))");
    expect(v).toContain('data-arg="${esc(blTo(\'postponed\'))}"');
    expect(js).toContain("x === 'from=needs'");
  });
});
