/**
 * Onboarding sources (docs/onboarding.md#the-request, #content-from-onboarding, #setup-progress; ONBOARDING-01 and 02):
 * 1. a new_team request says where the requirements or the brief come from, and an existing project supplies its kind;
 * 2. research records are typed and checked: lines need a research project, an FR there needs a module, never a line;
 * 3. the approval files the kept content as one linked proposal with each item's scope, or none when nothing was kept;
 * 4. the setup record derives its state from the answers and the proposal's status, also on the team's page;
 * 5. a repeated approval after a lost response finds the original team and proposal; changes since the screen loaded
 *    fail the approval inside its transaction and create nothing;
 * 6. the PC client applies the same rules before filing;
 * 7. the operator sets the source after setup on the team's card (PUT /api/onboarding/:id/source), and a team whose part
 *    already holds content reads Done with no proposal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error: a plain ES module without types
import { validateRequest } from '../../deploy/client/setup.mjs';
import { setupOf } from '../src/onboarding/teamStart.js';

const op = { kind: 'operator' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', dir = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': o.from ?? '10.9.0.1' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let ip = 1, seq = 0;
const enrol = async (name: string) => {
  const add = await api('POST', '/pcs/add', { name });
  const n = `n${Math.random().toString(36).slice(2)}`.padEnd(22, 'x'), from = `10.9.2.${ip++}`;
  const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  expect((await ob('POST', '/enrol/confirm', { body: { nonce: n }, from })).status).toBe(200);
  return e.body.app_key as string;
};
const ROLES = [
  { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans and assigns.' },
  { name: 'writer', team_role: 'worker', count: 1, job: 'Writes the papers.' },
  { name: 'reviewer', team_role: 'reviewer', count: 1, job: 'Reviews each draft.', reviews: ['writer'] },
];
const request = (over: Record<string, unknown> = {}) => ({
  kind: 'new_team', project: { name: `Source ${++seq}`, existing: false }, team: { name: `Source team ${seq}`, goal: 'Answer the research question.' },
  roles: ROLES, prompt: 'a research team', ...over,
});
/** The brief of one validate line with one hypothesis, one existing paper and two planned papers about that hypothesis. */
const RESEARCH = {
  lines: [{ id: 'sleep', title: 'Sleep and recall', mode: 'validate', question: 'Does sleep improve recall?', owner: 'writer',
    hypotheses: [{ id: 'h-sleep', title: 'Eight hours of sleep improves next-day recall', criteria: 'A recall gain of 10% or more in the trial.' }],
    questions: [{ title: 'Which recall test fits best?' }] }],
  papers: [
    { title: 'Sleep and memory: a review', status: 'published', venue: 'J. Sleep', type: 'paper', manuscript: 'https://example.org/review.pdf', authors: ['A. Author'], owner: 'writer' },
    { title: 'The recall trial', status: 'planned', hypotheses: ['h-sleep'], owner: 'writer' },
    { title: 'Recall after short sleep', status: 'planned', hypotheses: ['h-sleep'] },
  ],
};
const filed = async (pc: string, over: Record<string, unknown> = {}) => {
  const key = await enrol(pc);
  const f = await ob('POST', '/requests', { key, body: request(over) });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  return { key, id: f.body.request_id as string, version: f.body.version as number };
};
const approve = (r: { id: string; version: number }, extra: Record<string, unknown> = {}) => api('POST', `/onboarding/${r.id}/approve`, { version: r.version, ...extra });
const proposalsOf = (teamId: string) => app.db.prepare('SELECT id, ops, status FROM bp_proposals WHERE team_id=?').all(teamId) as { id: string; ops: string; status: string }[];
const problems = (body: unknown) => app.onboarding.validate(body, null).problems.map((p) => p.field);
const warnings = (body: unknown) => app.onboarding.validate(body, null).warnings.map((w) => w.code);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahsources-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app?.close(); });

