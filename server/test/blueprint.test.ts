/** Project Blueprint (docs/blueprint.md §2, §3, §5): kinds, keys, links, versions, history, limits and team plans. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { Blueprint, type Op } from '../src/blueprint/blueprint.js';
import { BlueprintViews } from '../src/blueprint/views.js';
import { KINDS, RETIRED } from '../src/blueprint/kinds.js';
import { Reset } from '../src/safety/reset.js';
import { tx } from '../src/db/db.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const op = { kind: 'operator' as const, id: 'adm_1' };
type Res = { isError?: boolean; structuredContent?: any; content?: any };
let app: App, base = '', dir = '', config: Config;
let C: (name: string, args?: Record<string, unknown>) => Promise<Res>, coordId = '', teamId = '', otherTeam = '';
let coordCred = '';
const mkTeam = (name: string) => app.teams.create({ name, goal: 'g', members: [{ agent_id: coordId, role: 'coordinator', credential_id: coordCred }] }, sys).id;

const code = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; } };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahbp-'));
  mkdirSync(join(dir, 'vault'));
  config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const { cookie, csrf } = await adminLogin(base);
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const a = app.keys.createAgent('coord', null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: 'coord' }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as Res).structuredContent.session_token;
  C = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
  coordId = a.id; coordCred = k.credential.id;
  teamId = app.teams.create({ name: 'Signals Lab', goal: 'Echo model.', members: [{ agent_id: a.id, role: 'coordinator', credential_id: k.credential.id }] }, sys).id;
  app.teams.start(teamId, sys);
  otherTeam = mkTeam('Power and Coils');
});
afterAll(async () => { await app?.close(); });

/** A fresh project for one test; tests that need teams attach them. */
const fresh = (kind: 'implementation' | 'research' = 'implementation', limits = {}) => {
  const bp = Object.keys(limits).length ? new Blueprint(app.db, limits) : app.blueprint;
  const p = bp.createProject({ key: bp.suggestKey(`Test ${Math.random().toString(36).slice(2, 6)}`), name: 'Test', kind }, op);
  let v = p.version;
  const w = (ops: Op[]) => { const r = bp.write(p.id, { version: v, ops }, op); v = r.version; return r; };
  return { bp, p, w, v: () => v };
};
const mod = (key = 'TEAM'): Op => ({ op: 'upsert', kind: 'module', key, title: 'Teams and tasks' });

