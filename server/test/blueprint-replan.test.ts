/**
 * Project Blueprint (docs/blueprint.md §4, §6, §8): start over. A re-plan resets the chosen kinds of a project
 * or one team's part to their first status, keeps keys, links and history, lets the part's coordinator rewrite its marked
 * items directly, and ends with one `replan` proposal reviewed as a before/after, or a cancel that restores the snapshot.
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
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '', adminId = '';
let teamA = '', teamB = '', coordA = '', P = '';
let CA: Call, WA: Call, CB: Call;
const opr = () => ({ kind: 'operator' as const, id: adminId });
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: (r.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t) as any };
};
const item = (k: string) => app.blueprint.item(P, k, true)!;
const notices = (agent: string, kind: string) => (app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND kind=? ORDER BY seq').all(agent, kind) as { body: string }[]).map((n) => n.body);

async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbp6b-'));
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
  coordA = ca.id;
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }, { agent_id: wa.id, role: 'worker', credential_id: wa.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put([
    { op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model', team_id: teamA },
    { op: 'upsert', kind: 'module', key: 'PWR', title: 'Power', team_id: teamB },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', parent_key: 'FLD', title: 'Fold the field', status: 'agreed' },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-02', parent_key: 'FLD', title: 'Measure drift', status: 'built' },
    { op: 'upsert', kind: 'ac', key: 'FR-FLD-01/AC1', parent_key: 'FR-FLD-01', title: 'Folds in 3 s', status: 'passing' },
    { op: 'upsert', kind: 'fr', key: 'FR-PWR-01', parent_key: 'PWR', title: 'Wind the coils', status: 'agreed' },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Field folds', status: 'reached', team_id: teamA },
    { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat', status: 'mitigated', team_id: teamA },
    { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'One field model', status: 'accepted' },
    { op: 'link', from: 'M1', to: 'FR-FLD-01', rel: 'delivers' },
  ]);
  [CA, WA, CB] = [await session(ca.secret), await session(wa.secret), await session(cb.secret)];
});
afterAll(async () => { await app?.close(); });

describe('starting over', () => {
  let R = '';
  it('resets the part\'s chosen kinds to their first status, keeps keys and links, saves a snapshot and tells the coordinator', async () => {
    const r = await api('POST', `/projects/${P}/replan`, { team_id: teamA, note: 'Rebuild the field requirements' });
    expect(r.status).toBe(200);
    R = r.body.replan.id;
    expect(r.body.replan).toMatchObject({ team_id: teamA, status: 'open', source: 'operator', kinds: ['fr', 'nfr', 'ac', 'milestone', 'release', 'risk', 'term'] });
    expect(r.body.reset.sort()).toEqual(['FR-FLD-01', 'FR-FLD-01/AC1', 'FR-FLD-02', 'M1', 'RK-01']);
    expect(item('FR-FLD-01')).toMatchObject({ status: 'draft', replan_id: R });
    expect(item('FR-FLD-02').status).toBe('draft');
    expect(item('FR-FLD-01/AC1').status).toBe('open');
    expect(item('M1').status).toBe('planned');
    expect(item('RK-01').status).toBe('open');
    // Another team's part and the kept kinds are untouched.
    expect(item('FR-PWR-01')).toMatchObject({ status: 'agreed', replan_id: null });
    expect(item('ADR-001')).toMatchObject({ status: 'accepted', replan_id: null });
    expect(app.blueprint.links(P)).toContainEqual(expect.objectContaining({ from_key: 'M1', to_key: 'FR-FLD-01', rel: 'delivers' }));
    expect(app.blueprint.events(P, 1)[0]!.note).toMatch(new RegExp(`re-plan ${R} started: 5 items`));
    const snap = await api('GET', `/replans/${R}/snapshot.md`);
    expect(snap.status).toBe(200);
    expect(snap.body).toMatch(/FR-FLD-01/);
    expect(snap.body).toMatch(/agreed/);
    expect(notices(coordA, 'replan_requested').at(-1)).toMatch(/started over your team's part.*submit_replan.*Note: Rebuild the field requirements/s);
  });

  it('allows one open re-plan per part: a project-wide one excludes a part\'s, and the reverse', async () => {
    expect((await api('POST', `/projects/${P}/replan`, { team_id: teamA })).body.error).toBe('invalid_state');
    expect((await api('POST', `/projects/${P}/replan`, {})).body.error).toBe('invalid_state');
    expect((await api('POST', `/projects/${P}/replan`, { team_id: teamB, kinds: ['decision'] })).body.error).toBe('invalid_argument');
  });

  it('bp_read marks the re-plan and its items', async () => {
    const r = await CA('bp_read', {});
    expect(text(r)).toMatch(new RegExp(`Re-plan ${R} of your part is open`));
    expect(text(r)).toMatch(/FR-FLD-01 fr \[draft\] \{re-plan\} Fold the field/);
    expect(ok(r).replan).toMatchObject({ id: R, items: 5, note: 'Rebuild the field requirements' });
  });

  it('the coordinator rewrites, re-links and deletes marked items directly; new items join the re-plan', async () => {
    const r = ok(await CA('bp_write', { version: v(), ops: [
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', title: 'Fold the field in under 3 s' },
      { op: 'remove', key: 'FR-FLD-01/AC1' },
      { op: 'remove', key: 'FR-FLD-02' },
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-*', parent_key: 'FLD', title: 'Report drift each run' },
      { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Field folds on demand' },
      { op: 'unlink', from: 'M1', to: 'FR-FLD-01', rel: 'delivers' },
    ] }));
    expect(r.status).toBe('applied');
    const added = r.keys['FR-FLD-*'];
    expect(added).toBe('FR-FLD-03');
    expect(item(added)).toMatchObject({ replan_id: R, status: 'draft' });
    expect(ok(await CA('bp_write', { version: v(), ops: [{ op: 'link', from: 'M1', to: added, rel: 'delivers' }] })).status).toBe('applied');
  });

  it('refuses what stays outside: another part, kept kinds, agreeing a requirement, and members', async () => {
    expect(ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', status: 'agreed' }] })).status).toBe('proposed');
    expect(ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'Two field models' }] })).status).toBe('proposed');
    const other = await CA('bp_write', { version: v(), ops: [{ op: 'remove', key: 'FR-PWR-01' }] });
    expect(ok(other).status).toBe('proposed');
    expect((await WA('bp_write', { version: v(), ops: [{ op: 'remove', key: 'FR-FLD-01' }] })).isError).toBe(true);
    // Coord B has no re-plan of its part; the submission is the coordinator's of the part.
    expect(text(await CB('bp_proposals', { action: 'submit_replan' }))).toMatch(/invalid_state.*No re-plan/);
    expect(text(await WA('bp_proposals', { action: 'submit_replan' }))).toMatch(/denied/);
    for (const pr of app.blueprint.proposals(P, { status: 'open' })) app.blueprint.rejectProposal(pr.id, opr(), 'not now');
  });

  it('submits once as a before/after; a reject keeps the re-plan open; a new submission replaces the pending one', async () => {
    const s = ok(await CA('bp_proposals', { action: 'submit_replan', reason: 'Field requirements rebuilt' }));
    expect(s).toMatchObject({ status: 'proposed', replan_id: R });
    expect(s.diff).toMatchObject({ added: ['FR-FLD-03'], removed: ['FR-FLD-02', 'FR-FLD-01/AC1'] });
    expect(s.diff.changed).toEqual(expect.arrayContaining(['FR-FLD-01', 'M1', 'RK-01']));
    const d = (await api('GET', `/replans/${R}`)).body;
    expect(d.diff.changed.find((c: { key: string }) => c.key === 'FR-FLD-01')).toMatchObject({ what: expect.arrayContaining(['title', 'status']), was: { title: 'Fold the field', status: 'agreed' } });
    expect(d.diff.links).toEqual({ added: ['M1 delivers FR-FLD-03'], removed: ['M1 delivers FR-FLD-01'] });
    const rej = await api('POST', `/proposals/${s.proposal_id}/reject`, { note: 'Keep the drift requirement' });
    expect(rej.body.proposal.status).toBe('rejected');
    expect(app.blueprint.replan(R)!.status).toBe('open');
    expect(notices(coordA, 'bp_proposal').at(-1)).toMatch(/sent back your re-plan.*Keep the drift requirement.*stays open/);
    const s2 = ok(await CA('bp_proposals', { action: 'submit_replan' }));
    const s3 = ok(await CA('bp_proposals', { action: 'submit_replan' }));
    expect(app.blueprint.proposal(s2.proposal_id)!.status).toBe('withdrawn');
    expect(app.blueprint.proposal(s3.proposal_id)!).toMatchObject({ status: 'open', type: 'replan' });
    expect(text(await CA('bp_read', {}))).toMatch(new RegExp(`submitted as ${s3.proposal_id}`));
  });

  it('a change after the submission makes it stale; applying the next agrees the requirements and clears the marks', async () => {
    const s = app.blueprint.proposals(P, { status: 'open' }).find((x) => x.type === 'replan')!;
    ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-03', title: 'Report drift after each run' }] }));
    const st = await api('POST', `/proposals/${s.id}/apply`, {});
    expect(st.body).toMatchObject({ stale: expect.stringMatching(/FR-FLD-03 changed after it was submitted/) });
    expect(app.blueprint.replan(R)!.status).toBe('open');
    const s2 = ok(await CA('bp_proposals', { action: 'submit_replan' }));
    // Home names it as a re-plan, not as a proposal of no changes.
    const att = (await api('GET', '/blueprint/attention')).body.items.find((i: { id: string }) => i.id === s2.proposal_id);
    expect(att).toMatchObject({ type: 'replan', replan_id: R, title: `Blueprint re-plan ${R} submitted: Signals Lab's part, reviewed as a whole` });
    const events = () => (app.db.prepare('SELECT COUNT(*) n FROM bp_events WHERE project_id=?').get(P) as { n: number }).n;
    const [v0, e0] = [v(), events()];
    const ap = await api('POST', `/proposals/${s2.proposal_id}/apply`, { note: 'Good' });
    expect(ap.body.proposal.status).toBe('applied');
    // One apply is one event and one version.
    expect([v(), events()]).toEqual([v0 + 1, e0 + 1]);
    expect(app.blueprint.events(P, 1)[0]).toMatchObject({ proposal_id: s2.proposal_id, version: v0 + 1 });
    expect(app.blueprint.replan(R)).toMatchObject({ status: 'applied', items: 0 });
    expect(item('FR-FLD-01')).toMatchObject({ status: 'agreed', replan_id: null, title: 'Fold the field in under 3 s', updated_by_kind: 'agent' });
    expect(item('FR-FLD-03').status).toBe('agreed');
    expect(item('M1').status).toBe('planned');
    expect(item('FR-FLD-02').deleted_at).not.toBeNull();
    // Back to normal rights: an agreed FR's text is a proposal again.
    expect(ok(await CA('bp_write', { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', title: 'Fold it' }] })).status).toBe('proposed');
    for (const pr of app.blueprint.proposals(P, { status: 'open' })) app.blueprint.rejectProposal(pr.id, opr(), null);
  });
});

describe('cancelling a re-plan', () => {
  it('restores every reset item\'s status and content, brings removed items back, removes new ones, restores links', async () => {
    put([{ op: 'link', from: 'M1', to: 'FR-FLD-01', rel: 'delivers' }, { op: 'upsert', kind: 'milestone', key: 'M1', status: 'reached' }]);
    const before = { fr: item('FR-FLD-01'), m1: item('M1'), links: app.blueprint.links(P).length };
    const r = (await api('POST', `/projects/${P}/replan`, { kinds: ['fr', 'milestone'] })).body.replan;
    expect(r.team_id).toBeNull();
    expect(item('FR-PWR-01')).toMatchObject({ status: 'draft', replan_id: r.id });
    expect(notices(coordA, 'replan_requested').at(-1)).toMatch(/started over project/);
    ok(await CA('bp_write', { version: v(), ops: [
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', title: 'Something else' },
      { op: 'unlink', from: 'M1', to: 'FR-FLD-01', rel: 'delivers' },
      { op: 'upsert', kind: 'fr', key: 'FR-FLD-*', parent_key: 'FLD', title: 'Temporary' },
    ] }));
    ok(await CA('bp_write', { version: v(), ops: [{ op: 'remove', key: 'FR-FLD-03' }] }));
    const sub = ok(await CA('bp_proposals', { action: 'submit_replan' }));
    const c = await api('POST', `/replans/${r.id}/cancel`, { note: 'Not now' });
    expect(c.status).toBe(200);
    expect(c.body.removed).toEqual(['FR-FLD-04']);
    expect(c.body.restored).toEqual(expect.arrayContaining(['FR-FLD-01', 'FR-FLD-03', 'M1', 'FR-PWR-01']));
    expect(item('FR-FLD-01')).toMatchObject({ title: before.fr.title, status: 'agreed', replan_id: null, deleted_at: null });
    expect(item('FR-FLD-03')).toMatchObject({ status: 'agreed', deleted_at: null });
    expect(item('FR-FLD-04').deleted_at).not.toBeNull();
    expect(item('M1').status).toBe('reached');
    expect(item('FR-PWR-01').status).toBe('agreed');
    expect(app.blueprint.links(P).length).toBe(before.links);
    expect(app.blueprint.proposal(sub.proposal_id)!.status).toBe('withdrawn');
    expect(app.blueprint.replan(r.id)).toMatchObject({ status: 'cancelled', close_note: 'Not now' });
    expect((await api('POST', `/replans/${r.id}/cancel`, {})).body.error).toBe('invalid_state');
    expect(app.blueprint.revisions(item('FR-FLD-01').id)[0]!.change_note).toBe('restored: re-plan cancelled');
  });

  it('lists re-plans with the open one\'s diff, and the operator can file the review itself', async () => {
    const r = (await api('POST', `/projects/${P}/replan`, { team_id: teamB, kinds: ['fr'] })).body.replan;
    const list = (await api('GET', `/projects/${P}/replans`)).body;
    expect(list.replans.map((x: { status: string }) => x.status)).toEqual(['open', 'cancelled', 'applied']);
    expect(list.open[0]).toMatchObject({ id: r.id, diff: { unchanged: 0, changed: [expect.objectContaining({ key: 'FR-PWR-01', what: ['status'] })] } });
    const s = (await api('POST', `/replans/${r.id}/submit`, { note: 'as is' })).body;
    expect(s.proposal).toMatchObject({ type: 'replan', agent_id: null, status: 'open' });
    expect((await api('POST', `/proposals/${s.proposal.id}/apply`, {})).body.proposal.status).toBe('applied');
    expect(item('FR-PWR-01').status).toBe('agreed');
  });
});

