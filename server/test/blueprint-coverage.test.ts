/**
 * Coverage and status meanings (docs/blueprint.md §3, §6, §7, §9): the six gap lists in the summary's plain block, counted
 * from the tasks the viewer may see; bp_read {plain: "coverage"}; the counts in a status report's hub facts; Coverage
 * feeding nothing in Needs you; and the operator's sentence per status, returned by bp_read {rules: true} as L0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const PW = 'coverage member password 1234';
type Res = { isError?: boolean; structuredContent?: any; content?: any };
type S = { cookie: string; csrf: string };
type R = { status: number; body: any };
let app: App, base = '', adminId = '', P = '', E = '', teamA = '', teamB = '', coordA = '';
let admin: S, plainMember: S, taskMember: S;
let C: (name: string, args?: Record<string, unknown>) => Promise<Res>;
const DAY = 86_400_000;

const call = async (who: S, method: string, path: string, body?: unknown): Promise<R> => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = {}; try { json = JSON.parse(await r.text()); } catch { /* not JSON */ }
  return { status: r.status, body: json };
};
const opr = () => ({ kind: 'operator' as const, id: adminId });
const put = (pid: string, ops: Op[]) => app.blueprint.write(pid, { version: app.blueprint.project(pid)!.version, ops }, opr());
const task = (id: string, team: string, status: string, refs: string[]) => app.db.prepare('INSERT INTO tasks(id,team_id,title,status,claimable,created_at,updated_at,plan_refs) VALUES (?,?,?,?,0,?,?,?)')
  .run(id, team, `Task ${id}`, status, Date.now(), Date.now(), JSON.stringify(refs));
const keys = (g: { items: { key: string }[] } | null) => (g ? g.items.map((i) => i.key).sort() : null);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahcov-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = (await call(admin, 'POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const ca = agent('cov-coord-a'), cb = agent('cov-coord-b');
  coordA = ca.id;
  teamA = app.teams.create({ name: 'Coverage A', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Coverage B', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put(P, [
    { op: 'upsert', kind: 'module', key: 'MOD', title: 'Booking', team_id: teamA },
    { op: 'upsert', kind: 'module', key: 'OTH', title: 'Other', team_id: teamB },
    // Agreed, no criteria, no milestone; only team B's task names it.
    { op: 'upsert', kind: 'fr', key: 'FR-MOD-01', parent_key: 'MOD', title: 'Book a room', status: 'agreed' },
    // Agreed, delivered by a project-level milestone, team A's task; its criterion passes with no evidence.
    { op: 'upsert', kind: 'fr', key: 'FR-MOD-02', parent_key: 'MOD', title: 'Cancel a booking', status: 'agreed' },
    { op: 'upsert', kind: 'ac', key: 'FR-MOD-02/AC1', parent_key: 'FR-MOD-02', title: 'Cancel frees the room', status: 'passing', fields: { given: 'a booking', when: 'cancelled', then: 'free' } },
    { op: 'upsert', kind: 'ac', key: 'FR-MOD-02/AC2', parent_key: 'FR-MOD-02', title: 'Cancel tells the guest', status: 'passing', fields: { given: 'a booking', when: 'cancelled', then: 'mail', evidence: 'task:task_mail' } },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Bookings live' },
    { op: 'link', from: 'M1', to: 'FR-MOD-02', rel: 'delivers' },
    // A draft with no criteria (No acceptance criteria only), and a dropped one (in no list).
    { op: 'upsert', kind: 'fr', key: 'FR-MOD-03', parent_key: 'MOD', title: 'Book for a group' },
    { op: 'upsert', kind: 'fr', key: 'FR-MOD-04', parent_key: 'MOD', title: 'Book by phone', status: 'dropped' },
    // A decision that governs nothing, and one that governs a requirement.
    { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'Use one calendar', status: 'accepted' },
    { op: 'upsert', kind: 'decision', key: 'ADR-002', title: 'Rooms hold one booking', status: 'accepted' },
    { op: 'link', from: 'ADR-002', to: 'FR-MOD-01', rel: 'governs' },
    // Questions: one asked 15 days ago, one asked today.
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Demand', fields: { mode: 'explore' }, team_id: teamA },
    { op: 'upsert', kind: 'question', key: 'Q-L1-01', parent_key: 'L1', title: 'Do guests book for groups?' },
    { op: 'upsert', kind: 'question', key: 'Q-L1-02', parent_key: 'L1', title: 'Do guests call?' },
  ] as Op[]);
  app.db.prepare("UPDATE bp_items SET created_at=? WHERE project_id=? AND key='Q-L1-01'").run(Date.now() - 15 * DAY, P);
  task('task_b1', teamB, 'open', ['FR-MOD-01']);
  task('task_a2', teamA, 'done', ['FR-MOD-02']);
  task('task_a1', teamA, 'backlog', ['FR-MOD-01']); // a backlog task does not count
  // An empty project for the no-gaps line.
  E = (await call(admin, 'POST', '/projects', { key: 'EMPTY', name: 'Nothing yet' })).body.project.id;

  // Two members of P: one with the blueprint only, one with the tasks component too.
  const mk = async (username: string, components: string[]) => {
    const c = await call(admin, 'POST', '/users', { username });
    const first = await adminLogin(base, username, c.body.password);
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: P, components }] })).status).toBe(200);
    return adminLogin(base, username, PW);
  };
  plainMember = await mk('cova', ['blueprint']);
  taskMember = await mk('covb', ['blueprint', 'tasks']);

  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: ca.secret } })) as Res).structuredContent.session_token;
  C = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
});
afterAll(async () => { await app?.close(); });

