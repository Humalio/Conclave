/**
 * Start, stop and move a team from the console with no one at the keyboard (docs/connector.md, "Reason orders"). Start team
 * sends each member's PC one `deliver` order with reason `team_start`, coordinator first, once per member while it is open;
 * only the operator may, and a paused team is resumed first. Stop team: the completion check says the team is paused. Move
 * team: a move's request becomes a `write_handout` order, and once the target PC restored the agents each gets a `resume` order.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
type Who = { cookie: string; csrf: string };
let app: App, base: string, admin: Who;
const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
const cn = async (method: string, path: string, key: string, body?: unknown) => {
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let n = 0;
/** A PC with its connector key, and agents whose keys that PC holds. */
const pc = async () => {
  const id = (await api('POST', '/pcs', { name: `start-pc-${++n}` })).body.pc.id as string;
  const key = app.keys.createAppKey({ machineId: id, appName: 'conclave-connector', maxLiveSessions: 10 }, sys).secret;
  const agent = (label: string) => { const a = app.keys.createAgent(`${label} ${n}`, null, sys); app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: id }, sys); return a.id; };
  return { id, key, agent };
};
/** A running team: a worker listed first, then the coordinator, so the order shows the coordinator goes first anyway. */
const team = async (members: { agent_id: string; role: string }[]) => {
  const r = await api('POST', '/teams', { name: `start team ${++n}`, goal: 'ship it', members });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const tid = r.body.team.id as string;
  expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  return tid;
};
const reasonOrders = (agentId: string, reason: string) => app.db.prepare("SELECT id, state, payload FROM pc_actions WHERE kind='deliver' AND json_extract(payload,'$.agent_id')=? AND json_extract(payload,'$.reason')=?").all(agentId, reason) as { id: string; state: string; payload: string }[];
const audits = (action: string) => (app.db.prepare('SELECT COUNT(*) n FROM audit_events WHERE action=?').get(action) as { n: number }).n;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahstart-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
});
afterAll(async () => { await app.close(); });

describe('Start team', () => {
  it('sends each member exactly one check-in order, coordinator first, and pressing again gives the same orders', async () => {
    const p = await pc(), w = p.agent('worker'), c = p.agent('coordinator');
    const tid = await team([{ agent_id: w, role: 'worker' }, { agent_id: c, role: 'coordinator' }]);
    const before = audits('team.start_turns');
    const r = await api('POST', `/teams/${tid}/start-turns`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.members.map((m: { agent_id: string }) => m.agent_id)).toEqual([c, w]);
    for (const m of r.body.members) expect(m).toMatchObject({ already: false, order: expect.stringMatching(/^pca_/) });
    for (const a of [c, w]) {
      const o = reasonOrders(a, 'team_start');
      expect(o).toHaveLength(1);
      expect(JSON.parse(o[0]!.payload)).toEqual({ agent_id: a, items: [], reason: 'team_start' });
    }
    expect(audits('team.start_turns')).toBe(before + 1);
    // Pressed again while the orders are open: the same orders, no second turn.
    const again = await api('POST', `/teams/${tid}/start-turns`);
    expect(again.body.members.map((m: { order: string }) => m.order)).toEqual(r.body.members.map((m: { order: string }) => m.order));
    expect(again.body.members.every((m: { already: boolean }) => m.already)).toBe(true);
    for (const a of [c, w]) expect(reasonOrders(a, 'team_start')).toHaveLength(1);
    // An item for the same agent never folds into the check-in order, nor the check-in into an item order.
    const item = app.connector.deliver(w, { notice: 'task_assigned', task: 'task_x1' });
    expect(item?.order).not.toBe(r.body.members[1].order);
    // The PC takes each order once; the console reads each member's state.
    const got = (await cn('GET', '/orders', p.key)).body.orders as { id: string; payload: { reason?: string } }[];
    expect(got.filter((o) => o.payload.reason === 'team_start')).toHaveLength(2);
    const st = await api('GET', `/teams/${tid}/start-turns`);
    expect(st.status).toBe(200);
    expect(st.body.members.map((m: { agent_id: string }) => m.agent_id)).toEqual([c, w]);
    expect(st.body.members[0].order).toMatchObject({ state: 'fetched', code: null });
    // Once the turn started the order is done, and Start team may be pressed again for a new check-in.
    expect((await cn('POST', `/orders/${st.body.members[0].order.order}/result`, p.key, { state: 'done' })).status).toBe(200);
    expect((await api('GET', `/teams/${tid}/start-turns`)).body.members[0].order.state).toBe('done');
    const third = await api('POST', `/teams/${tid}/start-turns`);
    expect(third.body.members[0]).toMatchObject({ agent_id: c, already: false });
    expect(reasonOrders(c, 'team_start')).toHaveLength(2);
  });

  it('is refused on a paused team, which is resumed first', async () => {
    const p = await pc(), c = p.agent('coordinator');
    const tid = await team([{ agent_id: c, role: 'coordinator' }]);
    expect((await api('POST', `/teams/${tid}/pause`, {})).status).toBe(200);
    const r = await api('POST', `/teams/${tid}/start-turns`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('paused');
    expect(reasonOrders(c, 'team_start')).toHaveLength(0);
    expect((await api('POST', `/teams/${tid}/resume`)).status).toBe(200);
    expect((await api('POST', `/teams/${tid}/start-turns`)).status).toBe(200);
  });

  it('says which member has no PC to wake', async () => {
    const p = await pc(), c = p.agent('coordinator');
    const loose = app.keys.createAgent(`no pc ${++n}`, null, sys).id;
    app.keys.createSessionKey({ agentId: loose, label: 'k' }, sys);
    const tid = await team([{ agent_id: c, role: 'coordinator' }, { agent_id: loose, role: 'worker' }]);
    const r = await api('POST', `/teams/${tid}/start-turns`);
    expect(r.body.members[1]).toMatchObject({ agent_id: loose, order: null, why: 'no_pc' });
    expect((await api('GET', `/teams/${tid}/start-turns`)).body.members[1]).toMatchObject({ pc_online: null, order: null });
  });

  it('only the operator may start a team or read its start state', async () => {
    const p = await pc(), c = p.agent('coordinator');
    const tid = await team([{ agent_id: c, role: 'coordinator' }]);
    const u = await api('POST', '/users', { username: `member${++n}`, display_name: `Member ${n}`, role: 'member' });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const l = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `member${n}`, password: u.body.password }) });
    const who = { cookie: l.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await l.json()) as { csrf: string }).csrf };
    expect((await call(who, 'POST', `/teams/${tid}/start-turns`)).status).toBe(403);
    expect((await call(who, 'GET', `/teams/${tid}/start-turns`)).status).toBe(403);
    expect(reasonOrders(c, 'team_start')).toHaveLength(0);
  });
});

