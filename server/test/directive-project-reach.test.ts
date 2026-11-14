/**
 * Directive project reach (docs/directives.md#project-reach; next release §2, enforcement contract point 5):
 * 1. an agent is in every project of its live teams: two projects for an agent shared by two teams, none for a teamless
 *    agent, whatever its free-text project label says;
 * 2. keep off stays an exclusion from delivery: a hub rule kept off project A leaves the list and the Inbox of an agent in
 *    teams of A and B;
 * 3. a project is its id; an older client's key or name resolves to it, and an unknown one is refused;
 * 4. joining or leaving a team, a team ending and a team moving project tell each agent once what it gained or lost;
 * 5. the preview shows who a scope or a keep off reaches, gains and loses, and saves nothing;
 * 6. migration 0117 turns stored labels into project ids and keeps every agent a project exemption kept off.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApp, type App } from '../src/app.js';
import { migrate } from '../src/db/db.js';
import { testConfig, adminLogin } from './hub.js';
import { inForceSql } from '../src/directives/reachSql.js';

const sys = { kind: 'system' as const, id: 'test' };
const admin = { kind: 'admin' as const, id: 'adm_test' };
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

describe('project reach follows live team memberships', () => {
  let app: App, root = '', base = '', cookie = '', csrf = '';
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'conclave-dpr-'));
    mkdirSync(join(root, 'vault'), { recursive: true });
    app = await buildApp(testConfig(root, { vaultDir: join(root, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined }));
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
    ({ cookie, csrf } = await adminLogin(base));
  });
  afterAll(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

  let n = 0;
  const agent = (label: string, project: string | null = null) => {
    const a = app.keys.createAgent(`${label}${++n}`, project, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
    return { id: a.id, cred: k.credential.id as string, label: a.label };
  };
  /** A team of its own (and so a project of its own, named after it) with these members, the first one coordinating. */
  const team = (name: string, ...m: { id: string; cred: string }[]) => {
    const t = app.teams.create({ name: `${name}${++n}`, goal: 'reach', members: m.map((x, i) => ({ agent_id: x.id, role: i ? 'worker' : 'coordinator', credential_id: x.cred })) }, sys);
    const p = app.blueprint.projectOfTeam(t.id)!;
    return { id: t.id, project: p.id, key: p.key, name: p.name };
  };
  /** Projects A and B, an agent in a team of each, one in A only, and a teamless one whose label names A. */
  const world = () => {
    const shared = agent('shared'), onlyA = agent('onlya'), onlyB = agent('onlyb');
    const A = team('alpha', onlyA, shared), B = team('beta', onlyB, shared);
    const loner = agent('loner', A.name);
    return { shared, onlyA, onlyB, loner, A, B };
  };
  const dir = (title: string, scope: { kind: 'hub' | 'project' | 'team'; ref?: string | null }) =>
    app.directives.create({ title, body: `${title} text.`, scope: { kind: scope.kind, ref: scope.ref ?? null } }, sys);
  const ids = (l: { id: string }[]) => l.map((x) => x.id);
  const reach = (d: { id: string }) => ids(app.directives.reach(app.directives.detail(d.id).directive)).sort();
  const sent = (agentId: string, about: string) => (app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND body LIKE ? ORDER BY seq').all(agentId, `%${about}%`) as { body: string }[]).map((x) => x.body);
  const inbox = (agentId: string, dirId: string) => app.keys.recentNotices(agentId, 200).filter((x) => x.current && x.body.includes(dirId));
  const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
  const retire = (...L: { id: string }[]) => { for (const d of L) app.directives.retire(d.id, null, sys); };
  const sqlIn = () => app.db.prepare(`SELECT 1 FROM directives d JOIN agents ag ON ag.id=? WHERE d.id=? AND ${inForceSql('d', 'ag')}`);

  it('an agent is in every project of its live teams; a teamless agent is in none, whatever its label says', () => {
    const W = world();
    const pa = dir('Project A rule', { kind: 'project', ref: W.A.project }), pb = dir('Project B rule', { kind: 'project', ref: W.B.project });
    expect(reach(pa)).toEqual([W.onlyA.id, W.shared.id].sort());
    expect(reach(pb)).toEqual([W.onlyB.id, W.shared.id].sort());
    expect(ids(app.directives.forAgent(W.shared.id))).toEqual(expect.arrayContaining([pa.id, pb.id]));
    // The loner's label names project A: it plays no part.
    expect(app.keys.agent(W.loner.id)!.project).toBe(W.A.name);
    expect(ids(app.directives.forAgent(W.loner.id))).not.toContain(pa.id);
    const q = sqlIn();
    for (const d of [pa, pb]) for (const a of [W.shared, W.onlyA, W.onlyB, W.loner]) {
      expect([d.title, a.label, !!q.get(a.id, d.id)]).toEqual([d.title, a.label, app.directives.applies(app.directives.detail(d.id).directive, app.keys.agent(a.id)!)]);
    }
    // A team that ends takes its project with it; the label still names the project, and the scope reads its name.
    expect(app.directives.detail(pa.id).directive.scope_label).toBe(`project ${W.A.name}`);
    retire(pa, pb);
  });

  it('keep off is an exclusion from delivery: a hub rule kept off A leaves the list and the Inbox of an agent in A and B', () => {
    const W = world();
    const hub = dir('Hub off project A', { kind: 'hub' });
    expect(inbox(W.shared.id, hub.id)).toHaveLength(1); // "New directive", waiting
    const r = app.directives.exempt(hub.id, { kind: 'project', ref: W.A.project, note: null }, admin);
    expect(r.exemption).toMatchObject({ target_kind: 'project', target_ref: W.A.project, label: `project ${W.A.name}` });
    expect(ids(app.directives.forAgent(W.shared.id))).not.toContain(hub.id);
    expect(ids(app.directives.forAgent(W.onlyA.id))).not.toContain(hub.id);
    expect(ids(app.directives.forAgent(W.onlyB.id))).toContain(hub.id);
    expect(ids(app.directives.forAgent(W.loner.id))).toContain(hub.id);
    // The waiting "New directive" notice settled; only the stop notice is in the Inbox now.
    expect(inbox(W.shared.id, hub.id).map((x) => x.body)).toEqual([expect.stringContaining('no longer applies to you. Stop following it.')]);
    // A new version is not sent to the shared agent: B membership does not bring it back.
    app.directives.update(hub.id, { body: 'Sharper hub text.' }, admin);
    expect(sent(W.shared.id, 'Changed directive')).toEqual([]);
    expect(sent(W.onlyB.id, 'Changed directive')).toHaveLength(1);
    retire(hub);
  });

  it('a project is its id: a key or a name from an older client resolves to it, an unknown one is refused', () => {
    const W = world();
    const byKey = dir('By key', { kind: 'project', ref: W.A.key.toLowerCase() }), byName = dir('By name', { kind: 'project', ref: W.B.name.toUpperCase() });
    expect(app.directives.detail(byKey.id).directive.scope_ref).toBe(W.A.project);
    expect(app.directives.detail(byName.id).directive.scope_ref).toBe(W.B.project);
    expect(code(() => dir('Nowhere', { kind: 'project', ref: 'NO-SUCH-PROJECT' }))).toBe('invalid_argument');
    const hub = dir('Hub off by name', { kind: 'hub' });
    expect(app.directives.exempt(hub.id, { kind: 'project', ref: W.B.name }, admin).exemption.target_ref).toBe(W.B.project);
    // The same project again, by its key this time, is a repeat.
    expect(code(() => app.directives.exempt(hub.id, { kind: 'project', ref: W.B.key }, admin))).toBe('conflict');
    expect(code(() => app.directives.exempt(hub.id, { kind: 'project', ref: 'Ghost town' }, admin))).toBe('invalid_argument');
    retire(byKey, byName, hub);
  });

  it('joining, leaving, a team ending and a team moving project tell each agent once what it gained or lost', () => {
    const W = world();
    const pa = dir('A only rule', { kind: 'project', ref: W.A.project }), hubOffB = dir('Hub off B', { kind: 'hub' });
    app.directives.exempt(hubOffB.id, { kind: 'project', ref: W.B.project }, admin);
    const j = agent('joiner');
    const t = team('gamma', j);
    // Joining A: the project rule now applies (one notice); leaving: one stop notice. Earlier confirmations stay.
    app.teams.addMember(W.A.id, { agent_id: j.id, role: 'worker', credential_id: j.cred }, sys);
    expect(sent(j.id, pa.id)).toEqual([expect.stringContaining('Directive now applies to you:')]);
    app.directives.read(j.id, pa.id, { ack: true });
    app.teams.removeMember(W.A.id, j.id, sys);
    expect(sent(j.id, pa.id)).toHaveLength(2);
    expect(sent(j.id, pa.id)[1]).toContain('no longer applies to you. Stop following it.');
    app.teams.addMember(W.A.id, { agent_id: j.id, role: 'worker', credential_id: j.cred }, sys);
    expect(app.directives.summaryFor(j.id).find((d) => d.id === pa.id)).toMatchObject({ read: 'current' });
    // Joining B, which the hub rule is kept off: one stop notice for it, nothing else.
    const before = sent(j.id, hubOffB.id).length;
    app.teams.addMember(W.B.id, { agent_id: j.id, role: 'worker', credential_id: j.cred }, sys);
    expect(sent(j.id, hubOffB.id).slice(before)).toEqual([expect.stringContaining('Stop following it.')]);
    // A team that stops: its members leave its project's reach.
    const solo = agent('solo'), s = team('delta', solo);
    const ps = dir('Delta rule', { kind: 'project', ref: s.project });
    expect(ids(app.directives.forAgent(solo.id))).toContain(ps.id);
    app.teams.stop(s.id, admin);
    expect(ids(app.directives.forAgent(solo.id))).not.toContain(ps.id);
    expect(sent(solo.id, ps.id).at(-1)).toContain('no longer applies to you.');
    // A team that moves project: its members are told what they gained and lost, once each.
    const pg = dir('Gamma rule', { kind: 'project', ref: t.project });
    const dest = app.blueprint.createProject({ key: `MV${String.fromCharCode(65 + (n % 26))}`, name: `Moved ${n}` }, { kind: 'operator', id: null });
    const pm = dir('Moved rule', { kind: 'project', ref: dest.id });
    expect(reach(pm)).toEqual([]);
    app.blueprint.assignTeam(t.id, dest.id, [], { kind: 'operator', id: null });
    expect(reach(pm)).toEqual([j.id]);
    expect(sent(j.id, pm.id)).toEqual([expect.stringContaining('Directive now applies to you:')]);
    expect(sent(j.id, pg.id).filter((b) => b.includes('no longer applies'))).toHaveLength(1);
    retire(pa, hubOffB, ps, pg, pm);
  });

  it('the preview shows who a scope or a keep off reaches, gains and loses, and saves nothing', async () => {
    const W = world();
    const pa = dir('Preview A', { kind: 'project', ref: W.A.project });
    const p1 = await api('POST', '/directives/preview', { scope: { kind: 'project', ref: W.B.key } });
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ scope_label: `project ${W.B.name}`, project: { id: W.B.project, key: W.B.key, name: W.B.name }, lost: [] });
    // With no directive to compare against, everyone it reaches is gained.
    expect(ids(p1.body.gained).sort()).toEqual(ids(p1.body.reach).sort());
    expect(ids(p1.body.reach).sort()).toEqual([W.onlyB.id, W.shared.id].sort());
    // Against the directive as it is: moving A's rule to B gains onlyB and loses onlyA.
    const p2 = await api('POST', '/directives/preview', { id: pa.id, scope: { kind: 'project', ref: W.B.project } });
    expect(ids(p2.body.gained)).toEqual([W.onlyB.id]);
    expect(ids(p2.body.lost)).toEqual([W.onlyA.id]);
    // Keeping a hub rule off A loses both A members, the shared one too.
    const hub = dir('Preview hub', { kind: 'hub' });
    const p3 = await api('POST', '/directives/preview', { id: hub.id, exempt: { target_kind: 'project', target_ref: W.A.project } });
    expect(ids(p3.body.lost).sort()).toEqual([W.onlyA.id, W.shared.id].sort());
    expect(p3.body.gained).toEqual([]);
    expect(app.db.prepare('SELECT COUNT(*) n FROM directive_exemptions WHERE directive_id=?').get(hub.id)).toEqual({ n: 0 });
    expect(app.directives.detail(pa.id).directive.scope_ref).toBe(W.A.project);
    expect((await api('POST', '/directives/preview', { scope: { kind: 'project', ref: 'Ghost town' } })).status).toBe(400);
    // The console's choices: each project with the agents in it.
    const pr = await api('GET', '/directives/projects');
    expect(pr.body.projects.find((p: { id: string }) => p.id === W.A.project)).toMatchObject({ key: W.A.key, name: W.A.name, agent_ids: expect.arrayContaining([W.onlyA.id, W.shared.id]) });
    expect(pr.body.projects.find((p: { id: string }) => p.id === W.A.project).agent_ids).not.toContain(W.loner.id);
    expect((await api('GET', '/directives')).body.projects.length).toBe(pr.body.projects.length);
    retire(pa, hub);
  });
});

