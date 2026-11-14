/**
 * Task turns (docs/proposals/console-systems.md §8.2, TASKFLOW-2): every point where a task waits on one party opens one
 * task_turns row through handOff() (src/teams/turns.ts), the previous turn closes with its reason, a task never has
 * two open turns, and only the holder's full read of the task or a successful action on its turn marks the turn seen
 * (docs/specification.md, Task turns). One test per transition: assign, claim,
 * start, submit, request_changes, reviewer change (8.A11), member removal, block and unblock, withdraw, cancel; plus
 * approve, the on-demand task_assigned notice and the hand-off returned to the actor.
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
import type { TurnRow } from '../src/teams/teams.js';
import { phaseOf, wakeLine } from '../src/teams/turns.js';

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
/** A running team: coordinator, two workers and two reviewers, all logged in; polling unless `on_demand`. */
async function team(mode: 'on_demand' | 'poll' = 'poll') {
  const name = `TT${++n}`;
  const agent = async (label: string) => {
    const a = app.keys.createAgent(`${name}-${label}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const [c, w, w2, r, r2] = await Promise.all(['coord', 'worker', 'worker2', 'rev', 'rev2'].map(agent));
  const id = app.teams.create({ name, goal: 'g', members: [{ agent_id: c!.id, role: 'coordinator', credential_id: c!.cred }, { agent_id: w!.id, role: 'worker', credential_id: w!.cred },
    { agent_id: w2!.id, role: 'worker', credential_id: w2!.cred }, { agent_id: r!.id, role: 'reviewer', credential_id: r!.cred }, { agent_id: r2!.id, role: 'reviewer', credential_id: r2!.cred }] }, sys).id;
  app.teams.start(id, sys);
  if (mode === 'on_demand') expect((await api('PATCH', `/teams/${id}`, { delivery_mode: 'on_demand' })).body.team.delivery_mode).toBe('on_demand');
  const s = async (x: typeof c) => ({ ...x!, call: await session(x!.secret) });
  return { id, c: await s(c), w: await s(w), w2: await s(w2), r: await s(r), r2: await s(r2) };
}
type T = Awaited<ReturnType<typeof team>>;
const turns = (task: string) => app.db.prepare('SELECT * FROM task_turns WHERE task_id=? ORDER BY opened_at, rowid').all(task) as unknown as TurnRow[];
const open = (task: string) => turns(task).filter((x) => x.closed_at === null);
/** The one open turn; fails when there are none or two. */
const only = (task: string) => { const o = open(task); expect(o).toHaveLength(1); return o[0]!; };
const notices = (agent: string, kind: string) => app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND kind=?').all(agent, kind) as { body: string }[];
const items = (agent: string, kind: string, task: string) => (app.db.prepare('SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind=? AND ref_id=? AND acked_at IS NULL').get(agent, kind, task) as { n: number }).n;
const create = async (X: T, args: Record<string, unknown> = {}) => ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${++n}`, reviewer: X.r.id, ...args })).task.id as string;
const assigned = async (X: T) => { const id = await create(X); ok(await X.c.call('task_assign', { task_id: id, agent_id: X.w.id })); return id; };
const started = async (X: T) => { const id = await assigned(X); ok(await X.w.call('task_start', { task_id: id })); return id; };
const inReview = async (X: T) => { const id = await started(X); ok(await X.w.call('task_submit', { task_id: id, summary: 'done' })); return id; };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahtrn-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 200 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('a turn per transition', () => {
  it('assign opens a queued turn for the assignee: no deadline, not seen, opened by the coordinator', async () => {
    const X = await team();
    const id = await assigned(X);
    expect(only(id)).toMatchObject({ phase: 'queued', holder_agent_id: X.w.id, team_id: X.id, opened_by_kind: 'agent', opened_by_id: X.c.id, seen_at: null, due_at: null });
    expect(items(X.w.id, 'task_assigned', id)).toBe(1);
  });
  it('the holder\'s full read of the task marks the turn seen; a list fetch, another call or anyone else\'s read does not', async () => {
    const X = await team();
    const id = await assigned(X);
    ok(await X.w.call('task_list', {}));
    ok(await X.w.call('task_list', { detail: 'full' }));
    ok(await X.w.call('session_whoami', {}));
    ok(await X.r.call('task_list', { task_id: id }));
    expect(only(id).seen_at).toBeNull();
    const before = Date.now();
    ok(await X.w.call('task_list', { task_id: id }));
    expect(only(id).seen_at).toBeGreaterThanOrEqual(before);
    const at = only(id).seen_at;
    await new Promise((r) => setTimeout(r, 5));
    ok(await X.w.call('task_list', { task_id: id }));
    expect(only(id).seen_at).toBe(at); // the first read counts
  });
  it('a work_next item that delivers the task is a full read of it', async () => {
    const X = await team();
    const id = await assigned(X);
    expect(only(id).seen_at).toBeNull();
    const r = ok(await X.w.call('work_next', { wait_seconds: 0 }));
    expect(JSON.stringify(r)).toContain(id);
    expect(only(id).seen_at).not.toBeNull();
  });
  it('a failed attempt leaves the turn unseen; a successful action stamps it before it closes', async () => {
    const X = await team();
    const id = await inReview(X);
    // The reviewer's refused calls on this task: a start it may not do, a review with no comments.
    expect((await X.r.call('task_start', { task_id: id })).isError).toBe(true);
    expect((await X.r.call('task_review', { task_id: id, decision: 'request_changes', comments: '', version: app.teams.task(id)!.version })).isError).toBe(true);
    expect(only(id).seen_at).toBeNull();
    const rv = only(id);
    ok(await X.r.call('task_review', { task_id: id, decision: 'approve', comments: 'ok', version: app.teams.task(id)!.version }));
    const closed = turns(id).find((x) => x.id === rv.id)!;
    expect(closed).toMatchObject({ close_reason: 'acted' });
    expect(closed.seen_at).not.toBeNull();
    expect(closed.seen_at).toBeLessThanOrEqual(closed.closed_at!);
    // Seen is not started nor reviewed: the task's own started_at and events are untouched by the read.
    const Y = await team();
    const q = await assigned(Y);
    ok(await Y.w.call('task_list', { task_id: q }));
    expect(app.teams.task(q)!.status).toBe('assigned');
    expect(app.teams.task(q)!.started_at ?? null).toBeNull();
  });
  it('start closes an unseen queued turn as seen', async () => {
    const X = await team();
    const id = await assigned(X);
    ok(await X.w.call('task_start', { task_id: id }));
    expect(turns(id)[0]!.seen_at).not.toBeNull();
  });
  it('claim opens a queued turn the claimer has seen; claim with start opens the work turn', async () => {
    const X = await team();
    const a = await create(X, { claimable: true });
    ok(await X.w.call('task_claim', { task_id: a, version: app.teams.task(a)!.version }));
    const q = only(a);
    expect(q).toMatchObject({ phase: 'queued', holder_agent_id: X.w.id, due_at: null });
    expect(q.seen_at).toBe(q.opened_at);
    const b = await create(X, { claimable: true });
    ok(await X.w2.call('task_claim', { task_id: b, version: app.teams.task(b)!.version, start: true }));
    const wk = only(b);
    expect(wk).toMatchObject({ phase: 'work', holder_agent_id: X.w2.id, due_at: app.teams.task(b)!.lease_expires_at });
    expect(wk.seen_at).toBe(wk.opened_at);
  });
  it('start closes the queued turn (acted) and opens a seen work turn due at the task\'s deadline', async () => {
    const X = await team();
    const id = await started(X);
    const [q, wk] = turns(id);
    expect(q).toMatchObject({ phase: 'queued', close_reason: 'acted' });
    expect(wk).toMatchObject({ phase: 'work', holder_agent_id: X.w.id, closed_at: null, due_at: app.teams.task(id)!.lease_expires_at });
    expect(wk!.seen_at).toBe(wk!.opened_at);
  });
  it('task_progress until moves the work turn\'s deadline with the task\'s', async () => {
    const X = await team('on_demand');
    const id = await started(X);
    const until = Date.now() + 3 * 3600_000;
    ok(await X.w.call('task_progress', { task_id: id, note: 'long run', until }));
    expect(only(id).due_at).toBe(until);
  });
  it('submit closes the work turn and opens an unseen review turn due lease_minutes after it opened', async () => {
    const X = await team();
    const id = await inReview(X);
    const all = turns(id), rv = only(id);
    expect(all.map((x) => [x.phase, x.close_reason])).toEqual([['queued', 'acted'], ['work', 'acted'], ['review', null]]);
    expect(rv).toMatchObject({ holder_agent_id: X.r.id, opened_by_id: X.w.id, seen_at: null });
    expect(rv.due_at).toBe(rv.opened_at + app.teams.team(X.id)!.lease_minutes * 60_000);
    ok(await X.r.call('task_list', {}));
    expect(only(id).seen_at).toBeNull();
    ok(await X.r.call('task_list', { task_id: id }));
    expect(only(id).seen_at).not.toBeNull();
  });
  it('request_changes closes the review turn and queues the task for the assignee again', async () => {
    const X = await team('on_demand');
    const id = await inReview(X);
    ok(await X.r.call('task_review', { task_id: id, decision: 'request_changes', comments: 'fix it', version: app.teams.task(id)!.version }));
    expect(turns(id).at(-2)).toMatchObject({ phase: 'review', close_reason: 'acted' });
    expect(only(id)).toMatchObject({ phase: 'queued', holder_agent_id: X.w.id, seen_at: null, due_at: null });
    expect(items(X.w.id, 'changes_requested', id)).toBe(1);
    expect(notices(X.w.id, 'changes_requested').map((x) => x.body).join()).toContain(id);
  });
  it('approve closes the review turn and leaves no open turn', async () => {
    const X = await team();
    const id = await inReview(X);
    ok(await X.r.call('task_review', { task_id: id, decision: 'approve', comments: 'good', version: app.teams.task(id)!.version }));
    expect(open(id)).toHaveLength(0);
    expect(turns(id).at(-1)).toMatchObject({ phase: 'review', close_reason: 'acted' });
  });
  it('8.A11: a reviewer change in review closes the old turn (reassigned) and opens one for the new reviewer', async () => {
    const X = await team();
    const id = await inReview(X);
    ok(await X.c.call('task_update', { task_id: id, version: app.teams.task(id)!.version, reviewer: X.r2.id }));
    const all = turns(id);
    expect(all.at(-2)).toMatchObject({ phase: 'review', holder_agent_id: X.r.id, close_reason: 'reassigned' });
    expect(only(id)).toMatchObject({ phase: 'review', holder_agent_id: X.r2.id, opened_by_id: X.c.id, seen_at: null });
  });
  it('member removal releases the assignee\'s turn and hands a waiting review to the remaining reviewer', async () => {
    const X = await team();
    const a = await started(X);
    app.teams.removeMember(X.id, X.w.id, sys);
    expect(open(a)).toHaveLength(0);
    expect(turns(a).at(-1)).toMatchObject({ phase: 'work', close_reason: 'released' });
    const Y = await team();
    const b = await inReview(Y);
    app.teams.removeMember(Y.id, Y.r.id, sys);
    expect(turns(b).at(-2)).toMatchObject({ holder_agent_id: Y.r.id, close_reason: 'reassigned' });
    expect(only(b)).toMatchObject({ phase: 'review', holder_agent_id: Y.r2.id, opened_by_kind: 'system', seen_at: null });
    app.teams.removeMember(Y.id, Y.r2.id, sys);
    expect(app.teams.task(b)!.status).toBe('open');
    expect(open(b)).toHaveLength(0);
    expect(turns(b).at(-1)).toMatchObject({ close_reason: 'released' });
  });
  it('member removal hands a waiting review to a coordinator when coordinators review: one turn, and an on-demand coordinator is told', async () => {
    const X = await team('on_demand');
    expect((await api('PATCH', `/teams/${X.id}`, { coordinator_reviews: true })).status).toBe(200);
    app.teams.removeMember(X.id, X.r2.id, sys);
    const id = await inReview(X);
    const v = app.teams.task(id)!.submitted_version;
    app.teams.removeMember(X.id, X.r.id, sys);
    expect(app.teams.task(id)).toMatchObject({ status: 'in_review', assignee_agent_id: X.w.id, reviewer_agent_id: X.c.id, submitted_version: v });
    expect(turns(id).at(-2)).toMatchObject({ phase: 'review', holder_agent_id: X.r.id, close_reason: 'reassigned' });
    expect(only(id)).toMatchObject({ phase: 'review', holder_agent_id: X.c.id, opened_by_kind: 'system', seen_at: null });
    expect(notices(X.c.id, 'review_requested').map((x) => x.body).join()).toContain(id);
  });
  it('block closes the turn; unblock opens the turn of the status it returns to', async () => {
    const X = await team();
    const a = await started(X);
    ok(await X.c.call('task_block', { task_id: a, reason: 'wait' }));
    expect(open(a)).toHaveLength(0);
    expect(turns(a).at(-1)).toMatchObject({ phase: 'work', close_reason: 'blocked' });
    ok(await X.c.call('task_unblock', { task_id: a }));
    expect(only(a)).toMatchObject({ phase: 'work', holder_agent_id: X.w.id, opened_by_id: X.c.id, seen_at: null });
    const b = await inReview(X);
    ok(await X.c.call('task_block', { task_id: b, reason: 'wait' }));
    ok(await X.c.call('task_unblock', { task_id: b }));
    expect(only(b)).toMatchObject({ phase: 'review', holder_agent_id: X.r.id });
    const c = await assigned(X);
    ok(await X.c.call('task_block', { task_id: c, reason: 'wait' }));
    app.teams.adminUnblock(X.id, c, null, { kind: 'admin', id: 'usr_op' });
    expect(only(c)).toMatchObject({ phase: 'queued', holder_agent_id: X.w.id, opened_by_kind: 'admin', due_at: null });
  });
  it('withdraw closes the review turn (withdrawn) and reopens the assignee\'s work turn, seen', async () => {
    const X = await team();
    const id = await inReview(X);
    ok(await X.w.call('task_withdraw', { task_id: id }));
    expect(turns(id).at(-2)).toMatchObject({ phase: 'review', close_reason: 'withdrawn' });
    const wk = only(id);
    expect(wk).toMatchObject({ phase: 'work', holder_agent_id: X.w.id });
    expect(wk.seen_at).toBe(wk.opened_at);
  });
  it('cancel closes the turn (cancelled)', async () => {
    const X = await team();
    const id = await assigned(X);
    ok(await X.c.call('task_cancel', { task_id: id, reason: 'not needed' }));
    expect(open(id)).toHaveLength(0);
    expect(turns(id).at(-1)).toMatchObject({ phase: 'queued', close_reason: 'cancelled' });
  });
  it('a task never has two open turns, through a whole review round trip', async () => {
    const X = await team('on_demand');
    const id = await inReview(X);
    ok(await X.r.call('task_review', { task_id: id, decision: 'request_changes', comments: 'again', version: app.teams.task(id)!.version }));
    ok(await X.w.call('task_start', { task_id: id }));
    ok(await X.w.call('task_submit', { task_id: id, summary: 'v2' }));
    ok(await X.c.call('task_update', { task_id: id, version: app.teams.task(id)!.version, reviewer: X.r2.id }));
    ok(await X.r2.call('task_review', { task_id: id, decision: 'approve', comments: 'ok', version: app.teams.task(id)!.version }));
    const all = turns(id);
    expect(all.map((x) => x.phase)).toEqual(['queued', 'work', 'review', 'queued', 'work', 'review', 'review']);
    expect(all.every((x) => x.closed_at !== null)).toBe(true);
    expect((app.db.prepare('SELECT COUNT(*) n FROM (SELECT task_id FROM task_turns WHERE closed_at IS NULL GROUP BY task_id HAVING COUNT(*) > 1)').get() as { n: number }).n).toBe(0);
  });
  it('a stopped team leaves no open turn', async () => {
    const X = await team();
    const id = await inReview(X);
    app.teams.stop(X.id, sys);
    expect(open(id)).toHaveLength(0);
    expect(turns(id).at(-1)!.close_reason).toBe('cancelled');
  });
});

