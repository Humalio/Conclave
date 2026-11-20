/**
 * A worker takes back a task that lapsed from it (docs/mcp.md task_claim). Since one delivery model (migration 0153) no task
 * lapses: a silent member keeps its work. A task that lapsed before the upgrade still records who it lapsed from; that
 * worker may claim it back within 24 hours, in the status it held, unless the coordinator assigned it meanwhile, the
 * worker left the team or the window passed. The tests seed such a lapse as the previous release's sweep left it.
 * Also: a resubmission while in review returns the hand-off with the reviewer's wake line, as the first submission does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '', pcId = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
async function loginWith(key: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const mk = (label: string) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  return { id: agent.id, secret: k.secret, cred: k.credential, login: () => loginWith(appKey, k.secret) };
};
let n = 0;
const cid = () => `c${++n}`;
/** As if the member had made no call for `ms`: its activity and declared busy-until time move back by `ms`. */
const silence = (teamId: string, agentId: string, ms: number) => {
  const at = Date.now() - ms;
  app.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(at, agentId);
  app.db.prepare('UPDATE team_members SET joined_at=MIN(joined_at, ?), last_work_next_at=MIN(COALESCE(last_work_next_at, ?), ?), busy_until=busy_until-? WHERE team_id=? AND agent_id=? AND removed_at IS NULL')
    .run(at, at, at, ms, teamId, agentId);
};

/** coordinator + 2 workers + reviewer + stakeholder; created, started and logged in. */
async function team(extra: Record<string, unknown> = {}, start = true) {
  const [c, w1, w2, r, s] = ['coord', 'w1', 'w2', 'rev', 'stake'].map(mk) as ReturnType<typeof mk>[];
  const res = await api('POST', '/teams', {
    name: `t${++n}`, goal: 'ship it', grant_messaging: true, ...extra,
    members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w1!.id, role: 'worker' }, { agent_id: w2!.id, role: 'worker' }, { agent_id: r!.id, role: 'reviewer' }, { agent_id: s!.id, role: 'stakeholder' }],
  });
  expect(res.status).toBe(201);
  const tid = res.body.team.id as string;
  if (start) expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  const [C, W1, W2, R, S] = await Promise.all([c!, w1!, w2!, r!, s!].map((x) => x.login()));
  return { tid, c: c!, w1: w1!, w2: w2!, r: r!, s: s!, C: C!, W1: W1!, W2: W2!, R: R!, S: S!, room: res.body.team.room_id as string };
}
type T = Awaited<ReturnType<typeof team>>;
/** Ack everything pending so later assertions see a clean queue. */
async function drain(call: Call) {
  for (let i = 0; i < 30; i++) {
    const r = (await call('work_next', { wait_seconds: 0 })).structuredContent;
    if (r.status !== 'item') return;
    await call('work_ack', { item_id: r.item.item_id });
  }
}
const mkTask = async (X: T, over: Record<string, unknown> = {}) =>
  (await X.C('task_create', { team_id: X.tid, title: 'do it', reviewer: X.r.id, ...over })).structuredContent.task;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahreclaim-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined });
  app = await buildApp(config);
  intakeOpen(app);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pcId = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  const ak = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 500 }, sys);
  appKey = ak.secret;
});
afterAll(async () => { await app.close(); });

/**
 * W1 holds the task in `status` and goes silent past the old lease: the task stays with W1 (one delivery model). Then the
 * lapse the previous release's sweep would have made is seeded: open, no assignee, lapsed_from W1, its turn closed.
 */
async function lapsed(X: T, status: 'assigned' | 'in_progress' | 'changes_requested', claimable = false) {
  const t = await mkTask(X, { claimable });
  await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
  if (status !== 'assigned') await X.W1('task_start', { task_id: t.id });
  if (status === 'changes_requested') {
    await X.W1('task_submit', { task_id: t.id, summary: 'first try' });
    expect((await X.R('task_review', { task_id: t.id, decision: 'request_changes', comments: 'fix the edge case', version: 1000 })).structuredContent.task.status).toBe('changes_requested');
  }
  silence(X.tid, X.w1.id, 31 * 60_000);
  app.teams.tick();
  expect(app.teams.task(t.id)).toMatchObject({ status, assignee_agent_id: X.w1.id, lapsed_from: null });
  const now = Date.now();
  app.db.prepare("UPDATE tasks SET status='open', assignee_agent_id=NULL, lease_expires_at=NULL, progress_until=NULL, overdue_at=NULL, lapsed_from=?, lapsed_at=?, lapsed_status=?, version=version+1, updated_at=? WHERE id=?")
    .run(X.w1.id, now, status, now, t.id);
  app.db.prepare("UPDATE task_turns SET closed_at=?, close_reason='released' WHERE task_id=? AND closed_at IS NULL").run(now, t.id);
  const k = app.teams.task(t.id)!;
  expect(k).toMatchObject({ status: 'open', assignee_agent_id: null, lapsed_from: X.w1.id, lapsed_status: status });
  return k;
}
const claim = (c: Call, k: { id: string; version: number }) => c('task_claim', { task_id: k.id, version: k.version });