describe('projects', () => {
  it('checks the key and name and refuses a taken key', () => {
    expect(code(() => app.blueprint.createProject({ key: 'cnv', name: 'x' }, op))).toMatch(/^invalid_argument/);
    expect(code(() => app.blueprint.createProject({ key: 'CNV', name: ' ' }, op))).toMatch(/^invalid_argument/);
    app.blueprint.createProject({ key: 'CNV', name: 'Conclave' }, op);
    expect(code(() => app.blueprint.createProject({ key: 'CNV', name: 'Again' }, op))).toMatch(/^conflict/);
    expect(app.blueprint.suggestKey('Conclave Nexus Vault')).toBe('CNVAA');
  });
  it('checks every value of an update before writing any: one bad value changes nothing', () => {
    const { bp, p } = fresh();
    const t = mkTeam(`Upd ${p.key}`);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(p.id, t);
    const notices = () => (app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE kind='project_changed'").get() as { n: number }).n;
    const n0 = notices();
    expect(code(() => bp.updateProject(p.id, { review_policy: 'none', task_intake: 'nope' as 'open' }, op))).toMatch(/^invalid_argument: A task intake/);
    expect(bp.project(p.id)).toMatchObject({ review_policy: p.review_policy, task_intake: p.task_intake });
    expect(notices()).toBe(n0);
    expect(bp.updateProject(p.id, { review_policy: 'none' }, op).review_policy).toBe('none');
    expect(notices()).toBeGreaterThan(n0);
  });
});

describe('kinds', () => {
  it('writes one item of every kind with its fields, statuses and authorship', () => {
    const { bp, p, w } = fresh();
    const r = w([
      { op: 'upsert', kind: 'summary', key: 'SUM', title: 'Conclave', fields: { vision: 'Agents work together.', objective: 'Who, what, done.', value: 'One hub.' } },
      { op: 'upsert', kind: 'stakeholder', key: 'SH-*', title: 'Bruno', fields: { role: 'Operator', decides: true, seat: 'operator' } },
      mod(),
      { op: 'upsert', kind: 'fr', key: 'FR-TEAM-*', parent_key: 'TEAM', title: 'Only one claim wins', fields: { priority: 'must', stories: ['As a coordinator …'] } },
      { op: 'upsert', kind: 'nfr', key: 'NFR-PERF-01', parent_key: 'TEAM', title: 'Footprint', fields: { category: 'performance', target: '1 vCPU / 2 GB' } },
      { op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC*', parent_key: 'FR-TEAM-01', title: 'Two claims', fields: { given: 'two workers', when: 'both claim', then: 'one wins' } },
      { op: 'upsert', kind: 'line', key: 'L1', title: 'Search index', fields: { mode: 'validate', question: 'FTS5?' } },
      { op: 'upsert', kind: 'line', key: 'L2', title: 'Blind review', fields: { mode: 'explore' } },
      { op: 'upsert', kind: 'hypothesis', key: 'H-L1-*', parent_key: 'L1', title: 'FTS5 is fast', fields: { statement: 'p95 < 50 ms', criteria: 'bench' }, status: 'testing' },
      { op: 'upsert', kind: 'question', key: 'Q-L2-*', parent_key: 'L2', title: 'Sealed scopes?' },
      { op: 'upsert', kind: 'finding', key: 'F-L2-*', parent_key: 'L2', title: 'Aliases leak', fields: { confidence: 'medium', evidence: 'run 3' } },
      { op: 'upsert', kind: 'architecture', key: 'ARCH', title: 'Architecture', body: 'One process.' },
      { op: 'upsert', kind: 'decision', key: 'ADR-*', title: 'Single process', status: 'accepted', fields: { options: [{ key: 'A', label: 'One' }], chosen: 'A', decided_at: 1, source: 'adr' } },
      { op: 'upsert', kind: 'milestone', key: 'M*', title: 'Baseline', fields: { phase: 'MVP', target_at: 2, exit: 'All green' } },
      { op: 'upsert', kind: 'release', key: 'REL-0.9', title: 'Onboarding', fields: { version: '0.9' } },
      { op: 'upsert', kind: 'report', key: 'SR-*', title: 'Week 1', fields: { health: 'at_risk', done: ['a'], next: ['b'], blockers: [], escalate: false } },
      { op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Prompt injection', fields: { likelihood: 'high', impact: 'high', owner: 'Operator' } },
      { op: 'upsert', kind: 'issue', key: 'I*', title: 'Disk at 90%', fields: { impact: 'medium' } },
      { op: 'upsert', kind: 'term', key: 'G-app-key', title: 'App key', body: 'Authenticates one app.' },
      { op: 'upsert', kind: 'reference', key: 'REF-*', title: 'MCP guide', fields: { url: 'docs/mcp.md', kind: 'doc' } },
    ]);
    expect(r.keys).toMatchObject({ 'SH-*': 'SH-1', 'FR-TEAM-*': 'FR-TEAM-01', 'FR-TEAM-01/AC*': 'FR-TEAM-01/AC1', 'H-L1-*': 'H-L1-01', 'ADR-*': 'ADR-001', 'M*': 'M1', 'SR-*': 'SR-001', 'RK-*': 'RK-01', 'I*': 'I1', 'REF-*': 'REF-1' });
    expect(r.added).toHaveLength(20);
    const fr = bp.item(p.id, 'FR-TEAM-01')!;
    expect(fr).toMatchObject({ status: 'draft', parent_key: 'TEAM', created_by_kind: 'operator', created_by_id: 'adm_1', rev: 1, fields: { priority: 'must' } });
    expect(bp.item(p.id, 'FR-TEAM-01/AC1')!.status).toBe('open');
    expect(bp.item(p.id, 'L1')!.status).toBe('active');
    expect(bp.item(p.id, 'SR-001')!.status).toBeNull();
  });

  it('a milestone may carry a short name of up to 24 characters, and a paper\'s item view lists it on the milestones that deliver it', () => {
    const { bp, p, w } = fresh();
    const ok = 'x'.repeat(24);
    w([{ op: 'upsert', kind: 'milestone', key: 'M*', title: 'Paper submitted to the journal', fields: { short: 'Submission' } }, { op: 'upsert', kind: 'milestone', key: 'M*', title: 'Plain milestone' }, { op: 'upsert', kind: 'milestone', key: 'M*', title: 'Edge', fields: { short: ok } }]);
    expect(bp.item(p.id, 'M3')!.fields).toMatchObject({ short: ok });
    expect(code(() => w([{ op: 'upsert', kind: 'milestone', key: 'M1', title: 'Paper submitted to the journal', fields: { short: ok + 'y' } }]))).toMatch(/short name is at most 24 characters; this one has 25/);
    expect(code(() => w([{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'x', fields: { short: 'no' } }]))).toMatch(/no field short/);
    w([{ op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'A paper' }, { op: 'link', from: 'M1', to: 'PAP-1', rel: 'delivers' }, { op: 'link', from: 'M2', to: 'PAP-1', rel: 'delivers' }]);
    const d = new BlueprintViews(app.db, bp).detail(p.id, 'PAP-1') as { links: { in: { key: string; short?: string }[] } };
    expect(d.links.in.find((l) => l.key === 'M1')).toMatchObject({ short: 'Submission' });
    expect(d.links.in.find((l) => l.key === 'M2')).not.toHaveProperty('short');
  });

  it('refuses bad keys, unknown kinds and fields, bad values and statuses', () => {
    const { w } = fresh();
    w([mod()]);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'R1', parent_key: 'TEAM', title: 'x' }]))).toMatch(/not a valid fr key/);
    expect(code(() => w([{ op: 'upsert', kind: 'risk', key: 'R01', title: 'x' }]))).toMatch(/not a valid risk key/);
    expect(code(() => w([{ op: 'upsert', kind: 'epic', key: 'E1', title: 'x' }]))).toMatch(/Unknown kind/);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'x', fields: { colour: 'red' } }]))).toMatch(/no field colour/);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'x', fields: { priority: 'urgent' } }]))).toMatch(/one of must, should, could/);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'x', fields: { stories: 'one' } }]))).toMatch(/must be strs/);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'x', status: 'met' }]))).toMatch(/status is one of draft/);
    expect(code(() => w([{ op: 'upsert', kind: 'term', key: 'G-x', title: 'x', status: 'open' }]))).toMatch(/has no status/);
    expect(code(() => w([{ op: 'upsert', kind: 'line', key: 'L1', title: 'x' }]))).toMatch(/needs mode/);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: '' }]))).toMatch(/needs a title/);
  });

  it('places items: parents required and of the right kind, ACs keyed by their parent, one summary', () => {
    const { w } = fresh();
    w([mod(), { op: 'upsert', kind: 'summary', key: 'SUM', title: 's' }, { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'x' }, { op: 'upsert', kind: 'line', key: 'L1', title: 'l', fields: { mode: 'validate' } }]);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', title: 'x' }]))).toMatch(/needs a parent/);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', parent_key: 'L1', title: 'x' }]))).toMatch(/sits under a module, not a line/);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', parent_key: 'NOPE', title: 'x' }]))).toMatch(/not in the blueprint/);
    expect(code(() => w([{ op: 'upsert', kind: 'milestone', key: 'M1', parent_key: 'TEAM', title: 'x' }]))).toMatch(/project level/);
    expect(code(() => w([{ op: 'upsert', kind: 'ac', key: 'FR-OTHER-01/AC1', parent_key: 'FR-TEAM-01', title: 'x' }]))).toMatch(/keyed FR-TEAM-01\/ACn/);
    expect(code(() => w([{ op: 'upsert', kind: 'summary', key: 'SUM', title: 's2' }]))).toBe('ok');
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'L1', parent_key: 'TEAM', title: 'x' }]))).toMatch(/L1 is a line, not a fr/);
  });
});

