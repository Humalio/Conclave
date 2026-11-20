/**
 * One delivery model (migration 0153, docs/specification.md "Task turns and deadlines"): every team is woken, nothing
 * returns to open by itself, started work past its check-in time is flagged and stays with its holder, and the operator
 * sees what has not reached its agent in Needs you, with Reassign. Delivered (delivered_at, reported by the connector) is
 * kept apart from seen (seen_at, the holder read the task in full).
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
/** A running team: coordinator, two workers and a reviewer, each logged in. */
async function team() {
  const name = `OD${++n}`;
  const agent = async (label: string) => {
    const a = app.keys.createAgent(`${name}-${label}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, label: `${name}-${label}`, call: await session(k.secret) };
  };
  const [c, w, w2, r] = [await agent('coord'), await agent('worker'), await agent('worker2'), await agent('rev')];
  const id = app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred },
    { agent_id: w2.id, role: 'worker', credential_id: w2.cred }, { agent_id: r.id, role: 'reviewer', credential_id: r.cred }] }, sys).id;
  app.teams.start(id, sys);
  return { id, c, w, w2, r };
}
type T = Awaited<ReturnType<typeof team>>;
const assigned = async (X: T) => {
  const t = ok(await X.c.call('task_create', { team_id: X.id, title: `Task ${++n}`, reviewer: X.r.id })).task;
  ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
  return t.id as string;
};
const started = async (X: T) => { const id = await assigned(X); ok(await X.w.call('task_start', { task_id: id })); return id; };
const turn = (task: string) => ({ ...(app.db.prepare('SELECT phase, holder_agent_id, opened_at, seen_at, delivered_at, delivery_reason FROM task_turns WHERE task_id=? AND closed_at IS NULL').get(task) as object) }) as
  { phase: string; holder_agent_id: string; opened_at: number; seen_at: number | null; delivered_at: number | null; delivery_reason: string | null };
/** As if the turn had opened `ms` ago (past the team's pickup time when ms is large enough). */
const age = (task: string, ms: number) => app.db.prepare('UPDATE task_turns SET opened_at=opened_at-? WHERE task_id=? AND closed_at IS NULL').run(ms, task);
const rowsFor = async (task: string) => ((await api('GET', '/needs-you')).body.items as any[]).filter((i) => i.id === `delivery:${task}`);
const released = (agentId: string) => app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='task_released'").all(agentId) as { body: string }[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahod-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 80 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('one playbook and no mode', () => {
  it('the team view has no delivery mode, and every role reads act when woken', async () => {
    const X = await team();
    const v = (await api('GET', `/teams/${X.id}`)).body.team;
    expect(v).not.toHaveProperty('delivery_mode');
    for (const role of ['coordinator', 'worker', 'reviewer']) {
      const pb = app.teams.playbook(X.id, role);
      expect(pb).toContain('you do not poll');
      expect(pb).toMatch(/When woken/);
    }
  });
  it('a PATCH that still sends delivery_mode changes nothing about how work reaches the team', async () => {
    const X = await team();
    await api('PATCH', `/teams/${X.id}`, { delivery_mode: 'poll' });
    const id = await assigned(X);
    // The assignee still gets the notice and the hand-off still carries the wake text.
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='task_assigned'").get(X.w.id)).toMatchObject({ n: 1 });
    expect(turn(id).phase).toBe('queued');
  });
});

describe('nothing returns to open by itself', () => {
  it('given an assigned agent that stays asleep for days, the task stays assigned and never returns to open', async () => {
    const X = await team();
    const id = await assigned(X);
    const days = 10 * 86_400_000, at = Date.now() - days;
    app.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(at, X.w.id);
    app.db.prepare('UPDATE team_members SET joined_at=?, last_work_next_at=NULL WHERE team_id=? AND agent_id=?').run(at, X.id, X.w.id);
    age(id, days);
    app.teams.tick(true);
    app.teams.tick(true);
    expect(app.teams.task(id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w.id, lapsed_from: null, overdue_at: null });
    expect(turn(id)).toMatchObject({ phase: 'queued', holder_agent_id: X.w.id });
    expect(app.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND from_status='assigned' AND to_status='open'").get(id)).toMatchObject({ n: 0 });
  });
  it('given started work past its check-in time, it is flagged, stays assigned, and Needs you offers Reassign', async () => {
    const X = await team();
    const id = await started(X);
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() - 60_000, id);
    app.db.prepare("UPDATE task_turns SET due_at=? WHERE task_id=? AND closed_at IS NULL").run(Date.now() - 60_000, id);
    app.teams.tick(true);
    const k = app.teams.task(id)!;
    expect(k).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w.id });
    expect(k.overdue_at).toBeGreaterThan(0);
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'overdue', open: { kind: 'task', id, team_id: X.id } });
    expect(rows[0].reason).toContain('Past its check-in time');
    expect(rows[0].reason).toContain(X.w.label);
    expect(rows[0].actions).toEqual([{ id: 'reassign', label: 'Reassign', path: `/api/teams/${encodeURIComponent(X.id)}/tasks/${encodeURIComponent(id)}/reassign`, input: true }]);
    // Progress clears the flag, and the row goes.
    ok(await X.w.call('task_progress', { task_id: id, note: 'still on it', until: Date.now() + 3600_000 }));
    expect(await rowsFor(id)).toHaveLength(0);
  });
});

describe('an item not yet delivered', () => {
  it('shows "Not delivered yet" in Needs you once the pickup time has passed, with Reassign', async () => {
    const X = await team();
    const id = await assigned(X);
    expect(await rowsFor(id)).toHaveLength(0); // inside the pickup time: nothing to see yet
    age(id, (app.teams.team(X.id)!.pickup_minutes + 1) * 60_000);
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'undelivered', title: expect.stringContaining('Task') });
    expect(rows[0].reason).toBe(`Not delivered yet · waiting for ${X.w.label} to work on it`);
    expect(rows[0].summary).toBe(`Not delivered yet. It stays with ${X.w.label} until it reaches them or you reassign it.`);
    expect(rows[0].actions.map((a: any) => a.id)).toEqual(['reassign']);
  });
  it('names why when the connector says so, and leaves once delivered or seen', async () => {
    const X = await team();
    const id = await assigned(X);
    age(id, (app.teams.team(X.id)!.pickup_minutes + 1) * 60_000);
    expect(app.teams.turns.undelivered(id, X.w.id, 'pc_offline')).toBe(true);
    expect((await rowsFor(id))[0].reason).toMatch(/^Not delivered: waiting for the PC · /);
    app.teams.turns.undelivered(id, X.w.id, 'chat_in_use');
    expect((await rowsFor(id))[0].reason).toMatch(/^Not delivered: chat in use · /);
    app.teams.turns.undelivered(id, X.w.id, 'wake_held');
    expect((await rowsFor(id))[0].reason).toMatch(/^Not delivered: wake held on this platform · /);
    expect(() => app.teams.turns.undelivered(id, X.w.id, 'bogus' as never)).toThrow();
    expect(app.teams.turns.delivered(id, X.w.id)).toBe(true);
    expect(await rowsFor(id)).toHaveLength(0);
    const id2 = await assigned(X);
    age(id2, (app.teams.team(X.id)!.pickup_minutes + 1) * 60_000);
    ok(await X.w.call('task_list', { task_id: id2 }));
    expect(await rowsFor(id2)).toHaveLength(0);
  });
  it('says "PC offline" with the time for the console, and "Waiting behind task X" while a woken run works on another task', async () => {
    const X = await team();
    const id = await assigned(X), other = await assigned(X);
    age(id, (app.teams.team(X.id)!.pickup_minutes + 1) * 60_000);
    const pc = `pc-od-${n}`, last = Date.now() - 2 * 3600_000;
    app.db.prepare("INSERT INTO machines (id, name, status, created_at) VALUES (?, ?, 'active', ?)").run(pc, pc, last);
    app.db.prepare('INSERT INTO connector_reports (machine_id, first_check_in_at, last_check_in_at) VALUES (?, ?, ?)').run(pc, last, last);
    app.db.prepare('UPDATE credentials SET bound_machine_id=? WHERE id=?').run(pc, X.w.cred);
    let [r] = await rowsFor(id);
    expect(r.reason).toBe(`Not delivered: PC offline · waiting for ${X.w.label} to work on it`);
    expect(r.offline_since).toBe(last);
    let k = (await api('GET', `/teams/${X.id}`)).body.team.board.find((b: any) => b.id === id);
    expect(k.turn).toMatchObject({ pc_offline_since: last, waiting_behind: null });
    // A PC that checks in again is online: the reason falls back to what the connector said.
    app.db.prepare('UPDATE connector_reports SET last_check_in_at=? WHERE machine_id=?').run(Date.now(), pc);
    expect((await rowsFor(id))[0]).toMatchObject({ reason: `Not delivered yet · waiting for ${X.w.label} to work on it`, offline_since: null });
    app.db.prepare("INSERT INTO wake_runs (agent_id, machine_id, state, task_id, updated_at) VALUES (?, ?, 'running', ?, ?)").run(X.w.id, pc, other, Date.now());
    [r] = await rowsFor(id);
    expect(r.reason).toBe(`Waiting behind task ${app.teams.task(other)!.title} · waiting for ${X.w.label} to work on it`);
    k = (await api('GET', `/teams/${X.id}`)).body.team.board.find((b: any) => b.id === id);
    expect(k.turn.waiting_behind).toEqual({ id: other, title: app.teams.task(other)!.title });
    app.db.prepare('DELETE FROM wake_runs WHERE agent_id=?').run(X.w.id);
  });
  it('a waiting review shows too, without Reassign (the reviewer is changed on the task)', async () => {
    const X = await team();
    const id = await started(X);
    ok(await X.w.call('task_submit', { task_id: id, summary: 'done' }));
    age(id, (app.teams.team(X.id)!.pickup_minutes + 1) * 60_000);
    const rows = await rowsFor(id);
    expect(rows[0].reason).toBe(`Not delivered yet · waiting for ${X.r.label} to review it`);
    expect(rows[0].actions).toEqual([]);
  });
  it('a paused team\'s work is not listed: it waits by design', async () => {
    const X = await team();
    const id = await assigned(X);
    age(id, (app.teams.team(X.id)!.pickup_minutes + 1) * 60_000);
    expect(await rowsFor(id)).toHaveLength(1);
    expect((await api('POST', `/teams/${X.id}/pause`)).status).toBe(200);
    expect(await rowsFor(id)).toHaveLength(0);
  });
});

describe('delivered and seen are kept apart', () => {
  it('delivered sets delivered_at only; a full read sets seen_at only; each once', async () => {
    const X = await team();
    const id = await assigned(X);
    expect(turn(id)).toMatchObject({ seen_at: null, delivered_at: null, delivery_reason: null });
    app.teams.turns.undelivered(id, X.w.id, 'chat_in_use');
    expect(turn(id)).toMatchObject({ seen_at: null, delivered_at: null, delivery_reason: 'chat_in_use' });
    expect(app.teams.turns.delivered(id, X.w.id, 1000)).toBe(true);
    expect(turn(id)).toMatchObject({ seen_at: null, delivered_at: 1000, delivery_reason: null });
    expect(app.teams.turns.delivered(id, X.w.id, 2000)).toBe(false); // once
    expect(app.teams.turns.undelivered(id, X.w.id, 'pc_offline')).toBe(false); // a delivered turn keeps its time
    expect(turn(id).delivered_at).toBe(1000);
    ok(await X.w.call('task_list', { task_id: id }));
    const t = turn(id);
    expect(t.seen_at).not.toBeNull();
    expect(t.delivered_at).toBe(1000);
    // Another holder's report does not touch this turn.
    const id2 = await assigned(X);
    expect(app.teams.turns.delivered(id2, X.w2.id)).toBe(false);
    expect(turn(id2).delivered_at).toBeNull();
  });
  it('the turn view carries both, for the console', async () => {
    const X = await team();
    const id = await assigned(X);
    app.teams.turns.delivered(id, X.w.id, 1234);
    const v = (await api('GET', `/teams/${X.id}/tasks/${id}`)).body;
    expect(JSON.stringify(v)).toContain('"delivered_at":1234');
    expect(JSON.stringify(v)).toContain('"seen_at":null');
  });
  it('an answered decision records when it reached the asker, apart from the answer', async () => {
    const X = await team();
    const q = ok(await X.c.call('team_ask', { team_id: X.id, question: 'Which dataset?' }));
    expect((await api('POST', `/decisions/${q.decision_id}/answer`, { text: 'Use A.' })).status).toBe(200);
    const row = () => app.db.prepare('SELECT status, answered_at, delivered_at FROM decisions WHERE id=?').get(q.decision_id) as { status: string; answered_at: number; delivered_at: number | null };
    expect(row()).toMatchObject({ status: 'answered', delivered_at: null });
    expect(app.decisions.delivered(q.decision_id, 5000)).toBe(true);
    expect(row().delivered_at).toBe(5000);
    expect(app.decisions.delivered(q.decision_id, 6000)).toBe(false);
  });
});

describe('reassigning', () => {
  it('the operator reassigns started work: the new worker has it queued, the previous one is told to stop, the reviewer stays', async () => {
    const X = await team();
    const id = await started(X);
    const r = await api('POST', `/teams/${X.id}/tasks/${id}/reassign`, { agent_id: X.w2.id });
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ status: 'assigned' });
    expect(app.teams.task(id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w2.id, reviewer_agent_id: X.r.id, overdue_at: null, lease_expires_at: null });
    expect(turn(id)).toMatchObject({ phase: 'queued', holder_agent_id: X.w2.id });
    const told = released(X.w.id);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain(`was reassigned to ${X.w2.label}`);
    expect(app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='task_assigned' AND body LIKE ?").get(X.w2.id, `%${id}%`)).toMatchObject({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='task.reassign' AND target_id=?").get(id)).toMatchObject({ n: 1 });
  });
  it('refuses the same worker, a non-worker, a task in review and an unknown body field', async () => {
    const X = await team();
    const id = await started(X);
    expect((await api('POST', `/teams/${X.id}/tasks/${id}/reassign`, { agent_id: X.w.id })).status).toBe(409);
    expect((await api('POST', `/teams/${X.id}/tasks/${id}/reassign`, { agent_id: X.r.id })).status).toBe(400);
    expect((await api('POST', `/teams/${X.id}/tasks/${id}/reassign`, { agent_id: X.w2.id, extra: 1 })).status).toBe(400);
    ok(await X.w.call('task_submit', { task_id: id, summary: 'done' }));
    expect((await api('POST', `/teams/${X.id}/tasks/${id}/reassign`, { agent_id: X.w2.id })).status).toBe(409);
    expect(app.teams.task(id)!.assignee_agent_id).toBe(X.w.id);
  });
  it('the coordinator reassigns a queued task with task_assign; the previous worker is told', async () => {
    const X = await team();
    const id = await assigned(X);
    const r = ok(await X.c.call('task_assign', { task_id: id, agent_id: X.w2.id }));
    expect(r.task).toMatchObject({ status: 'assigned', assignee: X.w2.id });
    expect(r.handoff).toMatchObject({ to: X.w2.id, phase: 'queued' });
    expect(released(X.w.id)).toHaveLength(1);
    expect((await X.w.call('task_start', { task_id: id })).isError).toBe(true);
  });
});

describe('work_next keeps its wait', () => {
  it('a call with wait_seconds returns the item assigned while it waits', async () => {
    const X = await team();
    for (let i = 0; i < 20; i++) {
      const r = (await X.w.call('work_next', { wait_seconds: 0 })).structuredContent;
      if (r.status !== 'item') break;
      await X.w.call('work_ack', { item_id: r.item.item_id });
    }
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: 'late', reviewer: X.r.id })).task;
    const began = Date.now();
    const waiting = X.w.call('work_next', { wait_seconds: 5 });
    setTimeout(() => void X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }), 200);
    const got = (await waiting).structuredContent;
    expect(Date.now() - began).toBeGreaterThanOrEqual(150);
    expect(got.status).toBe('item');
    expect(JSON.stringify(got.item)).toContain(t.id);
  });
});
