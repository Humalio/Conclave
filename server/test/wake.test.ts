/**
 * The wake on the hub (docs/connector.md, "The wake"): the connector reports each run it starts for one of its PC's agents, with the
 * task and the session; the hub keeps the latest state, audits a change of state (not a heartbeat), flags a run with no activity for
 * 30 minutes (nothing stops by itself), and answers the completion check (what the agent still holds, and whether a task is open).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { WAKE_QUIET_MS } from '../src/connector/connector.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const cn = async (method: string, path: string, key: string | null, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const world = async (name: string) => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: id, appName: 'conclave-connector', maxLiveSessions: 10 }, sys).secret;
  const agent = (label: string) => { const a = app.keys.createAgent(label, null, sys); app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: id }, sys); return a.id; };
  return { pc: id, appKey, agent };
};
const audits = (agent: string, action: string) => (app.db.prepare('SELECT COUNT(*) n FROM audit_events WHERE target_id=? AND action=?').get(agent, action) as { n: number }).n;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahwake-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir, { maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('a run the connector started', () => {
  it('is recorded with its task and session, a change of state is audited and a heartbeat is not', async () => {
    const w = await world('wake-report'), a = w.agent('wake agent');
    const body = { agent_id: a, state: 'running', task: 'task_abc', session_id: 'sess-1', last_activity: Date.now() };
    expect((await cn('POST', '/wake/report', w.appKey, body)).body).toEqual({ ok: true });
    expect(audits(a, 'connector.wake_running')).toBe(1);
    await cn('POST', '/wake/report', w.appKey, { ...body, last_activity: Date.now() + 1000 }); // the heartbeat
    expect(audits(a, 'connector.wake_running')).toBe(1);
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'paused_usage', task: 'task_abc', session_id: 'sess-1', resumes_at: Date.now() + 3600_000 });
    expect(audits(a, 'connector.wake_paused_usage')).toBe(1);
    const run = app.connector.wakeRuns(w.pc)[0]!;
    expect(run).toMatchObject({ agent_id: a, state: 'paused_usage', task: 'task_abc', session_id: 'sess-1', no_activity: false });
    expect(run.resumes_at).toBeGreaterThan(Date.now());
  });
  it('shows "no activity" after 30 minutes without stopping anything', async () => {
    const w = await world('wake-quiet'), a = w.agent('quiet agent');
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', task: 'task_q', last_activity: Date.now() });
    expect(app.connector.wakeRuns(w.pc)[0]!.no_activity).toBe(false);
    app.db.prepare('UPDATE wake_runs SET last_activity_at=? WHERE agent_id=?').run(Date.now() - WAKE_QUIET_MS - 1000, a);
    const run = app.connector.wakeRuns(w.pc)[0]!;
    expect(run.no_activity).toBe(true);
    expect(run.state).toBe('running');
  });
  it('is accepted only from the agent\'s own PC, with fixed states and short ids', async () => {
    const w = await world('wake-own'), other = await world('wake-other'), a = w.agent('own agent');
    expect((await cn('POST', '/wake/report', other.appKey, { agent_id: a, state: 'running' })).status).toBe(404);
    expect((await cn('POST', '/wake/report', null, { agent_id: a, state: 'running' })).status).toBe(401);
    expect((await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'thinking hard' })).status).toBe(400);
    expect((await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', task: 'a path/../x' })).status).toBe(400);
    expect((await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', note: 'text' })).status).toBe(400);
  });
});

describe('an item for another task during a run', () => {
  it('keeps the run running on its task and records the task the item waits behind', async () => {
    const w = await world('wake-behind'), a = w.agent('behind agent');
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', task: 'task_run', last_activity: Date.now() });
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'waiting', waiting_on: 'task_run' });
    expect(app.connector.wakeRuns(w.pc)[0]).toMatchObject({ state: 'running', task: 'task_run', waiting_on: 'task_run' });
    expect(audits(a, 'connector.wake_waiting')).toBe(0);
  });
});

describe('one clean record per run', () => {
  const wakeAudits = (agent: string) => (app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE target_id=? AND action LIKE 'connector.wake_%'").get(agent) as { n: number }).n;
  const later = () => new Promise((r) => setTimeout(r, 5));
  it('a run that waits and resumes twice keeps one row, one start time and one audit entry', async () => {
    const w = await world('wake-flip'), a = w.agent('flip agent');
    const run = { agent_id: a, state: 'running', task: 'task_f', session_id: 'sess-f', last_activity: Date.now() };
    await cn('POST', '/wake/report', w.appKey, run);
    const started = app.connector.wakeRuns(w.pc)[0]!.started_at;
    for (let i = 0; i < 2; i++) {
      await later();
      await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'waiting', task: 'task_f', session_id: 'sess-f', waiting_on: 'task_f' });
      expect(app.connector.wakeRuns(w.pc)[0]).toMatchObject({ state: 'running', task: 'task_f', waiting_on: 'task_f', started_at: started });
      await cn('POST', '/wake/report', w.appKey, { ...run, last_activity: Date.now() });
      expect(app.connector.wakeRuns(w.pc)[0]).toMatchObject({ state: 'running', task: 'task_f', waiting_on: null, started_at: started });
    }
    expect((app.db.prepare('SELECT COUNT(*) n FROM wake_runs WHERE agent_id=?').get(a) as { n: number }).n).toBe(1);
    expect(audits(a, 'connector.wake_running')).toBe(1);
    expect(wakeAudits(a)).toBe(1);
  });
  it('a usage pause is audited once, and running again in the same run is not a new start', async () => {
    const w = await world('wake-pause'), a = w.agent('pause agent');
    const run = { agent_id: a, state: 'running', run: 'run-p', task: 'task_p', session_id: 'sess-p' };
    await cn('POST', '/wake/report', w.appKey, run);
    const started = app.connector.wakeRuns(w.pc)[0]!.started_at;
    await later();
    await cn('POST', '/wake/report', w.appKey, { ...run, state: 'paused_usage', resumes_at: Date.now() + 60_000 });
    await cn('POST', '/wake/report', w.appKey, run);
    expect(app.connector.wakeRuns(w.pc)[0]).toMatchObject({ state: 'running', started_at: started });
    expect(audits(a, 'connector.wake_running')).toBe(1);
    expect(audits(a, 'connector.wake_paused_usage')).toBe(1);
  });
  it('a late end of an earlier run never ends the run that followed it', async () => {
    const w = await world('wake-late'), a = w.agent('late agent');
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', run: 'run-1', task: 'task_1', session_id: 'sess-1' });
    await later();
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', run: 'run-2', task: 'task_1', session_id: 'sess-1' });
    const second = app.connector.wakeRuns(w.pc)[0]!;
    expect(audits(a, 'connector.wake_running')).toBe(2);
    expect((await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'ended', run: 'run-1', task: 'task_1', session_id: 'sess-1' })).body).toEqual({ ok: true });
    expect(app.connector.wakeRuns(w.pc)[0]).toMatchObject({ state: 'running', started_at: second.started_at });
    expect(audits(a, 'connector.wake_ended')).toBe(0);
    // Its own end does end it.
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'ended', run: 'run-2', task: 'task_1', session_id: 'sess-1' });
    expect(app.connector.wakeRuns(w.pc)[0]!.state).toBe('ended');
    expect(audits(a, 'connector.wake_ended')).toBe(1);
  });
  it('without run ids, the task and session tell the runs apart', async () => {
    const w = await world('wake-late-old'), a = w.agent('old late agent');
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', task: 'task_a', session_id: 'sess-a' });
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'ended', task: 'task_a', session_id: 'sess-a' });
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', task: 'task_b', session_id: 'sess-b' });
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'stopped', task: 'task_a', session_id: 'sess-a' });
    expect(app.connector.wakeRuns(w.pc)[0]).toMatchObject({ state: 'running', task: 'task_b', session_id: 'sess-b' });
  });
});

describe('a connector too old for delivery orders', () => {
  it('is sent none: the order waits on the hub, the item reads connector too old, and it goes out once the PC updates', async () => {
    const w = await world('wake-old'), a = w.agent('old agent');
    expect((await cn('POST', '/check-in', w.appKey, { version: '0.9.3' })).status).toBe(200);
    const seen: { reason: string | null; tasks: (string | undefined)[] }[] = [];
    const saved = app.connector.onDelivery;
    app.connector.onDelivery = (agent, items, o) => { if (agent === a) seen.push({ reason: o.delivered ? null : o.reason, tasks: items.map((i) => i.task) }); saved?.(agent, items, o); };
    try {
      expect(app.connector.deliver(a, { notice: 'task_assigned', task: 'task_old' })?.order).toBeTruthy();
      expect(seen).toEqual([{ reason: 'connector_too_old', tasks: ['task_old'] }]);
    } finally { app.connector.onDelivery = saved; }
    expect((await cn('GET', '/orders', w.appKey)).body.orders.filter((o: any) => o.kind === 'deliver')).toEqual([]);
    expect((await cn('POST', '/check-in', w.appKey, { version: '0.9.3' })).body.orders).toBe(0);
    // A reset or a Stop is refused with the version to update to.
    const reset = await api('POST', `/agents/${a}/reset`, {});
    expect(reset.status).toBe(409);
    expect(reset.body.message).toContain('0.9.4');
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', task: 'task_old' });
    expect((await api('POST', `/agents/${a}/wake/stop`, {})).status).toBe(409);
    // The PC updates: the waiting order goes out on its next fetch.
    expect((await cn('POST', '/check-in', w.appKey, { version: '0.9.4' })).body.orders).toBe(1);
    expect((await cn('GET', '/orders', w.appKey)).body.orders.filter((o: any) => o.kind === 'deliver')).toHaveLength(1);
  });
});

describe("the operator's Stop", () => {
  it('sends one stop order to the PC of the run, audited, and refuses an agent with no live run', async () => {
    const w = await world('wake-stop'), a = w.agent('stop agent');
    expect((await api('GET', `/agents/${a}/wake`)).body).toEqual({ run: null });
    expect((await api('POST', `/agents/${a}/wake/stop`, {})).status).toBe(409);
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'running', task: 'task_s', session_id: 'sess-s', last_activity: Date.now() });
    expect((await api('GET', `/agents/${a}/wake`)).body.run).toMatchObject({ agent_id: a, state: 'running', task: 'task_s', pc: w.pc, no_activity: false });
    const r = await api('POST', `/agents/${a}/wake/stop`, {});
    expect(r.status).toBe(200);
    // A second click while the order is open is the same order.
    expect((await api('POST', `/agents/${a}/wake/stop`, {})).body.order).toBe(r.body.order);
    const o = app.db.prepare('SELECT machine_id, kind, payload, created_by FROM pc_actions WHERE id=?').get(r.body.order) as { machine_id: string; kind: string; payload: string; created_by: string };
    expect(o).toMatchObject({ machine_id: w.pc, kind: 'deliver' });
    expect(JSON.parse(o.payload)).toEqual({ agent_id: a, items: [], reason: 'stop' });
    expect(o.created_by).toMatch(/^operator:/);
    expect(audits(a, 'connector.wake_stop')).toBe(1);
    // The connector fetches it like any order.
    expect((await cn('GET', '/orders', w.appKey)).body.orders.some((x: any) => x.id === r.body.order && x.payload.reason === 'stop')).toBe(true);
    await cn('POST', '/wake/report', w.appKey, { agent_id: a, state: 'stopped', task: 'task_s', session_id: 'sess-s' });
    expect((await api('POST', `/agents/${a}/wake/stop`, {})).status).toBe(409);
    expect((await api('POST', '/agents/agent_nobody/wake/stop', {})).status).toBe(404);
  });
});

describe('the completion check after a run', () => {
  it('says what the agent still holds and whether the task is open, from the hub\'s task turns', async () => {
    const w = await world('wake-check'), a = w.agent('check agent');
    expect(app.connector.turns).not.toBeNull();
    const saved = app.connector.turns;
    app.connector.turns = { held: () => [{ task_id: 'task_open', phase: 'queued' }], open: (t) => t === 'task_open' };
    try {
      expect((await cn('POST', '/wake/check', w.appKey, { agent_id: a, task: 'task_open' })).body).toEqual({ held: [{ task: 'task_open', phase: 'queued' }], task_open: true, paused: false });
      expect((await cn('POST', '/wake/check', w.appKey, { agent_id: a, task: 'task_done' })).body.task_open).toBe(false);
      expect((await cn('POST', '/wake/check', w.appKey, { agent_id: a })).body.task_open).toBeNull();
    } finally { app.connector.turns = saved; }
    const other = await world('wake-check-other');
    expect((await cn('POST', '/wake/check', other.appKey, { agent_id: a })).status).toBe(404);
  });
  it('reads the real turns: a task nobody holds is not open, and an agent with none holds nothing', async () => {
    const w = await world('wake-real'), a = w.agent('real agent');
    expect((await cn('POST', '/wake/check', w.appKey, { agent_id: a, task: 'task_nonexistent' })).body).toEqual({ held: [], task_open: false, paused: false });
  });
});
