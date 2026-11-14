/**
 * Project Blueprint (docs/blueprint.md §6): the admin API. Admin only, bounded and paged; projects, team parts,
 * reads, operator writes, proposals, report requests, the export and its paper outline, the summary, Home attention
 * items, Settings limits, and Work in motion reading bp_events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { Blueprint } from '../src/blueprint/blueprint.js';
import { loadBlueprintLimits } from '../src/admin/blueprintApi.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '';
let coordA = '', workerA = '', coordB = '', teamA = '', teamB = '', OLD = '', P = '';
type R = { status: number; body: any; text: string; headers: Headers };
const call = async (method: string, path: string, body?: unknown, o: { auth?: boolean; csrf?: boolean } = {}): Promise<R> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.auth !== false) headers['cookie'] = cookie;
  if (method !== 'GET' && o.csrf !== false) headers['x-csrf-token'] = csrf;
  const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = {}; try { json = JSON.parse(text); } catch { /* markdown */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
const get = (p: string, o?: { auth?: boolean }) => call('GET', p, undefined, o);
const post = (p: string, b: unknown = {}, o?: { auth?: boolean; csrf?: boolean }) => call('POST', p, b, o);
const v = () => app.blueprint.project(P)!.version;
const ops = (list: unknown[]) => post(`/projects/${P}/ops`, { version: v(), ops: list });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbp4-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const agent = (label: string) => { const a = app.keys.createAgent(label, null, sys); const k = app.keys.createSessionKey({ agentId: a.id, label }, sys); return { id: a.id, cred: k.credential.id }; };
  const ca = agent('Dana'), wa = agent('Wynn'), cb = agent('Eli');
  coordA = ca.id; workerA = wa.id; coordB = cb.id;
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }, { agent_id: wa.id, role: 'worker', credential_id: wa.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  // Team A plans in its own project: one requirement with criteria in its module.
  const own = app.blueprint.projectOfTeam(teamA)!;
  OLD = own.id;
  app.blueprint.write(OLD, { version: own.version, ops: [{ op: 'upsert', kind: 'module', key: 'FP', title: 'Field Physics', team_id: teamA },
    { op: 'upsert', kind: 'fr', key: 'FR-FP-01', parent_key: 'FP', title: 'Field model fits run 46' },
    { op: 'upsert', kind: 'ac', key: 'FR-FP-01/AC1', parent_key: 'FR-FP-01', title: 'Acceptance', fields: { then: 'Residual under 2 %' } }] }, { kind: 'operator', id: null });
});
afterAll(async () => { await app?.close(); });

describe('admin only', () => {
  it('refuses without the operator session, and writes without the CSRF header', async () => {
    for (const p of ['/projects', '/blueprint/attention', '/settings/blueprint', `/projects/${OLD}/summary`, `/projects/${OLD}/export.md`]) expect((await get(p, { auth: false })).status).toBe(401);
    expect((await post('/projects', { key: 'XX', name: 'x' }, { csrf: false })).status).toBe(403);
    expect((await post('/projects', { key: 'XX', name: 'x' }, { auth: false })).status).toBe(401);
  });
});