describe('1. the source question and the project kind', () => {
  it('accepts each source choice; an existing source needs its reference', () => {
    for (const source of [{ from: 'existing', ref: 'docs/specification.md' }, { from: 'coordinator' }, { from: 'operator', note: 'I will paste them later.' }]) {
      expect(problems(request({ source })), JSON.stringify(source)).toEqual([]);
    }
    expect(problems(request({ source: { from: 'existing' } }))).toContain('source.ref');
    expect(problems(request({ source: { from: 'coordinator', ref: 'x' } }))).toContain('source.ref');
    expect(problems(request({ source: { from: 'someone' } }))).toContain('source.from');
    expect(problems(request({ source: { from: 'existing', ref: 'a\nb' } }))).toContain('source.ref');
  });
  it('warns when an older client leaves out the source or a new project\'s kind', () => {
    expect(warnings(request())).toEqual(expect.arrayContaining(['source_missing', 'project_kind_missing']));
    expect(warnings(request({ source: { from: 'coordinator' }, project: { name: 'Kinded', existing: false, kind: 'research' } }))).not.toEqual(expect.arrayContaining(['source_missing']));
    expect(warnings(request({ source: { from: 'coordinator' }, project: { name: 'Kinded', existing: false, kind: 'research' } }))).not.toContain('project_kind_missing');
  });
  it('an existing project supplies its kind; a different one is refused', () => {
    app.blueprint.createProject({ key: 'IMPLX', name: 'Impl existing', kind: 'implementation' }, op);
    expect(problems(request({ project: { name: 'Impl existing', existing: true } }))).toEqual([]);
    expect(problems(request({ project: { name: 'Impl existing', existing: true, kind: 'research' } }))).toContain('project.kind');
  });
});

describe('2. research records are typed and checked', () => {
  const research = (over: Record<string, unknown> = {}) => request({ project: { name: `Res ${seq}`, existing: false, kind: 'research' }, source: { from: 'coordinator' }, research: RESEARCH, ...over });
  it('accepts lines, hypotheses, questions, an existing paper and planned papers without manuscripts', () => {
    expect(problems(research())).toEqual([]);
  });
  it('lines need a research project; papers fit either kind', () => {
    expect(problems(research({ project: { name: 'Impl new', existing: false, kind: 'implementation' } }))).toContain('research.lines');
    expect(problems(research({ project: { name: 'Impl new', existing: false }, research: { lines: [], papers: RESEARCH.papers.slice(0, 1) } }))).toEqual([]);
  });
  it('in a research project a requirement needs a valid module, never a line', () => {
    const fr = { kind: 'fr', title: 'Export the data', text: 'The data exports as CSV.' };
    expect(problems(research({ requirements: [fr] }))).toContain('requirements[0].module');
    expect(problems(research({ requirements: [{ ...fr, module: 'DATA' }] }))).toContain('requirements[0].module'); // a new project has no modules
  });
  it('names each bad record: unknown hypothesis, duplicate id, explore line with hypotheses, claims, bad owner', () => {
    const bad = (r: unknown) => problems(research({ research: r }));
    expect(bad({ lines: RESEARCH.lines, papers: [{ title: 'P', status: 'planned', hypotheses: ['nope'] }] })).toContain('research.papers[0].hypotheses[0]');
    expect(bad({ lines: [RESEARCH.lines[0], { ...RESEARCH.lines[0], hypotheses: [] }], papers: [] })).toContain('research.lines[1].id');
    expect(bad({ lines: [{ ...RESEARCH.lines[0], mode: 'explore' }], papers: [] })).toContain('research.lines[0].hypotheses');
    expect(bad({ lines: [], papers: [{ title: 'P', status: 'planned', claims: ['x'] }] })).toContain('research.papers[0].claims');
    expect(bad({ lines: [], papers: [{ title: 'P', status: 'planned', owner: 'nobody' }] })).toContain('research.papers[0].owner');
    expect(bad({ lines: [], papers: [{ title: 'P', status: 'rejected' }] })).toContain('research.papers[0].status');
  });
  it('requirements and research records count together against the requirements limit', () => {
    const papers = Array.from({ length: 20 }, (_, i) => ({ title: `Paper ${i}`, status: 'planned' }));
    const reqs = Array.from({ length: 11 }, (_, i) => ({ kind: 'nfr', title: `Quality ${i}`, text: 'Fast.', category: 'perf' }));
    expect(problems(request({ source: { from: 'coordinator' }, requirements: reqs, research: { lines: [], papers } }))).toContain('requirements');
    expect(problems(request({ source: { from: 'coordinator' }, requirements: reqs.slice(0, 10), research: { lines: [], papers } }))).toEqual([]);
  });
});

