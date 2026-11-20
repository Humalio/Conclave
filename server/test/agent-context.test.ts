/**
 * Context size and Reset on the hub (design "the connector delivers work" 3c; docs/connector.md, "Context size" and
 * "Reset"): a PC's context numbers are kept only under its usage opt-in and only for its own agents; the console reads
 * "Not shared by this PC" otherwise; the bar's level is amber from 60 % and red from 85 %; an unknown window has no
 * percent; Reset is its own delivery order that never folds with an item; and a coordinator resets only its own team's agents.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { CONTEXT_AMBER, CONTEXT_RED } from '../src/connector/connector.js';
import { intakeOpen } from './intake.js';
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
const newPc = async (name: string) => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  const k = app.keys.createAppKey({ machineId: id, appName: 'claude-code', maxLiveSessions: 50 }, sys);
  return { id, key: k.secret };
};
const agentOn = (pcId: string | null, label: string) => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: 'k', ...(pcId ? { machineId: pcId } : {}) }, sys);
  return { id: a.id, secret: k.secret };
};
const base0 = { version: '1.4.0', platform: 'win32-x64', node: '22.11.0', git: '2.47.1', clients: [{ client: 'claude_code', version: '2.0.31' }] };
const ctx = (agent_id: string, o: Partial<Record<string, unknown>> = {}) => ({
  agent_id, source: 'connector', client: 'claude_code', model: 'claude-sonnet-4-5-20250929', context_tokens: 62_000, window: 200_000, percent: 31,
  turn_tokens: 120_000, compacted_at: null, compacts: 0, at: Date.now(), ...o,
});
const stored = (agentId: string) => app.db.prepare('SELECT * FROM agent_context WHERE agent_id=?').get(agentId) as any;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahctx-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir, { vaultDir: join(dir, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('context numbers on the check-in', () => {
  it('with the usage opt-in off nothing is kept, and the console reads "Not shared by this PC"', async () => {
    const pc = await newPc('cx-off'), a = agentOn(pc.id, 'cx-off-a');
    expect((await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: false, context: [ctx(a.id)] })).status).toBe(200);
    expect(stored(a.id)).toBeUndefined();
    expect((await api('GET', `/agents/${a.id}/context`)).body).toMatchObject({ shared: false, why: 'not_shared' });
  });
  it('with it on, the numbers are kept for its own agents only, and the console gets the percent and level', async () => {
    const pc = await newPc('cx-on'), a = agentOn(pc.id, 'cx-on-a'), quiet = agentOn(pc.id, 'cx-on-q'), other = agentOn((await newPc('cx-other')).id, 'cx-other-a');
    expect((await api('GET', `/agents/${a.id}/context`)).body).toMatchObject({ shared: false, why: 'not_shared' }); // no check-in yet: the opt-in is not known
    expect((await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: true, context: [ctx(a.id), ctx(other.id)] })).status).toBe(200);
    expect(stored(other.id)).toBeUndefined(); // not this PC's agent
    expect((await api('GET', `/agents/${quiet.id}/context`)).body).toMatchObject({ shared: false, why: 'not_reported' }); // opted in, nothing reported for it
    const r = (await api('GET', `/agents/${a.id}/context`)).body;
    expect(r).toMatchObject({ shared: true, source: 'connector', hand_opened: false, context_tokens: 62_000, window: 200_000, percent: 31, level: 'ok', turn_tokens: 120_000, stale: false });
    expect(Object.keys(r)).not.toContain('text');
  });
  it(`the bar is amber from ${CONTEXT_AMBER} % and red from ${CONTEXT_RED} %; an unknown window has no percent`, async () => {
    const pc = await newPc('cx-lv'), a = agentOn(pc.id, 'cx-lv-a');
    const level = async (o: Record<string, unknown>) => {
      await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: true, context: [ctx(a.id, o)] });
      const b = (await api('GET', `/agents/${a.id}/context`)).body;
      return [b.percent, b.level, b.window];
    };
    expect(await level({ context_tokens: 119_000 })).toEqual([60, 'amber', 200_000]);
    expect(await level({ context_tokens: 117_000 })).toEqual([59, 'ok', 200_000]);
    expect(await level({ context_tokens: 170_000 })).toEqual([85, 'red', 200_000]);
    expect(await level({ window: null, percent: null })).toEqual([null, null, null]);
    expect(await level({ context_tokens: 300_000, window: 200_000 })).toEqual([null, null, null]); // a window smaller than the context is wrong: unknown
  });
  it('an auto-compact reaches the console as a drop with its time, and a hand-opened chat says so', async () => {
    const pc = await newPc('cx-cmp'), a = agentOn(pc.id, 'cx-cmp-a'), t = Date.now();
    await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: true, context: [ctx(a.id, { source: 'chat', context_tokens: 150_000 })] });
    await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: true, context: [ctx(a.id, { source: 'chat', context_tokens: 30_000, compacts: 1, compacted_at: t })] });
    expect((await api('GET', `/agents/${a.id}/context`)).body).toMatchObject({ context_tokens: 30_000, compacts: 1, compacted_at: t, hand_opened: true });
  });
  it('a context row with anything but numbers and a model id is refused', async () => {
    const pc = await newPc('cx-strict'), a = agentOn(pc.id, 'cx-strict-a');
    expect((await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: true, context: [{ ...ctx(a.id), text: 'the last prompt' }] })).status).toBe(400);
    expect((await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: true, context: [ctx(a.id, { model: 'rm -rf /' })] })).status).toBe(400);
    expect(stored(a.id)).toBeUndefined();
  });
  it('the team route gives every member at once', async () => {
    const pc = await newPc('cx-team'), a = agentOn(pc.id, 'cx-team-a'), b = agentOn(pc.id, 'cx-team-b');
    const tid = (await api('POST', '/teams', { name: 'cx team', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator' }, { agent_id: b.id, role: 'worker' }] })).body.team.id as string;
    await cn('POST', '/check-in', pc.key, { ...base0, usage_opt_in: true, context: [ctx(a.id)] });
    const r = (await api('GET', `/teams/${tid}/context`)).body.agents;
    expect(r[a.id]).toMatchObject({ shared: true, percent: 31 });
    expect(r[b.id]).toMatchObject({ shared: false, why: 'not_reported' });
  });
});

describe('Reset', () => {
  it('is its own deliver order with reason reset; a second one while it waits is the same order; audited', async () => {
    const pc = await newPc('rs-op'), a = agentOn(pc.id, 'rs-op-a');
    const r1 = await api('POST', `/agents/${a.id}/reset`, {});
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ already: false, by_hand: false });
    expect((await api('POST', `/agents/${a.id}/reset`, {})).body).toMatchObject({ order: r1.body.order, already: true });
    // A notice for the same agent makes its own item order: a reset never folds with work.
    app.keys.notify(a.id, 'task_assigned', 'x', { task: 'task_abc', state: 'assigned' });
    const orders = (await cn('GET', '/orders', pc.key)).body.orders as { id: string; kind: string; payload: any }[];
    const reset = orders.find((o) => o.id === r1.body.order)!;
    expect(reset.payload).toEqual({ agent_id: a.id, reason: 'reset', items: [] });
    expect(orders.filter((o) => o.kind === 'deliver' && o.payload.agent_id === a.id && !o.payload.reason)).toHaveLength(1);
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='agent.reset' AND target_id=?").get(a.id)).toEqual({ n: 1 });
  });
  it('a hand-opened chat answers reset_by_hand, and the console then shows the steps', async () => {
    const pc = await newPc('rs-hand'), a = agentOn(pc.id, 'rs-hand-a');
    const { order } = (await api('POST', `/agents/${a.id}/reset`, {})).body;
    await cn('GET', '/orders', pc.key);
    expect((await cn('POST', `/orders/${order}/result`, pc.key, { state: 'failed', result: { reason: 'Not reset: a person opened this chat.', code: 'reset_by_hand' } })).status).toBe(200);
    expect((await api('GET', `/agents/${a.id}/context`)).body.reset).toMatchObject({ order, state: 'failed', by_hand: true });
  });
  it('an agent no PC runs gets the steps for the person, not an order', async () => {
    const a = agentOn(null, 'rs-nopc-a');
    expect((await api('POST', `/agents/${a.id}/reset`, {})).body).toMatchObject({ order: null, by_hand: true });
  });
});

describe('a coordinator resets only its own team\'s agents', () => {
  let appKey = '';
  type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
  async function loginWith(secret: string): Promise<Call> {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
    const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
    return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
  }
  const err = (r: { structuredContent?: any }) => r.structuredContent?.error as string | undefined;

  it('its own team: an order; another team\'s agent, itself, or a worker asking: refused', async () => {
    const pc = await newPc('rs-coord');
    appKey = pc.key;
    const [c1, w1, c2, w2] = ['rs-c1', 'rs-w1', 'rs-c2', 'rs-w2'].map((l) => agentOn(pc.id, l));
    const mkTeam = async (name: string, c: { id: string }, w: { id: string }) => {
      const r = await api('POST', '/teams', { name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: w.id, role: 'worker' }] });
      expect(r.status).toBe(201);
      expect((await api('POST', `/teams/${r.body.team.id}/start`)).status).toBe(200);
      return r.body.team.id as string;
    };
    const t1 = await mkTeam('rs team one', c1!, w1!), t2 = await mkTeam('rs team two', c2!, w2!);
    const C1 = await loginWith(c1!.secret), W1 = await loginWith(w1!.secret);

    const ok = await C1('agent_reset', { team_id: t1, agent_id: w1!.id });
    expect(ok.isError, JSON.stringify(ok.content)).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ agent_id: w1!.id, by_hand: false, already: false });
    expect(ok.structuredContent.order).toMatch(/^pca_/);

    expect(err(await C1('agent_reset', { team_id: t1, agent_id: w2!.id }))).toBe('denied'); // not a member of its team
    expect(err(await C1('agent_reset', { team_id: t2, agent_id: w2!.id }))).toBe('denied'); // not its team
    expect(err(await C1('agent_reset', { team_id: t1, agent_id: c1!.id }))).toBe('invalid_argument'); // itself
    expect(err(await W1('agent_reset', { team_id: t1, agent_id: c1!.id }))).toBe('denied'); // a worker cannot
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='agent.reset' AND target_id=?").get(w2!.id)).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT actor_kind, actor_id FROM audit_events WHERE action='agent.reset' AND target_id=?").get(w1!.id)).toEqual({ actor_kind: 'agent', actor_id: c1!.id });
  });
});
