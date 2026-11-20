/** Hardware step 2 (docs/hardware.md#measuring): the connector's samples of a compute machine, the user's opt-in, the clock
 *  guard, attribution to holds by time, the over-limit flag, measure-only orders, retention, and hw_list staying figure-free. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const MIN = 60_000, DAY = 86_400_000;
let app: App, base = '', cookie = '', csrf = '', appKey = '', plainKey = '';
let clock = Date.UTC(2026, 10, 20, 14, 0); // Lisbon is on UTC in November, so local times read the same
let n = 0;
const at = (h: number, m: number) => Date.UTC(2026, 10, 20, h, m);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const cn = async (method: string, path: string, key: string, body?: unknown) => {
  const r = await fetch(`${base}/connector/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
async function agent(label: string) {
  const a = app.keys.createAgent(`${label}-${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
  const token = (await raw('session_login', { session_key: k.secret })).structuredContent.session_token as string;
  const S = (name: string, args: Record<string, unknown> = {}) => raw(name, { session_token: token, ...args });
  return { id: a.id, cred: k.credential.id, S };
}
type Agent = Awaited<ReturnType<typeof agent>>;
const text = (r: Res) => r.content.map((c) => c.text).join('\n');
const notices = async (x: Agent, kind: string) => ((await x.S('session_whoami')).structuredContent?.notices ?? []).filter((m: any) => m.kind === kind) as { body: string }[];
const sample = (t: number, cpu: number, mem: number, gpu = 30) => ({ at: t, cpu_pct: cpu, cpu_count: 16, mem_used_gb: mem, mem_total_gb: 64, gpus: [{ util_pct: gpu, mem_used_gb: 8, mem_total_gb: 24 }] });
const send = (...s: ReturnType<typeof sample>[]) => cn('POST', '/hardware', appKey, { samples: s });
const count = (t: string) => (app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
const machine = async () => (await api('GET', '/hardware?period=7d')).body.machines.find((m: any) => m.id === pc);
const report = { version: '1.4.0', platform: 'linux-x64', node: '22.11.0', git: '2.47.1', clients: [], auto_update: true, remote_cleanup: true };

let ana: Agent, ben: Agent, team = '', pc = '', plain = '';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahhwm-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  app.hardware.now = () => clock;
  pc = (await api('POST', '/pcs', { name: 'gpu-box' })).body.pc.id;
  plain = (await api('POST', '/pcs', { name: 'laptop' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  plainKey = app.keys.createAppKey({ machineId: plain, appName: 'claude-code', maxLiveSessions: 5 }, sys).secret;
  [ana, ben] = [await agent('ana'), await agent('ben')];
  team = app.teams.create({ name: 'Model Lab', goal: 'g', members: [{ agent_id: ana.id, role: 'coordinator', credential_id: ana.cred }, { agent_id: ben.id, role: 'worker', credential_id: ben.cred }] }, sys).id;
  app.teams.start(team, sys);
  const r = await api('PUT', `/hardware/${pc}`, { access: 'ssh gpu-box', timezone: 'Europe/Lisbon', windows: [], memory_gb: 48, cpus: 12, gpu: 'RTX 4090', teams: [team], shared_with_people: true });
  expect(r.status).toBe(200);
});
afterAll(async () => { await app?.close(); });

describe('opt-in and the route', () => {
  it('refuses samples until the check-in says measuring is on', async () => {
    expect((await send(sample(clock, 10, 10))).status).toBe(403); // no check-in yet: unknown
    expect((await cn('POST', '/check-in', appKey, { ...report, hardware_opt_in: false })).body).toMatchObject({ ok: true, measure_only: true });
    const off = await send(sample(clock, 10, 10));
    expect(off.status).toBe(403);
    expect(off.body.message).toContain('conclave hardware on');
    expect(count('hw_samples')).toBe(0);
    expect((await machine()).measure).toMatchObject({ connector: true, opt_in: false, shared_with_people: true, live: null });
    await cn('POST', '/check-in', appKey, { ...report, hardware_opt_in: true });
    expect(await send(sample(clock, 10, 10))).toMatchObject({ status: 200, body: { accepted: 1, duplicates: 0, skewed: 0 } });
    expect((await machine()).measure.live).toMatchObject({ at: clock, cpu_pct: 10, mem_used_gb: 10, gpus: [{ util_pct: 30 }] });
  });

  it('takes no samples from a PC that offers no compute, and tells only compute machines they are measure-only', async () => {
    const r = await cn('POST', '/check-in', plainKey, { ...report, hardware_opt_in: true });
    expect(r.body.measure_only).toBeUndefined();
    expect((await cn('POST', '/hardware', plainKey, { samples: [sample(clock, 1, 1)] })).status).toBe(409);
  });

  it('validates the batch: numbers only, at most 120 samples', async () => {
    expect((await cn('POST', '/hardware', appKey, { samples: [{ ...sample(clock + 1, 10, 10), note: 'x' }] })).status).toBe(400);
    expect((await cn('POST', '/hardware', appKey, { samples: [sample(clock + 1, 101, 10)] })).status).toBe(400);
    expect((await cn('POST', '/hardware', appKey, { samples: [] })).status).toBe(400);
    expect((await cn('POST', '/hardware', appKey, { samples: Array.from({ length: 121 }, (_, i) => sample(clock - i, 1, 1)) })).status).toBe(400);
  });

  it('drops samples more than 5 minutes from the hub clock, and refuses a batch of only those', async () => {
    const r = await send(sample(clock - 10 * MIN, 10, 10), sample(clock + 1000, 10, 10));
    expect(r.body).toMatchObject({ accepted: 1, skewed: 1 });
    expect((await send(sample(clock + 6 * MIN, 10, 10))).status).toBe(400);
    expect((await send(sample(clock + 1000, 10, 10))).body).toMatchObject({ accepted: 0, duplicates: 1 }); // sent again
  });
});

describe('attribution by time', () => {
  it('a hold from 14:10 to 15:00 gets exactly the samples of that time', async () => {
    clock = at(14, 5); await send(sample(clock, 90, 30));
    clock = at(14, 10);
    const t = app.teams.hubTask(team, { title: 'Train the tern model', description: 'Train.', assignee: ana.id })!.id;
    expect((await ana.S('hw_join', { machine: 'gpu-box', task_id: t, estimate_minutes: 50 })).structuredContent).toMatchObject({ holder: true });
    for (let m = 0; m < 50; m++) { clock = at(14, 10 + m); await send(sample(clock, m % 2 ? 60 : 40, m === 20 ? 40 : 20)); }
    clock = at(15, 0);
    expect((await ana.S('hw_leave', { machine: 'gpu-box', outcome: 'done' })).isError).toBeFalsy();
    await send(sample(at(15, 0), 5, 12));
    clock = at(15, 1); await send(sample(clock, 5, 12));
    const m = await machine();
    const hold = m.what_ran.find((h: any) => h.agent_id === ana.id);
    expect(hold.use).toMatchObject({ samples: 50, first_at: at(14, 10), last_at: at(14, 59), cpu_avg: 50, cpu_peak: 60, mem_peak_gb: 40, gpu_avg: 30, gpu_peak: 30 });
    expect(hold.use.mem_avg_gb).toBeCloseTo(20.4);
    expect(m.analysis.use.held.samples).toBe(50);
    // Use with no holder: 14:00 and 14:00:01 from the first tests, 14:05, 15:00 and 15:01.
    expect(m.analysis.use.idle).toMatchObject({ samples: 5, cpu_peak: 90 });
    expect(m.flags).toHaveLength(0);
  });
});

describe('over the declared limit', () => {
  it('flags a hold once after 2 minutes over the memory limit, restarts after a gap, and stops nothing', async () => {
    clock = at(16, 0);
    const t = app.teams.hubTask(team, { title: 'Evaluate checkpoints', description: 'Eval.', assignee: ben.id })!.id;
    expect((await ben.S('hw_join', { machine: 'gpu-box', task_id: t, estimate_minutes: 30 })).structuredContent).toMatchObject({ holder: true });
    const over = async (min: number, mem = 52) => { clock = at(16, min); await send(sample(clock, 20, mem)); };
    await over(1); await over(5); await over(6); // a 4-minute gap restarts the clock: 1 minute over so far
    expect((await machine()).flags).toHaveLength(0);
    await over(7);
    let m = await machine();
    expect(m.flags).toHaveLength(1);
    expect(m.flags[0]).toMatchObject({ kind: 'limit', detail: 'memory', mem_peak: 52, agent_id: ben.id });
    await over(8); await over(9);
    m = await machine();
    expect(m.flags).toHaveLength(1);
    expect(m.holder.agent_id).toBe(ben.id); // nothing is stopped
    const sent = await notices(ben, 'hardware_flagged');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('memory limit');
    expect(sent[0].body).not.toMatch(/\d+ ?GB/);
  });

  it('hw_list shows the declared limits and never the measured figures', async () => {
    const list = text(await ana.S('hw_list'));
    expect(list).toContain('memory 48 GB');
    expect(list).not.toMatch(/52|cpu_pct|used/i);
  });
});

describe('measure-only orders', () => {
  it('refuses every PC order but Update on a compute machine', async () => {
    const r = await api('POST', `/pcs/${pc}/actions`, { kind: 'check' });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('only measures it');
    expect((await api('POST', `/pcs/${plain}/actions`, { kind: 'check' })).status).toBe(200);
  });
});

describe('retention', () => {
  it('raw samples go after 7 days; hold summaries stay 400 days, also after the machine is removed', async () => {
    const holds = count('hw_hold_use');
    expect(holds).toBe(2);
    clock += 8 * DAY;
    expect(app.hardware.retain().samples).toBeGreaterThan(50);
    expect(count('hw_samples')).toBe(0);
    expect((await api('DELETE', `/hardware/${pc}`)).status).toBe(200);
    expect(count('hw_hold_use')).toBe(holds);
    expect(count('hw_use_days')).toBeGreaterThan(0);
    clock += 400 * DAY;
    expect(app.hardware.retain()).toMatchObject({ holds: 2 });
    expect(count('hw_hold_use') + count('hw_use_days')).toBe(0);
  });
});