describe('research lines (shape per line)', () => {
  it('nests lines one level; explore lines take no hypotheses or criteria; a line with hypotheses cannot turn to explore', () => {
    const { w } = fresh('research');
    w([{ op: 'upsert', kind: 'line', key: 'L1', title: 'Search', fields: { mode: 'validate' } }, { op: 'upsert', kind: 'line', key: 'L1.1', parent_key: 'L1', title: 'FTS5', fields: { mode: 'validate' } },
      { op: 'upsert', kind: 'line', key: 'L2', title: 'Blind review', fields: { mode: 'explore' } }]);
    expect(code(() => w([{ op: 'upsert', kind: 'line', key: 'L1.1.1' as string, parent_key: 'L1.1', title: 'x', fields: { mode: 'explore' } }]))).toMatch(/not a valid line key|nest one level/);
    expect(code(() => w([{ op: 'upsert', kind: 'line', key: 'L3', parent_key: 'L1.1', title: 'x', fields: { mode: 'explore' } }]))).toMatch(/nest one level/);
    expect(code(() => w([{ op: 'upsert', kind: 'hypothesis', key: 'H-L2-01', parent_key: 'L2', title: 'x' }]))).toMatch(/explores/);
    expect(code(() => w([{ op: 'upsert', kind: 'question', key: 'Q-L2-01', parent_key: 'L2', title: 'x', fields: { criteria: 'y' } }]))).toMatch(/no validation criteria/);
    expect(code(() => w([{ op: 'upsert', kind: 'question', key: 'Q-L2-01', parent_key: 'L2', title: 'x' }]))).toBe('ok');
    w([{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'x', status: 'confirmed' }]);
    expect(code(() => w([{ op: 'upsert', kind: 'line', key: 'L1', title: 'Search', fields: { mode: 'explore' } }]))).toMatch(/still has items to validate \(H-L1-01\)/);
    // An implementation project may hold a research line, and a research project a module (F3: per line).
    expect(code(() => w([mod('IDX'), { op: 'upsert', kind: 'fr', key: 'FR-IDX-01', parent_key: 'IDX', title: 'Build the index' }]))).toBe('ok');
  });
});