describe('the hand-off', () => {
  it('on demand, assignment sends the assignee a task_assigned notice and a work item (8.A10)', async () => {
    const X = await team('on_demand');
    const id = await assigned(X);
    const nt = notices(X.w.id, 'task_assigned');
    expect(nt).toHaveLength(1);
    expect(nt[0]!.body).toContain(id);
    expect(items(X.w.id, 'task_assigned', id)).toBe(1);
    expect(only(id).phase).toBe('queued');
  });
  it('polling, assignment gives the work item only', async () => {
    const X = await team();
    const id = await assigned(X);
    expect(notices(X.w.id, 'task_assigned')).toHaveLength(0);
    expect(items(X.w.id, 'task_assigned', id)).toBe(1);
  });
  it('a coordinator assigning a task to itself sees the turn at once and still gets the work item', async () => {
    const X = await team();
    const id = await create(X);
    ok(await X.c.call('task_assign', { task_id: id, agent_id: X.c.id }));
    const q = only(id);
    expect(q).toMatchObject({ phase: 'queued', holder_agent_id: X.c.id, opened_by_id: X.c.id });
    expect(q.seen_at).toBe(q.opened_at);
    expect(items(X.c.id, 'task_assigned', id)).toBe(1);
    expect(notices(X.c.id, 'task_assigned')).toHaveLength(0);
  });
  it('the holder\'s own claim writes no work item', async () => {
    const X = await team();
    const id = await create(X, { claimable: true });
    ok(await X.w.call('task_claim', { task_id: id, version: app.teams.task(id)!.version }));
    expect(only(id)).toMatchObject({ phase: 'queued', holder_agent_id: X.w.id });
    expect(items(X.w.id, 'task_assigned', id)).toBe(0);
  });
  it('a replaced submission re-opens the review turn: unseen again, due from the replacement', async () => {
    const X = await team();
    const id = await inReview(X);
    ok(await X.r.call('task_list', { task_id: id }));
    const first = only(id);
    expect(first.seen_at).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    ok(await X.w.call('task_submit', { task_id: id, summary: 'done, v2' }));
    expect(turns(id).find((x) => x.id === first.id)).toMatchObject({ close_reason: 'acted' });
    const rv = only(id);
    expect(rv).toMatchObject({ phase: 'review', holder_agent_id: X.r.id, opened_by_id: X.w.id, seen_at: null });
    expect(rv.opened_at).toBeGreaterThan(first.opened_at);
    expect(rv.due_at).toBe(rv.opened_at + app.teams.team(X.id)!.lease_minutes * 60_000);
  });
  it('the round-limit block closes the review turn with the task', async () => {
    const X = await team();
    const id = await inReview(X);
    app.db.prepare('UPDATE tasks SET review_rounds=? WHERE id=?').run(app.teams.team(X.id)!.max_review_rounds - 1, id);
    ok(await X.r.call('task_review', { task_id: id, decision: 'request_changes', comments: 'again', version: app.teams.task(id)!.version }));
    expect(app.teams.task(id)!.status).toBe('blocked');
    expect(open(id)).toHaveLength(0);
    expect(turns(id).at(-1)).toMatchObject({ phase: 'review', close_reason: 'blocked' });
  });
  it('handOff returns the wake text for an on-demand holder and none for a poll holder', async () => {
    for (const mode of ['on_demand', 'poll'] as const) {
      const X = await team(mode);
      const id = await started(X);
      const t = app.teams.task(id)!, tm = app.teams.team(X.id)!;
      const h = app.teams.turns.handOff({ ...t, status: 'in_review' }, tm, X.r.id, { kind: 'agent', id: X.w.id });
      expect(h).toMatchObject({ to: X.r.id, phase: 'review', on_demand: mode === 'on_demand', seen: false });
      expect(h.to_label).toContain('rev');
      if (mode === 'on_demand') {
        expect(h.wake_text).toBe(`review ${id}`);
        expect(wakeLine(h)).toBe(`${h.to_label} (on demand) only sees this when woken. Tell its session: review ${id}`);
      } else {
        expect(h.wake_text).toBeUndefined();
        expect(wakeLine(h)).toBeNull();
      }
      expect(only(id).phase).toBe('review');
    }
  });
  it('phaseOf maps every held status and nothing else', () => {
    expect(['assigned', 'changes_requested', 'in_progress', 'in_review', 'open', 'approved', 'blocked', 'done'].map(phaseOf))
      .toEqual(['queued', 'queued', 'work', 'review', null, null, null, null]);
  });
});
