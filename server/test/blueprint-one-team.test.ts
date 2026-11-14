/** A project with only one team keeps its whole Blueprint at project level (FR-PLAN-12, docs/blueprint.md §3). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { Blueprint, type Op } from '../src/blueprint/blueprint.js';
import { BlueprintViews } from '../src/blueprint/views.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: any };
let app: App, dir = '', adminId = '', base = '', cookie = '', csrf = '', appKey = '';
const opr = () => ({ kind: 'operator' as const, id: adminId });
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const agent = (label: string) => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, cred: k.credential.id, secret: k.secret };
};
/** An MCP caller logged in with the agent's session key. */
const login = async (secret: string) => {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
};
let seq = 0;
/** A started team with one coordinator in a project of its own (the hub opens no part for it). */
const solo = (name = `Solo ${++seq}`) => {
  const c = agent(`coord-${++seq}`);
  const team = app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }] }, sys).id;
  app.teams.start(team, sys);
  const P = app.blueprint.ensureTeamProject(team).id;
  return { c, team, P };
};
const v = (P: string) => app.blueprint.project(P)!.version;
const put = (P: string, ops: Op[]) => app.blueprint.write(P, { version: v(P), ops }, opr());
const modules = (teamId: string) => app.db.prepare("SELECT key FROM bp_items WHERE team_id=? AND kind IN ('module','line') AND deleted_at IS NULL").all(teamId) as { key: string }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahbp1t-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('approval', () => {
  it("a project's only team gets no part; with more teams to come it gets one", async () => {
    const a = agent('solo-coord'), b = agent('more-coord');
    const one = await api('POST', '/teams', { name: 'Field Desk', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator', credential_id: a.cred }] });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(modules(one.body.team.id)).toEqual([]);
    const more = await api('POST', '/teams', { name: 'Grant Desk', goal: 'g', more_teams: true, members: [{ agent_id: b.id, role: 'coordinator', credential_id: b.cred }] });
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    expect(modules(more.body.team.id)).toHaveLength(1);
  });

  it('openTeamPart opens nothing for the only team unless more teams will join', () => {
    const { team } = solo('Quiet Room');
    expect(app.blueprint.openTeamPart(team, opr())).toBeNull();
    expect(modules(team)).toEqual([]);
    expect(app.blueprint.openTeamPart(team, opr(), { moreTeams: true })).toMatch(/^[A-Z]{2,6}$/);
  });
});

describe('rights of the only team', () => {
  it('its coordinator links a project-level paper to the hypotheses it studies while the paper is planned', async () => {
    const { c, P } = solo('Paper Lab');
    expect((await api('PATCH', `/projects/${P}`, { kind: 'research' })).status).toBe(200);
    put(P, [{ op: 'upsert', kind: 'line', key: 'L1', title: 'Field shape', fields: { mode: 'validate' } },
      { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'The field is axisymmetric' },
      { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'A field model', status: 'planned' }]);
    expect(app.blueprint.item(P, 'PAP-1')!.team_id).toBeNull();
    const r = app.blueprint.submit(P, { version: v(P), ops: [{ op: 'link', from: 'PAP-1', to: 'H-L1-01', rel: 'studies' }] }, c.id);
    expect(r.status, JSON.stringify(r)).toBe('applied');
  });

  it('its coordinator has own-part rights over project-level items', () => {
    const { c, team, P } = solo('Field Lab');
    put(P, [{ op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model' }, { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coils overheat' }]);
    expect(app.blueprint.item(P, 'FLD')!.team_id).toBeNull();
    const fr = app.blueprint.submit(P, { version: v(P), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', parent_key: 'FLD', title: 'Field map in 3D' }] }, c.id);
    expect(fr.status).toBe('applied');
    expect(app.blueprint.item(P, 'FR-FLD-01')).toMatchObject({ status: 'draft', team_id: null });
    // A project-level risk is its own too, and an existing module is edited directly.
    expect(app.blueprint.submit(P, { version: v(P), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coils overheat at 2 T' }] }, c.id).status).toBe('applied');
    expect(app.blueprint.submit(P, { version: v(P), ops: [{ op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model and map' }] }, c.id).status).toBe('applied');
    // Opening a new track still needs the operator, and agreeing stays the operator's while the setting is off.
    const track = app.blueprint.submit(P, { version: v(P), ops: [{ op: 'upsert', kind: 'module', key: 'PWR', title: 'Power' }] }, c.id);
    expect(track.status).toBe('proposed');
    if (track.status === 'proposed') app.blueprint.rejectProposal(track.proposal.id, opr(), null);
    const agree = app.blueprint.submit(P, { version: v(P), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', status: 'agreed' }] }, c.id);
    expect(agree.status).toBe('proposed');
    if (agree.status === 'proposed') app.blueprint.rejectProposal(agree.proposal.id, opr(), null);
    // With "Coordinator agrees requirements" on, it agrees project-level requirements directly.
    app.teams.update(team, { coordinator_decides_blueprint: true }, sys);
    expect(app.blueprint.submit(P, { version: v(P), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', status: 'agreed' }] }, c.id).status).toBe('applied');
    expect(app.blueprint.item(P, 'FR-FLD-01')!.status).toBe('agreed');
  });

  it('a second team brings back the normal rules: the first team keeps project-level items there, the new one gets a part', () => {
    const { c, team, P } = solo('Tide Lab');
    put(P, [{ op: 'upsert', kind: 'module', key: 'TDE', title: 'Tides' }, { op: 'upsert', kind: 'fr', key: 'FR-TDE-01', parent_key: 'TDE', title: 'Tide table' }]);
    const c2 = agent('second-coord');
    const second = app.teams.create({ name: 'Moon Desk', goal: 'g', members: [{ agent_id: c2.id, role: 'coordinator', credential_id: c2.cred }] }, sys).id;
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, second);
    expect(app.blueprint.soleTeam(P)).toBeNull();
    expect(app.blueprint.openTeamPart(second, opr())).toMatch(/^[A-Z]{2,6}$/);
    expect(app.blueprint.item(P, 'TDE')!.team_id).toBeNull();
    expect(app.blueprint.item(P, 'FR-TDE-01')!.team_id).toBeNull();
    const r = app.blueprint.submit(P, { version: v(P), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-TDE-02', parent_key: 'TDE', title: 'Spring tides' }] }, c.id);
    expect(r.status).toBe('proposed');
    if (r.status === 'proposed') expect(r.why.join(' ')).toMatch(/outside your team's part/);
    expect(new BlueprintViews(app.db, app.blueprint).summary(P, team).scope).toBe('part');
  });

  it('a stopped team does not count: the project keeps its only team', () => {
    const { team, P } = solo('Reef Watch');
    const c2 = agent('old-coord');
    const old = app.teams.create({ name: 'Old Reef', goal: 'g', members: [{ agent_id: c2.id, role: 'coordinator', credential_id: c2.cred }] }, sys).id;
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, old);
    expect(app.blueprint.soleTeam(P)).toBeNull(); // a draft team counts
    app.db.prepare("UPDATE teams SET status='stopped' WHERE id=?").run(old);
    expect(app.blueprint.soleTeam(P)).toBe(team);
  });
});

describe('reads, limits and the summary', () => {
  it('the summary of the only team covers the whole project', () => {
    const { team, P } = solo('Glass Lab');
    put(P, [{ op: 'upsert', kind: 'module', key: 'GLS', title: 'Glass' }, { op: 'upsert', kind: 'fr', key: 'FR-GLS-01', parent_key: 'GLS', title: 'Clear panes' }]);
    const s = new BlueprintViews(app.db, app.blueprint).summary(P, team);
    expect(s.scope).toBe('project');
    expect(s.teams).toBe(1);
  });

  it('the part limit gives way to the project limit for the only team', () => {
    const bp = new Blueprint(app.db, { itemsPerTeam: 2 });
    const { team, P } = solo('Cap Lab');
    let ver = bp.project(P)!.version;
    const w = (ops: Op[]) => { const r = bp.write(P, { version: ver, ops }, opr()); ver = r.version; return r; };
    w([{ op: 'upsert', kind: 'module', key: 'CAP', title: 'Caps', team_id: team }, { op: 'upsert', kind: 'fr', key: 'FR-CAP-01', parent_key: 'CAP', title: 'a' }]);
    expect(() => w([{ op: 'upsert', kind: 'fr', key: 'FR-CAP-02', parent_key: 'CAP', title: 'b' }, { op: 'upsert', kind: 'fr', key: 'FR-CAP-03', parent_key: 'CAP', title: 'c' }])).not.toThrow();
    expect(bp.item(P, 'FR-CAP-03')!.team_id).toBe(team);
  });

  it('bp_read defaults to the whole project; a part option still works and adds one plain line', async () => {
    const { c, team, P } = solo('Read Lab');
    put(P, [{ op: 'upsert', kind: 'module', key: 'RDA', title: 'Reading', team_id: team }, { op: 'upsert', kind: 'fr', key: 'FR-RDA-01', parent_key: 'RDA', title: 'In the part' },
      { op: 'upsert', kind: 'module', key: 'RDB', title: 'Project level' }, { op: 'upsert', kind: 'fr', key: 'FR-RDB-01', parent_key: 'RDB', title: 'At project level' }]);
    const C = await login(c.secret);
    const plain = (await C('bp_read', { kinds: ['fr'] })).structuredContent;
    expect(plain.items.map((i: any) => i.key).sort()).toEqual(['FR-RDA-01', 'FR-RDB-01']);
    expect(plain.hint).toBeUndefined();
    const part = await C('bp_read', { scope: 'part', kinds: ['fr'] });
    expect(part.structuredContent.hint).toMatch(/has one team, so its whole Blueprint is at project level/);
    expect(part.content[0].text).toContain(part.structuredContent.hint);
    expect((await C('bp_read', { team_id: team, kinds: ['fr'] })).structuredContent.hint).toMatch(/without scope: part or team_id/);
  });

  it('bp_write with team_id goes through and says to use the project level', async () => {
    const { c, team, P } = solo('Write Lab');
    put(P, [{ op: 'upsert', kind: 'module', key: 'WRT', title: 'Writing' }]);
    const C = await login(c.secret);
    const r = await C('bp_write', { team_id: team, version: v(P), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Ink runs out', team_id: team }] });
    expect(r.structuredContent.status, JSON.stringify(r.structuredContent)).toBe('applied');
    expect(r.content[0].text).toMatch(/has one team, so its whole Blueprint is at project level/);
    const quiet = await C('bp_write', { version: v(P), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Paper runs out' }] });
    expect(quiet.structuredContent.status).toBe('applied');
    expect(quiet.content[0].text).not.toMatch(/has one team/);
  });

  it('team_info says the team is its project\'s only one', async () => {
    const { c } = solo('Info Lab');
    const C = await login(c.secret);
    const r = await C('team_info');
    expect(r.structuredContent.teams.map((t: any) => t.one_team)).toEqual([true]);
    expect(JSON.stringify(r.content)).toMatch(/only one, so the whole Blueprint is at project level/);
  });
});

describe('existing projects (no migration)', () => {
  it('PUT /api/teams/:id/project with an empty part moves a one-team part to project level, keeping keys, links, criteria and history', async () => {
    const { team, P } = solo('Old Part');
    put(P, [{ op: 'upsert', kind: 'module', key: 'OLD', title: 'Old part', team_id: team },
      { op: 'upsert', kind: 'fr', key: 'FR-OLD-01', parent_key: 'OLD', title: 'Kept' },
      { op: 'upsert', kind: 'ac', key: 'FR-OLD-01/AC1', parent_key: 'FR-OLD-01', title: 'Still checked' },
      { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First', team_id: team },
      { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Filed in the part', team_id: team }]);
    put(P, [{ op: 'link', from: 'M1', to: 'FR-OLD-01', rel: 'delivers' }, { op: 'upsert', kind: 'fr', key: 'FR-OLD-01', title: 'Kept, edited' }]);
    const revs = app.blueprint.revisions(app.blueprint.item(P, 'FR-OLD-01')!.id).length;
    const links = app.blueprint.links(P).length;
    const r = await api('PUT', `/teams/${team}/project`, { project_id: P, owns: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.owns).toEqual([]);
    for (const k of ['OLD', 'FR-OLD-01', 'FR-OLD-01/AC1', 'M1', 'RK-01']) expect(app.blueprint.item(P, k), k).toMatchObject({ key: k, team_id: null });
    expect(app.blueprint.item(P, 'FR-OLD-01')!.title).toBe('Kept, edited');
    expect(app.blueprint.links(P)).toHaveLength(links);
    expect(app.blueprint.revisions(app.blueprint.item(P, 'FR-OLD-01')!.id).length).toBeGreaterThanOrEqual(revs);
  });
});

describe('agrees with the Single team setting', () => {
  it('a project set to Single team is a one-team project: its team gets no part even when more teams will join', async () => {
    const { c, team, P } = solo('Single Desk');
    const set = await api('PATCH', `/projects/${P}`, { single_team: true });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(app.blueprint.openTeamPart(team, opr(), { moreTeams: true })).toBeNull();
    expect(modules(team)).toEqual([]);
    // Its coordinator has part rights at project level, and team_info names both rules.
    const C = await login(c.secret);
    const w = await C('bp_write', { version: v(P), ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'One desk only' }] });
    expect(w.structuredContent.status).toBe('applied');
    const info = await C('team_info');
    expect(info.structuredContent.teams.map((t: any) => [t.one_team, t.single_team])).toEqual([[true, true]]);
    expect(info.content[0].text).toMatch(/only one, so the whole Blueprint is at project level[\s\S]*set to Single team/);
  });

  it('turning Single team off lets a later team with more teams to come get its part again', async () => {
    const { team, P } = solo('Single Off');
    await api('PATCH', `/projects/${P}`, { single_team: true });
    expect((await api('PATCH', `/projects/${P}`, { single_team: false })).status).toBe(200);
    expect(app.blueprint.openTeamPart(team, opr(), { moreTeams: true })).toMatch(/^[A-Z]{2,6}$/);
  });
});