describe('Coverage in the summary (§6)', () => {
  it('lists each gap of a team\'s part next to empty_acs, counting every task for the admin', async () => {
    const s = (await call(admin, 'GET', `/projects/${P}/summary?team=${teamA}`)).body;
    expect(s.plain).toHaveProperty('empty_acs');
    const c = s.plain.coverage;
    // Given a requirement with no acceptance criteria, it is listed under No acceptance criteria; a dropped one is not.
    expect(keys(c.no_ac)).toEqual(['FR-MOD-01', 'FR-MOD-03']);
    expect(c.no_ac.count).toBe(2);
    expect(c.no_ac.items[0]).toMatchObject({ key: 'FR-MOD-01', kind: 'fr', title: 'Book a room', status: 'agreed' });
    // A project-level milestone delivers a part's requirement; a draft needs none.
    expect(keys(c.no_milestone)).toEqual(['FR-MOD-01']);
    // The admin sees team B's open task on FR-MOD-01; a backlog task would not count.
    expect(keys(c.no_task)).toEqual([]);
    expect(keys(c.passing_no_evidence)).toEqual(['FR-MOD-02/AC1']);
    // Questions open over 14 days, with when they were asked.
    expect(keys(c.old_questions)).toEqual(['Q-L1-01']);
    expect(c.old_questions.items[0].since).toBeLessThan(Date.now() - 14 * DAY);
  });

  it('reads the project-level decisions in the whole project', async () => {
    const c = (await call(admin, 'GET', `/projects/${P}/summary`)).body.plain.coverage;
    expect(keys(c.decisions_govern_nothing)).toEqual(['ADR-001']);
  });

  it('counts only the tasks a member may see, and gives a member without tasks no No task list', async () => {
    const without = (await call(plainMember, 'GET', `/projects/${P}/summary?team=${teamA}`));
    expect(without.status).toBe(200);
    expect(without.body.plain.coverage.no_task).toBeNull();
    expect(keys(without.body.plain.coverage.no_ac)).toEqual(['FR-MOD-01', 'FR-MOD-03']);
    const withTasks = (await call(taskMember, 'GET', `/projects/${P}/summary?team=${teamA}`)).body.plain.coverage;
    expect(keys(withTasks.no_task)).toEqual([]);
  });

  it('says so in one line when a project has no gaps', async () => {
    const c = (await call(admin, 'GET', `/projects/${E}/summary`)).body.plain.coverage;
    for (const k of ['no_ac', 'no_milestone', 'no_task', 'passing_no_evidence', 'decisions_govern_nothing', 'old_questions']) expect(c[k].count).toBe(0);
  });

  it('feeds nothing in Needs you or For awareness', async () => {
    const ny = JSON.stringify((await call(admin, 'GET', `/needs-you?project=${P}`)).body);
    for (const k of ['FR-MOD-01', 'FR-MOD-03', 'FR-MOD-02/AC1', 'ADR-001', 'Q-L1-01']) expect(ny).not.toContain(`"${k}"`);
  });
});