describe('projects and parts', () => {
  it('creates, lists (bounded, paged) and updates projects', async () => {
    const c = await post('/projects', { key: 'ECHO', name: 'Echo case', kind: 'implementation' });
    expect(c.status).toBe(200);
    P = c.body.project.id;
    expect(c.body.project).toMatchObject({ key: 'ECHO', kind: 'implementation', status: 'active', version: 0 });
    expect((await post('/projects', { key: 'ECHO', name: 'again' })).status).toBe(409);
    expect((await post('/projects', { key: 'ship', name: 'x' })).body.error).toBe('invalid_argument');
    expect((await post('/projects', { key: 'ABC', name: 'x', extra: 1 })).status).toBe(400);
    const l = await get('/projects?limit=1');
    expect(l.body.projects).toHaveLength(1);
    expect(l.body.total).toBeGreaterThanOrEqual(2);
    expect(typeof l.body.next_cursor).toBe('string'); // opaque (F-25)
    const l2 = await get(`/projects?limit=1&cursor=${encodeURIComponent(l.body.next_cursor)}`);
    expect(l2.body.projects[0].id).not.toBe(l.body.projects[0].id);
    expect((await get('/projects?cursor=1')).status).toBe(400);
    expect(l.body.projects[0]).toHaveProperty('id');
    expect((await get('/projects?limit=101')).status).toBe(400);
    const p = await call('PATCH', `/projects/${P}`, { name: 'Echo case', status: 'paused' });
    expect(p.body.project).toMatchObject({ id: P, name: 'Echo case', status: 'paused' });
    expect((await call('PATCH', `/projects/${P}`, { status: 'gone' })).status).toBe(400);
    await call('PATCH', `/projects/${P}`, { status: 'active' });
    expect((await call('PATCH', '/projects/prj_nothere00', { name: 'x' })).status).toBe(404);
  });

  it('moves a team into a project only once its old part holds no work; the old part stays in the old project (docs/blueprint.md §3)', async () => {
    // A populated part is never released silently: the move is refused with what holds it, and nothing changes.
    const no = await call('PUT', `/teams/${teamA}/project`, { project_id: P, owns: [] });
    expect(no.status).toBe(409);
    expect(no.body).toMatchObject({ error: 'conflict', from: OLD, dependencies: { items: expect.arrayContaining(['FP', 'FR-FP-01', 'FR-FP-01/AC1']), proposals: [], tasks: [] } });
    expect(app.blueprint.projectOfTeam(teamA)!.id).toBe(OLD);
    expect(app.blueprint.item(OLD, 'FR-FP-01')!.team_id).toBe(teamA);
    // The operator gives the part back to the project first (same-project part editing still works), then moves the team.
    expect((await call('PUT', `/teams/${teamA}/project`, { project_id: OLD, owns: [] })).body.released).toEqual(['FP']);
    const r = await call('PUT', `/teams/${teamA}/project`, { project_id: P, owns: [] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ project_id: P, moved_from: OLD, owns: [] });
    expect(app.blueprint.projectOfTeam(teamA)!.id).toBe(P);
    expect(app.blueprint.item(OLD, 'FR-FP-01')!.team_id).toBeNull(); // history stays, at project level
    expect(app.blueprint.item(OLD, 'FR-FP-01/AC1')!.fields['then']).toBe('Residual under 2 %');
    expect(app.blueprint.item(P, 'FR-FP-01')).toBeUndefined();
    const told = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='project_changed' ORDER BY seq DESC LIMIT 1").get(workerA) as { body: string };
    expect(told.body).toMatch(/moved from project \w+ to ECHO[\s\S]*without since_version/);
    expect((await call('PUT', `/teams/${teamB}/project`, { project_id: P })).status).toBe(200);
  });

  it('gives a team its part: modules, lines and papers, children follow; the rest is refused', async () => {
    const w = await ops([
      { op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model' },
      { op: 'upsert', kind: 'module', key: 'PWR', title: 'Power' },
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-*', parent_key: 'FLD', title: 'Model the field to 2 %' },
      { op: 'upsert', kind: 'line', key: 'L1', title: 'Field shape', fields: { mode: 'validate' } },
      { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'The field is axisymmetric' },
      { op: 'upsert', kind: 'finding', key: 'F-L1-01', parent_key: 'L1', title: 'Run 46 fits', fields: { confidence: 'high' } },
      { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'A field model', fields: { venue: 'JFE', target_at: Date.parse('2027-01-15') }, body: 'We model the field.' },
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C1', parent_key: 'PAP-1', title: 'The model fits to 2 %', fields: { part: 'results' } },
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C2', parent_key: 'PAP-1', title: 'The field is axisymmetric', fields: { part: 'discussion' } },
    ]);
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ project_id: P, keys: { 'FR-FLD-*': 'FR-FLD-01' } });
    const a = await call('PUT', `/teams/${teamA}/project`, { project_id: P, owns: ['FLD', 'L1', 'PAP-1'] });
    expect(a.body.owns).toEqual(['FLD', 'L1', 'PAP-1']);
    expect(app.blueprint.item(P, 'FR-FLD-01')!.team_id).toBe(teamA);
    expect(app.blueprint.item(P, 'PAP-1/C1')!.team_id).toBe(teamA); // claims follow their paper
    await call('PUT', `/teams/${teamB}/project`, { project_id: P, owns: ['PWR'] });
    const back = await call('PUT', `/teams/${teamA}/project`, { project_id: P, owns: ['FLD', 'L1'] });
    expect(back.body.released).toContain('PAP-1');
    expect(app.blueprint.item(P, 'PAP-1/C1')!.team_id).toBeNull();
    expect((await call('PUT', `/teams/${teamA}/project`, { project_id: P, owns: ['FR-FLD-01'] })).status).toBe(400);
    expect((await call('PUT', `/teams/${teamA}/project`, { project_id: P, owns: ['NOPE'] })).status).toBe(400);
    expect((await call('PUT', `/teams/${teamA}/project`, { project_id: 'prj_nothere00', owns: [] })).status).toBe(404);
    await call('PUT', `/teams/${teamA}/project`, { project_id: P, owns: ['FLD', 'L1', 'PAP-1'] });
  });

  it('tells members when their team moves or their project pauses; versions from the old project do not carry over (F-15)', async () => {
    const notes = (a: string) => app.db.prepare("SELECT kind, body FROM agent_notices WHERE agent_id=? AND kind IN ('project_changed','project_paused') ORDER BY seq").all(a) as { kind: string; body: string }[];
    const held = app.blueprint.project(P)!.version; // what Eli last read in ECHO
    await call('PUT', `/teams/${teamB}/project`, { project_id: OLD, owns: [] });
    expect(app.blueprint.project(OLD)!.version).toBeGreaterThan(held);
    const since = app.blueprint.read(OLD, teamB, { since_version: held });
    expect(since.items.map((i) => i.key)).toEqual(expect.arrayContaining(['FR-FP-01', 'FR-FP-01/AC1'])); // the whole new view, not a slice of it
    expect(notes(coordB).at(-1)!.body).toMatch(/moved from project ECHO to/);
    await call('PUT', `/teams/${teamB}/project`, { project_id: P, owns: ['PWR'] });
    expect(notes(coordB).at(-1)!.body).toContain('Your part: PWR');
    await call('PATCH', `/projects/${P}`, { status: 'paused' });
    expect(notes(workerA).at(-1)).toMatchObject({ kind: 'project_paused', body: expect.stringContaining('ECHO is paused') });
    await call('PATCH', `/projects/${P}`, { status: 'active' });
    expect(notes(coordB).at(-1)).toMatchObject({ kind: 'project_changed', body: expect.stringContaining('active again') });
  });
});

