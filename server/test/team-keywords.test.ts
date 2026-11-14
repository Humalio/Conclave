/**
 * Keywords on projects and teams (docs/proposals/team-keywords.md): migration 0103 and its default triggers, the known list
 * (GET/PUT /api/settings/keywords), keywords on project and team create and patch, the remembered Teams filter
 * (GET/PUT /api/teams/keyword), and the console's matching rule and route arguments (tmMatch, tmArgs, tmFilters in app.js).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { hashPassword } from '../src/util/crypto.js';
import { testConfig, adminLogin } from './hub.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'src', 'db', 'migrations');
const RD = 'Research & Development';
const sys = { kind: 'system' as const, id: null };
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('migration 0103', () => {
  const kw = (db: DatabaseSync, table: string, col: string, id: string) => (db.prepare(`SELECT keyword FROM ${table} WHERE ${col}=? ORDER BY position`).all(id) as { keyword: string }[]).map((r) => r.keyword);
  const upTo0102 = () => {
    const d = tmp('conclave-0103-');
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.*\.sql$/.test(f) && f < '0103') copyFileSync(join(MIGRATIONS, f), join(d, f));
    return d;
  };
  const addProject = (db: DatabaseSync, id: string) => db.prepare("INSERT INTO projects(id,key,name,kind,created_by_kind,created_at,updated_at) VALUES (?,?,?,'implementation','system',1,1)").run(id, id.slice(-3).toUpperCase(), id);
  const addTeam = (db: DatabaseSync, id: string, project: string | null = null) => db.prepare('INSERT INTO teams(id,name,goal,created_at,updated_at,project_id) VALUES (?,?,?,1,1,?)').run(id, id, 'g', project);

  it('gives every existing project and team Research & Development', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, upTo0102());
    addProject(db, 'prj_one'); addTeam(db, 'team_one', 'prj_one'); addTeam(db, 'team_two');
    migrate(db);
    expect(kw(db, 'project_keywords', 'project_id', 'prj_one')).toEqual([RD]);
    expect(kw(db, 'team_keywords', 'team_id', 'team_one')).toEqual([RD]);
    expect(kw(db, 'team_keywords', 'team_id', 'team_two')).toEqual([RD]);
  });

  it('gives new ones Research & Development while it is known, and not once it is removed', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    addProject(db, 'prj_new'); addTeam(db, 'team_new');
    expect(kw(db, 'project_keywords', 'project_id', 'prj_new')).toEqual([RD]);
    expect(kw(db, 'team_keywords', 'team_id', 'team_new')).toEqual([RD]);
    const set = db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES ('keywords.known',?,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    set.run(JSON.stringify(['Applications']));
    addProject(db, 'prj_app'); addTeam(db, 'team_app');
    expect(kw(db, 'project_keywords', 'project_id', 'prj_app')).toEqual([]);
    expect(kw(db, 'team_keywords', 'team_id', 'team_app')).toEqual([]);
    // A setting that is not a list reads as the default list, which has it.
    set.run('{"not":"a list"}');
    addProject(db, 'prj_bad'); addTeam(db, 'team_bad');
    expect(kw(db, 'project_keywords', 'project_id', 'prj_bad')).toEqual([RD]);
    expect(kw(db, 'team_keywords', 'team_id', 'team_bad')).toEqual([RD]);
  });

  it('removes keywords with their project or team', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db);
    addProject(db, 'prj_gone'); addTeam(db, 'team_gone');
    db.prepare("DELETE FROM teams WHERE id='team_gone'").run();
    db.prepare("DELETE FROM projects WHERE id='prj_gone'").run();
    expect(db.prepare("SELECT COUNT(*) n FROM team_keywords WHERE team_id='team_gone'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM project_keywords WHERE project_id='prj_gone'").get()).toEqual({ n: 0 });
  });
});

let app: App, base = '';
type Op = { cookie: string; csrf: string };
let admin: Op, second: Op;
const api = async (op: Op | null, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (op) { headers.cookie = op.cookie; headers['x-csrf-token'] = op.csrf; }
  const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const newTeam = async (name: string, keywords?: string[]) => {
  const a = app.keys.createAgent(`${name} lead`, null, sys);
  app.keys.createSessionKey({ agentId: a.id, label: `${name} key` }, sys);
  return api(admin, 'POST', '/teams', { name, goal: 'g', members: [{ agent_id: a.id, role: 'coordinator' }], ...(keywords ? { keywords } : {}) });
};

beforeAll(async () => {
  const dir = tmp('ahkw-');
  mkdirSync(join(dir, 'vault'));
  const config: Config = testConfig(dir, { publicUrl: 'http://127.0.0.1', maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  app.db.prepare('INSERT INTO admin_users(id,username,password_hash,created_at) VALUES (?,?,?,?)').run('adm_second', 'second', hashPassword('another long passphrase'), Date.now());
  admin = await adminLogin(base);
  second = await adminLogin(base, 'second', 'another long passphrase');
});
afterAll(async () => { await app?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the known keywords', () => {
  it('default to Research & Development and Applications', async () => {
    const r = await api(admin, 'GET', '/settings/keywords');
    expect(r.status).toBe(200);
    expect(r.body.keywords).toEqual([RD, 'Applications']);
    expect(r.body.default).toEqual([RD]);
    expect(r.body.usage.Applications).toEqual({ projects: 0, teams: 0 });
  });

  it('refuse "All", duplicates ignoring case, empty and over-long keywords, and more than 20', async () => {
    for (const keywords of [['All'], ['all'], ['Applications', 'applications'], ['  '], ['x'.repeat(41)], ['a\u0007b'], Array.from({ length: 21 }, (_, i) => `k${i}`), 'Applications']) {
      const r = await api(admin, 'PUT', '/settings/keywords', { keywords });
      expect(r.status, JSON.stringify(keywords)).toBe(400);
    }
    expect((await api(admin, 'GET', '/settings/keywords')).body.keywords).toEqual([RD, 'Applications']);
  });

  it('trim and collapse spaces, keep the order, and are audited', async () => {
    const r = await api(admin, 'PUT', '/settings/keywords', { keywords: ['  Applications ', 'Research   &  Development', 'Ops'] });
    expect(r.status).toBe(200);
    expect(r.body.keywords).toEqual(['Applications', RD, 'Ops']);
    expect(r.body.removed).toEqual({});
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='keywords.update'").get()).toMatchObject({ n: 1 });
  });

  it('are admin-only and need the CSRF token', async () => {
    expect((await api(null, 'GET', '/settings/keywords')).status).toBe(401);
    const r = await fetch(`${base}/api/settings/keywords`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ keywords: [] }) });
    expect(r.status).toBe(403);
  });
});

describe('keywords on projects and teams', () => {
  let prj = '', team = '';
  it('a new project gets Research & Development unless it names its own', async () => {
    const a = await api(admin, 'POST', '/projects', { key: 'KWA', name: 'Keyword A' });
    expect(a.status).toBe(200);
    expect(a.body.project.keywords).toEqual([RD]);
    const b = await api(admin, 'POST', '/projects', { key: 'KWB', name: 'Keyword B', keywords: ['applications'] });
    expect(b.status).toBe(200);
    expect(b.body.project.keywords).toEqual(['Applications']); // the known list's spelling
    prj = b.body.project.id;
    const none = await api(admin, 'POST', '/projects', { key: 'KWC', name: 'Keyword C', keywords: [] });
    expect(none.body.project.keywords).toEqual([]);
  });

  it('refuse an unknown keyword without creating or changing anything', async () => {
    const r = await api(admin, 'POST', '/projects', { key: 'KWX', name: 'Keyword X', keywords: ['Nope'] });
    expect(r.status).toBe(400);
    expect(app.db.prepare("SELECT COUNT(*) n FROM projects WHERE key='KWX'").get()).toEqual({ n: 0 });
    const p = await api(admin, 'PATCH', `/projects/${prj}`, { name: 'Renamed', keywords: ['Nope'] });
    expect(p.status).toBe(400);
    expect((app.db.prepare('SELECT name FROM projects WHERE id=?').get(prj) as { name: string }).name).toBe('Keyword B');
  });

  it('PATCH sets a project\'s keywords on their own or with other fields, and GET /projects lists them', async () => {
    expect((await api(admin, 'PATCH', `/projects/${prj}`, { keywords: ['Ops', 'Applications'] })).body.project.keywords).toEqual(['Ops', 'Applications']);
    const list = await api(admin, 'GET', '/projects?limit=100');
    expect(list.body.projects.find((p: { id: string }) => p.id === prj).keywords).toEqual(['Ops', 'Applications']);
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='project.keywords' AND target_id=?").get(prj)).toMatchObject({ n: 2 }); // created with Applications, then changed
  });

  it('a team carries its own keywords and its project\'s', async () => {
    const t = await newTeam('kw team');
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    team = t.body.team.id;
    expect(t.body.team.keywords).toEqual([RD]);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(prj, team);
    const one = await api(admin, 'GET', `/teams/${team}`);
    expect(one.body.team.keywords).toEqual([RD]);
    expect(one.body.team.project_keywords).toEqual(['Ops', 'Applications']);
    const all = await api(admin, 'GET', '/teams');
    expect(all.body.teams.find((x: { id: string }) => x.id === team)).toMatchObject({ keywords: [RD], project_keywords: ['Ops', 'Applications'] });
  });

  it('team create and patch take keywords; unknown ones are refused', async () => {
    const t = await newTeam('kw team two', ['Ops']);
    expect(t.body.team.keywords).toEqual(['Ops']);
    expect((await newTeam('kw team bad', ['Nope'])).status).toBe(400);
    expect(app.db.prepare("SELECT COUNT(*) n FROM teams WHERE name='kw team bad'").get()).toEqual({ n: 0 });
    expect((await api(admin, 'PATCH', `/teams/${team}`, { keywords: ['Applications'] })).body.team.keywords).toEqual(['Applications']);
    expect((await api(admin, 'PATCH', `/teams/${team}`, { name: 'kw team renamed', keywords: ['Nope'] })).status).toBe(400);
    expect(app.teams.team(team)!.name).toBe('kw team');
  });

  it('removing a known keyword takes it off every project and team and says how many', async () => {
    const before = (await api(admin, 'GET', '/settings/keywords')).body.usage.Ops;
    expect(before).toEqual({ projects: 1, teams: 1 });
    const r = await api(admin, 'PUT', '/settings/keywords', { keywords: ['Applications', RD] });
    expect(r.status).toBe(200);
    expect(r.body.removed).toEqual({ Ops: { projects: 1, teams: 1 } });
    expect(app.db.prepare("SELECT (SELECT COUNT(*) FROM project_keywords WHERE keyword='Ops') + (SELECT COUNT(*) FROM team_keywords WHERE keyword='Ops') n").get()).toEqual({ n: 0 });
    expect((await api(admin, 'GET', `/teams/${team}`)).body.team.project_keywords).toEqual(['Applications']);
  });

  it('a new spelling of a kept keyword is renamed where it is used', async () => {
    const r = await api(admin, 'PUT', '/settings/keywords', { keywords: ['applications', RD] });
    expect(r.body.removed).toEqual({});
    expect((await api(admin, 'GET', `/teams/${team}`)).body.team.keywords).toEqual(['applications']);
    await api(admin, 'PUT', '/settings/keywords', { keywords: [RD, 'Applications'] });
  });
});

describe('the remembered Teams keyword', () => {
  it('defaults to All, is per operator, and refuses an unknown keyword', async () => {
    expect((await api(admin, 'GET', '/teams/keyword')).body).toEqual({ keyword: '' });
    expect((await api(admin, 'PUT', '/teams/keyword', { keyword: 'Applications' })).body).toEqual({ keyword: 'Applications' });
    expect((await api(admin, 'GET', '/teams/keyword')).body).toEqual({ keyword: 'Applications' });
    expect((await api(second, 'GET', '/teams/keyword')).body).toEqual({ keyword: '' });
    expect((await api(admin, 'PUT', '/teams/keyword', { keyword: 'Nope' })).status).toBe(400);
    expect((await api(admin, 'PUT', '/teams/keyword', { keyword: '' })).body).toEqual({ keyword: '' });
  });

  it('reads a keyword removed since as All', async () => {
    await api(admin, 'PUT', '/settings/keywords', { keywords: [RD, 'Applications', 'Temp'] });
    await api(admin, 'PUT', '/teams/keyword', { keyword: 'Temp' });
    await api(admin, 'PUT', '/settings/keywords', { keywords: [RD, 'Applications'] });
    expect((await api(admin, 'GET', '/teams/keyword')).body).toEqual({ keyword: '' });
  });

  it('needs a signed-in operator', async () => {
    expect((await api(null, 'GET', '/teams/keyword')).status).toBe(401);
  });
});

describe('the console filter', () => {
  // The pure helpers from app.js, run against a stub S (the known keywords and the remembered choices).
  const SRC = readFileSync(join(HERE, '..', 'public', 'app.js'), 'utf8');
  const take = (start: RegExp) => {
    const i = SRC.search(start); if (i < 0) throw new Error(`not found: ${start}`);
    const rest = SRC.slice(i), end = rest.search(/\n(?=const |function |let |\/\*)/);
    return rest.slice(0, end < 0 ? undefined : end);
  };
  const code = [/^const TM_ORG = /m, /^const TM_FOCUS = /m, /^function tmArgs\(/m, /^const tmArgStr = /m, /^const tmKws = /m, /^function tmFilters\(/m, /^const tmMatch = /m].map(take).join('\n');
  const make = (S: Record<string, unknown>) => new Function('S', `${code}\nreturn { tmArgs, tmArgStr, tmFilters, tmMatch };`)(S) as {
    tmArgs: (a: string) => Record<string, string> | null; tmArgStr: (f: Record<string, string>) => string;
    tmFilters: (a: string) => Record<string, string>; tmMatch: (t: object, k: string) => boolean;
  };
  const S = { kws: { keywords: [RD, 'Applications'] }, org: '', tkw: '' };
  const F = make(S);

  it('a team matches when it or its project has the keyword; All matches every team', () => {
    expect(F.tmMatch({ keywords: ['Applications'], project_keywords: [RD] }, 'Applications')).toBe(true);
    expect(F.tmMatch({ keywords: ['Applications'], project_keywords: [RD] }, RD)).toBe(true);
    expect(F.tmMatch({ keywords: [], project_keywords: [RD] }, 'Applications')).toBe(false);
    expect(F.tmMatch({}, 'Applications')).toBe(false);
    expect(F.tmMatch({}, '')).toBe(true);
  });

  it('keeps k= in the route, reads an unknown keyword as All, and falls back to the remembered choice', () => {
    expect(F.tmArgs('o=project&k=Applications&q=x')).toEqual({ o: 'project', q: 'x', k: 'Applications' });
    expect(F.tmFilters('k=Gone').k).toBe('');
    expect(F.tmArgStr({ o: 'name', k: 'Applications', q: 'x' })).toBe('o=name&k=Applications&q=x');
    const R = make({ ...S, tkw: 'Applications' });
    expect(R.tmFilters('').k).toBe('Applications');
    expect(R.tmFilters('k=').k).toBe(''); // a link that says All means it
    expect(R.tmArgStr({ o: '', k: '', q: '' })).toBe('k=');
  });

  it('Topology is no Organize choice, and the list argument takes no g=', () => {
    expect(take(/^const TM_ORG = /m)).not.toContain('topology');
    expect(F.tmArgs('o=topology')).toBeNull();
    expect(F.tmArgs('o=topology&g=project%3AConclave')).toBeNull();
    expect(F.tmArgs('o=name&g=team%3Ateam_abc')).toBeNull();
    expect(F.tmArgStr({ o: 'name', k: '', q: '' })).toBe('o=name');
  });

  it('Topology is its own Work tab again: VIEWS.topology, no #topology redirect, a Work bar tab, and the graph links open it (5.A5)', () => {
    expect(SRC).toMatch(/^VIEWS\.topology = async /m);
    const redirect = SRC.slice(SRC.search(/^const BP_REDIRECT = \{/m)).split(/\r?\n\};/)[0];
    expect(redirect).not.toMatch(/^ {2}topology:/m);
    const html = readFileSync(join(HERE, '..', 'public', 'index.html'), 'utf8');
    const bar = html.slice(html.indexOf('id="agentsBar"'), html.indexOf('id="securityBar"'));
    expect(bar.match(/data-go="topology"/g)).toHaveLength(2); // the desktop segment and the phone tabs
    // Connections graph (a project on the team list) and Open in Topology (a team's members) go to #topology/<focus>.
    expect(SRC).toContain('data-go="topology" data-arg="${esc(\'project:\' + g.proj)}"');
    expect(SRC).toContain('data-go="topology" data-arg="${esc(\'team:\' + teamId)}"');
    expect(SRC).not.toMatch(/data-go="teams" data-arg="\$\{esc\(topoArg/);
  });
});