describe('bp_read {plain: "coverage"} and the report facts', () => {
  it('counts only the caller\'s own team\'s tasks', async () => {
    const r = await C('bp_read', { team_id: teamA, plain: 'coverage' });
    expect(r.isError).toBeFalsy();
    const c = r.structuredContent.coverage;
    // Team B's task is not the caller's: FR-MOD-01 has no task for team A.
    expect(keys(c.no_task)).toEqual(['FR-MOD-01']);
    const text = r.content[0].text as string;
    expect(text).toContain('counts your team\'s tasks only');
    expect(text).toContain('No acceptance criteria · 2');
    expect(text).toContain('- FR-MOD-03 Book for a group [draft]');
    expect(text).toMatch(/Questions older than 14 days · 1\n- Q-L1-01 Do guests book for groups\? \[open\] · asked \d{4}-\d{2}-\d{2}/);
    expect(text).not.toContain('FR-MOD-04');
  });

  it('puts the coverage counts in the report\'s hub facts, not in its text', async () => {
    const r = await C('bp_report', { team_id: teamA, health: 'on_track', done: ['Bookings agreed'] });
    expect(r.isError).toBeFalsy();
    const f = r.structuredContent.facts.coverage;
    expect(f).toEqual({ no_ac: 2, no_milestone: 1, no_task: 1, passing_no_evidence: 1, decisions_govern_nothing: 0, old_questions: 1 });
    expect(r.content[0].text).toContain('coverage gaps: no acceptance criteria 2, no milestone 1, no task 1, passing with no evidence 1, questions older than 14 days 1');
    const it = app.blueprint.item(P, r.structuredContent.key)!;
    expect((it.fields['auto'] as { coverage: unknown }).coverage).toEqual(f);
    expect(it.body ?? '').not.toContain('coverage');
  });
});

describe('What each status means (§3)', () => {
  it('the operator writes a sentence per status; the agent reads it with the rules, as L0', async () => {
    const r = await call(admin, 'PATCH', `/projects/${P}`, { status_meanings: { fr: { built: 'Deployed with a backup.' }, ac: { passing: '  Checked on the live hub.  ' } } });
    expect(r.status).toBe(200);
    expect(r.body.project.status_meanings).toEqual({ fr: { built: 'Deployed with a backup.' }, ac: { passing: 'Checked on the live hub.' } });
    const rules = await C('bp_read', { team_id: teamA, rules: true });
    const text = rules.content[0].text as string;
    expect(text).toContain('(L0) What each status means in this project');
    expect(text).toContain('- fr built: Deployed with a backup.');
    expect(text).toContain('- ac passing: Checked on the live hub.');
    expect(rules.structuredContent).toMatchObject({ trust: 'L0', status_meanings: { fr: { built: 'Deployed with a backup.' } } });
    // Audited, and the coordinators are told to read the rules again.
    const au = app.db.prepare("SELECT details FROM audit_events WHERE action='blueprint.status_meanings' AND target_id=?").all(P) as { details: string }[];
    expect(JSON.parse(au.at(-1)!.details).changed).toEqual(['fr.built', 'ac.passing']);
    const n = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='project_changed' ORDER BY seq DESC LIMIT 1").get(coordA) as { body: string };
    expect(n.body).toContain('fr built, ac passing');
  });

  it('reaches the console on the item and in the summary, and an empty sentence removes one', async () => {
    const d = (await call(admin, 'GET', `/projects/${P}/items/FR-MOD-02`)).body;
    expect(d.project.status_meanings.fr.built).toBe('Deployed with a backup.');
    expect((await call(admin, 'GET', `/projects/${P}/items/ADR-001`)).body.project.status_meanings).toBeUndefined();
    expect((await call(plainMember, 'GET', `/projects/${P}/summary`)).body.project.status_meanings.ac.passing).toBe('Checked on the live hub.');
    const r = await call(admin, 'PATCH', `/projects/${P}`, { status_meanings: { ac: { passing: '' } } });
    expect(r.body.project.status_meanings).toEqual({ fr: { built: 'Deployed with a backup.' } });
  });

  it('refuses an unknown status or kind, a long sentence and anyone but the admin, and changes nothing', async () => {
    const before = app.blueprint.project(P)!.status_meanings;
    expect((await call(admin, 'PATCH', `/projects/${P}`, { status_meanings: { fr: { passing: 'x' } } })).status).toBe(400);
    expect((await call(admin, 'PATCH', `/projects/${P}`, { status_meanings: { decision: { accepted: 'x' } } })).status).toBe(400);
    expect((await call(admin, 'PATCH', `/projects/${P}`, { status_meanings: { fr: { verified: 'x'.repeat(201) } } })).status).toBe(400);
    expect((await call(taskMember, 'PATCH', `/projects/${P}`, { status_meanings: { fr: { built: 'Merged.' } } })).status).toBe(403);
    expect(app.blueprint.project(P)!.status_meanings).toBe(before);
  });

  it('a project with no meanings adds nothing to the rules', async () => {
    const r = await C('bp_read', { project: 'EMPTY', rules: true });
    if (!r.isError) expect(r.content[0].text).not.toContain('What each status means');
  });
});
