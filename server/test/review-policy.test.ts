/**
 * Review policy (task_kmare7of5enpsp5s): per project (required | per_task | none) and per task (task_create and
 * task_update `review`). A task with review none is approved on submit, audited; self-review stays forbidden.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const code = (r: Res) => (r.isError ? /^(\w+)/.exec(text(r))?.[1] : 'ok');
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}

/** A running team with a coordinator, a worker and a reviewer, in its own project. */
async function team(name: string, o: { checkpoints?: string[] } = {}) {
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent(`${name}-coord`), w = agent(`${name}-worker`), r = agent(`${name}-reviewer`);
  const id = app.teams.create({ name, goal: 'g', checkpoints: o.checkpoints, members: [
    { agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }, { agent_id: r.id, role: 'reviewer', credential_id: r.cred }] }, sys).id;
  app.teams.start(id, sys);
  const project = app.blueprint.ensureTeamProject(id).id;
  return { id, project, c: { ...c, call: await session(c.secret) }, w: { ...w, call: await session(w.secret) }, r: { ...r, call: await session(r.secret) } };
}
type T = Awaited<ReturnType<typeof team>>;
/** Create, assign to the worker and start a task; returns its id. */
async function started(X: T, args: Record<string, unknown> = {}) {
  const t = ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${Math.random().toString(36).slice(2, 7)}`, ...args })).task;
  ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
  ok(await X.w.call('task_start', { task_id: t.id }));
  return t.id as string;
}
const policy = (X: T, p: string) => api('PATCH', `/projects/${X.project}`, { review_policy: p });
const audits = (action: string, id: string) => (app.db.prepare('SELECT details FROM audit_events WHERE action=? AND target_id=?').all(action, id) as { details: string }[]).map((r) => JSON.parse(r.details));
const reviewItems = (task: string) => (app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE kind='review_requested' AND ref_id=?").get(task) as { n: number }).n;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrp-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 40 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('policy required (the default)', () => {
  it('keeps today\'s behaviour and refuses review none', async () => {
    const X = await team('Req');
    expect((await api('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === X.project).review_policy).toBe('required');
    const no = await X.c.call('task_create', { team_id: X.id, title: 'x', review: 'none' });
    expect(code(no)).toBe('invalid_argument');
    expect(text(no)).toMatch(/requires review for every task/);
    const id = await started(X);
    expect(ok(await X.w.call('task_submit', { task_id: id, summary: 'done' })).task).toMatchObject({ status: 'in_review', reviewer: X.r.id, review: 'required' });
    const t = ok(await X.c.call('task_list', { team_id: X.id })).tasks.find((k: { id: string }) => k.id === id);
    expect(code(await X.c.call('task_update', { task_id: id, version: t.version, review: 'none', reason: 'small' }))).toBe('invalid_argument');
  });
});

describe('policy per_task', () => {
  it('a task created with review none is approved and closed on submit, audited, with no reviewer or review request', async () => {
    const X = await team('PerTask');
    expect((await policy(X, 'per_task')).body.project.review_policy).toBe('per_task');
    // The coordinators are told; the change is audited.
    expect((app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='project_changed' ORDER BY seq DESC LIMIT 1").get(X.c.id) as { body: string }).body).toMatch(/review policy is now per_task/);
    expect(audits('blueprint.review_policy', X.project)[0]).toMatchObject({ from: 'required', to: 'per_task' });
    // Default is still required; a reviewer and review none do not go together.
    expect(ok(await X.c.call('task_create', { team_id: X.id, title: 'default' })).task.review).toBe('required');
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'both', review: 'none', reviewer: X.r.id }))).toBe('invalid_argument');
    const id = await started(X, { review: 'none' });
    const s = ok(await X.w.call('task_submit', { task_id: id, summary: 'Merged as abc123' })).task;
    expect(s).toMatchObject({ status: 'done', reviewer: null, review: 'none', summary: 'Merged as abc123' });
    expect(reviewItems(id)).toBe(0);
    const events = (await api('GET', `/teams/${X.id}/tasks/${id}`)).body.events as { tool: string; to_status: string; note: string }[];
    expect(events.map((e) => [e.tool, e.to_status, e.note])).toEqual(expect.arrayContaining([['task_submit', 'in_progress', 'Merged as abc123'], ['no_review', 'approved', 'no review (task)'], ['no_review', 'done', 'closed without review']]));
    expect(audits('task.no_review', id)[0]).toMatchObject({ source: 'task' });
  });

  it('switching a task in review to none closes the review, tells the reviewer, and needs a reason', async () => {
    const X = await team('Switch');
    await policy(X, 'per_task');
    const id = await started(X);
    ok(await X.w.call('task_submit', { task_id: id, summary: 'ready' }));
    let t = ok(await X.c.call('task_list', { team_id: X.id })).tasks.find((k: { id: string }) => k.id === id);
    expect(code(await X.c.call('task_update', { task_id: id, version: t.version, review: 'none' }))).toBe('invalid_argument');
    t = ok(await X.c.call('task_update', { task_id: id, version: t.version, review: 'none', reason: 'Docs-only change, reviewed in the PR' })).task;
    expect(t).toMatchObject({ status: 'done', reviewer: null, review: 'none' });
    expect(audits('task.review_change', id)[0]).toMatchObject({ from: 'required', to: 'none', status: 'in_review', reason: 'Docs-only change, reviewed in the PR' });
    expect((app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='review_cancelled'").get(X.r.id) as { body: string }).body).toMatch(/No verdict is due/);
    // The reviewer's pending item no longer applies: the task left review and has no reviewer, so a verdict is refused.
    expect(code(await X.r.call('task_review', { task_id: id, decision: 'approve', comments: 'late', version: 1000 }))).toBe('denied');
    // A done task cannot change review.
    expect(code(await X.c.call('task_update', { task_id: id, version: t.version, review: 'required', reason: 'x' }))).toBe('invalid_state');
  });

  it('the stuck-task path: a coordinator\'s own task set to none and completed, never self-approved', async () => {
    const X = await team('Stuck');
    await policy(X, 'per_task');
    const t0 = ok(await X.c.call('task_create', { team_id: X.id, title: 'Design note' })).task;
    ok(await X.c.call('task_assign', { task_id: t0.id, agent_id: X.c.id }));
    // Self-review stays forbidden: the assignee cannot be named reviewer, nor review its own submission.
    const cur = ok(await X.c.call('task_list', { team_id: X.id })).tasks.find((k: { id: string }) => k.id === t0.id);
    expect(code(await X.c.call('task_update', { task_id: t0.id, version: cur.version, reviewer: X.c.id }))).toBe('invalid_argument');
    const u = ok(await X.c.call('task_update', { task_id: t0.id, version: cur.version, review: 'none', reason: 'Landed in 3c2afda; nobody else can review a coordinator design note' })).task;
    expect(u.status).toBe('assigned');
    ok(await X.c.call('task_start', { task_id: t0.id }));
    expect(ok(await X.c.call('task_submit', { task_id: t0.id, summary: 'Landed in 3c2afda' })).task).toMatchObject({ status: 'done', review: 'none' });
    expect(code(await X.c.call('task_review', { task_id: t0.id, decision: 'approve', comments: 'mine', version: 1000 }))).toBe('denied');
  });

  it('a project that later requires review overrides a task\'s earlier none', async () => {
    const X = await team('Override');
    await policy(X, 'per_task');
    const id = await started(X, { review: 'none' });
    await policy(X, 'required');
    expect(ok(await X.w.call('task_submit', { task_id: id, summary: 'done' })).task).toMatchObject({ status: 'in_review', review: 'required', reviewer: X.r.id });
  });
});

describe('policy none', () => {
  it('tasks need no review unless created with review required; the done checkpoint still waits for the operator', async () => {
    const X = await team('NoReview', { checkpoints: ['done'] });
    await policy(X, 'none');
    const id = await started(X);
    const s = ok(await X.w.call('task_submit', { task_id: id, summary: 'done' })).task;
    expect(s).toMatchObject({ status: 'approved', awaiting_approval: true, review: 'none', reviewer: null });
    expect(audits('task.no_review', id)[0]).toMatchObject({ source: 'policy' });
    expect((await api('POST', `/teams/${X.id}/tasks/${id}/approve`)).body.task.status).toBe('done');
    const asked = await started(X, { review: 'required' });
    expect(ok(await X.w.call('task_submit', { task_id: asked, summary: 'please look' })).task).toMatchObject({ status: 'in_review', reviewer: X.r.id });
  });

  it('hub-raised tasks (knowledge flags) always need review, whatever the policy', async () => {
    const X = await team('Flags');
    await policy(X, 'none');
    const t = app.teams.hubTask(X.id, { title: 'Stale claim', description: 'd', assignee: X.w.id })!;
    expect(app.teams.taskView(t).review).toBe('required');
  });
});

describe('the operator', () => {
  it('changes a task\'s review through the admin API, with the same rules', async () => {
    const X = await team('Admin');
    const id = await started(X);
    expect((await api('POST', `/teams/${X.id}/tasks/${id}/review`, { review: 'none', reason: 'x' })).body.error).toBe('invalid_argument');
    await policy(X, 'per_task');
    expect((await api('POST', `/teams/${X.id}/tasks/${id}/review`, { review: 'none' })).status).toBe(400);
    const r = await api('POST', `/teams/${X.id}/tasks/${id}/review`, { review: 'none', reason: 'Operator: tracked elsewhere' });
    expect(r.body.task).toMatchObject({ review: 'none', status: 'in_progress' });
    expect(audits('task.review_change', id)[0]).toMatchObject({ to: 'none', reason: 'Operator: tracked elsewhere' });
    expect((await api('PATCH', `/projects/${X.project}`, { review_policy: 'sometimes' })).status).toBe(400);
  });
});

describe('checkpoint wording in Needs you', () => {
  it('says how each task reached approval, from its history, and a later policy change does not reword it', async () => {
    const X = await team('Wording', { checkpoints: ['done'] });
    await policy(X, 'per_task');
    const reason = async (id: string) => ((await api('GET', '/needs-you?limit=200')).body.items as { id: string; reason: string }[]).find((r) => r.id === `task:${id}`)?.reason;
    // Reviewed: the reviewer approves, the task waits for the operator.
    const reviewed = await started(X);
    ok(await X.w.call('task_submit', { task_id: reviewed, summary: 'ready' }));
    ok(await X.r.call('task_review', { task_id: reviewed, decision: 'approve', comments: 'fine', version: 1000 }));
    ok(await X.c.call('task_complete', { task_id: reviewed }));
    // Created with review off.
    const off = await started(X, { review: 'none' });
    ok(await X.w.call('task_submit', { task_id: off, summary: 'done' }));
    // Review switched off after it was submitted.
    const waived = await started(X);
    ok(await X.w.call('task_submit', { task_id: waived, summary: 'ready' }));
    const t = ok(await X.c.call('task_list', { team_id: X.id })).tasks.find((k: { id: string }) => k.id === waived);
    ok(await X.c.call('task_update', { task_id: waived, version: t.version, review: 'none', reason: 'Docs-only change' }));
    expect(await reason(reviewed)).toBe('Approved by Wording-reviewer · waits for your approval');
    expect(await reason(off)).toBe('Submitted without review · waits for your approval');
    expect(await reason(waived)).toBe('Submitted without review · waits for your approval');
    // The project now requires review: the tasks' recorded paths stay as they were.
    await policy(X, 'required');
    expect(await reason(off)).toBe('Submitted without review · waits for your approval');
    expect(await reason(reviewed)).toBe('Approved by Wording-reviewer · waits for your approval');
  });
});
