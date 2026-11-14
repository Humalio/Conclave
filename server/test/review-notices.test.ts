/**
 * The on-demand review_requested notice (code review of features-round, item 6): an on-demand reviewer does not poll
 * work_next, so every path that hands a waiting submission to a reviewer sends the notice, not only the first submit:
 * a reviewer replaced on member removal, task_update naming another reviewer in review, and an unblock back to in_review.
 * Also: the operator's "review none" switch passes the operator's id to the approval hook, not the literal 'admin'.
 * Since task turns (docs/proposals/console-systems.md §8.2), every such path is one handOff(): the waiting party also
 * holds the task's one open turn, and an on-demand assignee gets a task_assigned notice as a reviewer does (8.A10).
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
let n = 0;
/** A running team: coordinator, worker and two reviewers, on demand unless `poll`. */
async function team(mode: 'on_demand' | 'poll' = 'on_demand') {
  const name = `RN${++n}`;
  const agent = (label: string) => {
    const a = app.keys.createAgent(`${name}-${label}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent('coord'), w = agent('worker'), r = agent('rev'), r2 = agent('rev2');
  const id = app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred },
    { agent_id: r.id, role: 'reviewer', credential_id: r.cred }, { agent_id: r2.id, role: 'reviewer', credential_id: r2.cred }] }, sys).id;
  app.teams.start(id, sys);
  if (mode === 'on_demand') expect((await api('PATCH', `/teams/${id}`, { delivery_mode: 'on_demand' })).body.team.delivery_mode).toBe('on_demand');
  const project = app.blueprint.ensureTeamProject(id).id;
  return { id, project, c: { ...c, call: await session(c.secret) }, w: { ...w, call: await session(w.secret) }, r, r2 };
}
type T = Awaited<ReturnType<typeof team>>;
/** A task submitted by the worker, waiting in review for X.r. */
async function inReview(X: T, args: Record<string, unknown> = {}) {
  const t = ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${++n}`, reviewer: X.r.id, ...args })).task;
  ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
  ok(await X.w.call('task_start', { task_id: t.id }));
  ok(await X.w.call('task_submit', { task_id: t.id, summary: 'done' }));
  expect(app.teams.task(t.id)!).toMatchObject({ status: 'in_review', reviewer_agent_id: X.r.id });
  return t.id as string;
}
const notices = (agentId: string) => app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='review_requested'").all(agentId) as { body: string }[];
const openTurn = (task: string) => app.db.prepare('SELECT phase, holder_agent_id FROM task_turns WHERE task_id=? AND closed_at IS NULL').all(task).map((x) => ({ ...x }));
const items = (agentId: string, task: string) => (app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind='review_requested' AND ref_id=? AND acked_at IS NULL").get(agentId, task) as { n: number }).n;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrn-'));
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

describe('the new reviewer of a waiting submission hears about it', () => {
  it('on member removal, the replacement reviewer gets the notice and the item', async () => {
    const X = await team();
    const id = await inReview(X);
    expect(notices(X.r2.id)).toHaveLength(0);
    app.teams.removeMember(X.id, X.r.id, sys);
    expect(app.teams.task(id)!).toMatchObject({ status: 'in_review', reviewer_agent_id: X.r2.id });
    const nt = notices(X.r2.id);
    expect(nt).toHaveLength(1);
    expect(nt[0]!.body).toContain(id);
    expect(items(X.r2.id, id)).toBe(1);
    expect(openTurn(id)).toEqual([{ phase: 'review', holder_agent_id: X.r2.id }]);
  });
  it('on task_update naming another reviewer while in review', async () => {
    const X = await team();
    const id = await inReview(X);
    const version = app.teams.task(id)!.version;
    ok(await X.c.call('task_update', { task_id: id, version, reviewer: X.r2.id }));
    expect(notices(X.r2.id).map((x) => x.body).join()).toContain(id);
    expect(notices(X.r.id)).toHaveLength(1); // the submit's notice only; the old reviewer gets review_cancelled instead
    expect(items(X.r2.id, id)).toBe(1);
    expect(openTurn(id)).toEqual([{ phase: 'review', holder_agent_id: X.r2.id }]);
  });
  it('on an unblock that returns the task to in_review', async () => {
    const X = await team();
    const id = await inReview(X);
    app.db.prepare("UPDATE tasks SET status='blocked', blocked_from='in_review', blocked_reason='wait' WHERE id=?").run(id);
    app.teams.adminUnblock(X.id, id, null, { kind: 'admin', id: 'usr_op' });
    expect(app.teams.task(id)!.status).toBe('in_review');
    expect(notices(X.r.id)).toHaveLength(2); // submit, then unblock
    expect(openTurn(id)).toEqual([{ phase: 'review', holder_agent_id: X.r.id }]);
  });
  it('a polling team gets the work items only, no notice', async () => {
    const X = await team('poll');
    const id = await inReview(X);
    ok(await X.c.call('task_update', { task_id: id, version: app.teams.task(id)!.version, reviewer: X.r2.id }));
    app.teams.removeMember(X.id, X.r2.id, sys);
    expect(app.teams.task(id)!.reviewer_agent_id).toBe(X.r.id);
    expect(notices(X.r.id)).toHaveLength(0);
    expect(notices(X.r2.id)).toHaveLength(0);
    expect(items(X.r.id, id)).toBe(1);
    expect(openTurn(id)).toEqual([{ phase: 'review', holder_agent_id: X.r.id }]);
  });
});

describe('the assignee hears about an assignment (8.A10)', () => {
  const assigned = (agentId: string) => app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='task_assigned'").all(agentId) as { body: string }[];
  const assignItems = (agentId: string, task: string) => (app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind='task_assigned' AND ref_id=? AND acked_at IS NULL").get(agentId, task) as { n: number }).n;
  it('on demand, task_assign sends one task_assigned notice and one work item, and queues the task', async () => {
    const X = await team();
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${++n}`, reviewer: X.r.id })).task;
    ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
    const nt = assigned(X.w.id);
    expect(nt).toHaveLength(1);
    expect(nt[0]!.body).toContain(t.id);
    expect(assignItems(X.w.id, t.id)).toBe(1);
    expect(openTurn(t.id)).toEqual([{ phase: 'queued', holder_agent_id: X.w.id }]);
  });
  it('polling, task_assign gives the work item only', async () => {
    const X = await team('poll');
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${++n}`, reviewer: X.r.id })).task;
    ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
    expect(assigned(X.w.id)).toHaveLength(0);
    expect(assignItems(X.w.id, t.id)).toBe(1);
    expect(openTurn(t.id)).toEqual([{ phase: 'queued', holder_agent_id: X.w.id }]);
  });
  it('on demand, a settled team_ask that returns the task to assigned sends no second task_assigned notice', async () => {
    const X = await team();
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${++n}`, reviewer: X.r.id })).task;
    ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
    const q = ok(await X.w.call('team_ask', { team_id: X.id, question: 'Which dataset?', task_id: t.id }));
    expect(app.teams.task(t.id)!.status).toBe('blocked');
    expect((await api('POST', `/decisions/${q.decision_id}/answer`, { text: 'Use A.' })).status).toBe(200);
    expect(app.teams.task(t.id)!.status).toBe('assigned');
    // The answer's own 'decision' notice says where the task is; the hand-off adds the turn and the work item only.
    expect(assigned(X.w.id)).toHaveLength(1); // the original assignment's
    const told = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='decision'").all(X.w.id) as { body: string }[];
    expect(told.some((x) => x.body.includes('assigned to you again'))).toBe(true);
    expect(assignItems(X.w.id, t.id)).toBe(1);
    expect(openTurn(t.id)).toEqual([{ phase: 'queued', holder_agent_id: X.w.id }]);
  });
});

describe('the operator switching review to none', () => {
  it('passes the operator id to the approval hook (kg_flags.decided_by), not "admin"', async () => {
    const X = await team('poll');
    expect((await api('PATCH', `/projects/${X.project}`, { review_policy: 'per_task' })).status).toBe(200);
    const id = await inReview(X);
    const seen: string[] = [], orig = app.teams.onTaskApproved;
    app.teams.onTaskApproved = (t, reviewer, who) => { seen.push(reviewer); orig?.(t, reviewer, who); };
    try {
      app.teams.adminSetReview(X.id, id, 'none', 'small change', { kind: 'admin', id: 'usr_operator1' });
    } finally { app.teams.onTaskApproved = orig; }
    expect(seen).toEqual(['usr_operator1']);
    expect(app.teams.task(id)!.status).not.toBe('in_review');
  });
});
