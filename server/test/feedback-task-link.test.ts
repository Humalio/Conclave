/** Feedback reports linked to the tasks that fix them, and closing by itself (docs/feedback.md#linked-tasks). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { HUB_VERSION } from '../src/version.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '';
let n = 0;
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const code = (r: Res) => (r.isError ? /^(\w+)/.exec(text(r))?.[1] : 'ok');
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
async function agent(label: string) {
  const a = app.keys.createAgent(`${label}-${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as Res).structuredContent.session_token;
  const call: Call = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
  return { id: a.id, cred: k.credential.id, call };
}
type Agent = Awaited<ReturnType<typeof agent>>;

/** A running team (coordinator, worker, reviewer) in its own project. */
async function team(name: string) {
  const c = await agent(`${name}-coord`), w = await agent(`${name}-worker`), r = await agent(`${name}-reviewer`);
  const id = app.teams.create({ name, goal: 'g', members: [
    { agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }, { agent_id: r.id, role: 'reviewer', credential_id: r.cred }] }, sys).id;
  app.teams.start(id, sys);
  const project = app.blueprint.ensureTeamProject(id).id;
  return { id, project, c, w, r };
}
type T = Awaited<ReturnType<typeof team>>;

let filer: Agent, outsider: Agent, A: T, B: T;
const report = async (title: string, status: 'new' | 'accepted' = 'accepted', assignee?: string) => {
  const id = ok(await filer.call('feedback_file', { kind: 'bug', area: 'tasks', title, tried: 'tried it', happened: 'it failed', severity: 'minor' })).report_id as string;
  if (status === 'accepted') expect((await api('POST', `/feedback/${id}/status`, { status: 'accepted', note: 'Seen.' })).status).toBe(200);
  if (assignee) expect((await api('POST', `/feedback/${id}/assign`, { agent_id: assignee })).status).toBe(200);
  return id;
};
const row = (id: string) => app.db.prepare('SELECT status,fixed_in,fixed_after,closed_by_task,closed_from,status_note FROM feedback_reports WHERE id=?').get(id) as any;
const task = async (X: T, args: Record<string, unknown> = {}) => ok(await X.c.call('task_create', { team_id: X.id, title: `Fix ${Math.random().toString(36).slice(2, 7)}`, ...args })).task as { id: string; version: number };
/** Assign, start, submit, approve and complete a task. */
async function finish(X: T, id: string) {
  ok(await X.c.call('task_assign', { task_id: id, agent_id: X.w.id, reviewer: X.r.id }));
  ok(await X.w.call('task_start', { task_id: id }));
  const s = ok(await X.w.call('task_submit', { task_id: id, summary: 'Done.' })).task;
  if (s.status === 'in_review') {
    const v = app.teams.task(id)!.version;
    ok(await X.r.call('task_review', { task_id: id, decision: 'approve', comments: 'Good.', version: v }));
  }
  if (app.teams.task(id)!.status === 'approved') ok(await X.c.call('task_complete', { task_id: id }));
  expect(app.teams.task(id)!.status).toBe('done');
}
const notices = (agentId: string, reportId: string) => app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='feedback_update' AND ref_feedback_id=? ORDER BY seq").all(agentId, reportId) as { body: string }[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahftl-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 60 }, sys).secret;
  app.feedback.setSettings({ limits: { reportsPerHour: 1000, reportsPerDay: 1000, openPerAgent: 1000 } }, sys);
  filer = await agent('filer'); outsider = await agent('outsider');
  A = await team('Alpha'); B = await team('Beta');
});
afterAll(async () => { await app?.close(); });