describe('reading and writing', () => {
  it('reads the blueprint with filters, bounded and paged', async () => {
    const all = await get(`/projects/${P}/blueprint?limit=3`);
    expect(all.body.items).toHaveLength(3);
    expect(all.body.project_id).toBe(P);
    const page2 = await get(`/projects/${P}/blueprint?limit=3&cursor=${encodeURIComponent(all.body.next_cursor)}`);
    expect(page2.body.items.map((i: any) => i.key)).not.toContain(all.body.items[0].key);
    expect((await get(`/projects/${P}/blueprint?cursor=${encodeURIComponent(page2.body.next_cursor.replace(/./, 'x'))}`)).status).toBe(400);
    expect((await get(`/projects/${P}/blueprint`)).body.items.length).toBeGreaterThan(3); // a full page by default
    const frs = await get(`/projects/${P}/blueprint?kind=fr,module&team=${teamA}`);
    expect(frs.body.items.map((i: any) => i.key).sort()).toEqual(expect.arrayContaining(['FLD', 'FR-FLD-01']));
    expect(frs.body.items.every((i: any) => i.team_id === teamA)).toBe(true);
    const q = await get(`/projects/${P}/blueprint?q=${encodeURIComponent('axisymmetric')}`);
    expect(q.body.items.map((i: any) => i.key).sort()).toEqual(['H-L1-01', 'PAP-1/C2']);
    const s4 = await get(`/projects/${P}/blueprint?section=4&detail=full`);
    const paper = s4.body.items.find((i: any) => i.key === 'PAP-1');
    expect(paper).toMatchObject({ supported: '0 of 2', ready: false, fields: { venue: 'JFE' } });
    expect((await get(`/projects/${P}/blueprint?team=team_nothere0`)).status).toBe(400);
    expect((await get(`/projects/${P}/blueprint?limit=500`)).status).toBe(400);
    expect((await get(`/projects/${P}/blueprint?section=9`)).status).toBe(400);
  });

  it('writes as the operator: stale versions conflict, evidence returns the claims whose support changed', async () => {
    expect((await post(`/projects/${P}/ops`, { version: v() - 1, ops: [{ op: 'remove', key: 'PWR' }] })).status).toBe(409);
    const w = await ops([{ op: 'link', from: 'F-L1-01', to: 'PAP-1/C1', rel: 'evidence' }, { op: 'link', from: 'H-L1-01', to: 'PAP-1/C2', rel: 'evidence' }]);
    expect(w.body.support_changed).toEqual([{ key: 'PAP-1/C1', was: 'unsupported', now: 'supported' }, { key: 'PAP-1/C2', was: 'unsupported', now: 'weak' }]);
    expect((await ops([{ op: 'frobnicate', key: 'X' }])).status).toBe(400);
  });

  it('shows one item with links, tasks and history; keys with a slash are encoded', async () => {
    app.db.prepare("INSERT INTO tasks(id,team_id,title,status,claimable,created_at,updated_at,plan_refs) VALUES ('task_fld1',?,'Fit run 47','done',0,?,?,?)").run(teamA, Date.now(), Date.now(), JSON.stringify(['FR-FLD-01']));
    const fr = await get(`/projects/${P}/items/FR-FLD-01`);
    expect(fr.body).toMatchObject({ project: { id: P, key: 'ECHO' }, item: { key: 'FR-FLD-01', kind: 'fr', status: 'draft', team_id: teamA }, tasks: { done: 1 } });
    expect(fr.body.tasks.items[0].id).toBe('task_fld1');
    const c = await get(`/projects/${P}/items/${encodeURIComponent('PAP-1/C1')}`);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ support: 'supported', links: { in: [{ rel: 'evidence', key: 'F-L1-01', kind: 'finding' }] } });
    const p = await get(`/projects/${P}/items/PAP-1`);
    expect(p.body.paper).toMatchObject({ ready: false, supported: 1, total: 2, holding: ['PAP-1/C2'] });
    expect(p.body.paper.claims[0]).toMatchObject({ key: 'PAP-1/C1', part: 'results', chain: [{ key: 'F-L1-01', confidence: 'high' }] });
    for (let i = 0; i < 4; i++) await ops([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', title: `Model the field to 2 % (${i})` }]);
    const h1 = await get(`/projects/${P}/items/FR-FLD-01/history?limit=2`);
    expect(h1.body.revisions.map((r: any) => r.rev)).toEqual([6, 5]);
    const h2 = await get(`/projects/${P}/items/FR-FLD-01/history?limit=2&cursor=${encodeURIComponent(h1.body.next_cursor)}`);
    expect(h2.body.revisions.map((r: any) => r.rev)).toEqual([4, 3]);
    // Rev 2 is FR-FLD-01 following FLD into team A's part.
    const all = (await get(`/projects/${P}/items/FR-FLD-01/history?limit=50`)).body.revisions;
    expect(all.find((r: any) => r.rev === 2)).toMatchObject({ note: 'team follows FLD', snapshot: { team_id: teamA } });
    expect((await get(`/projects/${P}/items/FR-FLD-01/history?limit=51`)).status).toBe(400);
    expect((await get(`/projects/${P}/items/NOPE`)).status).toBe(404);
    expect((await get(`/projects/${P}/items/FR-FLD-01?detail=full`)).status).toBe(400); // no query fields
  });
});

