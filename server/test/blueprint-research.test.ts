/**
 * The research workspace (docs/blueprint.md §2.3, §2.4, §6, §9): the `studies` link (paper → hypothesis), its rights,
 * the matching rules in support.ts, GET /api/projects/:id/research with its milestone and hypothesis filters, and a
 * hypothesis's drill-downs (papers with reasons, results through evidence only, runs only when tagged, dated changes).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Op, SubmitResult } from '../src/blueprint/blueprint.js';
import type { Who } from '../src/teams/teams.js';
import { papersForHypothesis, papersForMilestone, resultsOf, isRun, reasonText } from '../src/blueprint/support.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type S = { cookie: string; csrf: string };
let app: App, base = '', admin: S, member: S;
let coordA = '', workerA = '', coordB = '', teamA = '', teamB = '', P = '', runTask = '', plainTask = '';
const PW = 'research workspace password 1234';
const opr = () => ({ kind: 'operator' as const, id: null });
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const vrd = (agent: string, ops: Op[]): SubmitResult => {
  const r = app.blueprint.submit(P, { version: v(), ops }, agent);
  if (r.status === 'proposed') app.blueprint.rejectProposal(r.proposal.id, opr(), null);
  return r;
};
const code = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; } };
const call = async (who: S, path: string) => {
  const r = await fetch(`${base}/api${path}`, { headers: { cookie: who.cookie, 'x-csrf-token': who.csrf } });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahres-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id };
  };
  const ca = agent('coord-a'), wa = agent('worker-a'), cb = agent('coord-b');
  coordA = ca.id; workerA = wa.id; coordB = cb.id;
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }, { agent_id: wa.id, role: 'worker', credential_id: wa.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put([
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Field shape', fields: { mode: 'validate' }, team_id: teamA },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'The field is axisymmetric', fields: { criteria: 'Asymmetry under 1 %' } },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-02', parent_key: 'L1', title: 'Coils drift under load' },
    { op: 'upsert', kind: 'finding', key: 'F-L1-01', parent_key: 'L1', title: 'Run 46 is symmetric', fields: { confidence: 'high' } },
    { op: 'upsert', kind: 'finding', key: 'F-L1-02', parent_key: 'L1', title: 'Run 47 drifts', fields: { confidence: 'low' } },
    // Two planned papers about H-L1-01 without claims, one published paper citing it through a claim, one with nothing.
    { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'A field model', team_id: teamA, status: 'planned' },
    { op: 'upsert', kind: 'paper', key: 'PAP-2', title: 'Coil heat', team_id: teamA, status: 'planned' },
    { op: 'upsert', kind: 'paper', key: 'PAP-3', title: 'Symmetry, measured', team_id: teamA, status: 'planned' },
    { op: 'upsert', kind: 'claim', key: 'PAP-3/C1', parent_key: 'PAP-3', title: 'The field is axisymmetric' },
    { op: 'upsert', kind: 'claim', key: 'PAP-3/C2', parent_key: 'PAP-3', title: 'Cut later' },
    { op: 'upsert', kind: 'paper', key: 'PAP-4', title: 'Unrelated', team_id: teamA, status: 'planned' },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First field', team_id: teamA },
    { op: 'link', from: 'PAP-1', to: 'H-L1-01', rel: 'studies' },
    { op: 'link', from: 'PAP-2', to: 'H-L1-01', rel: 'studies' },
    { op: 'link', from: 'PAP-3', to: 'H-L1-01', rel: 'studies' },
    { op: 'link', from: 'H-L1-01', to: 'PAP-3/C1', rel: 'evidence' },
    { op: 'link', from: 'H-L1-01', to: 'PAP-3/C2', rel: 'evidence' },
    { op: 'link', from: 'F-L1-01', to: 'H-L1-01', rel: 'evidence' },
    { op: 'link', from: 'M1', to: 'PAP-2', rel: 'delivers' },
    { op: 'link', from: 'M1', to: 'PAP-3', rel: 'delivers' },
  ]);
  put([{ op: 'upsert', kind: 'claim', key: 'PAP-3/C2', status: 'cut' }, { op: 'upsert', kind: 'paper', key: 'PAP-3', status: 'published' }]);
  put([{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', status: 'testing' }]);
  // Experiment runs: a task is a run only with the run tag and the hypothesis in its refs.
  const who: Who = { agentId: coordA, credId: ca.cred, tokenHash: `th_${coordA}`, rules: app.keys.rulesFor(ca.cred), cap: [] };
  runTask = app.teams.create_task(who, { team_id: teamA, title: 'Run 48 at full load', refs: ['H-L1-01'], tags: ['run'] }).id;
  plainTask = app.teams.create_task(who, { team_id: teamA, title: 'Tidy the H-L1-01 notes', refs: ['H-L1-01'] }).id;
  // A member with the blueprint component only: no tasks.
  const c = await (await fetch(`${base}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: JSON.stringify({ username: 'rea' }) })).json() as any;
  const first = await adminLogin(base, 'rea', c.password);
  await fetch(`${base}/api/me/password`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: first.cookie, 'x-csrf-token': first.csrf }, body: JSON.stringify({ current: c.password, new: PW }) });
  await fetch(`${base}/api/users/${c.user.id}/grants`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: JSON.stringify({ grants: [{ project_id: P, components: ['blueprint'] }] }) });
  member = await adminLogin(base, 'rea', PW);
  expect(ADMIN_PASSWORD).toBeTruthy();
});
afterAll(async () => { await app?.close(); });

describe('matching rules (support.ts)', () => {
  const links = [
    { from_key: 'PAP-1', to_key: 'H1', rel: 'studies' }, { from_key: 'H1', to_key: 'PAP-1/C1', rel: 'evidence' }, { from_key: 'H1', to_key: 'PAP-1/C2', rel: 'evidence' },
    { from_key: 'H1', to_key: 'PAP-2/C1', rel: 'evidence' }, { from_key: 'H1', to_key: 'PAP-9/C1', rel: 'evidence' }, { from_key: 'PAP-5', to_key: 'H2', rel: 'studies' },
    { from_key: 'F1', to_key: 'H1', rel: 'evidence' }, { from_key: 'F1', to_key: 'H1', rel: 'evidence' }, { from_key: 'F2', to_key: 'H2', rel: 'evidence' },
    { from_key: 'M1', to_key: 'PAP-1', rel: 'delivers' }, { from_key: 'M1', to_key: 'H1', rel: 'delivers' }, { from_key: 'M2', to_key: 'PAP-2', rel: 'delivers' },
  ];
  const claims = [{ key: 'PAP-1/C1', parent: 'PAP-1', status: 'draft' }, { key: 'PAP-1/C2', parent: 'PAP-1', status: 'final' }, { key: 'PAP-2/C1', parent: 'PAP-2', status: 'cut' }, { key: 'PAP-9/C1', parent: 'PAP-9', status: 'draft' }];

  it('finds a paper once, with every reason; cut claims and papers not live do not count', () => {
    const m = papersForHypothesis('H1', ['PAP-1', 'PAP-2', 'PAP-5'], links, claims);
    expect([...m.keys()]).toEqual(['PAP-1']);
    expect(m.get('PAP-1')!.map(reasonText)).toEqual(['Studies H1', 'PAP-1/C1 cites H1 as evidence', 'PAP-1/C2 cites H1 as evidence']);
  });
  it('keeps the papers a milestone delivers, not its other targets', () => {
    expect([...papersForMilestone('M1', ['PAP-1', 'PAP-2'], links)].map(([k, r]) => [k, r.map(reasonText)])).toEqual([['PAP-1', ['Delivered by M1']]]);
  });
  it('takes results only from evidence links, each finding once', () => {
    expect(resultsOf('H1', links)).toEqual(['F1']);
  });
  it('counts a task as a run only with the run tag and the hypothesis in its refs', () => {
    expect(isRun({ tags: ['run'], refs: ['H1'] }, 'H1')).toBe(true);
    expect(isRun({ tags: [], refs: ['H1'] }, 'H1')).toBe(false);
    expect(isRun({ tags: ['run'], refs: ['H2'] }, 'H1')).toBe(false);
  });
});

describe('the studies link (§2.3, §4)', () => {
  it('goes from a paper to a hypothesis only', () => {
    expect(app.blueprint.links(P).filter((l) => l.rel === 'studies').length).toBe(3);
    expect(code(() => put([{ op: 'link', from: 'F-L1-02', to: 'H-L1-02', rel: 'studies' }]))).toMatch(/^invalid_argument/);
    expect(code(() => put([{ op: 'link', from: 'PAP-1', to: 'F-L1-02', rel: 'studies' }]))).toMatch(/^invalid_argument/);
  });
  it('the coordinator applies it on its own planned paper and proposes it elsewhere; a worker may not write it', () => {
    expect(vrd(coordA, [{ op: 'link', from: 'PAP-4', to: 'H-L1-02', rel: 'studies' }]).status).toBe('applied');
    expect(vrd(coordA, [{ op: 'link', from: 'PAP-3', to: 'H-L1-02', rel: 'studies' }]).status).toBe('proposed');
    expect(vrd(coordB, [{ op: 'link', from: 'PAP-1', to: 'H-L1-02', rel: 'studies' }]).status).toBe('proposed');
    expect(code(() => vrd(workerA, [{ op: 'link', from: 'PAP-1', to: 'H-L1-02', rel: 'studies' }]))).not.toBe('ok');
    put([{ op: 'unlink', from: 'PAP-4', to: 'H-L1-02', rel: 'studies' }]);
  });
  it('shows in the Markdown export', async () => {
    const r = await fetch(`${base}/api/projects/${P}/export.md`, { headers: { cookie: admin.cookie } });
    expect(await r.text()).toMatch(/studies/);
  });
});

describe('GET /api/projects/:id/research (§6, §9)', () => {
  it('lists planned and published papers and every hypothesis', async () => {
    const r = await call(admin, `/projects/${P}/research`);
    expect(r.status).toBe(200);
    expect(r.body.papers.map((x: any) => [x.key, x.status])).toEqual(expect.arrayContaining([['PAP-1', 'planned'], ['PAP-3', 'published']]));
    expect(r.body.hypotheses.map((h: any) => [h.key, h.papers])).toEqual([['H-L1-01', 3], ['H-L1-02', 0]]);
    expect(r.body.hypotheses[0]).toMatchObject({ line: 'L1', line_title: 'Field shape', criteria: 'Asymmetry under 1 %' });
  });
  it('a hypothesis filter finds two planned papers without claims, and the published one once with both reasons', async () => {
    const r = await call(admin, `/projects/${P}/research?hypothesis=H-L1-01`);
    expect(r.body.papers.map((x: any) => [x.key, x.reasons.map((y: any) => y.text)])).toEqual([
      ['PAP-1', ['Studies H-L1-01']], ['PAP-2', ['Studies H-L1-01']], ['PAP-3', ['Studies H-L1-01', 'PAP-3/C1 cites H-L1-01 as evidence']],
    ].sort((a, b) => r.body.papers.findIndex((x: any) => x.key === a[0]) - r.body.papers.findIndex((x: any) => x.key === b[0])));
    expect(r.body.papers.filter((x: any) => x.key === 'PAP-1')[0].total).toBe(0);
  });
  it('a milestone filter keeps what it delivers; both filters keep the papers matching both', async () => {
    const m = await call(admin, `/projects/${P}/research?milestone=M1`);
    expect(m.body.papers.map((x: any) => x.key).sort()).toEqual(['PAP-2', 'PAP-3']);
    expect(m.body.papers[0].reasons.map((y: any) => y.text)).toEqual(['Delivered by M1']);
    const both = await call(admin, `/projects/${P}/research?milestone=M1&hypothesis=H-L1-02`);
    expect(both.body.papers).toEqual([]);
  });
  it('refuses a key of the wrong kind', async () => {
    expect((await call(admin, `/projects/${P}/research?milestone=H-L1-01`)).status).toBe(400);
  });
});

describe('a hypothesis page (§2.4)', () => {
  it('has its papers with reasons, results through evidence only, tagged runs and dated status changes', async () => {
    const r = await call(admin, `/projects/${P}/items/H-L1-01`);
    const x = r.body.research;
    expect(x.papers.map((p: any) => p.key).sort()).toEqual(['PAP-1', 'PAP-2', 'PAP-3']);
    expect(x.results.map((f: any) => f.key)).toEqual(['F-L1-01']);
    expect(x.runs.map((k: any) => k.id)).toEqual([runTask]);
    expect(x.runs.map((k: any) => k.id)).not.toContain(plainTask);
    expect(x.changes.map((c: any) => [c.was, c.to])).toEqual([['untested', 'testing'], [null, 'untested']]);
  });
  it('a member without the tasks component sees no runs, but the papers and results', async () => {
    const r = await call(member, `/projects/${P}/items/H-L1-01`);
    expect(r.status).toBe(200);
    expect(r.body.research.runs).toEqual([]);
    expect(r.body.research.results.length).toBe(1);
    expect((await call(member, `/projects/${P}/research?hypothesis=H-L1-01`)).body.papers.length).toBe(3);
  });
});
