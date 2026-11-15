/**
 * Operator console fixes: the codes the work feed and the backlog now carry (so the console does not match note text or hard-code
 * the relay window), a claim and its evidence link written in one batch, and what the console source must keep doing
 * (member screen, Back from an onboarding request, "and N more" on a proposal diff, one definition of each shared helper).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '';
const call = async (method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', cookie };
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-console-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp({ dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir: join(dir, 'vault'), vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'p',
    publicUrl: 'http://127.0.0.1', production: false, adminUsername: 'admin', adminPassword: 'admin-password-long', publicDir: join(process.cwd(), 'public'), logLevel: 'silent',
    allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0 });
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-password-long' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!; csrf = ((await r.json()) as { csrf: string }).csrf;
});
afterAll(async () => { await app?.close(); });

describe('work feed codes', () => {
  it('marks a task opened on a relayed request and a task waiting for approval, and nothing else', async () => {
    const dana = app.keys.createAgent('Dana', null, sys);
    app.keys.createSessionKey({ agentId: dana.id, label: 'Dana' }, sys);
    const team = app.teams.create({ name: 'Hull', goal: 'g', members: [{ agent_id: dana.id, role: 'coordinator' }] }, sys);
    const now = Date.now(), db = app.db;
    const task = (id: string, relayed: boolean) => db.prepare("INSERT INTO tasks(id,team_id,title,description,status,claimable,reviewer_agent_id,created_by_agent,created_at,updated_at,plan_refs,operator_request_source) VALUES (?,?,?,?,'open',0,NULL,?,?,?,'[]',?)")
      .run(id, team.id, id, null, dana.id, now, now, relayed ? 'chat with operator' : null);
    task('task_relayed', true); task('task_plain', false);
    const ev = (k: string, from: string | null, to: string, tool: string, note: string | null, at: number) =>
      db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,?,?,'agent',?,?,?,?)").run(k, from, to, dana.id, tool, note, at);
    ev('task_relayed', null, 'open', 'task_create', "opened on the operator's relayed request (chat with operator)", now - 3000);
    ev('task_plain', null, 'open', 'task_create', null, now - 2000);
    ev('task_plain', 'in_review', 'approved', 'no_review', 'awaiting administrator approval', now - 1000);
    const events = (await call('GET', '/work/recent')).body.events as any[];
    const flag = (taskId: string, tool: string) => events.find((e) => e.task?.id === taskId && e.tool === tool)?.flag;
    expect(flag('task_relayed', 'task_create')).toBe('relayed');
    expect(flag('task_plain', 'task_create')).toBeNull();
    expect(flag('task_plain', 'no_review')).toBe('awaiting_approval');
  });

  it('gives plan events a null flag', async () => {
    const own = app.blueprint.projects().find((p) => p.name === 'Hull')!;
    app.db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,note,created_at) VALUES (?,NULL,'review_request',1,'operator','admin','x',?)").run(own.id, Date.now());
    const e = ((await call('GET', '/work/recent')).body.events as any[]).find((x) => x.kind === 'plan');
    expect(e.flag).toBeNull();
  });
});

describe('backlog', () => {
  it('says how many days a relayed task is listed', async () => {
    const r = await call('GET', '/tasks/backlog');
    expect(r.status).toBe(200);
    expect(r.body.relayed_days).toBe(7);
  });
});

describe('a claim and its evidence in one batch', () => {
  it('lets a link op name a key allocated earlier in the same batch', async () => {
    const project = app.blueprint.projects().find((p) => p.name === 'Hull')!;
    const base0 = app.blueprint.project(project.id)!;
    app.blueprint.write(project.id, { version: base0.version, ops: [
      { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'A paper' },
      { op: 'upsert', kind: 'line', key: 'L1', title: 'A line', fields: { mode: 'validate' } },
      { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'A hypothesis' },
    ] }, { kind: 'operator', id: null });
    const v = app.blueprint.project(project.id)!.version;
    const r = await call('POST', `/projects/${project.id}/ops`, { version: v, note: 'one batch', ops: [
      { op: 'upsert', kind: 'claim', key: 'PAP-1/C*', parent_key: 'PAP-1', title: 'The claim', status: 'draft', fields: { part: 'results' } },
      { op: 'link', from: 'H-L1-01', to: 'PAP-1/C*', rel: 'evidence' },
    ] });
    expect(r.status).toBe(200);
    const key = r.body.keys['PAP-1/C*'];
    expect(key).toMatch(/^PAP-1\/C\d+$/);
    const links = app.db.prepare('SELECT from_key, to_key, rel FROM bp_links WHERE project_id=?').all(project.id) as { from_key: string; to_key: string; rel: string }[];
    expect(links).toContainEqual({ from_key: 'H-L1-01', to_key: key, rel: 'evidence' });
  });
});

describe('console source', () => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
  const count = (re: RegExp) => (js.match(re) || []).length;

  it('sends anyone who is not an administrator, or must add 2FA first, to the member shell', () => {
    expect(js).toMatch(/async function enter\(me\) \{\s*if \(me\.setup_needed \|\| me\.role !== 'admin'\) return muEnter\(me\);/);
    expect(html).toContain('id="member"');
    expect(html).toContain('id="muShell"');
    expect(html).toContain('id="muGate"');
  });

  it('sends Back from an onboarding request to Home, with the team list filters', () => {
    // ROUTES.ob.parent returns ['home', homeListArg()]; console-nav.test.ts runs it.
    expect(js).toContain("ob: navUnder(homeUp, 'Onboarding request')");
    expect(js).toContain("const homeUp = () => ['home', homeListArg()];");
  });

  it('says how many ops a proposal diff leaves out', () => {
    expect(js).toContain('and ${pr.ops.length - BP_DIFF_MAX} more');
  });

  it('defines each shared helper once', () => {
    expect(count(/const dz = /g)).toBe(1);
    expect(count(/const plural = /g)).toBe(1);
    expect(count(/const (fbPlural|tmPlural) = /g)).toBe(0);
    expect(count(/document\.createElement\('a'\)/g)).toBe(1);
    expect(count(/const obHubFacts = /g)).toBe(1);
  });

  it('keeps the old Objective, Goal, Plan and Project links, and drops their dead views', () => {
    expect(js).toMatch(/const BP_REDIRECT = \{\s*objective:/);
    expect(js).not.toMatch(/VIEWS\.objective|VIEWS\.goal|VIEWS\.plan\b|VIEWS\.project\b/);
    expect(js).not.toContain('data-goal');
    expect(css).not.toContain('tm-goal-full');
  });

  it('writes the claim and its link in one request, and reads a requirement\'s criteria in one', () => {
    expect(js).toMatch(/bpWrite\(pid, \[\{ op: 'upsert', kind: 'claim'[^\n]*\{ op: 'link', from: it\.key, to: slot, rel: 'evidence' \}\]/);
    expect(js).not.toMatch(/acs\.map\(\(a\) => api\(/);
  });

  it('redraws the views that exist, and nothing the console never opens', () => {
    const m = /const REFRESH_VIEWS = new Set\(\[([^\]]*)\]\)/.exec(js)!;
    const names = m[1]!.split(',').map((s) => s.trim().replace(/'/g, ''));
    for (const n of ['blueprint', 'bp', 'dec', 'pc', 'pcs', 'ob']) expect(names).toContain(n);
    for (const n of ['goal', 'objective', 'plan']) expect(names).not.toContain(n);
  });

  it('uses one name for each thing', () => {
    expect(js).not.toMatch(/Needs me|Re-plan asked|Cancel re-plan|Join a PC|>Create prompt</);
    expect(js).not.toContain('Plan review requested');
  });

  it('keeps long text inside its card: a card wraps words that do not fit, and its tags and the blocked reason wrap too', () => {
    // the operator saw a team page card overflow: a recruit request's long label and role pushed the phone page wider.
    expect(css).toMatch(/\n\.sec\{min-width:0;overflow-wrap:break-word\}/);
    expect(css).toMatch(/\n\.sec \.tag\{max-width:100%;white-space:normal;overflow-wrap:anywhere\}/);
    expect(css).toMatch(/\n\.tk-block\{[^}]*overflow-wrap:anywhere\}/);
    expect(css).toMatch(/@media \(max-width:767px\)\{\.rq\{grid-template-columns:minmax\(0,1fr\)\}\}/);
  });

  it('loads the pinned teams and the grouping once, not on every tick', () => {
    expect(js).toContain('async function loadPrefs()');
    expect(js).not.toMatch(/Promise\.all\(\[[^\n]*api\('\/teams\/pins'\)[^\n]*api\('\/blueprint\/attention/);
  });
});