describe('proposals, requests and Home attention', () => {
  it('lists proposals and applies or rejects them; Home lists the open ones', async () => {
    const one = app.blueprint.submit(P, { version: v(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Echo 47 stays unexplained', team_id: teamA, fields: { impact: 'high' } }], team_id: teamA }, workerA);
    const two = app.blueprint.submit(P, { version: v(), ops: [{ op: 'upsert', kind: 'issue', key: 'I*', title: 'Raw extract missing', team_id: teamA }], team_id: teamA }, workerA);
    expect([one.status, two.status]).toEqual(['proposed', 'proposed']);
    const l = await get(`/projects/${P}/proposals?status=open&limit=1`);
    expect(l.body).toMatchObject({ project: { id: P }, total: 2 });
    expect(typeof l.body.next_cursor).toBe('string');
    const att = await get('/blueprint/attention');
    expect(att.body.counts.proposals).toBe(2);
    expect(att.body.items.filter((i: any) => i.kind === 'bp_proposal').map((i: any) => i.agent.label)).toEqual(['Wynn', 'Wynn']);
    expect(att.body.items[0].project).toMatchObject({ id: P, key: 'ECHO' });
    const id1 = one.status === 'proposed' ? one.proposal.id : '', id2 = two.status === 'proposed' ? two.proposal.id : '';
    const a = await post(`/proposals/${id1}/apply`, { note: 'agreed' });
    expect(a.body).toMatchObject({ project_id: P, proposal: { status: 'applied' }, stale: null });
    expect(app.blueprint.item(P, 'RK-01')!.team_id).toBe(teamA);
    const rj = await post(`/proposals/${id2}/reject`, { note: 'not yet' });
    expect(rj.body.proposal).toMatchObject({ status: 'rejected', note: 'not yet' });
    expect((await post(`/proposals/${id2}/apply`, {})).status).toBe(409);
    expect((await get('/blueprint/attention')).body.counts.proposals).toBe(0);
    expect((await get('/blueprint/attention?limit=51')).status).toBe(400);
    // The list is bounded; the count is not.
    const ins = app.db.prepare("INSERT INTO bp_proposals(id,project_id,team_id,agent_id,ops,base_version,reason,status,created_at,revs) VALUES (?,?,?,?,'[]',0,NULL,'open',?,'{}')");
    for (let i = 0; i < 55; i++) ins.run(`bpp_bulk${String(i).padStart(4, '0')}`, P, teamA, workerA, Date.now());
    const many = await get('/blueprint/attention?limit=10');
    expect(many.body.items).toHaveLength(10);
    expect(many.body.counts.proposals).toBe(55);
    app.db.prepare("DELETE FROM bp_proposals WHERE id LIKE 'bpp_bulk%'").run();
  });

  it('asks every team of the project for a report, each for its own part; an escalation and a contradicted claim become attention items', async () => {
    const r = await post(`/projects/${P}/report-request`, { note: 'Before the review' });
    expect(r.body).toMatchObject({ project_id: P, teams: [teamA, teamB] });
    // One request per notified team (F-04): a team's report answers its own row only.
    const open = () => (app.db.prepare("SELECT team_id FROM bp_report_requests WHERE project_id=? AND scope='project' AND answered_at IS NULL").all(P) as { team_id: string }[]).map((x) => x.team_id).sort();
    expect(open()).toEqual([teamA, teamB].sort());
    const n = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='status_request' ORDER BY seq DESC LIMIT 1").get(coordB) as { body: string };
    expect(n.body).toContain('ECHO');
    expect(n.body).toContain('Call bp_report: health'); // the shared STATUS_FORMAT
    app.blueprint.fileReport(teamA, coordA, { health: 'off_track', done: ['FR-FLD-01 drafted'], blockers: ['Echo 47 off the curve'], escalate: true });
    expect(open()).toEqual([teamB]);
    expect(JSON.parse((app.db.prepare("SELECT fields FROM bp_items WHERE project_id=? AND kind='report' AND team_id=? ORDER BY created_at DESC LIMIT 1").get(P, teamA) as { fields: string }).fields).requested).toBe('Before the review');
    expect((await get(`/projects/${P}/summary`)).body.report_requests).toMatchObject([{ team: { id: teamB, name: 'Tern-9 Keepers' }, scope: 'project', kind: 'status', note: 'Before the review' }]);
    app.blueprint.write(P, { version: v(), ops: [{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', status: 'refuted' }] }, { kind: 'operator', id: null });
    const att = await get('/blueprint/attention');
    expect(att.body.counts).toEqual({ proposals: 0, escalations: 1, contradicted: 1, blocking: 0 });
    const esc = att.body.items.find((i: any) => i.kind === 'bp_escalation'), con = att.body.items.find((i: any) => i.kind === 'bp_contradicted');
    expect(esc).toMatchObject({ project: { id: P }, team: { id: teamA, name: 'Signals Lab' }, health: 'off_track', blockers: ['Echo 47 off the curve'] });
    expect(con).toMatchObject({ key: 'PAP-1/C2', paper: 'PAP-1', by: ['H-L1-01 refuted'] });
    // Work in motion reads bp_events: the operator's request at project level, the report and the write.
    const feed = await get('/work/recent?limit=10');
    const req = feed.body.events.find((e: any) => e.kind === 'plan' && e.plan.event === 'review_request' && e.project?.id === P);
    expect(req).toMatchObject({ team: { id: null, name: 'Echo case' }, note: 'Before the review', actor: { label: 'Operator' } });
    expect(feed.body.events.some((e: any) => e.kind === 'plan' && e.plan.moves.some((m: any) => m.key === 'H-L1-01' && m.status === 'refuted'))).toBe(true);
    // A later report without escalation clears it.
    app.blueprint.write(P, { version: v(), ops: [{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', status: 'confirmed' }] }, { kind: 'operator', id: null });
    app.db.prepare("UPDATE bp_items SET created_at=created_at-? WHERE project_id=? AND kind='report'").run(2 * 86_400_000, P);
    app.blueprint.fileReport(teamA, coordA, { health: 'at_risk', done: ['H-L1-01 confirmed'] });
    expect((await get('/blueprint/attention')).body.counts).toEqual({ proposals: 0, escalations: 0, contradicted: 0, blocking: 0 });
    expect((await post(`/projects/${OLD}/report-request`, {})).status).toBe(409); // no team left in the old project
    // Only an active project's running teams are asked.
    app.blueprint.updateProject(P, { status: 'paused' }, { kind: 'operator', id: null });
    expect((await post(`/projects/${P}/report-request`, {})).status).toBe(409);
    app.blueprint.updateProject(P, { status: 'active' }, { kind: 'operator', id: null });
    expect(open()).toEqual([teamB]);
  });
});

describe('summary and export', () => {
  it('summarises the project and one team part for the card and the Overview', async () => {
    const s = await get(`/projects/${P}/summary`);
    expect(s.body).toMatchObject({ project: { id: P, key: 'ECHO', kind: 'implementation' }, scope: 'project', teams: 2, health: { health: 'at_risk', stale: false } });
    expect(s.body.measures.bars.frs).toEqual({ done: 0, total: 1 });
    expect(s.body.nearest_paper).toMatchObject({ key: 'PAP-1', supported: 2, total: 2, ready: true });
    expect(s.body.risks).toMatchObject({ open: 1, top: [{ key: 'RK-01', impact: 'high' }] });
    expect(s.body.parts.map((x: any) => x.team.name)).toEqual(['Signals Lab', 'Tern-9 Keepers']);
    const t = await get(`/projects/${P}/summary?team=${teamB}`);
    expect(t.body).toMatchObject({ scope: 'part', team: { id: teamB }, health: null, papers: [] });
    expect((await get(`/projects/${P}/summary?team=team_nothere0`)).status).toBe(400);
  });

  it('exports the blueprint as Markdown, and a paper as the writer\'s outline', async () => {
    const e = await get(`/projects/${P}/export.md`);
    expect(e.status).toBe(200);
    expect(e.headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(e.headers.get('content-disposition')).toContain('ECHO-blueprint.md');
    expect(e.text).toContain('edit in the hub');
    expect(e.text).toContain('## 2. Product Requirements');
    expect(e.text).toMatch(/- \*\*FLD\*\* Field model\n[\s\S]*  - \*\*FR-FLD-01\*\*/);
    expect(e.text).toContain('**PAP-1** A field model · planned · 2 of 2 supported · ready');
    const o = await get(`/projects/${P}/export.md?paper=PAP-1`);
    expect(o.text).toContain('# A field model (PAP-1)');
    expect(o.text).toContain('## Framing\n\nWe model the field.');
    expect(o.text).toContain('### PAP-1/C1 · supported');
    expect(o.text).toContain('- F-L1-01 (finding, high): Run 46 fits');
    expect((await get(`/projects/${P}/export.md?paper=PAP-9`)).status).toBe(404);
    expect((await get(`/projects/${P}/export.md?paper=x`)).status).toBe(400);
  });
});

describe('Settings: limits', () => {
  it('reads, sets, enforces, resets and keeps the operator\'s limits', async () => {
    const g = await get('/settings/blueprint');
    expect(g.body.limits).toMatchObject({ items_per_project: 2000, ops_per_write: 50, claims_per_paper: 40 });
    const s = await call('PUT', '/settings/blueprint', { limits: { ops_per_write: 2 } });
    expect(s.body.limits.ops_per_write).toBe(2);
    const three = [1, 2, 3].map((i) => ({ op: 'upsert', kind: 'term', key: `G-t${i}`, title: `t${i}` }));
    expect((await ops(three)).status).toBe(400);
    const fresh = new Blueprint(app.db);
    loadBlueprintLimits(app.db, fresh);
    expect(fresh.limits.opsPerWrite).toBe(2); // survives a restart
    expect((await call('PUT', '/settings/blueprint', { limits: { ops_per_write: 0 } })).status).toBe(400);
    expect((await call('PUT', '/settings/blueprint', { limits: { title: 201 } })).status).toBe(400);
    expect((await call('PUT', '/settings/blueprint', { limits: { nope: 3 } })).status).toBe(400);
    const r = await call('PUT', '/settings/blueprint', { limits: { ops_per_write: null } });
    expect(r.body.limits.ops_per_write).toBe(50);
    expect((await ops(three)).status).toBe(200);
  });
});

describe('plain reading (docs/blueprint.md §2.7)', () => {
  it('item detail gives summary, Records, codes with their terms, issues, the standing line and sources; the list and summary add plain keys', async () => {
    const X = (await post('/projects', { key: 'PLN', name: 'Plain' })).body.project.id as string;
    const w = async (list: unknown[]) => { const r = await post(`/projects/${X}/ops`, { version: app.blueprint.project(X)!.version, ops: list }); expect(r.status).toBe(200); return r; };
    await w([
      { op: 'upsert', kind: 'term', key: 'G-t-prime', title: 'T′', body: 'The corrected time. Measured per run.', fields: { aliases: ["T'"] } },
      { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'Corrected time' },
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C1', parent_key: 'PAP-1', title: "T' drops with P26 and P26b" },
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C2', parent_key: 'PAP-1', title: 'It holds with P26', body: 'It holds.\n\n## Records\n- f6f163d, see [[Nowhere]]' },
      { op: 'upsert', kind: 'module', key: 'CORE', title: 'Core' },
      { op: 'upsert', kind: 'fr', key: 'FR-CORE-01', parent_key: 'CORE', title: 'Core reads' },
      { op: 'upsert', kind: 'ac', key: 'FR-CORE-01/AC1', parent_key: 'FR-CORE-01', title: 'Acceptance' },
    ]);
    expect(app.blueprint.item(X, 'G-t-prime')!.fields['aliases']).toEqual(["T'"]);
    const d = (await get(`/projects/${X}/items/${encodeURIComponent('PAP-1/C2')}`)).body;
    expect(d.plain).toMatchObject({ summary: 'It holds.', records: '- f6f163d, see [[Nowhere]]', codes: [{ token: 'P26', term: null }] });
    expect(d.standing).toBe('No evidence linked.');
    expect(d.sources).toEqual([{ text: 'Nowhere', where: 'missing' }]);
    const c1 = (await get(`/projects/${X}/items/${encodeURIComponent('PAP-1/C1')}`)).body;
    expect(c1.plain.codes).toEqual([{ token: "T'", term: { key: 'G-t-prime', title: 'T′', definition: 'The corrected time.' } }, { token: 'P26', term: null }, { token: 'P26b', term: null }]);
    expect(c1.plain.issues).toEqual([{ kind: 'undefined_code', issue: 'title codes: P26, P26b', message: expect.stringContaining('PAP-1/C1 title uses P26, P26b') }]);
    expect((await get(`/projects/${X}/items/PAP-1`)).body.standing).toBe('0 of 2 claims supported. C1 and C2 have none.');
    const list = (await get(`/projects/${X}/blueprint`)).body.items as { key: string; plain?: { undef: string[]; empty_ac: boolean; issues: string[] } }[];
    const by = Object.fromEntries(list.map((i) => [i.key, i.plain]));
    expect(by['PAP-1/C1']).toEqual({ undef: ['P26', 'P26b'], empty_ac: false, issues: ['title codes: P26, P26b'] });
    expect(by['FR-CORE-01/AC1']).toEqual({ undef: [], empty_ac: true, issues: ['acceptance says nothing to check'] });
    expect(by['PAP-1']).toBeUndefined();
    expect(by['G-t-prime']).toBeUndefined();
    const s = (await get(`/projects/${X}/summary`)).body.plain;
    expect(s.undefined_codes).toEqual([{ token: 'P26', count: 2, keys: ['PAP-1/C1', 'PAP-1/C2'] }, { token: 'P26b', count: 1, keys: ['PAP-1/C1'] }]);
    expect(s.empty_acs).toBe(1);
  });
});
