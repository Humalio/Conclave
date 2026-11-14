/** Hardware (docs/hardware.md): a machine's compute role, its ordered waiting list, the holder's report, and losing eligibility. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { availability, windowsText } from '../src/hardware/hardware.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', appKey = '';
let n = 0;
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie, 'x-csrf-token': csrf }) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
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
const queue = (m: string) => app.db.prepare('SELECT agent_id, held_since IS NOT NULL held FROM hw_queue WHERE machine_id=? ORDER BY seq').all(m) as { agent_id: string; held: number }[];
const task = (team: string, who: Agent, title: string) => app.teams.hubTask(team, { title, description: 'Train the model.', assignee: who.id })!.id;
const setTask = (id: string, set: string) => app.db.prepare(`UPDATE tasks SET ${set} WHERE id=?`).run(id);

let ana: Agent, ben: Agent, cy: Agent, dee: Agent, out: Agent;
let teamA = '', teamB = '', pc = '', spare = '';
const COMPUTE = { access: 'ssh gpu-box (alias in your ~/.ssh/config)', timezone: 'Europe/Lisbon', windows: [], memory_gb: 64, cpus: 16, gpu: 'RTX 4090', notes: 'Clean up /scratch when done.' };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahhw-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pc = (await api('POST', '/pcs', { name: 'gpu-box' })).body.pc.id;
  spare = (await api('POST', '/pcs', { name: 'spare' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 50 }, sys).secret;
  [ana, ben, cy, dee, out] = [await agent('ana'), await agent('ben'), await agent('cy'), await agent('dee'), await agent('out')];
  teamA = app.teams.create({ name: 'Model Lab', goal: 'g', members: [{ agent_id: ana.id, role: 'coordinator', credential_id: ana.cred }, { agent_id: ben.id, role: 'worker', credential_id: ben.cred }, { agent_id: dee.id, role: 'worker', credential_id: dee.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Other Lab', goal: 'g', members: [{ agent_id: cy.id, role: 'coordinator', credential_id: cy.cred }] }, sys).id;
  const teamC = app.teams.create({ name: 'Unserved Lab', goal: 'g', members: [{ agent_id: out.id, role: 'coordinator', credential_id: out.cred }] }, sys).id;
  for (const t of [teamA, teamB, teamC]) app.teams.start(t, sys);
});
afterAll(async () => { await app?.close(); });

describe('registering a machine', () => {
  it('needs the operator and the CSRF token, and validates the fields', async () => {
    expect((await api('PUT', `/hardware/${pc}`, { ...COMPUTE, teams: [teamA] }, {})).status).toBe(401);
    expect((await api('PUT', `/hardware/${pc}`, { ...COMPUTE, teams: [teamA] }, { cookie })).status).toBe(403);
    expect((await api('PUT', `/hardware/${pc}`, { ...COMPUTE, timezone: 'Mars/Olympus', teams: [teamA] })).status).toBe(400);
    expect((await api('PUT', `/hardware/${pc}`, { ...COMPUTE, windows: [{ days: ['mon'], from: '9am', to: '18:00' }], teams: [teamA] })).status).toBe(400);
    expect((await api('PUT', `/hardware/${pc}`, { ...COMPUTE, teams: ['team-nope'] })).status).toBe(404);
    expect((await api('PUT', `/hardware/${pc}`, { ...COMPUTE, extra: 1, teams: [teamA] })).status).toBe(400);
    expect((await api('PUT', '/hardware/pc-nope', { ...COMPUTE, teams: [teamA] })).status).toBe(404);
    expect(app.db.prepare('SELECT COUNT(*) n FROM hw_machines').get()).toEqual({ n: 0 });
  });

  it('registers, shows it in the overview, and audits it', async () => {
    const r = await api('PUT', `/hardware/${pc}`, { ...COMPUTE, teams: [teamA, teamB] });
    expect(r.status).toBe(200);
    const m = r.body.machines.find((x: any) => x.id === pc);
    expect(m).toMatchObject({ name: 'gpu-box', access: COMPUTE.access, timezone: 'Europe/Lisbon', memory_gb: 64, cpus: 16, gpu: 'RTX 4090', holder: null, waiting: [], flags: [] });
    expect(m.teams.map((t: any) => t.name)).toEqual(['Model Lab', 'Other Lab']);
    expect(m.availability.any).toBe(true);
    expect(audit('hardware.register').map((e) => e.target_id)).toEqual([pc]);
  });

  it('the preview is what an agent sees in hw_list', async () => {
    const p = await api('POST', '/hardware/preview', { ...COMPUTE, pc_id: pc, teams: [teamA] });
    expect(p.status).toBe(200);
    const list = text(await ana.S('hw_list'));
    expect(list).toContain(p.body.text.split('\n  Holder:')[0]);
    expect(p.body.text).toContain('Limits, declared by the operator and not measured: memory 64 GB · 16 CPUs · GPU RTX 4090');
    // A machine not registered yet previews too.
    expect((await api('POST', '/hardware/preview', { ...COMPUTE, teams: [] })).body.text).toContain('Access: ssh gpu-box');
  });

  it('agents of teams it does not serve see no machine and cannot join', async () => {
    expect(text(await out.S('hw_list'))).toMatch(/^No machine is offered to your teams./);
    const t = task((app.db.prepare("SELECT team_id FROM team_members WHERE agent_id=?").get(out.id) as { team_id: string }).team_id, out, 'Out task');
    const j = await out.S('hw_join', { machine: 'gpu-box', task_id: t });
    expect(j.isError).toBe(true);
    expect(text(j)).toContain('No machine of that name is offered to your teams');
  });
});

describe('the waiting list', () => {
  let tAna = '', tBen = '';
  it('two agents join: the first holds at once, the second waits', async () => {
    tAna = task(teamA, ana, 'Train the tern model'); tBen = task(teamA, ben, 'Evaluate checkpoints');
    const a = await ana.S('hw_join', { machine: 'gpu-box', task_id: tAna, estimate_minutes: 90 });
    expect(a.isError).toBeFalsy();
    expect(a.structuredContent).toMatchObject({ holder: true, position: 1 });
    const b = await ben.S('hw_join', { machine: pc, task_id: tBen, estimate_minutes: 30 });
    expect(b.structuredContent).toMatchObject({ holder: false, position: 2 });
    expect(text(b)).toContain('number 1 in line');
    expect(queue(pc)).toEqual([{ agent_id: ana.id, held: 1 }, { agent_id: ben.id, held: 0 }]);
    // Ana held at once, so no hold notice for her.
    expect(await notices(ana, 'hardware_hold')).toHaveLength(0);
  });

  it('refuses a duplicate join, someone else\'s task, and a report by a waiting agent', async () => {
    expect(text(await ana.S('hw_join', { machine: 'gpu-box', task_id: tAna }))).toContain('already on gpu-box');
    const j = await dee.S('hw_join', { machine: 'gpu-box', task_id: tBen });
    expect(j.isError).toBe(true);
    expect(text(j)).toContain('That task is not assigned to you.');
    const r = await ben.S('hw_report', { machine: 'gpu-box', progress: 'Waiting.' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Only the holder reports');
    const done = task(teamA, dee, 'Finished work'); setTask(done, "status='done'");
    expect(text(await dee.S('hw_join', { machine: 'gpu-box', task_id: done }))).toContain('this one is done');
  });

  it('the holder reports progress and a new estimate; the operator sees it', async () => {
    const r = await ana.S('hw_report', { machine: 'gpu-box', progress: 'Epoch 3 of 10, loss 0.41.', estimate_minutes: 60 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.estimate_until).toBeGreaterThan(Date.now() + 59 * 60_000);
    const m = (await api('GET', '/hardware')).body.machines.find((x: any) => x.id === pc);
    expect(m.holder).toMatchObject({ agent_id: ana.id, label: ana.label, task_title: 'Train the tern model', report: 'Epoch 3 of 10, loss 0.41.' });
    expect(m.waiting.map((e: any) => e.agent_id)).toEqual([ben.id]);
    expect(text(await ben.S('hw_list'))).toContain('last report');
  });

  it('agents of another team see the list without names or tasks', async () => {
    const l = await cy.S('hw_list');
    expect(text(l)).toContain('Holder: an agent of another team');
    expect(text(l)).not.toContain('Train the tern model');
    expect(text(l)).not.toContain('Epoch 3');
    expect(JSON.stringify(l.structuredContent)).not.toContain(ana.id);
    expect(JSON.stringify(l.structuredContent)).not.toContain('Evaluate checkpoints');
  });

  it('releasing moves the next entry up and notifies it', async () => {
    const l = await ana.S('hw_leave', { machine: 'gpu-box', outcome: 'done', note: 'Model saved.' });
    expect(l.structuredContent).toMatchObject({ outcome: 'done', moved_up: true });
    expect(queue(pc)).toEqual([{ agent_id: ben.id, held: 1 }]);
    const hold = await notices(ben, 'hardware_hold');
    expect(hold).toHaveLength(1);
    expect(hold[0]!.body).toContain(`You now hold gpu-box for task ${tBen}`);
    expect(JSON.stringify(audit('hardware.leave').map((e) => JSON.parse(e.details)))).toContain('"outcome":"done"');
    expect(audit('hardware.hold').map((e) => e.target_id)).toEqual([ana.id, ben.id]);
  });

  it('a waiting agent cancels; the holder is unchanged', async () => {
    const t = task(teamA, dee, 'Small sweep');
    await dee.S('hw_join', { machine: 'gpu-box', task_id: t });
    const c = await dee.S('hw_leave', { machine: 'gpu-box', outcome: 'cancelled' });
    expect(c.structuredContent).toMatchObject({ outcome: 'cancelled', moved_up: false });
    expect(queue(pc)).toEqual([{ agent_id: ben.id, held: 1 }]);
    expect(await notices(dee, 'hardware_hold')).toHaveLength(0);
    await ben.S('hw_leave', { machine: 'gpu-box', outcome: 'cancelled' });
    expect(queue(pc)).toEqual([]);
  });

  it('two simultaneous joins give one holder and one waiting entry', async () => {
    const [t1, t2] = [task(teamA, ana, 'Race one'), task(teamB, cy, 'Race two')];
    const [r1, r2] = await Promise.all([ana.S('hw_join', { machine: 'gpu-box', task_id: t1 }), cy.S('hw_join', { machine: 'gpu-box', task_id: t2 })]);
    expect([r1, r2].every((r) => !r.isError)).toBe(true);
    expect([r1.structuredContent.holder, r2.structuredContent.holder].sort()).toEqual([false, true]);
    expect(queue(pc).map((q) => q.held)).toEqual([1, 0]);
    // Clean up for the next tests.
    for (const a of [ana, cy]) await a.S('hw_leave', { machine: 'gpu-box', outcome: 'cancelled' });
  });
});

describe('losing eligibility', () => {
  it('a cancelled task removes the holder, raises a flag, and moves the next entry up', async () => {
    const tA = task(teamA, ana, 'Long run'), tB = task(teamA, ben, 'Next run');
    await ana.S('hw_join', { machine: 'gpu-box', task_id: tA });
    await ben.S('hw_join', { machine: 'gpu-box', task_id: tB });
    const before = (await notices(ben, 'hardware_hold')).length;
    setTask(tA, "status='cancelled'");
    const m = (await api('GET', '/hardware')).body.machines.find((x: any) => x.id === pc);
    expect(m.holder.agent_id).toBe(ben.id);
    expect(m.flags).toHaveLength(1);
    expect(m.flags[0]).toMatchObject({ agent_id: ana.id, task_id: tA, reason: 'task' });
    const gone = await notices(ana, 'hardware_removed');
    expect(gone.at(-1)!.body).toContain('no longer have the task you joined with');
    expect(gone.at(-1)!.body).toContain('Stop using the machine now.');
    expect((await notices(ben, 'hardware_hold')).length).toBe(before + 1);
    // The operator clears the flag.
    const c = await api('POST', `/hardware/flags/${m.flags[0].id}/clear`);
    expect(c.status).toBe(200);
    expect(c.body.machines.find((x: any) => x.id === pc).flags).toEqual([]);
    expect((await api('POST', `/hardware/flags/${m.flags[0].id}/clear`)).status).toBe(404);
    expect(audit('hardware.flag_clear')).toHaveLength(1);
  });

  it('a reassigned task removes a waiting entry without a flag', async () => {
    const t = task(teamA, dee, 'Reassigned run');
    await dee.S('hw_join', { machine: 'gpu-box', task_id: t });
    app.db.prepare('UPDATE tasks SET assignee_agent_id=? WHERE id=?').run(ana.id, t);
    await ben.S('hw_list');
    expect(queue(pc).map((q) => q.agent_id)).toEqual([ben.id]);
    expect((await api('GET', '/hardware')).body.machines.find((x: any) => x.id === pc).flags).toEqual([]);
    expect((await notices(dee, 'hardware_removed')).at(-1)!.body).not.toContain('Stop using');
  });

  it('the team taken off the machine loses access: the holder goes with an access flag', async () => {
    const t = task(teamB, cy, 'Other run');
    await cy.S('hw_join', { machine: 'gpu-box', task_id: t });
    expect(queue(pc).map((q) => q.agent_id)).toEqual([ben.id, cy.id]);
    // Ben leaves, Cy holds; then the operator stops serving Other Lab.
    await ben.S('hw_leave', { machine: 'gpu-box', outcome: 'done' });
    expect(queue(pc)).toEqual([{ agent_id: cy.id, held: 1 }]);
    const r = await api('PUT', `/hardware/${pc}`, { ...COMPUTE, teams: [teamA] });
    expect(r.status).toBe(200);
    expect(queue(pc)).toEqual([]);
    const m = r.body.machines.find((x: any) => x.id === pc);
    expect(m.flags.map((f: any) => [f.agent_id, f.reason])).toEqual([[cy.id, 'access']]);
    expect((await notices(cy, 'hardware_removed')).at(-1)!.body).toContain('no longer have access to it');
    expect(text(await cy.S('hw_list'))).toMatch(/^No machine is offered to your teams./);
    await api('POST', `/hardware/flags/${m.flags[0].id}/clear`);
  });

  it('the operator removes an entry; the next one moves up', async () => {
    const [t1, t2] = [task(teamA, ana, 'Op one'), task(teamA, dee, 'Op two')];
    await ana.S('hw_join', { machine: 'gpu-box', task_id: t1 });
    await dee.S('hw_join', { machine: 'gpu-box', task_id: t2 });
    const seq = (await api('GET', '/hardware')).body.machines.find((x: any) => x.id === pc).holder.seq;
    expect((await api('POST', `/hardware/entries/${seq}/remove`, undefined, { cookie })).status).toBe(403);
    const r = await api('POST', `/hardware/entries/${seq}/remove`);
    expect(r.status).toBe(200);
    expect(queue(pc)).toEqual([{ agent_id: dee.id, held: 1 }]);
    expect((await notices(ana, 'hardware_removed')).at(-1)!.body).toContain('The operator took you off');
    expect(JSON.parse(audit('hardware.remove').at(-1)!.details)).toMatchObject({ reason: 'operator', held: true });
  });

  it('the upkeep removes a holder whose task ended, with nobody calling a Hardware tool, and moves the next one up', async () => {
    const tDee = (app.db.prepare('SELECT task_id FROM hw_queue WHERE machine_id=? AND agent_id=?').get(pc, dee.id) as { task_id: string }).task_id;
    const tBen = task(teamA, ben, 'Upkeep run');
    await ben.S('hw_join', { machine: 'gpu-box', task_id: tBen });
    const held = (await notices(ben, 'hardware_hold')).length, gone = (await notices(dee, 'hardware_removed')).length;
    setTask(tDee, "status='done'");
    expect(queue(pc)).toEqual([{ agent_id: dee.id, held: 1 }, { agent_id: ben.id, held: 0 }]);
    app.hardware.sweepAll(); // what the hub's 30 s upkeep runs
    expect(queue(pc)).toEqual([{ agent_id: ben.id, held: 1 }]);
    expect((await notices(ben, 'hardware_hold')).length).toBe(held + 1);
    const removed = await notices(dee, 'hardware_removed');
    expect(removed.length).toBe(gone + 1);
    expect(removed.at(-1)!.body).toContain('Stop using the machine now.');
    expect(app.db.prepare('SELECT agent_id, reason FROM hw_flags WHERE machine_id=? AND cleared_at IS NULL').all(pc)).toEqual([{ agent_id: dee.id, reason: 'task' }]);
    const upkeep = readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8').split(/\r?\n/).find((l) => l.includes('const upkeep = setInterval'))!;
    expect(upkeep).toContain('hardware.sweepAll();');
  });

  it('refuses a report or a leave note that carries a credential', async () => {
    const key = 'login with ah_ses_abcdefghijkl_abcdefghijklmnopqrstuvwxyz234567'; // the shape of a hub key, not a real one
    const r = await ben.S('hw_report', { machine: 'gpu-box', progress: key });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/contains_key|must not contain a key/);
    expect((await ben.S('hw_leave', { machine: 'gpu-box', outcome: 'done', note: key })).isError).toBe(true);
    expect(queue(pc)).toEqual([{ agent_id: ben.id, held: 1 }]);
    expect(app.db.prepare('SELECT report FROM hw_queue WHERE machine_id=?').get(pc)).toEqual({ report: null });
  });

  it('unregistering ends every entry, tells the agents and closes the open flags', async () => {
    const r = await api('DELETE', `/hardware/${pc}`);
    expect(r.body).toEqual({ ended: 1 });
    expect(queue(pc)).toEqual([]);
    expect(app.db.prepare('SELECT COUNT(*) n FROM hw_flags WHERE machine_id=? AND cleared_at IS NULL').get(pc)).toEqual({ n: 0 });
    expect(JSON.parse(audit('hardware.unregister').at(-1)!.details)).toMatchObject({ ended: 1, flags_cleared: 1 });
    expect((await notices(ben, 'hardware_removed')).at(-1)!.body).toContain('no longer offered for compute');
    expect(text(await dee.S('hw_list'))).toMatch(/^No machine is offered to your teams./);
    expect((await api('DELETE', `/hardware/${spare}`)).status).toBe(404);
  });
});

describe('scheduled windows', () => {
  // Wednesday 2026-11-18 23:30 UTC.
  const at = Date.UTC(2026, 10, 18, 23, 30);
  it('a window past midnight is open late on its day and early the next', () => {
    const c = { timezone: 'UTC', windows: [{ days: ['wed' as const], from: '22:00', to: '06:00' }] };
    expect(availability(c, at)).toEqual({ any: false, now: true, until: '06:00', next: 'Wed 22:00' });
    expect(availability(c, at + 5 * 3600_000)).toMatchObject({ now: true, until: '06:00' }); // Thursday 04:30
    expect(availability(c, at + 7 * 3600_000)).toMatchObject({ now: false, until: null, next: 'Wed 22:00' }); // Thursday 06:30
  });
  it('reads the time in the machine\'s own time zone', () => {
    // 23:30 UTC on Wednesday is 18:30 in New York (UTC-5 in November).
    const w = [{ days: ['wed' as const], from: '12:00', to: '19:00' }];
    expect(availability({ timezone: 'America/New_York', windows: w }, at)).toMatchObject({ now: true, until: '19:00' });
    expect(availability({ timezone: 'UTC', windows: w }, at)).toMatchObject({ now: false, next: 'Wed 12:00' });
  });
  it('labels windows in words', () => {
    expect(windowsText([])).toBe('Any time');
    expect(windowsText([{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' }, { days: ['sat', 'sun'], from: '10:00', to: '14:00' }])).toBe('Mon–Fri 09:00–18:00; Sat, Sun 10:00–14:00');
  });
});