describe('taking back a task that lapsed', () => {
  it('the worker it lapsed from holds it again in the status it lapsed from', async () => {
    const X = await team();
    const k = await lapsed(X, 'in_progress');
    // No task lapses any more, so no lease_expired notice is sent.
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE kind='lease_expired'").get()).toEqual({ n: 0 });
    // An hour later, still open: W1 claims it back, started, with a fresh clock.
    app.db.prepare('UPDATE tasks SET lapsed_at=lapsed_at-3600000 WHERE id=?').run(k.id);
    const r = await claim(X.W1, k);
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    const back = app.teams.task(k.id)!;
    expect(back).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w1.id, lapsed_from: null, lapsed_at: null, lapsed_status: null });
    expect(back.lease_expires_at!).toBeGreaterThan(Date.now());
    // A task held queued comes back queued.
    const q = await lapsed(X, 'assigned');
    expect((await claim(X.W1, q)).structuredContent.task).toMatchObject({ status: 'assigned', assignee: X.w1.id });
  });

  it('a changes_requested task comes back as changes requested, with the reviewer\'s comments', async () => {
    const X = await team();
    const k = await lapsed(X, 'changes_requested');
    const r = await claim(X.W1, k);
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    expect(app.teams.task(k.id)).toMatchObject({ status: 'changes_requested', assignee_agent_id: X.w1.id, review_comments: 'fix the edge case', reviewer_agent_id: X.r.id });
    // And it goes on as usual: start and resubmit.
    expect((await X.W1('task_start', { task_id: k.id })).structuredContent.task.status).toBe('in_progress');
  });

  it('refuses another worker, a reassignment in the meantime, a worker who left, and a lapse older than 24 hours', async () => {
    const X = await team();
    // Another worker: the task is not claimable, so it needs an assignment.
    const a = await lapsed(X, 'in_progress');
    const other = await claim(X.W2, a);
    expect(other.structuredContent.error).toBe('invalid_state');
    expect(app.teams.task(a.id)).toMatchObject({ status: 'open', assignee_agent_id: null, lapsed_from: X.w1.id });
    // The coordinator reassigned it to W2: that wins, and the way back is gone.
    await X.C('task_assign', { task_id: a.id, agent_id: X.w2.id });
    expect(app.teams.task(a.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w2.id, lapsed_from: null });
    expect((await claim(X.W1, app.teams.task(a.id)!)).isError).toBe(true);
    expect(app.teams.task(a.id)!.assignee_agent_id).toBe(X.w2.id);
    // 25 hours since the lapse.
    const b = await lapsed(X, 'assigned');
    app.db.prepare('UPDATE tasks SET lapsed_at=lapsed_at-? WHERE id=?').run(25 * 3600_000, b.id);
    const late = await claim(X.W1, b);
    expect(late.structuredContent.error).toBe('invalid_state');
    expect(late.structuredContent.message).toContain('24-hour');
    // W1 removed from the team.
    const c = await lapsed(X, 'assigned');
    expect((await api('DELETE', `/teams/${X.tid}/members/${X.w1.id}`)).status).toBe(200);
    expect((await claim(X.W1, c)).isError).toBe(true);
    expect(app.teams.task(c.id)).toMatchObject({ status: 'open', assignee_agent_id: null });
  });

  it('a claimable task stays claimable for the worker it lapsed from after the window, the normal way', async () => {
    const X = await team();
    const k = await lapsed(X, 'in_progress', true);
    app.db.prepare('UPDATE tasks SET lapsed_at=lapsed_at-? WHERE id=?').run(25 * 3600_000, k.id);
    const r = await claim(X.W1, app.teams.task(k.id)!);
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    // A normal claim: queued, not the status it lapsed from.
    expect(app.teams.task(k.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w1.id, lapsed_from: null });
    // Within the window, a reclaim in progress records the same two events as a claim with start.
    const b = await lapsed(X, 'in_progress');
    expect((await claim(X.W1, b)).isError).toBeFalsy();
    const ev = app.db.prepare("SELECT from_status f, to_status t, tool FROM task_events WHERE task_id=? AND created_at>=? ORDER BY id").all(b.id, b.updated_at) as { f: string; t: string; tool: string }[];
    expect(ev.slice(-2)).toEqual([{ f: 'open', t: 'assigned', tool: 'task_claim' }, { f: 'assigned', t: 'in_progress', tool: 'task_start' }]);
  });

  it('a cancellation or a block clears the way back', async () => {
    const X = await team();
    const a = await lapsed(X, 'assigned');
    await X.C('task_cancel', { task_id: a.id, reason: 'not needed' });
    expect(app.teams.task(a.id)).toMatchObject({ status: 'cancelled', lapsed_from: null, lapsed_at: null });
    const b = await lapsed(X, 'assigned');
    const bl = await X.C('task_block', { task_id: b.id, reason: 'waits on a decision' });
    expect(bl.isError, JSON.stringify(bl.structuredContent)).toBeFalsy();
    expect(app.teams.task(b.id)).toMatchObject({ status: 'blocked', lapsed_from: null });
  });
});

describe('a resubmission while in review', () => {
  it('returns the hand-off with the reviewer\'s wake line, as the first submission does', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const first = (await X.W1('task_submit', { task_id: t.id, summary: 'v1' })).structuredContent;
    expect(first.handoff).toMatchObject({ to: X.r.id, phase: 'review', on_demand: true, seen: false });
    expect(first.handoff.wake_text).toBeTruthy();
    const again = await X.W1('task_submit', { task_id: t.id, summary: 'v2' });
    expect(again.isError, JSON.stringify(again.structuredContent)).toBeFalsy();
    expect(again.structuredContent.handoff).toMatchObject({ to: X.r.id, phase: 'review', on_demand: true, seen: false });
    expect(again.structuredContent.handoff.wake_text).toBe(first.handoff.wake_text);
    expect(again.content[0]!.text).toContain(first.handoff.wake_text);
  });
});