describe('keys', () => {
  it('allocates the next number and never reuses a removed key', () => {
    const { bp, p, w } = fresh();
    w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-*', parent_key: 'TEAM', title: 'a' }, { op: 'upsert', kind: 'fr', key: 'FR-TEAM-*', parent_key: 'TEAM', title: 'b' }]);
    expect(bp.items(p.id, { kinds: ['fr'] }).map((i) => i.key)).toEqual(['FR-TEAM-01', 'FR-TEAM-02']);
    w([{ op: 'remove', key: 'FR-TEAM-02' }]);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', parent_key: 'TEAM', title: 'again' }]))).toMatch(/^conflict: Key FR-TEAM-02 was used before/);
    expect(w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-*', parent_key: 'TEAM', title: 'c' }]).keys['FR-TEAM-*']).toBe('FR-TEAM-03');
    expect(bp.item(p.id, 'FR-TEAM-02')).toBeUndefined();
    expect(bp.item(p.id, 'FR-TEAM-02', true)!.deleted_at).toBeTypeOf('number');
  });

  it('refuses to remove an item that still holds others', () => {
    const { w } = fresh();
    w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a' }]);
    expect(code(() => w([{ op: 'remove', key: 'TEAM' }]))).toMatch(/still holds FR-TEAM-01/);
    expect(code(() => w([{ op: 'remove', key: 'FR-TEAM-01' }, { op: 'remove', key: 'TEAM' }]))).toBe('ok');
    expect(code(() => w([{ op: 'remove', key: 'TEAM' }]))).toMatch(/^not_found/);
  });
});

describe('links', () => {
  it('allows only the listed pairs between live items, and removing an item removes its links', () => {
    const { bp, p, w } = fresh();
    w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a' }, { op: 'upsert', kind: 'milestone', key: 'M1', title: 'm' },
      { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'r' }, { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'd' }, { op: 'upsert', kind: 'decision', key: 'ADR-002', title: 'd2' },
      { op: 'upsert', kind: 'release', key: 'REL-1.0', title: 'r' }, { op: 'upsert', kind: 'issue', key: 'I1', title: 'i' }, { op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', parent_key: 'FR-TEAM-01', title: 'ac' }]);
    w([{ op: 'link', from: 'M1', to: 'FR-TEAM-01', rel: 'delivers' }, { op: 'link', from: 'RK-01', to: 'M1', rel: 'threatens' }, { op: 'link', from: 'ADR-001', to: 'FR-TEAM-01', rel: 'governs' },
      { op: 'link', from: 'ADR-002', to: 'ADR-001', rel: 'supersedes' }, { op: 'link', from: 'REL-1.0', to: 'M1', rel: 'ships' }, { op: 'link', from: 'I1', to: 'ADR-001', rel: 'blocks' }]);
    expect(bp.links(p.id)).toHaveLength(6);
    expect(code(() => w([{ op: 'link', from: 'FR-TEAM-01', to: 'M1', rel: 'delivers' }]))).toMatch(/delivers links a milestone to a fr or nfr or hypothesis or paper; not a fr to a milestone/);
    expect(code(() => w([{ op: 'link', from: 'FR-TEAM-01/AC1', to: 'FR-TEAM-01', rel: 'verifies' }]))).toMatch(/Unknown link verifies.*verifies its parent/);
    expect(code(() => w([{ op: 'link', from: 'M1', to: 'FR-TEAM-09', rel: 'delivers' }]))).toMatch(/FR-TEAM-09 is not in the blueprint/);
    expect(code(() => w([{ op: 'link', from: 'ADR-001', to: 'ADR-001', rel: 'supersedes' }]))).toMatch(/itself/);
    w([{ op: 'remove', key: 'RK-01' }]);
    expect(code(() => w([{ op: 'link', from: 'RK-01', to: 'M1', rel: 'threatens' }]))).toMatch(/RK-01 is not in the blueprint/);
    expect(bp.links(p.id).map((l) => l.rel).sort()).toEqual(['blocks', 'delivers', 'governs', 'ships', 'supersedes']);
    w([{ op: 'unlink', from: 'M1', to: 'FR-TEAM-01', rel: 'delivers' }]);
    expect(bp.links(p.id).some((l) => l.rel === 'delivers')).toBe(false);
  });
});

describe('papers, claims and evidence (§2.4)', () => {
  const base = (): ReturnType<typeof fresh> => {
    const f = fresh('research');
    f.w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'Search keeps ACL filtering' },
      { op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', parent_key: 'FR-TEAM-01', title: 'Denied notes stay hidden' },
      { op: 'upsert', kind: 'line', key: 'L1', title: 'Search index', fields: { mode: 'validate' } },
      { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'FTS5 keeps p95 under 50 ms' },
      { op: 'upsert', kind: 'question', key: 'Q-L1-01', parent_key: 'L1', title: 'Does the index leak titles?' },
      { op: 'upsert', kind: 'finding', key: 'F-L1-01', parent_key: 'L1', title: 'p95 18 ms at 1 800 notes', fields: { confidence: 'low' } },
      { op: 'upsert', kind: 'paper', key: 'PAP-*', title: 'Authorized search for agent vaults', body: 'RQ: can an index keep ACLs?', fields: { venue: 'Workshop', type: 'paper', target_at: 1_900_000_000_000, authors: ['operator'], manuscript: 'vault/papers/search.md' } },
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C*', parent_key: 'PAP-1', title: 'An FTS5 index is fast enough', fields: { part: 'results' } },
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C*', parent_key: 'PAP-1', title: 'Filtering survives indexing', fields: { part: 'results' } },
      { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Submission' }, { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Venue deadline slips' }]);
    return f;
  };

  it('writes papers and claims with their fields, keys and statuses, and claims sit only under their paper', () => {
    const { bp, p, w } = base();
    expect(bp.item(p.id, 'PAP-1')).toMatchObject({ kind: 'paper', status: 'planned', fields: { venue: 'Workshop', type: 'paper', authors: ['operator'] } });
    expect(bp.item(p.id, 'PAP-1/C2')).toMatchObject({ kind: 'claim', parent_key: 'PAP-1', status: 'draft', fields: { part: 'results' } });
    expect(code(() => w([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C3', title: 'x' }]))).toMatch(/needs a parent \(paper\)/);
    expect(code(() => w([{ op: 'upsert', kind: 'claim', key: 'PAP-2/C1', parent_key: 'PAP-1', title: 'x' }]))).toMatch(/keyed PAP-1\/Cn/);
    expect(code(() => w([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C3', parent_key: 'L1', title: 'x' }]))).toMatch(/sits under a paper, not a line/);
    expect(code(() => w([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C1', status: 'supported' }]))).toMatch(/status is one of draft, final, cut/);
    expect(code(() => w([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C1', fields: { support: 'supported' } }]))).toMatch(/no field support/);
    expect(code(() => w([{ op: 'upsert', kind: 'paper', key: 'PAP-1', fields: { type: 'poster' } }]))).toMatch(/one of paper, preprint, report, thesis/);
  });

  it('links evidence only in the allowed directions, and delivers and threatens reach papers', () => {
    const { w } = base();
    const ok = (from: string, to: string, rel = 'evidence') => code(() => w([{ op: 'link', from, to, rel }]));
    expect([ok('F-L1-01', 'Q-L1-01'), ok('F-L1-01', 'H-L1-01'), ok('F-L1-01', 'PAP-1/C1'), ok('H-L1-01', 'PAP-1/C1'), ok('FR-TEAM-01', 'PAP-1/C2'), ok('FR-TEAM-01/AC1', 'PAP-1/C2'),
      ok('M1', 'PAP-1', 'delivers'), ok('RK-01', 'PAP-1', 'threatens')]).toEqual(Array(8).fill('ok'));
    expect(ok('PAP-1/C1', 'H-L1-01')).toMatch(/evidence links a finding to a question or hypothesis or claim; or a hypothesis or fr or nfr or ac to a claim; not a claim to a hypothesis/);
    expect(ok('H-L1-01', 'Q-L1-01')).toMatch(/not a hypothesis to a question/);
    expect(ok('F-L1-01', 'PAP-1')).toMatch(/not a finding to a paper/);
    expect(ok('F-L1-01', 'Q-L1-01', 'answers')).toMatch(/Unknown link answers/);
  });

  it('computes support worst first and a paper is ready when every kept claim is supported', () => {
    const { bp, p, w } = base();
    const s = (k: string) => bp.claim(p.id, k)!.support;
    expect(s('PAP-1/C1')).toBe('unsupported');
    w([{ op: 'link', from: 'H-L1-01', to: 'PAP-1/C1', rel: 'evidence' }, { op: 'link', from: 'F-L1-01', to: 'PAP-1/C1', rel: 'evidence' }]);
    expect(s('PAP-1/C1')).toBe('weak'); // untested hypothesis, low-confidence finding
    w([{ op: 'upsert', kind: 'finding', key: 'F-L1-01', fields: { confidence: 'medium' } }]);
    expect(s('PAP-1/C1')).toBe('supported');
    w([{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', status: 'refuted' }]);
    expect(s('PAP-1/C1')).toBe('contradicted');
    w([{ op: 'link', from: 'FR-TEAM-01', to: 'PAP-1/C2', rel: 'evidence' }, { op: 'link', from: 'FR-TEAM-01/AC1', to: 'PAP-1/C2', rel: 'evidence' }]);
    expect(s('PAP-1/C2')).toBe('weak');
    w([{ op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', status: 'passing' }]);
    expect(s('PAP-1/C2')).toBe('supported');
    w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', status: 'dropped' }]);
    expect(s('PAP-1/C2')).toBe('contradicted');
    w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', status: 'verified' }, { op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', status: 'failing' }]);
    expect(s('PAP-1/C2')).toBe('contradicted');
    w([{ op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', status: 'passing' }]);
    let paper = bp.paper(p.id, 'PAP-1')!;
    expect(paper).toMatchObject({ ready: false, supported: 1, total: 2, holding: ['PAP-1/C1'] });
    expect(paper.claims.map((c) => [c.key, c.support])).toEqual([['PAP-1/C1', 'contradicted'], ['PAP-1/C2', 'supported']]);
    w([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C1', status: 'cut' }]);
    paper = bp.paper(p.id, 'PAP-1')!;
    expect(paper).toMatchObject({ ready: true, supported: 1, total: 1, holding: [] });
    // Removing the evidence item removes its link, so the claim falls back.
    w([{ op: 'remove', key: 'FR-TEAM-01/AC1' }]);
    expect(s('PAP-1/C2')).toBe('supported'); // the verified FR still carries it
    expect(bp.claim(p.id, 'PAP-1/C2')!.evidence.map((e) => e.key)).toEqual(['FR-TEAM-01']);
  });

  it('caps papers per project and claims per paper; claims follow their paper\'s team', () => {
    const { bp, p, w } = fresh('implementation', { papers: 1, claimsPerPaper: 1 });
    const t = mkTeam(`Pap ${p.key}`);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(p.id, t);
    w([{ op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'One', team_id: t }, { op: 'upsert', kind: 'claim', key: 'PAP-1/C1', parent_key: 'PAP-1', title: 'c' }]);
    expect(bp.item(p.id, 'PAP-1/C1')!.team_id).toBe(t);
    expect(code(() => w([{ op: 'upsert', kind: 'paper', key: 'PAP-2', title: 'Two' }]))).toMatch(/at most 1 papers/);
    expect(code(() => w([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C2', parent_key: 'PAP-1', title: 'c' }]))).toMatch(/PAP-1 holds at most 1 claims/);
  });
});

describe('support rules (pure)', async () => {
  const { claimSupport, paperReadiness, decided } = await import('../src/blueprint/support.js');
  const e = (kind: string, status: string | null, fields = {}) => ({ kind, key: kind, status, fields });
  it('ranks contradicted over everything, then unsupported, weak and supported', () => {
    expect(claimSupport([])).toBe('unsupported');
    expect(claimSupport([e('hypothesis', 'inconclusive'), e('fr', 'built'), e('ac', 'open'), e('finding', null, { confidence: 'low' }), e('finding', null)])).toBe('weak');
    expect(claimSupport([e('hypothesis', 'confirmed'), e('ac', 'failing')])).toBe('contradicted');
    expect(claimSupport([e('nfr', 'verified'), e('hypothesis', 'testing')])).toBe('supported');
    expect([e('hypothesis', 'confirmed'), e('finding', null, { confidence: 'high' }), e('fr', 'verified'), e('ac', 'passing')].every(decided)).toBe(true);
    expect([e('hypothesis', 'dropped'), e('ac', 'waived'), e('fr', 'agreed')].some(decided)).toBe(false);
  });
  it('a paper with no kept claims is not ready', () => {
    expect(paperReadiness([]).ready).toBe(false);
    expect(paperReadiness([{ key: 'C1', status: 'cut', support: 'unsupported' }]).ready).toBe(false);
  });
});

describe('versions, events and history', () => {
  it('refuses a stale version, writes nothing for a no-op, and records one event per write with moves', () => {
    const { bp, p, w, v } = fresh();
    w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a' }]);
    const at = v();
    // Per item (F-24): FR-TEAM-01 changed after version 0, so a write from version 0 that touches it conflicts and names it.
    expect(code(() => bp.write(p.id, { version: at - 1, ops: [{ op: 'remove', key: 'FR-TEAM-01' }] }, op))).toMatch(/^conflict: Changed since you read it: FR-TEAM-01 \(current version 1\)/);
    expect(code(() => bp.write(p.id, { version: at + 1, ops: [{ op: 'remove', key: 'FR-TEAM-01' }] }, op))).toMatch(/^conflict: Version 2 is ahead/);
    expect(code(() => bp.write(p.id, { version: at, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', title: 'a', rev: 2 }] }, op))).toMatch(/^conflict: Changed since you read it: FR-TEAM-01/);
    expect(code(() => bp.write(p.id, { version: at, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-09', parent_key: 'TEAM', title: 'z', rev: 1 }] }, op))).toMatch(/^conflict/);
    try { bp.write(p.id, { version: at - 1, ops: [{ op: 'remove', key: 'FR-TEAM-01' }] }, op); } catch (e) { expect((e as { extra?: unknown }).extra).toEqual({ current_version: 1, keys: ['FR-TEAM-01'] }); }
    expect(w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', title: 'a' }]).version).toBe(at);
    expect(bp.events(p.id)).toHaveLength(1);
    w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', status: 'agreed' }, { op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', parent_key: 'TEAM', title: 'b' }]);
    const [e2, e1] = bp.events(p.id);
    expect(e1).toMatchObject({ kind: 'update', version: 1, actor_kind: 'operator', actor_id: 'adm_1', added: ['TEAM', 'FR-TEAM-01'] });
    expect(e2).toMatchObject({ version: 2, added: ['FR-TEAM-02'], changed: ['FR-TEAM-01'], moves: [{ key: 'FR-TEAM-01', status: 'agreed', was: 'draft' }], items: 3 });
    expect(bp.project(p.id)!.version).toBe(2);
  });

  it('keeps a revision per change with its author, and collapses the oldest past the limit', () => {
    const { bp, p, w } = fresh('implementation', { revisionsPerItem: 3 });
    w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'v1' }]);
    for (const t of ['v2', 'v3', 'v4', 'v5']) w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', title: t }]);
    const it = bp.item(p.id, 'FR-TEAM-01')!;
    expect(it.rev).toBe(5);
    const revs = bp.revisions(it.id);
    expect(revs.map((r) => r.rev)).toEqual([5, 4, 3]);
    expect(revs[0]).toMatchObject({ actor_kind: 'operator', snapshot: { title: 'v5', key: 'FR-TEAM-01' } });
    expect(revs[2]!.change_note).toBe('earlier changes collapsed');
  });

  it('moves an item to another parent with move', () => {
    const { bp, p, w } = fresh();
    w([mod(), mod('AUTH'), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a' }]);
    w([{ op: 'move', key: 'FR-TEAM-01', parent_key: 'AUTH', position: 4 }]);
    expect(bp.item(p.id, 'FR-TEAM-01')).toMatchObject({ parent_key: 'AUTH', position: 4 });
  });
});

describe('limits', () => {
  it('enforces sizes, counts and ops per write', () => {
    const { w } = fresh('implementation', { itemsPerProject: 8, acsPerParent: 2, lines: 1, opsPerWrite: 3, linksPerItem: 1 });
    expect(code(() => w([{ op: 'upsert', kind: 'term', key: 'G-a', title: 'x'.repeat(201) }]))).toMatch(/title holds at most 200/);
    expect(code(() => w([{ op: 'upsert', kind: 'term', key: 'G-a', title: 'a', body: 'x'.repeat(4001) }]))).toMatch(/body holds at most 4000/);
    expect(code(() => w([{ op: 'upsert', kind: 'architecture', key: 'ARCH', title: 'a', body: 'x'.repeat(16000) }]))).toBe('ok');
    expect(code(() => w([{ op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'a', fields: { context: 'x'.repeat(4001) } }]))).toMatch(/Fields hold at most 4000/);
    expect(code(() => w([mod(), mod('AUTH'), mod('VAULT'), mod('OPS')]))).toMatch(/at most 3 ops/);
    w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a' }]);
    w([{ op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', parent_key: 'FR-TEAM-01', title: 'a' }, { op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC2', parent_key: 'FR-TEAM-01', title: 'b' }]);
    expect(code(() => w([{ op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC3', parent_key: 'FR-TEAM-01', title: 'c' }]))).toMatch(/at most 2 acceptance criteria/);
    expect(code(() => w([{ op: 'upsert', kind: 'line', key: 'L1', title: 'l', fields: { mode: 'explore' } }, { op: 'upsert', kind: 'line', key: 'L2', title: 'l', fields: { mode: 'explore' } }]))).toMatch(/at most 1 lines/);
    w([{ op: 'upsert', kind: 'milestone', key: 'M1', title: 'm' }]);
    expect(code(() => w([{ op: 'upsert', kind: 'milestone', key: 'M2', title: 'm' }, { op: 'link', from: 'M1', to: 'FR-TEAM-01', rel: 'delivers' }, { op: 'link', from: 'M2', to: 'FR-TEAM-01', rel: 'delivers' }]))).toMatch(/more than 1 links/);
    expect(code(() => w([{ op: 'upsert', kind: 'milestone', key: 'M2', title: 'm' }, { op: 'upsert', kind: 'milestone', key: 'M3', title: 'm' }, { op: 'upsert', kind: 'milestone', key: 'M4', title: 'm' }]))).toMatch(/at most 8 items/);
  });

  it('caps a team part', () => {
    const { bp, p, w } = fresh('implementation', { itemsPerTeam: 2 });
    // A second team makes it a part (FR-PLAN-12: a project's only team gives way to the project limit).
    const t = mkTeam(`Cap ${p.key}`), t2 = mkTeam(`Cap B ${p.key}`);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id IN (?,?)').run(p.id, t, t2);
    w([{ ...mod(), team_id: t } as Op, { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a' }]);
    expect(bp.item(p.id, 'FR-TEAM-01')!.team_id).toBe(t);
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', parent_key: 'TEAM', title: 'b' }]))).toMatch(/team's part holds at most 2/);
  });

  it('leaves retired items out of the item limits, and the refusal says how many are retired', () => {
    for (const [k, s] of Object.entries(RETIRED)) for (const x of s) expect([k, KINDS[k]?.statuses]).toEqual([k, expect.arrayContaining([x])]);
    const { p, w } = fresh('implementation', { itemsPerTeam: 3 });
    const t = mkTeam(`Retired ${p.key}`), t2 = mkTeam(`Retired B ${p.key}`);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id IN (?,?)').run(p.id, t, t2);
    const fr = (n: number): Op => ({ op: 'upsert', kind: 'fr', key: `FR-TEAM-0${n}`, parent_key: 'TEAM', title: `r${n}` });
    w([{ ...mod(), team_id: t } as Op, fr(1), fr(2)]);
    expect(code(() => w([fr(3)]))).toMatch(/team's part holds at most 3 items \(limit items_per_team, set by the operator\)\.$/);
    w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', status: 'dropped' }]);
    w([fr(3)]); // the dropped requirement leaves room
    expect(code(() => w([fr(4)]))).toMatch(/team's part holds at most 3 items .* 1 retired item is not counted\.$/);
    // waived criteria leave room under their requirement too
    const q = fresh('implementation', { acsPerParent: 1 });
    const ac = (n: number): Op => ({ op: 'upsert', kind: 'ac', key: `FR-TEAM-01/AC${n}`, parent_key: 'FR-TEAM-01', title: `c${n}` });
    q.w([mod(), { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a' }, ac(1)]);
    expect(code(() => q.w([ac(2)]))).toMatch(/at most 1 acceptance criteria/);
    q.w([{ op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', status: 'waived' }]);
    q.w([ac(2)]);
    expect(code(() => q.w([ac(3)]))).toMatch(/at most 1 acceptance criteria .* 1 retired item is not counted\.$/);
  });

  it('rechecks capacity when a retired item is reopened, and refuses the reopening over the limit', () => {
    const { bp, p, w } = fresh('implementation', { itemsPerProject: 3 });
    const fr = (n: number): Op => ({ op: 'upsert', kind: 'fr', key: `FR-TEAM-0${n}`, parent_key: 'TEAM', title: `r${n}` });
    w([mod(), fr(1), fr(2)]);
    w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', status: 'dropped' }]);
    w([fr(3)]); // room left by the dropped one
    const before = bp.project(p.id)!.version;
    expect(code(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-TEAM-02', status: 'draft' }]))).toMatch(/at most 3 items \(limit items_per_project, set by the operator\)\.$/);
    expect(bp.item(p.id, 'FR-TEAM-02')!.status).toBe('dropped');
    expect(bp.project(p.id)!.version).toBe(before);
  });

  it('archived items leave the limits, and unarchiving is checked like a creation', () => {
    const { bp, p, w } = fresh('implementation', { itemsPerProject: 3 });
    const fr = (n: number): Op => ({ op: 'upsert', kind: 'fr', key: `FR-TEAM-0${n}`, parent_key: 'TEAM', title: `r${n}` });
    w([mod(), fr(1), fr(2)]);
    app.db.prepare("UPDATE bp_items SET archived=1 WHERE project_id=? AND key='FR-TEAM-02'").run(p.id);
    w([fr(3)]);
    // Bringing FR-TEAM-02 back would make four: refused inside the transaction, so it stays archived.
    expect(code(() => tx(app.db, () => {
      app.db.prepare("UPDATE bp_items SET archived=0 WHERE project_id=? AND key='FR-TEAM-02'").run(p.id);
      bp.checkCapacity(p.id, ['FR-TEAM-02']);
    }))).toMatch(/limit items_per_project/);
    expect((app.db.prepare("SELECT archived FROM bp_items WHERE project_id=? AND key='FR-TEAM-02'").get(p.id) as { archived: number }).archived).toBe(1);
  });

  it('dropped papers leave the paper limit', () => {
    const { p, w } = fresh('research', { papers: 1 });
    w([{ op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'Tidal drift' }]);
    expect(code(() => w([{ op: 'upsert', kind: 'paper', key: 'PAP-2', title: 'Gauge noise' }]))).toMatch(/at most 1 papers \(limit papers/);
    w([{ op: 'upsert', kind: 'paper', key: 'PAP-1', status: 'dropped' }]);
    expect(code(() => w([{ op: 'upsert', kind: 'paper', key: 'PAP-2', title: 'Gauge noise' }]))).toBe('ok');
    expect(p.id).toBeTruthy();
  });

  it('a 130-item rebuild with dependent children over the paper limit names the limit and writes nothing', () => {
    const { bp, p, w } = fresh('research', { opsPerWrite: 200 });
    // 13 papers (the default limit is 10), each with 9 claims written under it in the same batch: 130 ops.
    const ops: Op[] = [];
    for (let n = 1; n <= 13; n++) {
      ops.push({ op: 'upsert', kind: 'paper', key: `PAP-${n}`, title: `Paper ${n}` });
      for (let c = 1; c <= 9; c++) ops.push({ op: 'upsert', kind: 'claim', key: `PAP-${n}/C${c}`, parent_key: `PAP-${n}`, title: `Claim ${c} of paper ${n}` });
    }
    expect(ops).toHaveLength(130);
    const before = bp.project(p.id)!.version;
    expect(code(() => w(ops))).toMatch(/^invalid_argument: A blueprint holds at most 10 papers \(limit papers, set by the operator\)\.$/);
    expect(bp.project(p.id)!.version).toBe(before);
    expect(bp.items(p.id)).toEqual([]);
    // Within the limit, the same shape applies whole: children find their parents declared earlier in the batch.
    expect(code(() => w(ops.filter((o) => 'key' in o && Number(/^PAP-(\d+)/.exec(o.key)![1]) <= 10)))).toBe('ok');
    expect(bp.items(p.id)).toHaveLength(100);
  });
});

describe('team parts', () => {
  it('items inside a track carry its team, follow it when it moves, and a team must belong to the project', () => {
    const { bp, p, w } = fresh();
    const t1 = mkTeam(`A ${p.key}`), t2 = mkTeam(`B ${p.key}`);
    expect(code(() => w([{ ...mod(), team_id: t1 } as Op]))).toMatch(/is not part of project/);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id IN (?,?)').run(p.id, t1, t2);
    w([{ ...mod(), team_id: t1 } as Op, { op: 'upsert', kind: 'fr', key: 'FR-TEAM-01', parent_key: 'TEAM', title: 'a', team_id: t2 }, { op: 'upsert', kind: 'ac', key: 'FR-TEAM-01/AC1', parent_key: 'FR-TEAM-01', title: 'x' }]);
    expect(bp.item(p.id, 'FR-TEAM-01')!.team_id).toBe(t1);
    const at = bp.project(p.id)!.version;
    w([{ ...mod(), team_id: t2 } as Op]);
    expect([bp.item(p.id, 'FR-TEAM-01')!.team_id, bp.item(p.id, 'FR-TEAM-01/AC1')!.team_id]).toEqual([t2, t2]);
    expect(bp.items(p.id, { team: t2 }).map((i) => i.key).sort()).toEqual(['FR-TEAM-01', 'FR-TEAM-01/AC1', 'TEAM']);
    // The children's move is a change of their own: a revision each, and since_version readers see it.
    expect(bp.read(p.id, t2, { since_version: at }).items.map((i) => i.key).sort()).toEqual(['FR-TEAM-01', 'FR-TEAM-01/AC1', 'TEAM']);
    expect(bp.events(p.id, 1)[0]!.changed.sort()).toEqual(['FR-TEAM-01', 'FR-TEAM-01/AC1', 'TEAM']);
    const ac = app.db.prepare('SELECT id, rev FROM bp_items WHERE project_id=? AND key=?').get(p.id, 'FR-TEAM-01/AC1') as { id: string; rev: number };
    expect(bp.revisions(ac.id)[0]).toMatchObject({ rev: ac.rev, change_note: 'team follows FR-TEAM-01', snapshot: { team_id: t2 } });
  });
});

describe('a team plans in its own project (§5)', () => {
  it('every team gets its own project when it is made, without a module until it plans', () => {
    expect(app.blueprint.projectOfTeam(teamId)).toMatchObject({ key: 'SL', name: 'Signals Lab', kind: 'implementation' });
    const p = app.blueprint.projectOfTeam(otherTeam)!;
    expect(p).toMatchObject({ key: 'PAC', name: 'Power and Coils' });
    expect(app.blueprint.items(p.id)).toEqual([]);
    expect(app.teams.plan(otherTeam)).toMatchObject({ requirements: [], milestones: [], requested_at: null });
  });

  it('teams made with a project name share that project, named after it', () => {
    const mk = (name: string) => app.teams.createDraftTeam({ name, goal: 'g', project: 'Harbour Twin', delivery_mode: 'on_demand', close_on_approve: false, coordinator_reviews: false, lease_minutes: 30, max_review_rounds: 3 }, sys).id;
    const a = app.blueprint.projectOfTeam(mk('Harbour Developers'))!, b = app.blueprint.projectOfTeam(mk('Harbour Board'))!;
    expect(a).toMatchObject({ name: 'Harbour Twin', key: 'HT' });
    expect(b.id).toBe(a.id);
  });

  it('a team joining a tagged project takes its tags instead of the default', () => {
    const db = (app as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } } }).db;
    const p = app.blueprint.createProject({ key: 'APPX', name: 'Apps Shell' }, op);
    db.prepare('DELETE FROM project_keywords WHERE project_id=?').run(p.id);
    db.prepare("INSERT INTO project_keywords(project_id, keyword, position) VALUES (?, 'Applications', 0)").run(p.id);
    const id = app.teams.createDraftTeam({ name: 'Shell App', goal: 'g', project: 'Apps Shell', delivery_mode: 'on_demand', close_on_approve: false, coordinator_reviews: false, lease_minutes: 30, max_review_rounds: 3 }, sys).id;
    expect(app.blueprint.projectOfTeam(id)!.id).toBe(p.id);
    expect(db.prepare('SELECT keyword FROM team_keywords WHERE team_id=?').all(id)).toEqual([{ keyword: 'Applications' }]);
  });

  it('a refused batch names every refused op at once and writes nothing', () => {
    const bp = app.blueprint, p = bp.projectOfTeam(otherTeam)!;
    const why = code(() => bp.write(p.id, { version: p.version, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-X-01', title: 'No parent' },
      { op: 'upsert', kind: 'ac', key: 'FR-X-01/AC1', parent_key: 'FR-X-01', title: 'Follows its FR' },
      { op: 'upsert', kind: 'module', key: 'GOOD', title: 'Fine' }, { op: 'upsert', kind: 'fr', key: 'FR-Y-01', title: 'Also no parent' }] }, op));
    expect(why).toMatch(/^invalid_argument: 2 ops were refused/);
    expect(why).toContain('op 1 (FR-X-01)');
    expect(why).toContain('op 4 (FR-Y-01)');
    expect(why).not.toContain('FR-X-01/AC1');
    expect(bp.item(p.id, 'GOOD')).toBeUndefined();
  });

  it('a new module written for a team is in that team\'s part unless the op names none', () => {
    const bp = app.blueprint, p = bp.projectOfTeam(otherTeam)!;
    bp.write(p.id, { version: p.version, team_id: otherTeam, ops: [{ op: 'upsert', kind: 'module', key: 'COIL', title: 'Coils' }, { op: 'upsert', kind: 'module', key: 'SHARED', title: 'Shared', team_id: null }] }, op);
    expect(bp.item(p.id, 'COIL')).toMatchObject({ team_id: otherTeam });
    expect(bp.item(p.id, 'SHARED')).toMatchObject({ team_id: null });
  });

  it('the team plan is a view of its part: FRs as requirements in plan words, milestones with the FRs they deliver', async () => {
    const bp = app.blueprint, p = bp.projectOfTeam(teamId)!;
    bp.write(p.id, { version: p.version, ops: [{ op: 'upsert', kind: 'module', key: 'FP', title: 'Field Physics', team_id: teamId },
      { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Field model v2 issued', team_id: teamId, fields: { target_at: 1_800_000_000_000, exit: 'Issued to Integration.' } }] }, op);
    // The coordinator writes draft FRs in its own module at once.
    const w = await C('bp_write', { team_id: teamId, version: bp.project(p.id)!.version, ops: [
      { op: 'upsert', kind: 'fr', key: 'FR-FP-01', parent_key: 'FP', title: 'Field model v2 validated', body: 'Bench data.', fields: { priority: 'must' } },
      { op: 'upsert', kind: 'fr', key: 'FR-FP-02', parent_key: 'FP', title: 'Run 47 explained', fields: { priority: 'should', unclear: true, evidence: 'vault/run47.md' } }] });
    expect(w.structuredContent, JSON.stringify(w.structuredContent.why)).toMatchObject({ status: 'applied' });
    // Criteria of a draft FR in its part are the coordinator's too (rights are checked against the FR as it is).
    const ac = await C('bp_write', { team_id: teamId, version: w.structuredContent.version, ops: [{ op: 'upsert', kind: 'ac', key: 'FR-FP-01/AC1', parent_key: 'FR-FP-01', title: 'Acceptance', fields: { then: 'Within tolerance.' } }] });
    expect(ac.structuredContent.status).toBe('applied');
    // Scope is the operator's (§4): the milestone's delivers link.
    bp.write(p.id, { version: bp.project(p.id)!.version, ops: [{ op: 'link', from: 'M1', to: 'FR-FP-01', rel: 'delivers' }] }, op);
    const plan = app.teams.plan(teamId);
    expect(plan.version).toBe(bp.project(p.id)!.version);
    expect(plan.requirements.map((r) => [r.key, r.status, r.priority, r.links])).toEqual([['FR-FP-01', 'open', 'must', ['M1']], ['FR-FP-02', 'unclear', 'should', []]]);
    expect(plan.requirements[0]).toMatchObject({ detail: 'Bench data.', criteria: 'Within tolerance.', updated_by: coordId });
    expect(plan.requirements[1]!.evidence).toBe('vault/run47.md');
    expect(plan.milestones).toEqual([expect.objectContaining({ key: 'M1', status: 'planned', due_at: 1_800_000_000_000, criteria: 'Issued to Integration.', links: [] })]);
    // Agreed and verified read as open and met; a dropped FR reads as dropped.
    bp.write(p.id, { version: bp.project(p.id)!.version, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FP-01', status: 'verified' }, { op: 'upsert', kind: 'fr', key: 'FR-FP-02', status: 'dropped' }] }, op);
    expect(app.teams.plan(teamId).requirements.map((r) => r.status)).toEqual(['met', 'dropped']);
    expect(app.teams.planEvents(teamId)[1]).toMatchObject({ kind: 'update', actor: { kind: 'agent', id: coordId }, added: expect.arrayContaining(['FR-FP-01', 'FR-FP-02']) });
  });

  it('the operator\'s plan request is an event and stays open until the coordinator changes the part', async () => {
    const bp = app.blueprint, p = bp.projectOfTeam(teamId)!;
    app.teams.requestPlan(teamId, 'Is FR-FP-02 still unclear?', { kind: 'admin', id: null });
    expect(app.teams.planEvents(teamId)[0]).toMatchObject({ kind: 'review_request', actor: { kind: 'operator' }, note: 'Is FR-FP-02 still unclear?' });
    expect(app.teams.plan(teamId)).toMatchObject({ request_note: 'Is FR-FP-02 still unclear?' });
    expect(app.teams.plan(teamId).requested_at).toBeGreaterThan(0);
    const w = await C('bp_write', { team_id: teamId, version: bp.project(p.id)!.version, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FP-03', parent_key: 'FP', title: 'Stability margin' }] });
    expect(w.structuredContent.status).toBe('applied');
    expect(app.teams.plan(teamId)).toMatchObject({ requested_at: null, request_note: null });
  });

  it('a team without a project gets one on first use', () => {
    const t = mkTeam('Navigation and Timing');
    app.db.prepare('UPDATE teams SET project_id=NULL WHERE id=?').run(t);
    app.teams.requestStatus(t, null, { kind: 'admin', id: null });
    expect(app.blueprint.projectOfTeam(t)).toBeTruthy();
  });

  it('the Teams and tasks reset removes projects and their blueprints', () => {
    const plan = new Reset(app.db).plan(['teams']);
    for (const t of ['projects', 'bp_items', 'bp_links', 'bp_revisions', 'bp_events']) expect(plan.tables[t], t).toBeGreaterThan(0);
    for (const t of ['projects', 'bp_items', 'bp_links', 'bp_revisions', 'bp_events']) expect(plan.byTable.find((r) => r.table === t)?.part, t).toBe('teams');
  });
});

describe('glossary terms (docs/blueprint.md §2.2, §2.7)', () => {
  it('takes aliases as a list of strings and refuses anything else', () => {
    const { bp, p, w } = fresh();
    w([{ op: 'upsert', kind: 'term', key: 'G-t-prime', title: 'T′', body: 'The corrected time.', fields: { aliases: ["T'", 'T-prime'] } }]);
    expect(bp.item(p.id, 'G-t-prime')!.fields['aliases']).toEqual(["T'", 'T-prime']);
    expect(() => w([{ op: 'upsert', kind: 'term', key: 'G-h-oa', title: 'H_oa', fields: { aliases: 'H-oa' } }])).toThrow(/aliases/);
    expect(() => w([{ op: 'upsert', kind: 'term', key: 'G-h-oa', title: 'H_oa', fields: { aliases: [1] } }])).toThrow(/aliases/);
  });
});