/** A hub at 0116, with project labels on directives and exemptions, upgraded with 0117 and the rest. */
describe('migration 0117: project labels become project ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'conclave-0117-'));
  const UPTO = join(root, 'migrations');
  mkdirSync(UPTO);
  for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) < 117) copyFileSync(join(MIGRATIONS, f), join(UPTO, f));
  let app: App;
  beforeAll(async () => {
    mkdirSync(join(root, 'vault'), { recursive: true }); mkdirSync(join(root, 'data'), { recursive: true });
    const config = testConfig(root, { vaultDir: join(root, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined });
    const db = new DatabaseSync(config.dbFile);
    migrate(db, UPTO);
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE version=117').get()).toBeUndefined();
    const now = Date.now();
    const prj = db.prepare("INSERT INTO projects(id,key,name,kind,status,created_by_kind,created_at,updated_at) VALUES (?,?,?,'implementation',?,'system',?,?)");
    prj.run('prj_apps', 'APPS', 'Apps', 'active', now, now); prj.run('prj_beta', 'BETA', 'Beta', 'active', now, now);
    const ag = db.prepare("INSERT INTO agents(id,label,project,status,created_at) VALUES (?,?,?,'active',?)");
    ag.run('ag_in', 'in apps team', 'APPS', now); ag.run('ag_lbl', 'label only', 'APPS', now); ag.run('ag_ghost', 'ghost label', 'Ghost', now); ag.run('ag_beta', 'in beta', null, now);
    const pol = db.prepare("INSERT INTO permission_policies(id,kind,created_at,updated_at) VALUES (?,'credential',?,?)");
    const cred = db.prepare("INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,policy_id,created_at) VALUES (?,'session_key',?,?,?,?,'active',?,?)");
    for (const a of ['in', 'beta']) { pol.run(`pol_${a}`, now, now); cred.run(`crd_${a}`, `ag_${a}`, a, `kid${a}`, '00', `pol_${a}`, now); }
    const tm = db.prepare("INSERT INTO teams(id,name,goal,status,created_at,updated_at,project_id) VALUES (?,?,'goal','running',?,?,?)");
    tm.run('tm_apps', 'Apps team', now, now, 'prj_apps'); tm.run('tm_beta', 'Beta team', now, now, 'prj_beta');
    const mem = db.prepare("INSERT INTO team_members(team_id,agent_id,credential_id,role,joined_at) VALUES (?,?,?,'coordinator',?)");
    mem.run('tm_apps', 'ag_in', 'crd_in', now); mem.run('tm_beta', 'ag_beta', 'crd_beta', now);
    const d = db.prepare("INSERT INTO directives(id,title,body,scope_kind,scope_ref,version,status,created_at,updated_at,tags) VALUES (?,?,?,?,?,1,'active',?,?,'[]')");
    d.run('dir_apps', 'Apps', 'a', 'project', 'APPS', now, now);
    d.run('dir_beta', 'Beta', 'b', 'project', 'beta', now + 1, now);
    d.run('dir_ghost', 'Ghost', 'g', 'project', 'Ghost', now + 2, now);
    d.run('dir_hub1', 'Hub off apps', 'h', 'hub', null, now + 3, now);
    d.run('dir_hub2', 'Hub off ghost', 'h', 'hub', null, now + 4, now);
    const x = db.prepare("INSERT INTO directive_exemptions(id,directive_id,target_kind,target_ref,note,created_by,created_at) VALUES (?,?,'project',?,?,'adm_x',?)");
    x.run('dex_apps', 'dir_hub1', 'APPS', 'apps have their own', now); x.run('dex_ghost', 'dir_hub2', 'Ghost', null, now);
    db.close();
    app = await buildApp(config);
  });
  afterAll(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

  it('maps scopes by key or name, leaves an unknown label reaching nobody, and keeps the version history', () => {
    const scope = (id: string) => (app.db.prepare('SELECT scope_ref r FROM directives WHERE id=?').get(id) as { r: string }).r;
    expect([scope('dir_apps'), scope('dir_beta'), scope('dir_ghost')]).toEqual(['prj_apps', 'prj_beta', 'Ghost']);
    const reach = (id: string) => app.directives.reach(app.directives.detail(id).directive).map((a) => a.id).sort();
    expect(reach('dir_apps')).toEqual(['ag_in']);
    expect(reach('dir_beta')).toEqual(['ag_beta']);
    expect(reach('dir_ghost')).toEqual([]);
  });

  it('keeps every agent a project exemption kept off, with agent exemptions where membership no longer covers it', () => {
    const rows = app.db.prepare("SELECT directive_id d, target_kind k, target_ref r, note, removed_by FROM directive_exemptions ORDER BY directive_id, target_kind, target_ref").all();
    expect(rows).toEqual([
      { d: 'dir_hub1', k: 'agent', r: 'ag_lbl', note: 'Kept off project APPS before reach followed teams', removed_by: null },
      { d: 'dir_hub1', k: 'project', r: 'prj_apps', note: 'apps have their own', removed_by: null },
      { d: 'dir_hub2', k: 'agent', r: 'ag_ghost', note: 'Kept off project Ghost before reach followed teams', removed_by: null },
      { d: 'dir_hub2', k: 'project', r: 'Ghost', note: null, removed_by: 'migration:0117' },
    ]);
    const reach = (id: string) => app.directives.reach(app.directives.detail(id).directive).map((a) => a.id).sort();
    expect(reach('dir_hub1')).toEqual(['ag_beta', 'ag_ghost']);
    expect(reach('dir_hub2')).toEqual(['ag_beta', 'ag_in', 'ag_lbl']);
    const label = app.directives.detail('dir_hub1').directive.reach_label as string;
    expect(label).toMatch(/^All agents except /);
    expect(label).toContain('project Apps');
    expect(label).toContain('agent label only');
  });
});

