/**
 * Project Blueprint (docs/blueprint.md §4, §4.2): check mode and restore from an export. `bp_write {check: true}` runs a
 * write as a dry run and says what would apply, become a proposal or be refused, writing nothing. A restore puts the
 * project, or a part, back from its JSON or Markdown export in one write (one event, one revision per item), bringing
 * deleted keys back and keeping links, criteria and fields; agents propose it, and only the hub sets the restore marker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { parseExport, parseMarkdown } from '../src/blueprint/restore.js';
import { BpRouting } from '../src/admin/bpRouting.js';
import { RELS } from '../src/blueprint/kinds.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '', adminId = '', dir = '';
let teamA = '', teamB = '', coordA = '', workerA = '', P = '';
let CA: Call, WA: Call;
const DAY = 86_400_000;
const opr = () => ({ kind: 'operator' as const, id: adminId });
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, raw: t, body: (r.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t) as any };
};
const item = (k: string) => app.blueprint.item(P, k, true)!;
const live = (k: string) => app.blueprint.item(P, k);
const events = () => (app.db.prepare('SELECT COUNT(*) n FROM bp_events WHERE project_id=?').get(P) as { n: number }).n;
const revs = (k: string) => app.blueprint.revisions(item(k).id);
const proposals = () => (app.db.prepare('SELECT COUNT(*) n FROM bp_proposals WHERE project_id=?').get(P) as { n: number }).n;
const hasLink = (from: string, to: string, rel: string) => app.blueprint.links(P).some((l) => l.from_key === from && l.to_key === to && l.rel === rel);
const exportJson = async () => (await api('GET', `/projects/${P}/export.json`)).raw;
const exportMd = async () => (await api('GET', `/projects/${P}/export.md`)).raw;
/** The operator's restore; applying names the version, as the check returned it (here: the current one). */
const restore = (b: Record<string, unknown>) => api('POST', `/projects/${P}/restore`, b['check'] || 'version' in b ? b : { version: v(), ...b });
/** The JSON export with items' text edited and their writers claimed by the file (L2 data the hub must not trust). */
const forged = async (claims: Record<string, { title: string; by: { kind: string; id: string | null } }>) => {
  const doc = JSON.parse(await exportJson());
  for (const i of doc.items) { const c = claims[i.key]; if (c) Object.assign(i, { title: c.title, created_by: c.by, updated_by: c.by }); }
  return JSON.stringify(doc);
};

async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahbpcr-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const ca = agent('coord-a'), wa = agent('worker-a'), cb = agent('coord-b');
  coordA = ca.id; workerA = wa.id;
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }, { agent_id: wa.id, role: 'worker', credential_id: wa.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put([
    { op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model', team_id: teamA },
    { op: 'upsert', kind: 'module', key: 'PWR', title: 'Power', team_id: teamB },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', parent_key: 'FLD', title: 'Fold the field', body: 'The field folds on request.\n\nTwo lines of body.', status: 'agreed' },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-02', parent_key: 'FLD', title: 'Measure drift', status: 'built' },
    { op: 'upsert', kind: 'ac', key: 'FR-FLD-01/AC1', parent_key: 'FR-FLD-01', title: 'Folds in 3 s', status: 'passing', fields: { given: 'a flat field', when: 'the operator folds it', then: 'it folds in 3 s' } },
    { op: 'upsert', kind: 'fr', key: 'FR-PWR-01', parent_key: 'PWR', title: 'Wind the coils', status: 'agreed' },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Field folds', status: 'reached', team_id: teamA, fields: { phase: 'alpha', target_at: Date.UTC(2026, 5, 1, 15, 30) } },
    { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat', status: 'mitigated', team_id: teamA },
    { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'One field model', status: 'accepted' },
    { op: 'upsert', kind: 'architecture', key: 'ARCH', title: 'How the field is built', body: '# Overview\n\nOne model.\n\n- **not an item** just text' },
    { op: 'link', from: 'M1', to: 'FR-FLD-01', rel: 'delivers' },
  ]);
  [CA, WA] = [await session(ca.secret), await session(wa.secret)];
});
afterAll(async () => { await app?.close(); });