describe('3 and 4. one linked proposal, and the setup record', () => {
  it('"the operator supplies them" with nothing typed: no proposal, and the setup shows the operator owes the content', async () => {
    const r = await filed('src-op-pc', { source: { from: 'operator' } });
    const a = await approve(r);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    expect(proposalsOf(team)).toHaveLength(0);
    expect(app.db.prepare('SELECT proposal_id, approved_version, filed FROM onboarding_requests WHERE id=?').get(r.id)).toEqual({ proposal_id: null, approved_version: r.version, filed: '[]' });
    const page = await api('GET', `/teams/${team}`);
    expect(page.body.setup).toMatchObject({ state: 'operator_supplies', responsible: 'operator', proposal: null, source: { from: 'operator' }, request_id: r.id });
  });
  it('"the coordinator derives them" and "an existing source": the coordinator is responsible, and the reference is only shown', async () => {
    const c = await approve(await filed('src-co-pc', { source: { from: 'coordinator' } }));
    expect((await api('GET', `/teams/${c.body.request.team_id}`)).body.setup).toMatchObject({ state: 'coordinator_derives', responsible: 'coordinator' });
    const e = await approve(await filed('src-ex-pc', { source: { from: 'existing', ref: 'https://example.org/spec' } }));
    const s = (await api('GET', `/teams/${e.body.request.team_id}`)).body.setup;
    expect(s).toMatchObject({ state: 'from_source', responsible: 'coordinator', source: { from: 'existing', ref: 'https://example.org/spec' } });
    expect(s.next).toContain('https://example.org/spec');
    // An older client's request: the source was never asked, and only the operator can set it.
    const o = await approve(await filed('src-old-pc'));
    expect((await api('GET', `/teams/${o.body.request.team_id}`)).body.setup).toMatchObject({ state: 'not_asked', responsible: 'operator', next: 'Set where the requirements or the brief come from.' });
  });
  it('a research brief: the new project takes its kind, and one proposal holds the line, hypothesis, question and three papers', async () => {
    const r = await filed('src-res-pc', { project: { name: 'Sleep study', existing: false, kind: 'research', more_teams: true }, source: { from: 'existing', ref: 'docs/brief.md' }, research: RESEARCH });
    const a = await approve(r);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    const project = app.blueprint.projectOfTeam(team)!;
    expect(project.kind).toBe('research');
    const props = proposalsOf(team);
    expect(props).toHaveLength(1);
    const all = JSON.parse(props[0]!.ops) as { op: string; kind: string; key: string; parent_key?: string; status?: string; team_id?: string; fields?: Record<string, unknown>; from?: string; to?: string; rel?: string }[];
    // The items, then the links: each planned paper studies the hypothesis it is about (the Blueprint's studies relation).
    const ops = all.filter((o) => o.op !== 'link');
    const track = app.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND team_id=? AND kind='line' AND deleted_at IS NULL").get(project.id, team) as { key: string };
    expect(ops.map((o) => [o.kind, o.key])).toEqual([
      ['line', `${track.key}.1`], ['hypothesis', `H-${track.key}.1-01`], ['question', `Q-${track.key}.1-01`], ['paper', 'PAP-1'], ['paper', 'PAP-2'], ['paper', 'PAP-3'],
    ]);
    expect(ops[0]).toMatchObject({ parent_key: track.key, status: 'active', fields: { mode: 'validate', question: 'Does sleep improve recall?' } });
    expect(ops[1]).toMatchObject({ status: 'untested', fields: { statement: 'Eight hours of sleep improves next-day recall', criteria: 'A recall gain of 10% or more in the trial.' } });
    // One existing paper imported with its manuscript; two planned papers about one hypothesis, without manuscripts or claims.
    expect(ops[3]).toMatchObject({ status: 'published', team_id: team, fields: { venue: 'J. Sleep', type: 'paper', manuscript: 'https://example.org/review.pdf', authors: ['A. Author'] } });
    expect(ops.slice(4).every((o) => o.status === 'planned' && !o.fields)).toBe(true);
    expect(all.filter((o) => o.op === 'link').map((o) => [o.from, o.rel, o.to])).toEqual([['PAP-2', 'studies', `H-${track.key}.1-01`], ['PAP-3', 'studies', `H-${track.key}.1-01`]]);
    expect(ops.some((o) => o.kind === 'claim')).toBe(false);
    // The request records the proposal, and each item with its scope and owner; the paper's hypotheses stay on the request.
    const row = app.db.prepare('SELECT proposal_id, filed, approved_body FROM onboarding_requests WHERE id=?').get(r.id) as { proposal_id: string; filed: string; approved_body: string };
    expect(row.proposal_id).toBe(props[0]!.id);
    expect(JSON.parse(row.filed)).toEqual(expect.arrayContaining([{ key: `${track.key}.1`, kind: 'line', title: 'Sleep and recall', scope: 'team', owner: 'writer' }, { key: 'PAP-2', kind: 'paper', title: 'The recall trial', scope: 'team', owner: 'writer' }]));
    expect(JSON.parse(row.approved_body).research.papers[2].hypotheses).toEqual(['h-sleep']);
    // Nothing applied yet; the setup shows a proposal to review, then done once the operator applies it.
    expect(app.blueprint.item(project.id, 'PAP-1')).toBeUndefined();
    expect((await api('GET', `/teams/${team}`)).body.setup).toMatchObject({ state: 'in_review', responsible: 'operator', items: 6 });
    const applied = await api('POST', `/proposals/${props[0]!.id}/apply`, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(app.blueprint.item(project.id, 'PAP-1')).toMatchObject({ team_id: team, status: 'published' });
    expect(app.blueprint.item(project.id, `H-${track.key}.1-01`)).toMatchObject({ team_id: team, status: 'untested' });
    expect((await api('GET', `/teams/${team}`)).body.setup).toMatchObject({ state: 'done', responsible: null });
  });
  it("a research brief for a project's only team opens a project-level line in the same proposal, scoped to the project", async () => {
    const r = await filed('src-sole-pc', { project: { name: 'Solo sleep study', existing: false, kind: 'research' }, source: { from: 'existing', ref: 'docs/brief.md' }, research: RESEARCH });
    const a = await approve(r);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    const project = app.blueprint.projectOfTeam(team)!;
    // No part: the team owns no line.
    expect(app.db.prepare("SELECT 1 FROM bp_items WHERE project_id=? AND team_id=? AND kind IN ('module','line') AND deleted_at IS NULL").get(project.id, team)).toBeUndefined();
    const props = proposalsOf(team);
    expect(props).toHaveLength(1);
    const ops = (JSON.parse(props[0]!.ops) as { op: string; kind: string; key: string; parent_key?: string; team_id?: string | null }[]).filter((o) => o.op !== 'link');
    expect(ops[0]).toMatchObject({ op: 'upsert', kind: 'line', key: 'L1', team_id: null });
    expect(ops.slice(1, 4).map((o) => [o.kind, o.key])).toEqual([['line', 'L1.1'], ['hypothesis', 'H-L1.1-01'], ['question', 'Q-L1.1-01']]);
    expect(JSON.parse((app.db.prepare('SELECT filed FROM onboarding_requests WHERE id=?').get(r.id) as { filed: string }).filed)).toEqual(expect.arrayContaining([{ key: 'L1.1', kind: 'line', title: 'Sleep and recall', scope: 'project', owner: 'writer' }]));
    const applied = await api('POST', `/proposals/${props[0]!.id}/apply`, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(app.blueprint.item(project.id, 'L1')).toMatchObject({ kind: 'line', team_id: null, status: 'active' });
    expect(app.blueprint.item(project.id, 'H-L1.1-01')).toMatchObject({ status: 'untested' });
    // Its papers are the project's too, so they stay there if a second team joins.
    const paper = ops.find((o) => o.kind === 'paper')!;
    expect(paper.team_id).toBeNull();
    expect(app.blueprint.item(project.id, paper.key)).toMatchObject({ kind: 'paper', team_id: null });
    expect(JSON.parse((app.db.prepare('SELECT filed FROM onboarding_requests WHERE id=?').get(r.id) as { filed: string }).filed)).toEqual(expect.arrayContaining([expect.objectContaining({ key: paper.key, kind: 'paper', scope: 'project' })]));
  });
  it('the operator unticks content: only what was kept is filed; unticking everything files no proposal', async () => {
    const r = await filed('src-pick-pc', { project: { name: 'Pick study', existing: false, kind: 'research' }, source: { from: 'coordinator' }, research: RESEARCH });
    const a = await approve(r, { edits: { research: { lines: [], papers: [RESEARCH.papers[0]] } } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect((JSON.parse(proposalsOf(a.body.request.team_id)[0]!.ops) as { key: string }[]).map((o) => o.key)).toEqual(['PAP-1']);
    const r2 = await filed('src-none-pc', { project: { name: 'None study', existing: false, kind: 'research' }, source: { from: 'coordinator' }, research: RESEARCH });
    const a2 = await approve(r2, { edits: { research: { lines: [], papers: [] } } });
    expect(a2.status, JSON.stringify(a2.body)).toBe(200);
    expect(proposalsOf(a2.body.request.team_id)).toHaveLength(0);
    expect((await api('GET', `/teams/${a2.body.request.team_id}`)).body.setup).toMatchObject({ state: 'coordinator_derives' });
  });
  it('a rejected proposal returns the content to the named person', async () => {
    const r = await filed('src-rej-pc', { source: { from: 'operator' }, requirements: [{ kind: 'fr', title: 'Export', text: 'The data exports as CSV.' }] });
    const a = await approve(r);
    const team = a.body.request.team_id as string, pid = proposalsOf(team)[0]!.id;
    expect((await api('POST', `/proposals/${pid}/reject`, { note: 'Too vague' })).status).toBe(200);
    expect((await api('GET', `/teams/${team}`)).body.setup).toMatchObject({ state: 'returned', responsible: 'operator', proposal: { id: pid, status: 'rejected' } });
    expect((await api('GET', `/onboarding/${r.id}`)).body.request.setup).toMatchObject({ state: 'returned' });
  });
  it('a requirement in an existing research project goes into the named module, with project scope', async () => {
    const p = app.blueprint.createProject({ key: 'RSX', name: 'Research existing', kind: 'research' }, op);
    app.blueprint.write(p.id, { version: p.version, ops: [{ op: 'upsert', kind: 'module', key: 'DATA', title: 'Data tools' }] }, op);
    const fr = { kind: 'fr', title: 'Export the data', text: 'The data exports as CSV.' };
    expect(problems(request({ project: { name: 'Research existing', existing: true }, source: { from: 'coordinator' }, requirements: [fr] }))).toContain('requirements[0].module');
    expect(problems(request({ project: { name: 'Research existing', existing: true }, source: { from: 'coordinator' }, requirements: [{ ...fr, module: 'NOPE' }] }))).toContain('requirements[0].module');
    const r = await filed('src-mod-pc', { project: { name: 'Research existing', existing: true }, source: { from: 'coordinator' }, requirements: [{ ...fr, module: 'DATA' }] });
    const a = await approve(r);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const ops = JSON.parse(proposalsOf(a.body.request.team_id)[0]!.ops) as { kind: string; key: string; parent_key: string }[];
    expect(ops[0]).toMatchObject({ kind: 'fr', key: 'FR-DATA-01', parent_key: 'DATA' });
    expect(JSON.parse((app.db.prepare('SELECT filed FROM onboarding_requests WHERE id=?').get(r.id) as { filed: string }).filed)).toEqual([{ key: 'FR-DATA-01', kind: 'fr', title: 'Export the data', scope: 'project' }]);
  });
});

describe('5. one approval: replay and checks inside the transaction', () => {
  it('a repeated approval after a lost response returns the original team and proposal and creates nothing', async () => {
    const r = await filed('src-replay-pc', { source: { from: 'coordinator' }, requirements: [{ kind: 'fr', title: 'Export', text: 'The data exports as CSV.' }] });
    const a = await approve(r);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const teams = (app.db.prepare('SELECT COUNT(*) n FROM teams').get() as { n: number }).n;
    const b = await approve(r);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.request.team_id).toBe(a.body.request.team_id);
    expect((app.db.prepare('SELECT COUNT(*) n FROM teams').get() as { n: number }).n).toBe(teams);
    expect(proposalsOf(a.body.request.team_id)).toHaveLength(1);
    expect(a.body.replayed).toBeUndefined();
    // Another version is not a replay.
    expect((await approve({ id: r.id, version: r.version + 5 })).status).not.toBe(200);
  });
  it('a limit lowered after filing fails the approval and creates nothing', async () => {
    const r = await filed('src-limit-pc', { project: { name: 'Limit study', existing: false, kind: 'research' }, source: { from: 'coordinator' }, research: RESEARCH });
    const teams = (app.db.prepare('SELECT COUNT(*) n FROM teams').get() as { n: number }).n;
    expect((await api('PUT', '/settings/onboarding', { max_requirements: 3 })).status).toBe(200);
    try {
      const a = await approve(r);
      expect(a.status).toBe(400);
      expect(JSON.stringify(a.body)).toContain('max_requirements');
      expect((app.db.prepare('SELECT COUNT(*) n FROM teams').get() as { n: number }).n).toBe(teams);
      expect(app.db.prepare('SELECT state, proposal_id FROM onboarding_requests WHERE id=?').get(r.id)).toEqual({ state: 'submitted', proposal_id: null });
    } finally { expect((await api('PUT', '/settings/onboarding', { max_requirements: 30 })).status).toBe(200); }
  });
  it('a failure while filing the proposal rolls back the whole approval', async () => {
    const r = await filed('src-roll-pc', { source: { from: 'coordinator' }, requirements: [{ kind: 'fr', title: 'Export', text: 'The data exports as CSV.' }] });
    const teams = (app.db.prepare('SELECT COUNT(*) n FROM teams').get() as { n: number }).n;
    const real = app.onboarding.proposeContent;
    app.onboarding.proposeContent = () => { throw new Error('boom'); };
    try { expect((await approve(r)).status).toBe(500); } finally { app.onboarding.proposeContent = real; }
    expect((app.db.prepare('SELECT COUNT(*) n FROM teams').get() as { n: number }).n).toBe(teams);
    expect(app.db.prepare('SELECT state FROM onboarding_requests WHERE id=?').get(r.id)).toEqual({ state: 'submitted' });
  });
});

describe('6. the PC client applies the same rules', () => {
  const fields = (r: unknown) => (validateRequest(r) as { field: string }[]).map((p) => p.field);
  it('checks the source, the project kind and the research records before filing', () => {
    expect(fields(request({ source: { from: 'coordinator' } }))).toEqual([]);
    expect(fields(request({ project: { name: 'R', existing: false, kind: 'research' }, source: { from: 'existing', ref: 'docs/brief.md' }, research: RESEARCH }))).toEqual([]);
    expect(fields(request({ source: { from: 'existing' } }))).toContain('source.ref');
    expect(fields(request({ project: { name: 'R', existing: false, kind: 'lab' } }))).toContain('project.kind');
    expect(fields(request({ project: { name: 'R', existing: false }, research: RESEARCH }))).toContain('research.lines');
    expect(fields(request({ research: { lines: [], papers: [{ title: 'P', status: 'planned', claims: ['x'] }] } }))).toContain('research.papers[0].claims');
    expect(fields(request({ project: { name: 'R', existing: false, kind: 'research' }, research: { lines: RESEARCH.lines, papers: [{ title: 'P', status: 'planned', hypotheses: ['nope'] }] } }))).toContain('research.papers[0].hypotheses[0]');
  });
});

describe('7. the source after setup, and Done for a team whose part holds content', () => {
  const P = { id: 'prop_1', status: 'open' };
  /** A request filed and approved: the team exists. */
  const collected = async (pc: string, over: Record<string, unknown> = {}) => {
    const r = await filed(pc, over);
    const a = await approve(r);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return { ...r, team: a.body.request.team_id as string };
  };
  const setSrc = (id: string, source: unknown) => api('PUT', `/onboarding/${id}/source`, { source });
  const audits = (id: string) => app.db.prepare("SELECT details FROM audit_events WHERE action='onboarding.source_set' AND target_id=?").all(id) as { details: string }[];
  const write = (team: string, ops: unknown[]) => { const p = app.blueprint.projectOfTeam(team)!; app.blueprint.write(p.id, { version: p.version, ops: ops as never }, { kind: 'operator', id: null }); };
  const track = (team: string) => (app.db.prepare("SELECT key FROM bp_items WHERE team_id=? AND kind IN ('module','line') AND deleted_at IS NULL").get(team) as { key: string } | undefined)?.key;

  it('setupOf: content with no proposal reads Done; a linked proposal still decides; no content keeps today\'s states', () => {
    expect(setupOf(null, null, 0, 3)).toMatchObject({ state: 'done', responsible: null, next: 'Done: the team plans from its part (3 items).' });
    expect(setupOf({ from: 'existing', ref: 'docs/spec.md' }, null, 0, 1).next).toBe('Done: the team plans from its part (1 item).');
    expect(setupOf(null, { id: 'prop_1', status: 'rejected' }, 0, 5).state).toBe('returned');
    expect(setupOf(null, P, 0, 5).state).toBe('in_review');
    expect(setupOf(null, null, 0, 0)).toMatchObject({ state: 'not_asked', responsible: 'operator' });
    expect(setupOf({ from: 'coordinator' }, null, 0).state).toBe('coordinator_derives');
  });

  it('the operator sets an existing source on a not-asked team: shown, audited once, the approved request unchanged', async () => {
    const r = await collected('src-set-pc');
    const before = app.db.prepare('SELECT approved_body FROM onboarding_requests WHERE id=?').get(r.id) as { approved_body: string };
    const s = await setSrc(r.id, { from: 'existing', ref: 'docs/specification.md' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.setup).toMatchObject({ state: 'from_source', responsible: 'coordinator', source: { from: 'existing', ref: 'docs/specification.md' } });
    expect((await api('GET', `/teams/${r.team}`)).body.setup).toMatchObject({ state: 'from_source', source: { from: 'existing', ref: 'docs/specification.md' } });
    const a = audits(r.id);
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]!.details)).toMatchObject({ old: null, new: { from: 'existing', ref: 'docs/specification.md' } });
    const after = app.db.prepare('SELECT approved_body, source_set FROM onboarding_requests WHERE id=?').get(r.id) as { approved_body: string; source_set: string };
    expect(after.approved_body).toBe(before.approved_body);
    expect(JSON.parse(after.approved_body).source).toBeUndefined();
    expect(JSON.parse(after.source_set)).toMatchObject({ from: 'existing', ref: 'docs/specification.md', by: { kind: 'admin' } });
    // A correction is audited with the old value.
    expect((await setSrc(r.id, { from: 'coordinator', note: 'Derive them from the goal.' })).status).toBe(200);
    expect(JSON.parse(audits(r.id)[1]!.details)).toMatchObject({ old: { from: 'existing', ref: 'docs/specification.md' }, new: { from: 'coordinator', note: 'Derive them from the goal.' } });
  });

  it('refuses a bad source with the request\'s field names', async () => {
    const r = await collected('src-bad-pc');
    const field = async (source: unknown) => ((await setSrc(r.id, source)).body.problems ?? []).map((p: { field: string }) => p.field);
    expect((await setSrc(r.id, { from: 'existing' })).status).toBe(400);
    expect(await field({ from: 'existing' })).toContain('source.ref');
    expect(await field({ from: 'existing', ref: 'a\nb' })).toContain('source.ref');
    expect(await field({ from: 'operator', ref: 'x' })).toContain('source.ref');
    expect(await field({ from: 'someone' })).toContain('source.from');
    expect(await field('docs')).toContain('source');
    expect(audits(r.id)).toHaveLength(0);
  });

  it('refuses a request that is not an approved new team, and any change while a proposal is open', async () => {
    const pending = await filed('src-pend-pc');
    expect((await setSrc(pending.id, { from: 'coordinator' })).status).toBe(409);
    expect((await setSrc('obr_none', { from: 'coordinator' })).status).toBe(404);
    const r = await collected('src-open-pc', { source: { from: 'coordinator' }, requirements: [{ kind: 'fr', title: 'Export', text: 'The data exports as CSV.' }] });
    expect((await api('GET', `/teams/${r.team}`)).body.setup.state).toBe('in_review');
    const s = await setSrc(r.id, { from: 'operator' });
    expect(s.status).toBe(409);
    expect(JSON.stringify(s.body)).toContain('proposal is open');
    expect(audits(r.id)).toHaveLength(0);
  });

  it('is the operator\'s only: declared admin in ROUTE_SCOPES, and refused without the admin session', async () => {
    const src = (await import('node:fs')).readFileSync(join(process.cwd(), 'src', 'admin', 'scopes.ts'), 'utf8');
    expect(src).toContain("'PUT /api/onboarding/:id/source': 'admin',");
    const r = await collected('src-anon-pc');
    const anon = await fetch(`${base}/api/onboarding/${r.id}/source`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: { from: 'coordinator' } }) });
    expect(anon.status).toBe(401);
    expect(audits(r.id)).toHaveLength(0);
  });

  it('a team right after approval, holding only its track, is not Done; content in its part makes it Done', async () => {
    const r = await collected('src-part-pc', { project: { name: 'Shared work', existing: false, kind: 'implementation', more_teams: true }, source: { from: 'operator' } });
    const k = track(r.team)!;
    expect(k).toBeTruthy();
    expect((await api('GET', `/teams/${r.team}`)).body.setup).toMatchObject({ state: 'operator_supplies' });
    write(r.team, [{ op: 'upsert', kind: 'fr', key: `FR-${k}-01`, parent_key: k, title: 'Export the data' }]);
    expect((await api('GET', `/teams/${r.team}`)).body.setup).toMatchObject({ state: 'done', responsible: null, next: 'Done: the team plans from its part (1 item).' });
    // Dropped items do not count.
    write(r.team, [{ op: 'upsert', kind: 'fr', key: `FR-${k}-01`, status: 'dropped' }]);
    expect((await api('GET', `/teams/${r.team}`)).body.setup.state).toBe('operator_supplies');
  });

  it('a project\'s only team with project-level items and no proposal reads Done, whatever its source', async () => {
    const r = await collected('src-only-team-pc');
    expect(track(r.team)).toBeUndefined(); // FR-PLAN-12: no part
    expect((await api('GET', `/teams/${r.team}`)).body.setup.state).toBe('not_asked');
    write(r.team, [{ op: 'upsert', kind: 'module', key: 'CORE', title: 'Core' }, { op: 'upsert', kind: 'fr', key: 'FR-CORE-01', parent_key: 'CORE', title: 'The hub starts' }]);
    const s = (await api('GET', `/teams/${r.team}`)).body.setup;
    expect(s).toMatchObject({ state: 'done', source: null, next: 'Done: the team plans from its part (1 item).' });
  });

  it('notifies the coordinators when the new state is theirs, and not for "the operator supplies them"', async () => {
    const key = await enrol('src-notice-pc');
    const f = await ob('POST', '/requests', { key, body: request() });
    expect(f.status).toBe(200);
    expect((await approve({ id: f.body.request_id, version: f.body.version })).status).toBe(200);
    const p = await ob('POST', '/pickup', { key, body: { request_id: f.body.request_id } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const c = await ob('POST', '/pickup/confirm', { key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const req = app.db.prepare('SELECT team_id, state FROM onboarding_requests WHERE id=?').get(f.body.request_id) as { team_id: string; state: string };
    expect(req.state).toBe('collected');
    const coord = (app.db.prepare("SELECT agent_id FROM team_members WHERE team_id=? AND role='coordinator' AND removed_at IS NULL").get(req.team_id) as { agent_id: string }).agent_id;
    const notices = () => app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='setup_source'").all(coord) as { body: string }[];
    expect((await setSrc(f.body.request_id, { from: 'operator' })).status).toBe(200);
    expect(notices()).toHaveLength(0);
    expect((await setSrc(f.body.request_id, { from: 'existing', ref: 'docs/specification.md' })).status).toBe(200);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.body).toContain('docs/specification.md');
    expect(notices()[0]!.body).toContain('grants no access');
  });
});

describe('8. a setup whose next step is the operator\'s is one Needs you row', () => {
  const setups = async (team: string) => ((await api('GET', `/needs-you?team=${team}`)).body.items as { kind: string; title: string; source: { version: string }; open: { kind: string; id: string } }[]).filter((x) => x.kind === 'setup');
  const teamOf = async (over: Record<string, unknown>, pc: string) => { const r = await filed(pc, over); const a = await approve(r); expect(a.status, JSON.stringify(a.body)).toBe(200); return { id: r.id, team: a.body.request.team_id as string }; };

  it('shows for Source not asked and Waiting for you, opens the setup, and leaves when the state changes', async () => {
    const o = await teamOf({}, 'ny-old-pc');
    const [row, ...more] = await setups(o.team);
    expect(more).toHaveLength(0);
    expect(row).toMatchObject({ title: 'Setup: Set where the requirements or the brief come from', open: { kind: 'setup', id: o.id }, source: { version: 'not_asked:' } });
    expect((await api('PUT', `/onboarding/${o.id}/source`, { source: { from: 'operator' } })).status).toBe(200);
    expect((await setups(o.team)).map((x) => x.title)).toEqual(['Setup: Supply the requirements or the brief']);
    expect((await api('PUT', `/onboarding/${o.id}/source`, { source: { from: 'coordinator' } })).status).toBe(200);
    expect(await setups(o.team)).toHaveLength(0); // the coordinator's now
  });

  it('none while the coordinator owes it or a proposal is in review; one when a rejected proposal returns to the operator; none once Done', async () => {
    expect(await setups((await teamOf({ source: { from: 'existing', ref: 'docs/spec.md' } }, 'ny-ex-pc')).team)).toHaveLength(0);
    expect(await setups((await teamOf({ source: { from: 'coordinator' } }, 'ny-co-pc')).team)).toHaveLength(0);
    const req = [{ kind: 'fr', title: 'Export', text: 'The data exports as CSV.' }];
    const r = await teamOf({ source: { from: 'operator' }, requirements: req }, 'ny-rej-pc');
    expect(await setups(r.team)).toHaveLength(0); // in review: the proposal itself is what waits
    expect((await api('POST', `/proposals/${proposalsOf(r.team)[0]!.id}/reject`, { note: 'Too vague' })).status).toBe(200);
    expect((await setups(r.team)).map((x) => x.source.version)).toEqual([`returned:${proposalsOf(r.team)[0]!.id}`]);
    // Returned to the coordinator (it derives them): theirs, not a row.
    const c = await teamOf({ source: { from: 'coordinator' }, requirements: req }, 'ny-rejc-pc');
    expect((await api('POST', `/proposals/${proposalsOf(c.team)[0]!.id}/reject`, { note: 'Too vague' })).status).toBe(200);
    expect(await setups(c.team)).toHaveLength(0);
    const d = await teamOf({ source: { from: 'operator' }, requirements: req }, 'ny-done-pc');
    expect((await api('POST', `/proposals/${proposalsOf(d.team)[0]!.id}/apply`, {})).status).toBe(200);
    expect(await setups(d.team)).toHaveLength(0);
  });
});
