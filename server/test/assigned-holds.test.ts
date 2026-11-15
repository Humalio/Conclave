/**
 * Assigned work does not drop back to open for reasons that are not the member's silence (docs/specification.md, "Task
 * turns and deadlines": "Holds stop the sweep", "A reviewer leaves", "An author leaves"): a lockdown or an operator pause
 * longer than the lease releases nothing and restarts the lease when it lifts; removing a member or the last reviewer keeps
 * submitted work in review with its author; task_assign's text says what the spec says about silent polling members.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const LEASE = 30 * 60_000;
let app: App, base: string, cookie = '', csrf = '', appKey = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
const clients: Client[] = [];
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
let n = 0;
const mk = (label: string) => {
  const agent = app.keys.createAgent(`${label} ${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  return { id: agent.id, secret: k.secret };
};
/** As if the member had made no call for `ms`. */
const silence = (teamId: string, agentId: string, ms: number) => {
  const at = Date.now() - ms;
  app.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(at, agentId);
  app.db.prepare('UPDATE team_members SET joined_at=MIN(joined_at, ?), last_work_next_at=MIN(COALESCE(last_work_next_at, ?), ?), busy_until=NULL WHERE team_id=? AND agent_id=? AND removed_at IS NULL')
    .run(at, at, at, teamId, agentId);
};
/** As if the hold had been on for `ms`: the flag's set time moves back. */
const heldFor = (key: string, ms: number) => app.db.prepare('UPDATE system_settings SET updated_at=? WHERE key=?').run(Date.now() - ms, key);
const lock = async (scope: string, id: string | undefined, on: boolean) => expect((await api('POST', '/lockdown', { scope, id, on })).status).toBe(200);

/** Coordinator, two workers, one reviewer; started. W1 holds a queued and a started task. */
async function team(mode: 'poll' | 'on_demand' = 'poll') {
  const [c, w1, w2, r] = ['coord', 'w1', 'w2', 'rev'].map(mk) as ReturnType<typeof mk>[];
  const res = await api('POST', '/teams', { name: `holds ${++n}`, goal: 'ship it',
    members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w1!.id, role: 'worker' }, { agent_id: w2!.id, role: 'worker' }, { agent_id: r!.id, role: 'reviewer' }] });
  expect(res.status).toBe(201);
  const tid = res.body.team.id as string;
  expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  if (mode === 'on_demand') expect((await api('PATCH', `/teams/${tid}`, { delivery_mode: 'on_demand' })).body.team.delivery_mode).toBe('on_demand');
  const [C, W1, R] = await Promise.all([c!, w1!, r!].map((x) => loginWith(x.secret)));
  const mkTask = async (title: string) => (await C!('task_create', { team_id: tid, title, reviewer: r!.id })).structuredContent.task as { id: string };
  const queued = await mkTask('queued'), started = await mkTask('started');
  for (const t of [queued, started]) expect((await C!('task_assign', { task_id: t.id, agent_id: w1!.id })).isError).toBeFalsy();
  expect((await W1!('task_start', { task_id: started.id })).isError).toBeFalsy();
  return { tid, c: c!, w1: w1!, r: r!, C: C!, W1: W1!, R: R!, queued: queued.id, started: started.id };
}
type T = Awaited<ReturnType<typeof team>>;
const task = (id: string) => app.teams.task(id)!;
const member = (X: T) => app.db.prepare('SELECT last_work_next_at FROM team_members WHERE team_id=? AND agent_id=?').get(X.tid, X.w1.id) as { last_work_next_at: number };
const stillHeld = (X: T) => {
  expect(task(X.queued)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w1.id });
  expect(task(X.started)).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w1.id });
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahholds-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined });
  app = await buildApp(config);
  intakeOpen(app);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('holds stop the sweep', () => {
  it('a lockdown of all writes longer than the lease releases nothing, and lifting it restarts the lease', async () => {
    const X = await team();
    await lock('writes', undefined, true);
    silence(X.tid, X.w1.id, LEASE + 60_000);
    heldFor('emergency.writes_disabled', LEASE + 60_000);
    app.teams.tick();
    stillHeld(X);
    const lifted = Date.now();
    await lock('writes', undefined, false);
    expect(member(X).last_work_next_at).toBeGreaterThanOrEqual(lifted);
    expect(task(X.started).lease_expires_at!).toBeGreaterThanOrEqual(lifted + LEASE);
    app.teams.tick();
    stillHeld(X);
    // The lease runs again: silent past it after the lift, the member loses its work as the spec says.
    silence(X.tid, X.w1.id, LEASE + 60_000);
    app.teams.tick();
    expect(task(X.queued)).toMatchObject({ status: 'open', lapsed_from: X.w1.id });
  });
  it('a lockdown of the team or of the agent holds the same way', async () => {
    for (const scope of ['team', 'agent'] as const) {
      const X = await team();
      const id = scope === 'team' ? X.tid : X.w1.id;
      await lock(scope, id, true);
      silence(X.tid, X.w1.id, LEASE + 60_000);
      app.teams.tick();
      stillHeld(X);
      await lock(scope, id, false);
      app.teams.tick();
      stillHeld(X);
    }
  });
  it('an on-demand check-in time that passes during a lockdown is not flagged, and moves by the time the hold lasted', async () => {
    const X = await team('on_demand');
    await lock('team', X.tid, true);
    const due = Date.now() - 60_000;
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(due, X.started);
    heldFor(`emergency.team_disabled.${X.tid}`, 2 * 3600_000);
    app.teams.tick();
    expect(task(X.started).overdue_at).toBeNull();
    await lock('team', X.tid, false);
    expect(task(X.started).lease_expires_at!).toBeGreaterThanOrEqual(due + 2 * 3600_000 - 5_000);
    app.teams.tick();
    expect(task(X.started).overdue_at).toBeNull();
  });
  it('an operator pause longer than the lease releases nothing, and resuming restarts the lease', async () => {
    const X = await team();
    expect((await api('POST', `/teams/${X.tid}/pause`, { reason: 'operator hold' })).status).toBe(200);
    silence(X.tid, X.w1.id, LEASE + 60_000);
    app.teams.tick();
    stillHeld(X);
    const resumed = Date.now();
    expect((await api('POST', `/teams/${X.tid}/resume`)).status).toBe(200);
    expect(member(X).last_work_next_at).toBeGreaterThanOrEqual(resumed);
    app.teams.tick();
    stillHeld(X);
  });
});

