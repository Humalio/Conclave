/** Hardware control (docs/hardware.md): enforced opening hours, daily allowances split at midnight, pausing a machine,
   flags with a kind, and What ran with its analysis. The hub's clock (app.hardware.now) walks each machine through the day. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { localDay, openIntervals } from '../src/hardware/hardware.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const H = 3_600_000, M = 60_000;
// Monday 7 December 2026, 00:00 UTC; every machine here runs on UTC.
const D1 = Date.UTC(2026, 11, 7), D2 = D1 + 24 * H;
let T = D1;
let app: App, base = '', cookie = '', csrf = '', appKey = '';
let n = 0;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  return { id: a.id, cred: k.credential.id, label: a.label, S };
}
type Agent = Awaited<ReturnType<typeof agent>>;
const notices = async (x: Agent, kind: string) => ((await x.S('session_whoami')).structuredContent?.notices ?? []).filter((m: any) => m.kind === kind) as { seq: number; body: string }[];
const text = (r: Res) => r.content.map((c) => c.text).join('\n');
const audit = (action: string) => app.db.prepare('SELECT target_id, details FROM audit_events WHERE action=? ORDER BY id').all(action) as { target_id: string; details: string }[];
const holder = (m: string) => (app.db.prepare('SELECT agent_id FROM hw_queue WHERE machine_id=? AND held_since IS NOT NULL').get(m) as { agent_id: string } | undefined)?.agent_id ?? null;
const order = (m: string) => (app.db.prepare('SELECT agent_id FROM hw_queue WHERE machine_id=? ORDER BY seq').all(m) as { agent_id: string }[]).map((r) => r.agent_id);
const task = (team: string, who: Agent, title: string) => app.teams.hubTask(team, { title, description: 'Train the model.', assignee: who.id })!.id;
const machine = async (id: string) => (await api('GET', '/hardware?period=7d&tz=UTC')).body.machines.find((m: any) => m.id === id);
const at = (t: number) => { T = t; app.hardware.sweepAll(); };

let ana: Agent, ben: Agent, cy: Agent, dee: Agent;
let teamA = '', teamB = '';
const base0 = { access: 'ssh gpu (alias in your ~/.ssh/config)', timezone: 'UTC', memory_gb: 64, cpus: 16, gpu: 'RTX 4090' };
const OPEN_DAY = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '08:00', to: '22:00' }];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahhwc-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  app.hardware.now = () => T;
  const pc = (await api('POST', '/pcs', { name: 'office' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 50 }, sys).secret;
  [ana, ben, cy, dee] = [await agent('ana'), await agent('ben'), await agent('cy'), await agent('dee')];
  teamA = app.teams.create({ name: 'Model Lab', goal: 'g', members: [{ agent_id: ana.id, role: 'coordinator', credential_id: ana.cred }, { agent_id: ben.id, role: 'worker', credential_id: ben.cred }, { agent_id: dee.id, role: 'worker', credential_id: dee.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Other Lab', goal: 'g', members: [{ agent_id: cy.id, role: 'coordinator', credential_id: cy.cred }] }, sys).id;
  for (const t of [teamA, teamB]) app.teams.start(t, sys);
});
afterAll(async () => { await app?.close(); });

describe('opening hours are enforced', () => {
  let pcW = '', tA = '';
  it('a join at 23:00 on a machine open 08:00–22:00 waits, and becomes holder at 08:00', async () => {
    pcW = (await api('POST', '/pcs', { name: 'day-box' })).body.pc.id;
    expect((await api('PUT', `/hardware/${pcW}`, { ...base0, windows: OPEN_DAY, teams: [teamA] })).status).toBe(200);
    tA = task(teamA, ana, 'Train in the day');
    T = D1 + 23 * H;
    const j = await ana.S('hw_join', { machine: 'day-box', task_id: tA, estimate_minutes: 600 });
    expect(j.structuredContent).toMatchObject({ holder: false, line: 1 });
    expect(j.structuredContent.waiting_because).toContain('closed until');
    expect(text(j)).toContain('nobody holds it because the machine is closed');
    expect(text(await ana.S('hw_list'))).toContain('day-box (' + pcW + '): Closed; the next window opens');
    at(D2 + 8 * H - M);
    expect(holder(pcW)).toBeNull();
    at(D2 + 8 * H);
    expect(holder(pcW)).toBe(ana.id);
    expect((await notices(ana, 'hardware_hold')).length).toBe(1);
    expect((await machine(pcW)).availability).toMatchObject({ now: true, until: '22:00', ends_at: D2 + 22 * H });
  });

  it('a holder at 21:50 gets a notice once; at 22:00 the hold is flagged past window and not removed', async () => {
    at(D2 + 21 * H + 50 * M);
    at(D2 + 21 * H + 51 * M);
    const warn = await notices(ana, 'hardware_window_ending');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.body).toContain('ends at 22:00 (UTC), in 10 minutes');
    expect((await machine(pcW)).flags).toEqual([]);
    at(D2 + 22 * H);
    at(D2 + 22 * H + M);
    const m = await machine(pcW);
    expect(m.holder.agent_id).toBe(ana.id);
    expect(m.flags).toHaveLength(1);
    expect(m.flags[0]).toMatchObject({ kind: 'window', reason: null, agent_id: ana.id, task_id: tA });
    expect(JSON.parse(audit('hardware.flag').at(-1)!.details)).toMatchObject({ machine: pcW, kind: 'window' });
    expect((await notices(ana, 'hardware_flagged')).length).toBe(1);
    expect(m.what_ran[0]).toMatchObject({ agent_id: ana.id, team_id: teamA, held_since: D2 + 8 * H, ended_at: null, flags: ['window'] });
    // Cleared, it is not raised again for the same hold.
    await api('POST', `/hardware/flags/${m.flags[0].id}/clear`);
    at(D2 + 22 * H + 2 * M);
    expect((await machine(pcW)).flags).toEqual([]);
    await ana.S('hw_leave', { machine: 'day-box', outcome: 'done' });
    expect((await machine(pcW)).what_ran[0]).toMatchObject({ ended_at: D2 + 22 * H + 2 * M, ended: 'done' });
  });

  it('the open intervals of a window past midnight split across the two days', () => {
    const c = { timezone: 'UTC', windows: [{ days: ['mon' as const], from: '22:00', to: '02:00' }] };
    expect(openIntervals(c, D1, D1 + 2 * 24 * H)).toEqual([[D1 + 22 * H, D1 + 26 * H]]);
    expect(localDay('Europe/Lisbon', Date.UTC(2026, 2, 29, 12))).toMatchObject({ date: '2026-03-29', end: Date.UTC(2026, 2, 29, 23) }); // a 23-hour day
  });
});

describe('daily allowances', () => {
  let pcA = '', tAna = '', tBen = '', tCy = '', tDee = '';
  it('a team with 0.5 h left keeps its place at the head of the line, and the next eligible team holds the machine', async () => {
    pcA = (await api('POST', '/pcs', { name: 'shared-box' })).body.pc.id;
    expect((await api('PUT', `/hardware/${pcA}`, { ...base0, windows: [], teams: [teamA, teamB], allowances: { [teamA]: 2 } })).status).toBe(200);
    [tAna, tBen, tCy, tDee] = [task(teamA, ana, 'Fine-tune'), task(teamA, ben, 'Evaluate'), task(teamB, cy, 'Render'), task(teamA, dee, 'Sweep')];
    T = D1 + 10 * H;
    expect((await ana.S('hw_join', { machine: 'shared-box', task_id: tAna })).structuredContent.holder).toBe(true);
    T = D1 + 10 * H + 5 * M;
    await ben.S('hw_join', { machine: 'shared-box', task_id: tBen, estimate_minutes: 60 });
    T = D1 + 10 * H + 6 * M;
    await cy.S('hw_join', { machine: 'shared-box', task_id: tCy });
    T = D1 + 11 * H + 30 * M;
    await ana.S('hw_leave', { machine: 'shared-box', outcome: 'done' });
    expect(holder(pcA)).toBe(cy.id);
    expect(order(pcA)).toEqual([ben.id, cy.id]);
    const l = text(await ben.S('hw_list'));
    expect(l).toContain('You: waiting, number 1 in line.');
    expect(l).toContain("Your teams' hours today: Model Lab, 0.5 h left of 2 h, resets Tue 00:00");
    const m = await machine(pcA);
    expect(m.allowances.find((a: any) => a.team_id === teamA)).toMatchObject({ daily_hours: 2, used_ms: 1.5 * H, left_ms: 0.5 * H, resets_at: D2 });
    expect(m.allowances.find((a: any) => a.team_id === teamB)).toMatchObject({ daily_hours: null, left_ms: null });
  });

  it('with nobody holding, the entry that does not fit still waits and says why', async () => {
    T = D1 + 12 * H;
    await cy.S('hw_leave', { machine: 'shared-box', outcome: 'done' });
    expect(holder(pcA)).toBeNull();
    expect(text(await ben.S('hw_list'))).toContain('number 1 in line: your team has 0.5 h left today, less than your estimate; it resets Tue 00:00 (UTC)');
    await ben.S('hw_leave', { machine: 'shared-box', outcome: 'cancelled' });
  });

  it('warns the holder 10 minutes before its team\'s allowance ends, then flags the hold without removing it', async () => {
    expect((await dee.S('hw_join', { machine: 'shared-box', task_id: tDee })).structuredContent.holder).toBe(true);
    at(D1 + 12 * H + 21 * M);
    expect((await notices(dee, 'hardware_allowance_ending'))[0]!.body).toContain("Model Lab's 2 h on shared-box today run out in 9 minutes");
    at(D1 + 12 * H + 30 * M);
    at(D1 + 12 * H + 31 * M);
    const m = await machine(pcA);
    expect(m.holder.agent_id).toBe(dee.id);
    expect(m.flags.map((f: any) => f.kind)).toEqual(['allowance']);
    expect(m.flags[0].team_name).toBe('Model Lab');
    await dee.S('hw_leave', { machine: 'shared-box', outcome: 'done' });
  });

  it('a join is refused when the team has no hours left today, with the reset time', async () => {
    const r = await ben.S('hw_join', { machine: 'shared-box', task_id: tBen });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Model Lab has used its 2 h on shared-box today. The allowance resets at Tue 00:00 (UTC)');
    expect(order(pcA)).toEqual([]);
  });

  it('held time is split at local midnight', async () => {
    expect((await api('PUT', `/hardware/${pcA}`, { ...base0, windows: [], teams: [teamA, teamB], allowances: { [teamB]: 3 } })).status).toBe(200);
    expect((await machine(pcA)).allowances.find((a: any) => a.team_id === teamA).daily_hours).toBe(2); // kept: the input named no allowance for it
    T = D1 + 23 * H;
    expect((await cy.S('hw_join', { machine: 'shared-box', task_id: tCy })).structuredContent.holder).toBe(true);
    T = D2 + H;
    const m = await machine(pcA);
    expect(m.allowances.find((a: any) => a.team_id === teamB)).toMatchObject({ used_ms: H, left_ms: 2 * H, resets_at: D2 + 24 * H });
    const day = (d: number) => m.analysis.days.find((x: any) => x.date === new Date(d).toISOString().slice(0, 10));
    expect(day(D1).teams[teamB]).toBe(0.5 * H + H); // 11:30–12:00 and 23:00–24:00
    expect(day(D2).teams[teamB]).toBe(H);
    // A new day: Model Lab may join again.
    expect((await ben.S('hw_join', { machine: 'shared-box', task_id: tBen })).isError).toBeFalsy();
    T = D2 + 2 * H;
    await cy.S('hw_leave', { machine: 'shared-box', outcome: 'done' });
    expect(holder(pcA)).toBe(ben.id);
    await ben.S('hw_leave', { machine: 'shared-box', outcome: 'done' });
  });
});

describe('pausing a machine', () => {
  it('a paused machine takes joins as waiting; resuming promotes the first eligible entry; both are audited', async () => {
    const pcP = (await api('POST', '/pcs', { name: 'pause-box' })).body.pc.id;
    await api('PUT', `/hardware/${pcP}`, { ...base0, windows: [], teams: [teamA] });
    T = D2 + 3 * H;
    expect((await api('POST', `/hardware/${pcP}/pause`)).status).toBe(200);
    const tk = task(teamA, dee, 'Profile');
    const j = await dee.S('hw_join', { machine: 'pause-box', task_id: tk });
    expect(j.structuredContent).toMatchObject({ holder: false, waiting_because: 'the operator paused the machine' });
    expect(text(await dee.S('hw_list'))).toContain('pause-box (' + pcP + '): Paused by the operator');
    expect((await machine(pcP)).paused).toBe(true);
    expect((await api('POST', `/hardware/${pcP}/resume`)).status).toBe(200);
    expect(holder(pcP)).toBe(dee.id);
    expect(audit('hardware.pause').map((e) => e.target_id)).toEqual([pcP]);
    expect(audit('hardware.resume').map((e) => e.target_id)).toEqual([pcP]);
    // Paused with a holder: it keeps the machine; when it leaves, nobody new holds it until resume.
    await api('POST', `/hardware/${pcP}/pause`);
    const tb = task(teamA, ben, 'Benchmark');
    await ben.S('hw_join', { machine: 'pause-box', task_id: tb });
    expect(holder(pcP)).toBe(dee.id);
    await dee.S('hw_leave', { machine: 'pause-box', outcome: 'done' });
    expect(holder(pcP)).toBeNull();
    await api('POST', `/hardware/${pcP}/resume`);
    expect(holder(pcP)).toBe(ben.id);
    await ben.S('hw_leave', { machine: 'pause-box', outcome: 'done' });
  });
});

describe('What ran and the analysis', () => {
  it('for 7 days, hours held per team and the waits match the holds in What ran', async () => {
    T = D2 + 23 * H;
    const r = (await api('GET', '/hardware?period=7d&tz=UTC')).body;
    expect(r.counts).toMatchObject({ machines: 3, in_use: 0, waiting: 0 });
    for (const m of r.machines) {
      const per: Record<string, number> = {};
      for (const h of m.what_ran) if ((h.ended_at ?? T) > h.held_since) per[h.team_id] = (per[h.team_id] ?? 0) + (h.ended_at ?? T) - h.held_since;
      expect(Object.fromEntries(m.analysis.teams.map((t: any) => [t.id, t.ms]))).toEqual(per);
      const waits = m.what_ran.map((h: any) => h.held_since - h.joined_at).sort((a: number, b: number) => a - b);
      expect(m.analysis.waits.longest_ms).toBe(waits.at(-1) ?? null);
      expect(m.analysis.waits.n).toBe(waits.length);
      expect(m.analysis.flagged).toBe(m.what_ran.filter((h: any) => h.flags.length).length);
    }
    const day = r.machines.find((m: any) => m.name === 'day-box');
    expect(day.analysis.waits.longest_ms).toBe(9 * H); // joined 23:00, held 08:00
    // Open 14 h a day; held 08:00–22:02 on the second day only.
    expect(day.analysis.held_open_ms).toBe(14 * H);
    expect(r.analysis.teams.reduce((n: number, t: any) => n + t.ms, 0)).toBe(r.machines.reduce((n: number, m: any) => n + m.analysis.held_ms, 0));
    expect(r.analysis.top_tasks[0]).toMatchObject({ task_title: 'Train in the day', team_name: 'Model Lab' });
    expect(day.week[1][9]).toBe(60); // Tuesday 09:00–10:00 held
  });

  it('the toolbar filters narrow What ran and the analysis, and the chips count what each would show', async () => {
    const all = (await api('GET', '/hardware?period=7d&tz=UTC')).body;
    const b = (await api('GET', `/hardware?period=7d&tz=UTC&team=${teamB}`)).body;
    expect(b.counts.shown).toBe(all.machines.flatMap((m: any) => m.what_ran).filter((h: any) => h.team_id === teamB).length);
    expect(b.machines.flatMap((m: any) => m.what_ran).every((h: any) => h.team_id === teamB)).toBe(true);
    expect(b.analysis.teams.map((t: any) => t.id)).toEqual([teamB]);
    expect(all.facets.team.find((f: any) => f.id === teamB).n).toBe(b.counts.shown);
    const q = (await api('GET', '/hardware?period=7d&tz=UTC&q=render')).body;
    expect(q.counts.shown).toBeGreaterThan(0);
    expect(q.machines.flatMap((m: any) => m.what_ran).every((h: any) => h.task_title === 'Render')).toBe(true);
    expect((await api('GET', '/hardware?period=1y')).status).toBe(400);
  });
});
