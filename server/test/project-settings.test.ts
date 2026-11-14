/**
 * Project settings (docs/blueprint.md §3, §6; docs/multi-user.md): Single team, enforced on creation, assignment and
 * onboarding, with a database backstop for concurrent approvals; the ecosystem as a one-level parent link that holds only
 * its Foundation and an overview filtered by the viewer's grants; the change of kind shown before the save and audited;
 * and a move to another project that never silently releases work. Journey PROJECT-01..04, BLUEPRINT-01.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const PW = 'project settings password 1234';
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, cara: S;
type R = { status: number; body: any; text: string };
const call = async (who: S, method: string, path: string, body?: unknown): Promise<R> => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = {}; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
};
const as = (m: string, p: string, b?: unknown) => call(admin, m, p, b);
let n = 0;
const team = (name: string) => {
  const a = app.keys.createAgent(`${name} lead ${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${name} key` }, sys);
  const t = app.teams.create({ name, goal: 'g', members: [{ agent_id: a.id, role: 'coordinator', credential_id: k.credential.id }] }, sys);
  app.teams.start(t.id, sys);
  return t.id;
};
const newProject = async (key: string, name: string, extra: Record<string, unknown> = {}) => {
  const r = await as('POST', '/projects', { key, name, ...extra });
  expect(r.status).toBe(200);
  return r.body.project.id as string;
};
const auditOf = (action: string, id: string) => app.db.prepare('SELECT actor_kind, details FROM audit_events WHERE action=? AND target_id=? ORDER BY id').all(action, id) as { actor_kind: string; details: string }[];
const teamsNamed = (name: string) => (app.db.prepare('SELECT COUNT(*) n FROM teams WHERE name=?').get(name) as { n: number }).n;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahps-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
});
afterAll(async () => { await app?.close(); });

describe('Single team (PROJECT-01)', () => {
  let SOLO = '', first = '', second = '';
  beforeAll(async () => {
    SOLO = await newProject('SOLO', 'Solo works', { single_team: true });
    first = team('Solo First'); second = team('Solo Second');
  });

  it('is off by default and set explicitly; the summary says so and counts the contributing teams', async () => {
    const other = await newProject('MULT', 'Many hands');
    expect((await as('GET', `/projects/${other}/summary`)).body.project.single_team).toBe(false);
    expect((await as('PUT', `/teams/${first}/project`, { project_id: SOLO, owns: [] })).status).toBe(200);
    const s = (await as('GET', `/projects/${SOLO}/summary`)).body;
    expect(s.project.single_team).toBe(true);
    expect(s.contributing).toBe(1);
  });

  it('refuses a second team on assignment, explains it and changes nothing', async () => {
    const was = app.blueprint.projectOfTeam(second)!.id;
    const r = await as('PUT', `/teams/${second}/project`, { project_id: SOLO, owns: [] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'conflict', project_id: SOLO, teams: [{ id: first, name: 'Solo First' }] });
    expect(r.body.message).toMatch(/single-team project.*Solo First/);
    expect(app.blueprint.projectOfTeam(second)!.id).toBe(was);
  });

  it('refuses a second enrollment atomically: no draft team, room or project is left behind', () => {
    const rooms = (app.db.prepare('SELECT COUNT(*) n FROM rooms').get() as { n: number }).n;
    expect(() => app.teams.createDraftTeam({ name: 'Solo Late', goal: 'g', project: 'Solo works', delivery_mode: 'on_demand', close_on_approve: false, coordinator_reviews: false, lease_minutes: 30, max_review_rounds: 3 }, sys))
      .toThrow(/single-team project/);
    expect(teamsNamed('Solo Late')).toBe(0);
    expect((app.db.prepare('SELECT COUNT(*) n FROM rooms').get() as { n: number }).n).toBe(rooms);
    expect(app.blueprint.contributingTeams(SOLO).map((t) => t.id)).toEqual([first]);
  });

  it('holds in the database too, so two approvals at the same moment cannot both land', () => {
    expect(() => app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(SOLO, second)).toThrow(/single_team/);
    const t = app.db.prepare('SELECT created_at FROM teams WHERE id=?').get(second) as { created_at: number };
    expect(() => app.db.prepare("INSERT INTO teams(id,name,goal,status,limits,checkpoints,grant_messaging,stall_minutes,lease_minutes,max_review_rounds,created_by,created_at,updated_at,project_id) VALUES ('tm_raw','Raw','g','draft','{}','[]',1,15,30,3,NULL,?,?,?)")
      .run(t.created_at, t.created_at, SOLO)).toThrow(/single_team/);
  });

  it('still adds members to the existing team', () => {
    const a = app.keys.createAgent('Solo helper', null, sys);
    app.keys.createSessionKey({ agentId: a.id, label: 'Solo helper key' }, sys);
    app.teams.addMember(first, { agent_id: a.id, role: 'worker' }, sys);
    expect(app.teams.members(first).some((m) => m.agent_id === a.id)).toBe(true);
    expect(app.teams.singleTeam(first)).toBe(true);
  });

  it('cannot be turned on while several teams contribute: it lists them and nothing changes', async () => {
    const DUO = await newProject('DUO', 'Duet');
    const a = team('Duet One'), b = team('Duet Two');
    for (const t of [a, b]) expect((await as('PUT', `/teams/${t}/project`, { project_id: DUO, owns: [] })).status).toBe(200);
    expect((await as('GET', `/projects/${DUO}/summary`)).body.contributing).toBe(2);
    const r = await as('PATCH', `/projects/${DUO}`, { single_team: true });
    expect(r.status).toBe(409);
    expect(r.body.teams.map((t: { name: string }) => t.name)).toEqual(['Duet One', 'Duet Two']);
    expect(r.body.message).toMatch(/Nothing changed\.$/);
    expect(app.blueprint.project(DUO)!.single_team).toBe(0);
    expect(auditOf('blueprint.single_team', DUO)).toEqual([]);
    expect(() => app.db.prepare('UPDATE projects SET single_team=1 WHERE id=?').run(DUO)).toThrow(/single_team/);
  });

  it('turning it on with one team is recorded with who made it', async () => {
    const one = await newProject('ONE', 'Alone');
    expect((await as('PATCH', `/projects/${one}`, { single_team: true })).body.project.single_team).toBe(1);
    const ev = auditOf('blueprint.single_team', one);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor_kind).toBe('admin');
    expect(JSON.parse(ev[0]!.details)).toMatchObject({ from: false, to: true });
  });
});

describe('Kind (PROJECT-02)', () => {
  it('shows what changes and what stays before the save, changes only future setup and is audited', async () => {
    const K = await newProject('KND', 'Kind case');
    const v = app.blueprint.project(K)!.version;
    expect((await as('POST', `/projects/${K}/ops`, { version: v, ops: [
      { op: 'upsert', kind: 'module', key: 'KA', title: 'A module' },
      { op: 'upsert', kind: 'fr', key: 'FR-KA-01', parent_key: 'KA', title: 'A requirement' },
    ] })).status).toBe(200);
    const fx = (await as('GET', `/projects/${K}/kind-effects?kind=research`)).body;
    expect(fx).toMatchObject({ from: 'implementation', to: 'research', populated: true, keeps: { items: 2, tracks: 1 } });
    expect(fx.changes).toHaveLength(3);
    expect(fx.keeps_text.join(' ')).toMatch(/stays as it is/);
    expect((await as('GET', `/projects/${K}/kind-effects?kind=implementation`)).body.changes).toEqual([]);
    expect((await as('GET', `/projects/${K}/kind-effects?kind=other`)).status).toBe(400);

    expect((await as('PATCH', `/projects/${K}`, { kind: 'research' })).status).toBe(200);
    expect(app.blueprint.item(K, 'FR-KA-01')!.kind).toBe('fr');
    const ev = auditOf('blueprint.project_update', K);
    expect(ev.at(-1)!.actor_kind).toBe('admin');
    expect(JSON.parse(ev.at(-1)!.details)).toMatchObject({ kind: 'research', kind_from: 'implementation' });
  });
});

describe('Ecosystem (PROJECT-03, BLUEPRINT-01)', () => {
  let ECO = '', ALFA = '', BETA = '', alfaTeam = '';
  beforeAll(async () => {
    ECO = await newProject('ECO', 'Harbour ecosystem');
    ALFA = await newProject('ALFA', 'Alfa pier', { parent_id: ECO });
    BETA = await newProject('BETA', 'Hidden sibling wharf', { parent_id: ECO });
    alfaTeam = team('Alfa crew');
    expect((await as('PUT', `/teams/${alfaTeam}/project`, { project_id: ALFA, owns: [] })).status).toBe(200);
  });

  it('is one level deep: no self-parent, no third level, no cycle, and an ecosystem has no teams', async () => {
    expect((await as('PATCH', `/projects/${ECO}`, { parent_id: ECO })).status).toBe(400);
    expect((await as('POST', '/projects', { key: 'GAMA', name: 'Third level', parent_id: ALFA })).status).toBe(400);
    expect((await as('PATCH', `/projects/${ECO}`, { parent_id: ALFA })).status).toBe(400);
    const withTeam = app.blueprint.projectOfTeam(team('Own project crew'))!.id;
    expect((await as('POST', '/projects', { key: 'DLTA', name: 'Under a team', parent_id: withTeam })).body.error).toBe('invalid_state');
    expect((await as('POST', '/projects', { key: 'NOPE', name: 'Nowhere', parent_id: 'prj_missing' })).status).toBe(404);
    expect(() => app.db.prepare('UPDATE projects SET parent_id=? WHERE id=?').run(ECO, ECO)).toThrow(/ecosystem/);
    expect(app.blueprint.project(ECO)!.parent_id).toBeNull();
    const r = await as('PUT', `/teams/${team('Eco crew')}/project`, { project_id: ECO, owns: [] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('invalid_state');
  });

  it('holds only its Foundation', async () => {
    const v = () => app.blueprint.project(ECO)!.version;
    expect((await as('POST', `/projects/${ECO}/ops`, { version: v(), ops: [{ op: 'upsert', kind: 'summary', key: 'SUM', title: 'Harbour', fields: { vision: 'One harbour.' } }] })).status).toBe(200);
    const r = await as('POST', `/projects/${ECO}/ops`, { version: v(), ops: [{ op: 'upsert', kind: 'module', key: 'EM', title: 'Not here' }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('invalid_state');
    expect(app.blueprint.item(ECO, 'EM')).toBeFalsy();
  });

  it('gives the operator an overview of its projects, "No report yet" when none reported', async () => {
    const o = (await as('GET', `/projects/${ECO}/overview`)).body;
    expect(o.project).toMatchObject({ id: ECO, ecosystem: true });
    expect(o.children.map((c: { project: { key: string } }) => c.project.key)).toEqual(['ALFA', 'BETA']);
    for (const c of o.children) { expect(c.health).toBeNull(); expect(c.waiting).toEqual({ proposals: 0 }); }
    expect(o.children[0].teams).toBe(1);
    const s = (await as('GET', `/projects/${ALFA}/summary`)).body;
    expect(s.project.parent).toMatchObject({ id: ECO, key: 'ECO' });
    expect((await as('GET', `/projects/${ECO}/summary`)).body.project.ecosystem).toBe(true);
  });

  it('a child-only collaborator learns nothing about the ecosystem or a hidden sibling', async () => {
    const c = await as('POST', '/users', { username: 'cara' });
    expect(c.status).toBe(200);
    const first = await adminLogin(base, 'cara', c.body.password);
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    expect((await as('PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: ALFA, components: [] }] })).status).toBe(200);
    cara = await adminLogin(base, 'cara', PW);

    const seen: string[] = [];
    const s = await call(cara, 'GET', `/projects/${ALFA}/summary`);
    expect(s.status).toBe(200);
    expect(s.body.project.parent).toBeNull();
    seen.push(s.text);
    const list = await call(cara, 'GET', '/projects');
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: { id: string }) => p.id)).toEqual([ALFA]);
    expect(list.body.projects[0].parent_id).toBeNull();
    seen.push(list.text);
    for (const p of [`/projects/${ECO}/overview`, `/projects/${ECO}/summary`, `/projects/${BETA}/summary`, `/projects/${ALFA}/kind-effects?kind=research`]) {
      const r = await call(cara, 'GET', p);
      expect(r.status, p).not.toBe(200);
      seen.push(r.text);
    }
    // Parentage gives no permission: nothing she was answered names the ecosystem or the sibling.
    for (const t of seen) for (const leak of [ECO, BETA, 'Harbour', 'Hidden sibling', 'BETA']) expect(t, leak).not.toContain(leak);
  });

  it('a collaborator granted the ecosystem sees only the children they hold a grant on', async () => {
    const id = (app.db.prepare("SELECT id FROM admin_users WHERE username='cara'").get() as { id: string }).id;
    expect((await as('PUT', `/users/${id}/grants`, { grants: [{ project_id: ALFA, components: [] }, { project_id: ECO, components: [] }] })).status).toBe(200);
    const o = await call(cara, 'GET', `/projects/${ECO}/overview`);
    expect(o.status).toBe(200);
    expect(o.body.children.map((c: { project: { id: string } }) => c.project.id)).toEqual([ALFA]);
    expect(o.text).not.toContain(BETA);
    expect(o.text).not.toContain('Hidden sibling');
    expect((await call(cara, 'GET', `/projects/${ALFA}/summary`)).body.project.parent).toMatchObject({ id: ECO });
  });
});

describe('Moving a team to another project (PROJECT-04)', () => {
  it('refuses to release a populated part, an open proposal or referenced work, and keeps the source intact', async () => {
    const t = team('Mover crew');
    const src = app.blueprint.projectOfTeam(t)!;
    const dest = await newProject('DEST', 'Destination');
    // An empty auto-opened part does not hold the team back.
    app.blueprint.write(src.id, { version: app.blueprint.project(src.id)!.version, ops: [
      { op: 'upsert', kind: 'module', key: 'MV', title: 'Moving parts', team_id: t },
      { op: 'upsert', kind: 'fr', key: 'FR-MV-01', parent_key: 'MV', title: 'Carry the load' },
    ] }, { kind: 'operator', id: null });
    app.db.prepare("INSERT INTO bp_proposals(id,project_id,team_id,agent_id,ops,base_version,reason,status,created_at,revs) VALUES ('bpp_mv',?,?,NULL,'[]',0,NULL,'open',?,'{}')").run(src.id, t, Date.now());
    app.db.prepare("INSERT INTO tasks(id,team_id,title,status,claimable,created_at,updated_at,plan_refs) VALUES ('task_mv',?,'Lift it','open',0,?,?,?)").run(t, Date.now(), Date.now(), JSON.stringify(['FR-MV-01']));
    const before = app.blueprint.project(src.id)!.version;

    const r = await as('PUT', `/teams/${t}/project`, { project_id: dest, owns: [] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'conflict', from: src.id, dependencies: { items: ['FR-MV-01', 'MV'], proposals: ['bpp_mv'], tasks: [{ id: 'task_mv', title: 'Lift it' }] } });
    expect(r.body.message).toMatch(/nothing changed/);
    expect(app.blueprint.projectOfTeam(t)!.id).toBe(src.id);
    expect(app.blueprint.item(src.id, 'MV')!.team_id).toBe(t);
    expect(app.blueprint.project(src.id)!.version).toBe(before);

    // Once the work is done or given back, the move goes through.
    app.db.prepare("UPDATE bp_proposals SET status='withdrawn' WHERE id='bpp_mv'").run();
    app.db.prepare("UPDATE tasks SET status='done' WHERE id='task_mv'").run();
    expect((await as('PUT', `/teams/${t}/project`, { project_id: src.id, owns: [] })).body.released).toEqual(['MV']);
    expect((await as('PUT', `/teams/${t}/project`, { project_id: dest, owns: [] })).body.moved_from).toBe(src.id);
  });
});