describe('submitted work keeps its author', () => {
  const submit = async (X: T) => {
    expect((await X.W1('task_submit', { task_id: X.started, summary: 'Done, with evidence' })).isError).toBeFalsy();
    return task(X.started);
  };
  it('removing the author leaves the task in review with them; approval works as usual', async () => {
    const X = await team();
    const before = await submit(X);
    app.teams.removeMember(X.tid, X.w1.id, sys);
    expect(task(X.started)).toMatchObject({ status: 'in_review', assignee_agent_id: X.w1.id, reviewer_agent_id: X.r.id, summary: 'Done, with evidence', submitted_version: before.submitted_version });
    expect(task(X.queued)).toMatchObject({ status: 'open', assignee_agent_id: null }); // queued work is freed as before
    const r = await X.R('task_review', { task_id: X.started, decision: 'approve', comments: 'Checked.', version: 1000 });
    expect(r.structuredContent.task.status).toBe('approved');
  });
  it('a request for changes after the author left returns it to open with the comments, for the coordinator to reassign', async () => {
    const X = await team();
    await submit(X);
    app.teams.removeMember(X.tid, X.w1.id, sys);
    const r = await X.R('task_review', { task_id: X.started, decision: 'request_changes', comments: 'Handle the empty case.', version: 1000 });
    expect(r.isError).toBeFalsy();
    expect(task(X.started)).toMatchObject({ status: 'open', assignee_agent_id: null, review_comments: 'Handle the empty case.', review_rounds: 1 });
  });
  it('approved work whose author left goes to open when the coordinator sends it back, never to a non-member', async () => {
    const X = await team();
    await submit(X);
    app.teams.removeMember(X.tid, X.w1.id, sys);
    expect((await X.R('task_review', { task_id: X.started, decision: 'approve', comments: 'Checked.', version: 1000 })).structuredContent.task.status).toBe('approved');
    const r = await X.C('task_reopen', { task_id: X.started, reason: 'The merge test failed.' });
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(task(X.started)).toMatchObject({ status: 'open', assignee_agent_id: null, review_comments: 'The merge test failed.', review_rounds: 1 });
    const turn = app.db.prepare('SELECT holder_agent_id FROM task_turns WHERE task_id=? AND closed_at IS NULL').get(X.started) as { holder_agent_id: string } | undefined;
    expect(turn?.holder_agent_id).not.toBe(X.w1.id);
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='task.reopen' AND target_id=?").get(X.started) as { n: number }).n).toBe(1);
  });
  it('removing the last reviewer leaves the task waiting in review for one, never open', async () => {
    const X = await team();
    await submit(X);
    app.teams.removeMember(X.tid, X.r.id, sys);
    expect(task(X.started)).toMatchObject({ status: 'in_review', assignee_agent_id: X.w1.id, reviewer_agent_id: null });
    const note = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='reviewer_missing' ORDER BY rowid DESC LIMIT 1").get(X.c.id) as { body: string };
    expect(note.body).toMatch(/waits in review for a reviewer.*task_update \(reviewer\)/);
    // The coordinator names a new reviewer and the review goes on.
    const nr = mk('rev2');
    app.teams.addMember(X.tid, { agent_id: nr.id, role: 'reviewer' }, sys);
    expect((await X.C('task_update', { task_id: X.started, version: task(X.started).version, reviewer: nr.id })).isError).toBeFalsy();
    const R2 = await loginWith(nr.secret);
    expect((await R2('task_review', { task_id: X.started, decision: 'approve', comments: 'Checked.', version: 1000 })).structuredContent.task.status).toBe('approved');
  });
});

describe('the tool text', () => {
  it('task_assign says what the spec\'s "Polling teams" rule says about silent polling members', async () => {
    const spec = readFileSync(join(process.cwd(), '..', 'docs', 'specification.md'), 'utf8').split('\n');
    expect(spec.find((l) => l.startsWith('- **Polling teams**'))).toMatch(/^- \*\*Polling teams\*\* track liveness by member\..*one sweep returns the member's queued and in-progress assignments to open/);
    const tools = (await clients[0]!.listTools()).tools;
    const assign = tools.find((t) => t.name === 'task_assign')!.description!;
    expect(assign).toContain("Queued work has no work deadline, but a polling member who goes silent past the team's lease loses its queued and started tasks.");
    expect(assign).not.toContain('without a clock');
  });
});