describe('check mode (bp_write check: true)', () => {
  it('a write the coordinator may apply answers apply and what it would add, and writes nothing', async () => {
    const before = v(), ev = events();
    const r = ok(await CA('bp_write', { version: before, check: true, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-*', parent_key: 'FLD', title: 'Hold the fold' }] }));
    expect(r.status).toBe('checked');
    expect(r.outcome).toBe('apply');
    expect(r.would.added).toEqual(['FR-FLD-03']);
    expect(r.would.keys).toEqual({ 'FR-FLD-*': 'FR-FLD-03' });
    expect(v()).toBe(before);
    expect(events()).toBe(ev);
    expect(live('FR-FLD-03')).toBeUndefined();
  });

  it('a write that needs the operator answers propose with the reasons, and files no proposal', async () => {
    const n = proposals();
    const r = await WA('bp_write', { version: v(), check: true, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-*', parent_key: 'FLD', title: 'Hold the fold' }] });
    const d = ok(r);
    expect(d.outcome).toBe('propose');
    expect(d.why.length).toBeGreaterThan(0);
    expect(d.ops[0]).toMatchObject({ op: 1, verdict: 'propose' });
    expect(text(r)).toMatch(/nothing written/);
    expect(proposals()).toBe(n);
  });

  it('every refused op is listed at once, and nothing is written', async () => {
    const before = v();
    const d = ok(await CA('bp_write', { version: before, check: true, ops: [
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-09', parent_key: 'NOPE', title: 'Orphan' },
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-10', parent_key: 'FLD', title: 'Bad status', status: 'shiny' },
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-11', parent_key: 'FLD', title: 'Fine' },
    ] }));
    expect(d.outcome).toBe('refused');
    expect(d.code).toBe('invalid_argument');
    expect(d.problems).toHaveLength(2);
    expect(d.problems.join('\n')).toMatch(/FR-FLD-09/);
    expect(d.problems.join('\n')).toMatch(/FR-FLD-10/);
    expect(v()).toBe(before);
    expect(live('FR-FLD-11')).toBeUndefined();
  });

  it('an op that is not the caller\'s answers refused (denied) with its reason', async () => {
    const d = ok(await WA('bp_write', { version: v(), check: true, ops: [{ op: 'remove', key: 'RK-01' }] }));
    expect(d.outcome).toBe('refused');
    expect(d.code).toBe('denied');
    expect(d.ops[0].verdict).toBe('deny');
    expect(live('RK-01')).toBeDefined();
  });

  it('a conflict names its keys and the current version', async () => {
    const old = v();
    put([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-02', title: 'Measure the drift' }]);
    const d = ok(await CA('bp_write', { version: old, check: true, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-02', title: 'Measure drift again' }] }));
    expect(d.outcome).toBe('refused');
    expect(d.conflict).toEqual({ keys: ['FR-FLD-02'], current_version: v() });
    put([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-02', title: 'Measure drift' }]);
  });

  it('a check under team pause answers refused with the pause text, like the write', async () => {
    app.db.prepare("UPDATE teams SET status='paused', paused_reason='maintenance' WHERE id=?").run(teamA);
    try {
      const d = ok(await CA('bp_write', { version: v(), check: true, ops: [{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat' }] }));
      expect(d.outcome).toBe('refused');
      expect(d.code).toBe('paused');
    } finally { app.db.prepare("UPDATE teams SET status='running', paused_reason=NULL WHERE id=?").run(teamA); }
  });
});

describe('the restore marker is the hub\'s alone', () => {
  it('bp_write strips it, so a deleted key stays deleted', async () => {
    put([{ op: 'upsert', kind: 'risk', key: 'RK-90', title: 'Gone risk', team_id: teamA }]);
    put([{ op: 'remove', key: 'RK-90' }]);
    const r = await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-90', title: 'Back?', restore: { by: { kind: 'operator', id: null } } }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/never reused/);
    expect(live('RK-90')).toBeUndefined();
  });
  it('the service refuses it from an agent, and the ops route refuses it from anyone', async () => {
    expect(() => app.blueprint.submit(P, { version: v(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-90', title: 'Back?', restore: {} }] }, coordA)).toThrow(/restore is not an op field/);
    const r = await api('POST', `/projects/${P}/ops`, { version: v(), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-90', title: 'Back?', restore: {} }] });
    expect(r.body.error).toBe('invalid_argument');
    expect(live('RK-90')).toBeUndefined();
  });
});

describe('JSON export and restore (operator)', () => {
  it('brings deleted keys back with their links, criteria and fields, in one event and one revision per item', async () => {
    const snap = await exportJson();
    put([{ op: 'remove', key: 'FR-FLD-01/AC1' }]);
    put([{ op: 'remove', key: 'FR-FLD-01' }, { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat and smoke' }]);
    expect(hasLink('M1', 'FR-FLD-01', 'delivers')).toBe(false);
    const before = v(), ev = events(), acRevs = revs('FR-FLD-01/AC1').length, rkRevs = revs('RK-01').length;

    // The check: the plan, and nothing written.
    const c = await restore({ text: snap, check: true });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('checked');
    expect(c.body.outcome).toBe('apply');
    expect(c.body.plan.restored.sort()).toEqual(['FR-FLD-01', 'FR-FLD-01/AC1']);
    expect(c.body.plan.changed).toEqual(['RK-01']);
    expect(c.body.plan.links.added).toBe(1);
    expect(c.body.plan.ops).toBeUndefined();
    expect(v()).toBe(before);
    expect(live('FR-FLD-01')).toBeUndefined();

    const r = await restore({ text: snap });
    expect(r.body.status).toBe('applied');
    expect(events()).toBe(ev + 1);
    expect(v()).toBe(before + 1);
    expect(live('FR-FLD-01')).toMatchObject({ title: 'Fold the field', status: 'agreed', body: 'The field folds on request.\n\nTwo lines of body.' });
    expect(live('FR-FLD-01/AC1')).toMatchObject({ parent_key: 'FR-FLD-01', status: 'passing', fields: { given: 'a flat field', when: 'the operator folds it', then: 'it folds in 3 s' } });
    expect(live('RK-01')!.title).toBe('Coil heat');
    expect(hasLink('M1', 'FR-FLD-01', 'delivers')).toBe(true);
    expect(revs('FR-FLD-01/AC1')).toHaveLength(acRevs + 1);
    expect(revs('RK-01')).toHaveLength(rkRevs + 1);
    expect(revs('FR-FLD-01/AC1')[0]!.change_note).toBe('restored');
    // The operator wrote that text first, so it stays the operator's (L0).
    expect(live('FR-FLD-01')!.updated_by_kind).toBe('operator');
    const e = app.blueprint.events(P, 1)[0]!;
    expect(e.note).toBe('restored from the export');
    expect(e.added.sort()).toEqual(['FR-FLD-01', 'FR-FLD-01/AC1']);
  });

  it('is not held to ops_per_write', async () => {
    const keys = Array.from({ length: 60 }, (_, i) => `RK-${String(i + 10).padStart(2, '0')}`);
    put(keys.slice(0, 30).map((k) => ({ op: 'upsert', kind: 'risk', key: k, title: `Risk ${k}`, team_id: teamA })));
    put(keys.slice(30).map((k) => ({ op: 'upsert', kind: 'risk', key: k, title: `Risk ${k}`, team_id: teamA })));
    const snap = await exportJson();
    put(keys.slice(0, 30).map((k) => ({ op: 'remove', key: k })));
    put(keys.slice(30).map((k) => ({ op: 'remove', key: k })));
    const ev = events();
    const r = await restore({ text: snap });
    expect(r.body.plan.restored).toHaveLength(60);
    expect(events()).toBe(ev + 1);
    expect(keys.every((k) => !!live(k))).toBe(true);
  });

  it('remove_missing removes what the file does not hold in scope; by default a restore only adds and changes', async () => {
    const snap = await exportJson();
    put([{ op: 'upsert', kind: 'risk', key: 'RK-02', title: 'A new risk', team_id: teamA }]);
    const keep = await restore({ text: snap });
    expect(keep.body.plan.removed).toEqual([]);
    expect(live('RK-02')).toBeDefined();
    const c = await restore({ text: snap, remove_missing: true, check: true });
    expect(c.body.plan.removed).toEqual(['RK-02']);
    await restore({ text: snap, remove_missing: true });
    expect(live('RK-02')).toBeUndefined();
  });

  it('a team scope restores only that team\'s part', async () => {
    const snap = await exportJson();
    put([{ op: 'upsert', kind: 'fr', key: 'FR-PWR-01', title: 'Wind the coils faster' }, { op: 'upsert', kind: 'fr', key: 'FR-FLD-02', title: 'Measure drift faster' }]);
    const r = await restore({ text: snap, team_id: teamA });
    expect(r.body.plan.changed).toEqual(['FR-FLD-02']);
    expect(r.body.plan.left_out).toBeGreaterThan(0);
    expect(live('FR-FLD-02')!.title).toBe('Measure drift');
    expect(live('FR-PWR-01')!.title).toBe('Wind the coils faster');
    const t = await restore({ text: snap, tracks: ['PWR'] });
    expect(t.body.plan.changed).toEqual(['FR-PWR-01']);
    expect(live('FR-PWR-01')!.title).toBe('Wind the coils');
  });

  it('is refused while a re-plan is open, and is the admin\'s alone', async () => {
    const snap = await exportJson();
    const rp = (await api('POST', `/projects/${P}/replan`, { team_id: teamB, kinds: ['fr'] })).body.replan;
    expect((await restore({ text: snap })).body.error).toBe('invalid_state');
    expect((await restore({ text: snap, team_id: teamB })).body.error).toBe('invalid_state');
    await api('POST', `/replans/${rp.id}/cancel`, {});
    expect((await restore({ text: 'not an export' })).body.error).toBe('invalid_argument');
  });

  it('text the hub has no record of is credited to an unnamed agent (L2), whoever the file names as its writer', async () => {
    const snap = await forged({
      'RK-01': { title: "Coil heat, said to be the operator's", by: { kind: 'operator', id: null } },
      'ADR-001': { title: "One field model, said to be coord-a's", by: { kind: 'agent', id: coordA } },
    });
    const r = await restore({ text: snap, tracks: ['RK-01', 'ADR-001'] });
    expect(r.body.status).toBe('applied');
    expect(r.body.plan.changed.sort()).toEqual(['ADR-001', 'RK-01']);
    // Neither the operator (L0) nor coord-a: the file is L2 data and never decides trust.
    expect(live('RK-01')).toMatchObject({ title: "Coil heat, said to be the operator's", updated_by_kind: 'agent', updated_by_id: null });
    expect(live('ADR-001')).toMatchObject({ title: "One field model, said to be coord-a's", updated_by_kind: 'agent', updated_by_id: null });
    put([{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat' }, { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'One field model' }]);
  });
});

describe('Markdown export and restore', () => {
  it('reads kinds, statuses, links, bodies, criteria, fields and the architecture back', async () => {
    const s = parseMarkdown(await exportMd());
    const by = new Map(s.items.map((i) => [i.key, i]));
    expect(by.get('FLD')).toMatchObject({ kind: 'module', parent_key: null });
    expect(by.get('FR-FLD-01')).toMatchObject({ kind: 'fr', parent_key: 'FLD', status: 'agreed', title: 'Fold the field', body: 'The field folds on request.\n\nTwo lines of body.' });
    expect(by.get('FR-FLD-01/AC1')).toMatchObject({ kind: 'ac', parent_key: 'FR-FLD-01', fields: { given: 'a flat field', when: 'the operator folds it', then: 'it folds in 3 s' } });
    expect(by.get('M1')!.fields).toEqual({ phase: 'alpha', target_at: Date.UTC(2026, 5, 1) });
    expect(by.get('ADR-001')).toMatchObject({ kind: 'decision', status: 'accepted' });
    expect(by.get('ARCH')).toMatchObject({ kind: 'architecture', body: '# Overview\n\nOne model.\n\n- **not an item** just text', no_title: true });
    expect(s.links).toContainEqual({ from: 'M1', to: 'FR-FLD-01', rel: 'delivers' });
    expect(s.lost.join('\n')).toMatch(/who wrote/);
    expect(parseExport(await exportMd()).format).toBe('markdown');
  });

  it('a Markdown restore keeps what it flattened as the hub has it, and the hub\'s writer for text it knows', async () => {
    // The coordinator writes an item in its own part: the hub's record names it as the writer.
    ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-05', parent_key: 'FLD', title: 'Keep the fold warm' }] }));
    const md = await exportMd();
    put([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-05', title: 'Changed by the operator' }]);
    const r = await restore({ text: md, team_id: teamA });
    expect(r.body.status).toBe('applied');
    expect(r.body.plan.changed).toEqual(['FR-FLD-05']);
    // M1's target date has a time of day the Markdown drops: the hub's value is kept, M1 is unchanged.
    expect(live('M1')!.fields['target_at']).toBe(Date.UTC(2026, 5, 1, 15, 30));
    expect(live('FR-FLD-05')).toMatchObject({ title: 'Keep the fold warm', updated_by_kind: 'agent', updated_by_id: coordA });
  });

  it('text the hub never saw from anyone reads as L2 after a Markdown restore', async () => {
    const md = (await exportMd()).replace('**RK-01** Coil heat', '**RK-01** Coil heat, edited in the file');
    await restore({ text: md, tracks: ['RK-01'] });
    expect(live('RK-01')).toMatchObject({ title: 'Coil heat, edited in the file', updated_by_kind: 'agent', updated_by_id: null });
    expect(item('RK-01').created_by_kind).toBe('operator');
    put([{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat' }]);
  });

  it('the architecture keeps its title, which Markdown does not carry', async () => {
    const md = (await exportMd()).replace('One model.', 'One model, restored.');
    const r = await restore({ text: md, tracks: ['ARCH'] });
    expect(r.body.plan.changed).toEqual(['ARCH']);
    expect(live('ARCH')).toMatchObject({ title: 'How the field is built', body: '# Overview\n\nOne model, restored.\n\n- **not an item** just text' });
  });
});

describe('agents propose a restore', () => {
  let snap = ''; // the export from before FR-FLD-02 was removed, which the proposal brings it back from
  it('check: true returns the plan and files nothing', async () => {
    snap = await exportJson();
    put([{ op: 'remove', key: 'FR-FLD-02' }]);
    const n = proposals();
    const r = await CA('bp_write', { version: v(), check: true, restore: { text: snap, team_id: teamA } });
    const d = ok(r);
    expect(d.status).toBe('checked');
    expect(d.outcome).toBe('propose');
    expect(d.plan.restored).toEqual(['FR-FLD-02']);
    expect(text(r)).toMatch(/nothing written or proposed/);
    expect(proposals()).toBe(n);
  });

  it('a restore is always one proposal for the admin, applied as one restore write', async () => {
    const d = ok(await WA('bp_write', { version: v(), restore: { text: snap, tracks: ['FLD'] }, reason: 'Bring back the drift requirement' }));
    expect(d.status).toBe('proposed');
    const pr = app.blueprint.proposal(d.proposal_id)!;
    expect(pr.ops.some((o) => o.op === 'upsert' && !!o.restore)).toBe(true);
    expect(new BpRouting(app.db, app.blueprint, {} as never).proposalTeam(pr)).toBeNull();
    expect(live('FR-FLD-02')).toBeUndefined();
    const ev = events();
    const a = await api('POST', `/proposals/${pr.id}/apply`, {});
    expect(a.body.proposal.status).toBe('applied');
    expect(events()).toBe(ev + 1);
    // The operator wrote that requirement first: the hub's record keeps it the operator's, not the proposer's.
    expect(live('FR-FLD-02')).toMatchObject({ title: 'Measure drift', status: 'built', updated_by_kind: 'operator' });
    expect(revs('FR-FLD-02')[0]!.change_note).toBe('restored');
  });

  it('ops and restore together are refused', async () => {
    const r = await CA('bp_write', { version: v(), ops: [{ op: 'remove', key: 'RK-01' }], restore: { text: await exportJson() } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not both/);
  });

  it('text the hub has no record of is credited to the proposer, not to the agent or operator the file names', async () => {
    const snap = await forged({
      'RK-01': { title: "Coil heat, said to be coord-a's", by: { kind: 'agent', id: coordA } },
      'ADR-001': { title: "One field model, said to be the operator's", by: { kind: 'operator', id: null } },
    });
    const d = ok(await WA('bp_write', { version: v(), restore: { text: snap, tracks: ['RK-01', 'ADR-001'] }, reason: 'Restore two items' }));
    expect(d.status).toBe('proposed');
    const pr = app.blueprint.proposal(d.proposal_id)!;
    // The marker names no writer for text the hub never recorded, so the proposal's author applies.
    expect(pr.ops.filter((o) => o.op === 'upsert').every((o) => o.op === 'upsert' && !!o.restore && o.restore.by === undefined)).toBe(true);
    const a = await api('POST', `/proposals/${pr.id}/apply`, {});
    expect(a.body.proposal.status).toBe('applied');
    expect(live('RK-01')).toMatchObject({ title: "Coil heat, said to be coord-a's", updated_by_kind: 'agent', updated_by_id: workerA });
    expect(live('ADR-001')).toMatchObject({ title: "One field model, said to be the operator's", updated_by_kind: 'agent', updated_by_id: workerA });
    put([{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat' }, { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'One field model' }]);
  });
});

describe('authorship from the pre-reset backup, a retry, and the check plan (§4.2)', () => {
  // A second hub stands for the hub after a reset: empty, new team and agent ids, and the old hub's backup in its folder.
  let hub2: App, team2 = '', agent2 = '', P2 = '', text2 = '';
  const opr2 = { kind: 'operator' as const, id: 'adm_2' };
  const trustOf = (h: App, pid: string, tid: string | null, keys: string[]) => Object.fromEntries(h.blueprint.read(pid, tid, { keys, detail: 'full', scope: 'project' }).items.map((i) => [i.key, i]));
  const restore2 = (pid: string, a: Record<string, unknown>) => hub2.blueprint.restore(pid, { text: text2, ...a } as any, opr2) as any;

  beforeAll(async () => {
    // Bruno's vision, written by the operator, and a requirement coord-a wrote; then the backup and the export.
    put([{ op: 'upsert', kind: 'summary', key: 'SUM', title: 'Signals Lab', fields: { vision: 'Every field folds safely, on request.' } }]);
    ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-03', parent_key: 'FLD', title: 'Log every fold' }] }));
    expect(item('FR-FLD-03').created_by_kind).toBe('agent');
    // coord-a writes FR-FLD-04, then the operator agrees it: that revision repeats coord-a's text under the operator.
    ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-04', parent_key: 'FLD', title: 'Warn before a fold', body: 'coord-a wrote this.' }] }));
    put([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-04', status: 'agreed' }, { op: 'upsert', kind: 'fr', key: 'FR-FLD-03', position: 7 }]);
    expect(item('FR-FLD-04')).toMatchObject({ created_by_kind: 'agent', updated_by_kind: 'operator', status: 'agreed' });
    const backups = join(dir, 'data', 'backups');
    mkdirSync(backups, { recursive: true });
    app.db.exec(`VACUUM INTO '${join(backups, 'pre-reset.db').replace(/'/g, "''")}'`);
    writeFileSync(join(backups, 'notes.db'), 'not a database');
    text2 = await exportJson();
    const dir2 = mkdtempSync(join(tmpdir(), 'ahbpcr2-'));
    mkdirSync(join(dir2, 'vault'));
    hub2 = await buildApp(testConfig(dir2, { backupDir: backups }));
    await hub2.store.ready;
    const a = hub2.keys.createAgent('coord-a2', null, sys);
    const k = hub2.keys.createSessionKey({ agentId: a.id, label: 'coord-a2' }, sys);
    agent2 = a.id;
    team2 = hub2.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator', credential_id: k.credential.id }] }, sys).id;
    P2 = hub2.blueprint.ensureTeamProject(team2).id;
  });
  afterAll(async () => { await hub2?.close(); });

  it('the check plan previews the destination, base version, digest, team remap, authorship and references, and writes nothing', () => {
    const before = hub2.blueprint.project(P2)!.version;
    const c = restore2(P2, { check: true, backup: 'pre-reset.db', team_map: { [teamA]: team2 }, authors: { [coordA]: agent2 } });
    expect(c.status).toBe('checked');
    expect(c.outcome).toBe('apply');
    expect(c.plan.destination).toEqual({ project: hub2.blueprint.project(P2)!.key, version: before });
    expect(c.plan.base_version).toBe(before);
    expect(c.plan.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(c.plan.teams).toEqual(expect.arrayContaining([{ from: teamA, to: team2, how: 'mapped' }, { from: teamB, to: null, how: 'not_in_project' }]));
    // Every text is verified from the backup, except what an unnamed agent wrote there (an earlier restore's L2 text).
    const unnamed = (app.db.prepare("SELECT key FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND kind<>'report' AND updated_by_kind='agent' AND updated_by_id IS NULL ORDER BY key").all(P) as { key: string }[]).map((r) => r.key);
    expect(c.plan.authors).toMatchObject({ backup: 'pre-reset.db', l2: unnamed.length });
    expect([...c.plan.authors.unverified].sort()).toEqual(unnamed);
    expect(c.plan.authors.from_backup + c.plan.authors.l2).toBe(c.plan.added.length);
    expect(c.plan.collisions).toEqual([]);
    expect(c.plan.unknown_refs).toEqual([]);
    expect(c.plan.prior).toBeNull();
    expect(hub2.blueprint.project(P2)!.version).toBe(before);
    expect(hub2.blueprint.item(P2, 'SUM')).toBeFalsy();
  });

  it('a restore into an empty hub with the backup keeps Bruno\'s vision at L0, and a mapped agent\'s text as that agent\'s', () => {
    const r = restore2(P2, { backup: 'pre-reset.db', team_map: { [teamA]: team2 }, authors: { [coordA]: agent2 }, version: hub2.blueprint.project(P2)!.version });
    expect(r.status).toBe('applied');
    const it = trustOf(hub2, P2, team2, ['SUM', 'FR-FLD-01', 'FR-FLD-03', 'FLD']);
    expect(it['SUM']).toMatchObject({ trust: 'L0', created_by: 'operator:' + adminId });
    expect(it['FR-FLD-01'].trust).toBe('L0');
    expect(it['FR-FLD-03']).toMatchObject({ trust: 'L1', updated_by: 'agent:' + agent2 });
    // The operator's status move does not make coord-a's text the operator's: it comes back as the mapped agent's.
    expect(trustOf(hub2, P2, team2, ['FR-FLD-04'])['FR-FLD-04']).toMatchObject({ trust: 'L1', status: 'agreed', created_by: 'agent:' + agent2, updated_by: 'agent:' + agent2 });
    expect(it['FLD'].team_id).toBe(team2);
    for (const k of ['SUM', 'FR-FLD-03']) expect(it[k].attributed_to).toBeUndefined();
  });

  it('a retry of the same restore returns its first result and writes nothing; a later check shows it', () => {
    const p = hub2.blueprint.project(P2)!;
    const base = (hub2.db.prepare('SELECT base_version FROM bp_restores WHERE project_id=?').get(P2) as { base_version: number }).base_version;
    const events = () => (hub2.db.prepare('SELECT COUNT(*) n FROM bp_events WHERE project_id=?').get(P2) as { n: number }).n;
    const ev = events();
    const again = restore2(P2, { backup: 'pre-reset.db', team_map: { [teamA]: team2 }, authors: { [coordA]: agent2 }, version: base });
    expect(again.retried).toBe(true);
    expect(again.status).toBe('applied');
    expect(again.result.version).toBe(p.version);
    expect(events()).toBe(ev);
    expect(hub2.blueprint.project(P2)!.version).toBe(p.version);
    // The same text with another scope or map is another restore: against a moved Blueprint it is a conflict.
    expect(() => restore2(P2, { backup: 'pre-reset.db', team_map: { [teamA]: team2 }, version: base })).toThrow(/moved since the check/);
    const c = restore2(P2, { check: true, backup: 'pre-reset.db', team_map: { [teamA]: team2 }, authors: { [coordA]: agent2 } });
    expect(c.plan.prior).toMatchObject({ base_version: base, version: p.version });
  });

  it("an operator's status or position change never credits the operator with an agent's text; unmapped, it reads L2", () => {
    const a4 = hub2.keys.createAgent('coord-a4', null, sys), k4 = hub2.keys.createSessionKey({ agentId: a4.id, label: 'coord-a4' }, sys);
    const t4 = hub2.teams.create({ name: 'Rebuild unmapped', goal: 'g', members: [{ agent_id: a4.id, role: 'coordinator', credential_id: k4.credential.id }] }, sys).id;
    const P4 = hub2.blueprint.ensureTeamProject(t4).id;
    const plan = hub2.blueprint.restorePlan(P4, parseExport(text2), { text: text2, backup: 'pre-reset.db', team_map: { [teamA]: t4 } }, { operator: opr2 });
    expect(plan.authors.unverified).toEqual(expect.arrayContaining(['FR-FLD-03', 'FR-FLD-04']));
    const by = (k: string) => (plan.ops.find((o) => o.op === 'upsert' && o.key === k) as { restore?: { by?: { kind: string; id: string | null } } }).restore?.by;
    for (const k of ['FR-FLD-03', 'FR-FLD-04']) expect(by(k)).toEqual({ kind: 'agent', id: null });
    // The operator's own text is still verified as the operator's.
    expect(by('SUM')?.kind).toBe('operator');
  });

  it('a file naming the operator as author is not believed: the text reads L2, the claim kept as attribution only', () => {
    const doc = JSON.parse(text2);
    const sum = doc.items.find((i: any) => i.key === 'SUM');
    Object.assign(sum, { fields: { vision: 'Folding is optional.' }, created_by: { kind: 'operator', id: null }, updated_by: { kind: 'operator', id: null } });
    const r = hub2.blueprint.restore(P2, { text: JSON.stringify(doc), backup: 'pre-reset.db', team_map: { [teamA]: team2 }, tracks: ['SUM'], version: hub2.blueprint.project(P2)!.version }, opr2) as any;
    expect(r.plan.authors).toMatchObject({ verified: 0, l2: 1, unverified: ['SUM'] });
    const it = trustOf(hub2, P2, team2, ['SUM'])['SUM'];
    expect(it).toMatchObject({ trust: 'L2', updated_by: 'agent', attributed_to: 'operator' });
  });

  it('without the backup every item reads as L2, whoever the file names', () => {
    const a3 = hub2.keys.createAgent('coord-a3', null, sys), k3 = hub2.keys.createSessionKey({ agentId: a3.id, label: 'coord-a3' }, sys);
    const t3 = hub2.teams.create({ name: 'Rebuild without backup', goal: 'g', members: [{ agent_id: a3.id, role: 'coordinator', credential_id: k3.credential.id }] }, sys).id;
    const P3 = hub2.blueprint.ensureTeamProject(t3).id;
    const r = restore2(P3, { team_map: { [teamA]: t3 }, version: hub2.blueprint.project(P3)!.version });
    expect(r.plan.authors).toMatchObject({ backup: null, verified: 0 });
    expect(r.plan.authors.l2).toBe(r.plan.added.length);
    const items = hub2.blueprint.read(P3, t3, { detail: 'full', scope: 'project', limit: 200 }).items;
    expect(items.length).toBe(r.plan.added.length);
    expect(items.every((i) => i.trust === 'L2')).toBe(true);
    // The file's claims are attribution only: the operator's vision and coord-a's requirement name their claimed authors.
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by['SUM']).toMatchObject({ trust: 'L2', attributed_to: 'operator' });
    expect(by['FR-FLD-03']).toMatchObject({ trust: 'L2', attributed_to: 'agent:' + coordA });
  });

  it('a backup is a file name in the backup folder that opens as a hub database; an agent cannot name one', () => {
    const v2 = hub2.blueprint.project(P2)!.version;
    expect(() => restore2(P2, { check: true, backup: '../pre-reset.db' })).toThrow(/file name of a backup/);
    expect(() => restore2(P2, { check: true, backup: 'gone.db' })).toThrow(/No backup gone.db/);
    expect(() => restore2(P2, { check: true, backup: 'notes.db' })).toThrow(/does not open|not a Conclave/);
    expect(() => hub2.blueprint.restorePlan(P2, parseExport(text2),{ text: text2, backup: 'pre-reset.db' }, { agent: agent2 })).toThrow(/Only the operator/);
    expect(() => restore2(P2, { authors: { [coordA]: 'agt_nobody' }, version: v2 })).toThrow(/not known to this hub/);
    expect(() => restore2(P2, { team_map: { [teamA]: 'team_nowhere' }, version: v2 })).toThrow(/not part of project/);
  });

  it('applying needs the version the check returned', async () => {
    const snap = await exportJson();
    expect((await api('POST', `/projects/${P}/restore`, { text: snap })).body.error).toBe('invalid_argument');
    expect((await api('POST', `/projects/${P}/restore`, { text: snap, version: v() - 1 })).body.error).toBe('conflict');
  });
});

describe('every link type survives a restore round trip', () => {
  // One example per relation. paper → studies → hypothesis comes with the research workspace (3b, migration 0122): it is
  // tested as soon as kinds.ts has it, and the guard below fails if a relation is ever added without an example here.
  const EXAMPLES: Record<string, [string, string]> = {
    delivers: ['M1', 'FR-FLD-01'], ships: ['REL-9', 'FR-FLD-01'], governs: ['ADR-001', 'FLD'], supersedes: ['ADR-002', 'ADR-001'],
    threatens: ['RK-01', 'FR-FLD-01'], blocks: ['I7', 'FR-FLD-01'], evidence: ['F-L9-01', 'H-L9-01'], studies: ['PAP-9', 'H-L9-01'],
  };
  const rels = Object.keys(RELS);
  const unlinkAll = () => put(rels.filter((r) => hasLink(EXAMPLES[r]![0], EXAMPLES[r]![1], r)).map((r) => ({ op: 'unlink', from: EXAMPLES[r]![0], to: EXAMPLES[r]![1], rel: r })));

  it('has an example for every relation in kinds.ts', () => {
    expect(rels.filter((r) => !EXAMPLES[r])).toEqual([]);
  });

  it('JSON and Markdown restores bring back every link type', async () => {
    put([
      { op: 'upsert', kind: 'release', key: 'REL-9', title: 'Fold release' },
      { op: 'upsert', kind: 'decision', key: 'ADR-002', title: 'Two field models', status: 'proposed' },
      { op: 'upsert', kind: 'issue', key: 'I7', title: 'Fold jams' },
      { op: 'upsert', kind: 'line', key: 'L9', title: 'Fold physics', fields: { mode: 'validate' }, team_id: teamA },
      { op: 'upsert', kind: 'hypothesis', key: 'H-L9-01', parent_key: 'L9', title: 'Folds keep energy' },
      { op: 'upsert', kind: 'finding', key: 'F-L9-01', parent_key: 'L9', title: 'Energy held in 9 of 10 folds' },
      { op: 'upsert', kind: 'paper', key: 'PAP-9', title: 'On folding fields' },
    ]);
    put(rels.filter((r) => !hasLink(EXAMPLES[r]![0], EXAMPLES[r]![1], r)).map((r) => ({ op: 'link', from: EXAMPLES[r]![0], to: EXAMPLES[r]![1], rel: r })));
    expect(rels.filter((r) => !hasLink(EXAMPLES[r]![0], EXAMPLES[r]![1], r))).toEqual([]);
    const json = await exportJson(), md = await exportMd();
    for (const [name, text] of [['json', json], ['markdown', md]] as const) {
      unlinkAll();
      expect(rels.filter((r) => hasLink(EXAMPLES[r]![0], EXAMPLES[r]![1], r))).toEqual([]);
      const r = await restore({ text });
      expect(r.body.status, name).toBe('applied');
      expect(r.body.plan.links.added, name).toBe(rels.length);
      expect(rels.filter((x) => !hasLink(EXAMPLES[x]![0], EXAMPLES[x]![1], x)), name).toEqual([]);
    }
  });
});