/** While owner enforcement is on, only eligible memberships put an agent in a project, and grant changes refresh notices. */
describe('project reach under owner enforcement follows the owner\'s grant', () => {
  let app: App, root = '', base = '', cookie = '', csrf = '', adminId = '';
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'conclave-dpr-own-'));
    mkdirSync(join(root, 'vault'), { recursive: true });
    app = await buildApp(testConfig(root, { vaultDir: join(root, 'vault'), vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined }));
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
    ({ cookie, csrf } = await adminLogin(base));
    adminId = (await api('GET', '/me')).body.id;
  });
  afterAll(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

  it('an agent whose owner\'s grant does not delegate the team leaves the project; grants, status and the setting each tell it once', async () => {
    const adm = { kind: 'admin' as const, id: adminId, role: 'admin' as const };
    const mk = (label: string) => { const a = app.keys.createAgent(label, null, sys); const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys); return { id: a.id, cred: k.credential.id as string }; };
    const carolsAgent = mk('carols'), adminsAgent = mk('admins');
    const t = app.teams.create({ name: 'Owned team', goal: 'g', members: [{ agent_id: adminsAgent.id, role: 'coordinator', credential_id: adminsAgent.cred }, { agent_id: carolsAgent.id, role: 'worker', credential_id: carolsAgent.cred }] }, sys);
    const prj = app.blueprint.projectOfTeam(t.id)!;
    const c = await api('POST', '/users', { username: 'carol', display_name: 'Carol', role: 'member' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const carol = c.body.user.id as string;
    app.keys.claimUnowned(adm);
    app.keys.setOwner(carolsAgent.id, carol, adm);
    const rule = app.directives.create({ title: 'Owned project rule', body: 'Text.', scope: { kind: 'project', ref: prj.id } }, sys);
    const hub = app.directives.create({ title: 'Hub off the owned project', body: 'Text.', scope: { kind: 'hub', ref: null } }, sys);
    app.directives.exempt(hub.id, { kind: 'project', ref: prj.id }, admin);
    const reach = (d: { id: string }) => app.directives.reach(app.directives.detail(d.id).directive).map((a) => a.id).filter((id) => [carolsAgent.id, adminsAgent.id].includes(id)).sort();
    const sent = (agentId: string, dirId: string) => (app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND body LIKE ? ORDER BY seq').all(agentId, `%${dirId}%`) as { body: string }[]).map((x) => x.body);
    const q = app.db.prepare(`SELECT 1 FROM directives d JOIN agents ag ON ag.id=? WHERE d.id=? AND ${inForceSql('d', 'ag')}`);
    const parity = () => { for (const d of [rule, hub]) for (const a of [carolsAgent, adminsAgent]) expect([d.title, a.id, !!q.get(a.id, d.id)]).toEqual([d.title, a.id, app.directives.applies(app.directives.detail(d.id).directive, app.keys.agent(a.id)!)]); };
    const both = [adminsAgent.id, carolsAgent.id].sort();
    // Enforcement off: every live membership counts.
    expect(reach(rule)).toEqual(both); expect(reach(hub)).toEqual([]); parity();
    const n0 = sent(carolsAgent.id, rule.id).length, h0 = sent(carolsAgent.id, hub.id).length, a0 = sent(adminsAgent.id, hub.id).length;
    // On: Carol's grant delegates nothing, so her agent is in no project; the admin's agent stays in.
    app.keys.setOwnerEnforcement(true, adm);
    // Keep off is an exclusion: the hub rule kept off the project stays off Carol's agent, an ineligible member of it.
    expect(reach(rule)).toEqual([adminsAgent.id]); expect(reach(hub)).toEqual([]); parity();
    expect(sent(carolsAgent.id, rule.id).slice(n0)).toEqual([expect.stringContaining('no longer applies to you. Stop following it.')]);
    expect(sent(carolsAgent.id, hub.id)).toHaveLength(h0);
    expect(sent(adminsAgent.id, hub.id)).toHaveLength(a0); // nothing moved for it
    // A grant that delegates the team brings it back in; one that leaves the team out takes it out again.
    const put = (teams: string[]) => api('PUT', `/users/${carol}/grants`, { grants: [{ project_id: prj.id, components: ['tasks', 'messages'], delegation: { teams } }] });
    expect((await put([t.id])).status).toBe(200);
    expect(reach(rule)).toEqual(both); parity();
    expect(sent(carolsAgent.id, rule.id).at(-1)).toContain('Directive now applies to you:');
    expect((await put([])).status).toBe(200);
    expect(reach(rule)).toEqual([adminsAgent.id]); expect(reach(hub)).toEqual([]); parity();
    expect(sent(carolsAgent.id, rule.id).at(-1)).toContain('no longer applies to you.');
    // A disabled owner takes the agent out; enabling the owner brings it back.
    await put([t.id]);
    const k = sent(carolsAgent.id, rule.id).length;
    expect((await api('POST', `/users/${carol}/disable`)).status).toBe(200);
    expect(reach(rule)).toEqual([adminsAgent.id]); parity();
    expect((await api('POST', `/users/${carol}/enable`)).status).toBe(200);
    expect(reach(rule)).toEqual(both); parity();
    expect(sent(carolsAgent.id, rule.id).slice(k)).toEqual([expect.stringContaining('no longer applies'), expect.stringContaining('now applies')]);
    // The preview reads the same rule: keeping a rule off the project now leaves both agents.
    expect((await api('POST', '/directives/preview', { scope: { kind: 'project', ref: prj.id } })).body.reach.map((a: { id: string }) => a.id).sort()).toEqual(both);
    await put([]);
    app.keys.setOwnerEnforcement(false, adm);
    expect(reach(rule)).toEqual(both); parity();
  });
});