describe('Stop team', () => {
  it('the completion check tells the connector the team is paused, so nothing more starts', async () => {
    const p = await pc(), c = p.agent('coordinator');
    const tid = await team([{ agent_id: c, role: 'coordinator' }]);
    const waiting = (await api('POST', `/teams/${tid}/start-turns`)).body.members[0].order as string;
    await cn('GET', '/orders', p.key);
    expect((await cn('POST', '/wake/check', p.key, { agent_id: c })).body.paused).toBe(false);
    expect((await api('POST', `/teams/${tid}/pause`, {})).status).toBe(200);
    expect((await cn('POST', '/wake/check', p.key, { agent_id: c })).body.paused).toBe(true);
    // The work the PC dropped reports the fixed code; it is not a delivery state of a task.
    expect((await cn('POST', `/orders/${waiting}/result`, p.key, { state: 'failed', result: { code: 'team_paused', reason: 'Not started: the team was paused.' } })).status).toBe(200);
    expect((await api('GET', `/teams/${tid}/start-turns`)).body.members[0].order).toMatchObject({ state: 'failed', code: 'team_paused' });
  });
});

describe('Move team with no one at the keyboard', () => {
  it('a move\'s request becomes one write_handout order per agent', async () => {
    const p = await pc(), a = p.agent('mover');
    const first = app.connector.deliver(a, { notice: 'checkout_requested' });
    expect(first).toMatchObject({ order: expect.stringMatching(/^pca_/), folded: false });
    expect(app.connector.deliver(a, { notice: 'checkout_requested' })).toEqual({ order: first!.order, folded: true });
    const o = reasonOrders(a, 'write_handout');
    expect(o).toHaveLength(1);
    expect(JSON.parse(o[0]!.payload)).toEqual({ agent_id: a, items: [], reason: 'write_handout' });
  });

  it('after the render, Restore goes out by itself when the target PC\'s user approved exactly one destination', async () => {
    const p = await pc(), lead = p.agent('lead');
    const report = { version: '1.4.0', platform: 'win32-x64', node: '22.11.0', git: '2.47.1', clients: [{ client: 'claude_code', version: '2.0.31' }], auto_update: true, remote_cleanup: true };
    const tm = app.teams.create({ name: `auto restore ${++n}`, goal: 'Move house', members: [{ agent_id: lead, role: 'coordinator' }] }, sys);
    const cko = `cko_autorestore${n}`, now = Date.now();
    app.db.prepare("INSERT INTO checkouts(id,team_id,status,target_machine_id,created_at,updated_at,expires_at) VALUES (?,?,'rendered',?,?,?,?)").run(cko, tm.id, p.id, now, now, now + 86400_000);
    const restores = () => app.db.prepare("SELECT payload FROM pc_actions WHERE kind='restore' AND machine_id=?").all(p.id) as { payload: string }[];
    // None approved yet, then two: the operator picks, nothing is sent.
    expect(app.connector.restoreIfOneDestination(cko, sys)).toBeNull();
    await cn('POST', '/check-in', p.key, { ...report, destinations: [{ id: 'dst_auto0001', label: 'One' }, { id: 'dst_auto0002', label: 'Two' }] });
    expect(app.connector.restoreIfOneDestination(cko, sys)).toBeNull();
    expect(restores()).toHaveLength(0);
    // Exactly one: the check-in that reports it already sends Restore (the hub learns it after the render), and never twice while it is open.
    await cn('POST', '/check-in', p.key, { ...report, destinations: [{ id: 'dst_auto0001', label: 'One' }] });
    expect(restores()).toHaveLength(1);
    expect(app.connector.restoreIfOneDestination(cko, sys)).toBeNull();
    expect(restores().map((r) => JSON.parse(r.payload))).toEqual([{ checkout_id: cko, destination_id: 'dst_auto0001' }]);
    // A checkout that is not rendered gets none.
    expect(app.connector.restoreIfOneDestination('cko_missing01', sys)).toBeNull();
  });

  // The resume order after the target PC restored the agents: test/connector-restore-real.test.ts, on a real move.
});