describe('linking', () => {
  it('a coordinator links a report assigned to its team from task_create; both sides show it; it is recorded and audited', async () => {
    const id = await report('Linked from task_create', 'accepted', A.w.id);
    const t = await task(A, { feedback: [id] });
    const d = (await api('GET', `/feedback/${id}`)).body;
    expect(d.linked_tasks).toEqual([expect.objectContaining({ task_id: t.id, title: app.teams.task(t.id)!.title, status: 'open', team_name: 'Alpha', linked_by_kind: 'agent' })]);
    expect(d.history.some((h: any) => h.field === 'linked_task' && h.new_value === t.id)).toBe(true);
    const aud = app.db.prepare("SELECT actor_id,details FROM audit_events WHERE action='feedback.link' AND target_id=?").all(id) as { actor_id: string; details: string }[];
    expect(aud.map((x) => [x.actor_id, JSON.parse(x.details)])).toEqual([[A.c.id, { task: t.id, action: 'link' }]]);
    // The task shows the report: to the team (task_list in full), and to the operator.
    const full = ok(await A.w.call('task_list', { team_id: A.id, task_id: t.id }));
    expect(full.tasks[0].from_feedback).toEqual([expect.objectContaining({ id, title: 'Linked from task_create', status: 'accepted' })]);
    expect(text(await A.w.call('task_list', { team_id: A.id, task_id: t.id }))).toContain('From feedback');
    expect((await api('GET', `/feedback/by-task/${t.id}`)).body.reports).toEqual([expect.objectContaining({ id, status: 'accepted' })]);
  });

  it('a coordinator whose team is not assigned the report is refused, and no task is created', async () => {
    const id = await report('Assigned to Alpha only', 'accepted', A.w.id);
    const before = (app.db.prepare('SELECT COUNT(*) n FROM tasks WHERE team_id=?').get(B.id) as { n: number }).n;
    expect(code(await B.c.call('task_create', { team_id: B.id, title: 'Steal it', feedback: [id] }))).toBe('denied');
    expect((app.db.prepare('SELECT COUNT(*) n FROM tasks WHERE team_id=?').get(B.id) as { n: number }).n).toBe(before);
    // An unassigned report cannot be linked by a coordinator either; through task_update the task stays as it was.
    const un = await report('Not assigned');
    const t = await task(B);
    expect(code(await B.c.call('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, title: 'Renamed', feedback: { add: [un] } }))).toBe('denied');
    expect(app.teams.task(t.id)!.title).not.toBe('Renamed');
    expect(app.db.prepare('SELECT COUNT(*) n FROM feedback_task_links WHERE report_id IN (?,?)').get(id, un)).toEqual({ n: 0 });
  });

  it('task_update adds and removes; a coordinator removes only its own link, and not once the task is done', async () => {
    const id = await report('Update links', 'accepted', A.c.id);
    const t = await task(A);
    ok(await A.c.call('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, feedback: { add: [id] } }));
    expect(app.feedback.taskState(id).linked).toBe(1);
    ok(await A.c.call('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, feedback: { remove: [id] } }));
    expect(app.feedback.taskState(id).linked).toBe(0);
    // The operator's link: the coordinator cannot remove it.
    expect((await api('POST', `/feedback/${id}/tasks`, { task_id: t.id })).status).toBe(200);
    expect(code(await A.c.call('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, feedback: { remove: [id] } }))).toBe('denied');
    expect((await api('DELETE', `/feedback/${id}/tasks/${t.id}`)).status).toBe(200);
    // Done: the coordinator's own link stays; the operator can still remove it.
    ok(await A.c.call('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, feedback: { add: [id] } }));
    await finish(A, t.id);
    expect(code(await A.c.call('task_update', { task_id: t.id, version: app.teams.task(t.id)!.version, feedback: { remove: [id] } }))).toBe('invalid_state');
    expect((await api('DELETE', `/feedback/${id}/tasks/${t.id}`)).status).toBe(200);
    const h = (await api('GET', `/feedback/${id}`)).body.history.filter((x: any) => x.field === 'linked_task');
    expect(h.length).toBe(6);
  });

  it('a merge moves the links to the surviving report', async () => {
    const dup = await report('Merge me'), target = await report('Keep me');
    const t = await task(A);
    expect((await api('POST', `/feedback/${dup}/tasks`, { task_id: t.id })).status).toBe(200);
    expect((await api('POST', `/feedback/${dup}/merge`, { target_id: target })).status).toBe(200);
    expect(app.feedback.taskState(dup).linked).toBe(0);
    expect((await api('GET', `/feedback/${target}`)).body.linked_tasks.map((l: any) => l.task_id)).toEqual([t.id]);
  });
});

describe('closing by itself', () => {
  it('an accepted report whose only linked task is approved and done becomes fixed after the current version; backers are told', async () => {
    const id = await report('Close me');
    const t = await task(A, {});
    expect((await api('POST', `/feedback/${id}/tasks`, { task_id: t.id })).status).toBe(200);
    await finish(A, t.id);
    expect(row(id)).toMatchObject({ status: 'fixed', fixed_in: null, fixed_after: HUB_VERSION, closed_by_task: 1, closed_from: 'accepted', status_note: 'Linked task done; the fix reaches agents with the next deploy.' });
    const got = notices(filer.id, id);
    expect(got.at(-1)!.body).toMatch(/is now fixed.*fixed after hub version/);
    const l = (await api('GET', '/feedback?bucket=closed')).body.reports.find((r: any) => r.id === id);
    expect(l).toMatchObject({ closed_by_task: true, linked_tasks: { count: 1, done: 1, status: 'done' } });
    const aud = app.db.prepare("SELECT actor_kind,details FROM audit_events WHERE action='feedback.status' AND target_id=? ORDER BY rowid DESC LIMIT 1").get(id) as { actor_kind: string; details: string };
    expect([aud.actor_kind, JSON.parse(aud.details)]).toEqual(['system', { from: 'accepted', to: 'fixed', closed_by_task: true, fixed_after: HUB_VERSION }]);
  });

  it('still_happening on the same version is evidence only; on a later version it reopens', async () => {
    const id = await report('Still happening');
    const t = await task(A);
    await api('POST', `/feedback/${id}/tasks`, { task_id: t.id });
    await finish(A, t.id);
    const r = ok(await filer.call('feedback_add', { report_id: id, kind: 'still_happening', text: 'again' }));
    expect(r.result).toBe('added');
    expect(text(await filer.call('feedback_read', { report_id: id }))).toBeTruthy();
    expect(row(id).status).toBe('fixed');
    // A later hub version: the hub closed it after an older one.
    app.db.prepare("UPDATE feedback_reports SET fixed_after='0.0.1' WHERE id=?").run(id);
    expect(ok(await filer.call('feedback_add', { report_id: id, kind: 'still_happening', text: 'still' })).result).toBe('reopened');
    expect(row(id)).toMatchObject({ status: 'new', closed_by_task: 0, fixed_after: null });
  });

  it('a new report whose linked task is done stays new and shows Task done', async () => {
    const id = await report('Still new', 'new');
    const t = await task(A);
    await api('POST', `/feedback/${id}/tasks`, { task_id: t.id });
    await finish(A, t.id);
    expect(row(id).status).toBe('new');
    expect((await api('GET', '/feedback?bucket=new')).body.reports.find((r: any) => r.id === id)).toMatchObject({ task_done: true, closed_by_task: false });
  });

  it('two linked tasks with one done stays open; cancelling or reopening reverts a hub close; the operator\'s close stays', async () => {
    const id = await report('Two tasks');
    const t1 = await task(A), t2 = await task(A);
    await api('POST', `/feedback/${id}/tasks`, { task_id: t1.id });
    await api('POST', `/feedback/${id}/tasks`, { task_id: t2.id });
    await finish(A, t1.id);
    expect(row(id).status).toBe('accepted');
    await finish(A, t2.id);
    expect(row(id).status).toBe('fixed');
    // Linking a task that is not done undoes the hub's close.
    const t3 = await task(A);
    await api('POST', `/feedback/${id}/tasks`, { task_id: t3.id });
    expect(row(id)).toMatchObject({ status: 'accepted', closed_by_task: 0, status_note: 'A linked task is no longer done.' });
    expect(notices(filer.id, id).at(-1)!.body).toContain('A linked task is no longer done.');
    // Cancelling it counts as not done: still open.
    ok(await A.c.call('task_cancel', { task_id: t3.id, reason: 'Not needed.' }));
    expect(row(id).status).toBe('accepted');
    // The operator closes it; a later change on the tasks never touches it.
    expect((await api('POST', `/feedback/${id}/status`, { status: 'fixed', note: 'Done by hand.', fixed_in: '9.9.9' })).status).toBe(200);
    await api('DELETE', `/feedback/${id}/tasks/${t3.id}`);
    const t4 = await task(A);
    await api('POST', `/feedback/${id}/tasks`, { task_id: t4.id });
    expect(row(id)).toMatchObject({ status: 'fixed', fixed_in: '9.9.9', closed_by_task: 0 });
  });

  it('a cancelled linked task reverts a hub close', async () => {
    const id = await report('Cancel reverts');
    const t1 = await task(A), t2 = await task(A);
    await api('POST', `/feedback/${id}/tasks`, { task_id: t1.id });
    await finish(A, t1.id);
    expect(row(id).status).toBe('fixed');
    // A second task linked while it waits in the backlog does not count; accepted into work, it does.
    app.db.prepare("UPDATE tasks SET status='backlog' WHERE id=?").run(t2.id);
    await api('POST', `/feedback/${id}/tasks`, { task_id: t2.id });
    expect(row(id).status).toBe('fixed');
    app.db.prepare("UPDATE tasks SET status='open' WHERE id=?").run(t2.id);
    ok(await A.c.call('task_cancel', { task_id: t2.id, reason: 'Wrong task.' }));
    expect(row(id)).toMatchObject({ status: 'accepted', closed_by_task: 0 });
  });

  it('a task done without review leaves the close to the operator', async () => {
    expect((await api('PATCH', `/projects/${B.project}`, { review_policy: 'per_task' })).status).toBe(200);
    const id = await report('No review');
    const t = await task(B, { review: 'none' });
    await api('POST', `/feedback/${id}/tasks`, { task_id: t.id });
    await finish(B, t.id);
    expect(row(id).status).toBe('accepted');
    expect((await api('GET', '/feedback?bucket=open')).body.reports.find((r: any) => r.id === id)).toMatchObject({ task_done: true });
  });
});

describe('who sees what', () => {
  it('an agent who cannot read the task sees only that a task is linked; the team sees title and status', async () => {
    const id = await report('Visibility', 'accepted', A.w.id);
    const t = await task(A, { feedback: [id] });
    const out = ok(await outsider.call('feedback_find', { query: 'Visibility' }));
    const s = out.reports.find((r: any) => r.id === id);
    expect(s.linked_tasks).toEqual({ count: 1, tasks: [] });
    const outText = text(await outsider.call('feedback_read', { report_id: id }));
    expect(outText).toContain('A task is linked');
    expect(outText).not.toContain(app.teams.task(t.id)!.title);
    const mine = ok(await A.w.call('feedback_read', { report_id: id }));
    expect(mine.report.linked_tasks.tasks).toEqual([expect.objectContaining({ id: t.id, status: 'open' })]);
  });

  it('a hidden report never shows on the task', async () => {
    const id = await report('Hidden one', 'accepted', A.w.id);
    const t = await task(A, { feedback: [id] });
    expect((await api('PATCH', `/feedback/${id}`, { hidden: true })).status).toBe(200);
    expect(ok(await A.r.call('task_list', { team_id: A.id, task_id: t.id })).tasks[0].from_feedback).toBeUndefined();
  });

  it('the Not linked filter shows only reports without a task', async () => {
    const all = (await api('GET', '/feedback?limit=500')).body.reports as any[];
    const not = (await api('GET', '/feedback?linked=not_linked&limit=500')).body.reports as any[];
    const linked = (await api('GET', '/feedback?linked=linked&limit=500')).body.reports as any[];
    expect(not.length).toBeGreaterThan(0);
    expect(not.every((r) => r.linked_tasks === null)).toBe(true);
    expect(linked.every((r) => r.linked_tasks !== null)).toBe(true);
    expect(not.length + linked.length).toBe(all.length);
  });
});
