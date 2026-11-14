/**
 * Console users and keys (docs/multi-user.md §1.3, §1.4, §2): what a member decider sees of requests, decisions, task
 * events and the work feed (no key id, no console user id); promotion to admin; admins and `external`; the last-admin
 * rule; one-use TOTP codes and the enrolment attempt limit; restricted subfolders; routing of an agent in two teams;
 * and rotation during a checkout move.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Who } from '../src/teams/teams.js';
import { MemberScope } from '../src/admin/memberScope.js';
import { totp } from '../src/util/crypto.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, dana: S;
const PW = 'security test password 1234';
const call = async (who: S | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const signIn = async (username: string, code?: string) => {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: username === 'admin' ? 'correct horse battery' : PW, ...(code ? { totp: code } : {}) }) });
  const b = (await r.json()) as any;
  return { status: r.status, body: b, who: r.status === 200 ? { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: b.csrf } as S : null };
};
const login = async (username: string, code?: string): Promise<S> => { const r = await signIn(username, code); expect(r.status).toBe(200); return r.who!; };
type A = { id: string; cred: string };
const mk = (label: string): A => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, cred: k.credential.id };
};
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
const team = async (project: string, name: string, members: A[]) => {
  const t = app.teams.create({ name, goal: `${name} goal`, members: members.map((m, i) => ({ agent_id: m.id, role: i ? 'worker' : 'coordinator' })) }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  return t.id;
};
let n = 0;
/** A user signed in once with the generated password and set the test's; with 2FA required, enrolled then, and the code enrolment spent is returned too. */
const mkUser = async (o: { role?: 'admin' | 'member'; totp_required?: boolean; external?: boolean } = {}) => {
  const c = await call(admin, 'POST', '/users', { username: `user${++n}`, ...o });
  expect(c.status).toBe(200);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: c.body.user.username, password: c.body.password }) });
  expect(r.status).toBe(200);
  const first: S = { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as any).csrf };
  let secret: string | undefined;
  const at = Date.now();
  if (c.body.user.totp_required) {
    secret = (await call(first, 'POST', '/totp/enroll', {})).body.secret as string;
    expect((await call(first, 'POST', '/totp/confirm', { code: totp(secret, at) })).status).toBe(200);
  }
  expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
  return { id: c.body.user.id as string, username: c.body.user.username as string, secret, at };
};

let cnv = '', one = '', two = '', coord: A, worker: A, coord2: A, adminId = '', danaId = '';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahsec-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir: join(dir, 'vault'), vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0,
  };
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin');
  adminId = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
  cnv = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  coord = mk('one-coord'); worker = mk('one-worker'); coord2 = mk('two-coord');
  one = await team(cnv, 'CNV One', [coord, worker]);
  two = await team(cnv, 'CNV Two', [coord2]);
  const d = await mkUser();
  danaId = d.id;
  expect((await call(admin, 'PUT', `/users/${danaId}/grants`, { grants: [{ project_id: cnv, components: ['tasks', 'feed'] }] })).status).toBe(200);
  expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId] })).status).toBe(200);
  dana = await login(d.username);
});
afterAll(async () => { await app?.close(); });

describe('a member decider sees no key id and no console user id', () => {
  it('GET /api/requests: no credential_id, and whoever decided shows as operator', async () => {
    const ask = (resource: string) => app.access.request({ id: worker.cred }, worker.id, { actions: ['fs.read'], resource, reason: 'need it' });
    const byDana = ask('path:/vault/Projects/Conclave/a/**'), byAdmin = ask('path:/vault/Projects/Conclave/b/**'), open = ask('path:/vault/Projects/Conclave/c/**');
    const elsewhere = app.access.request({ id: coord2.cred }, coord2.id, { actions: ['fs.read'], resource: 'path:/vault/Projects/Conclave/d/**', reason: 'other team' });
    expect([byDana.team_id, elsewhere.team_id]).toEqual([one, two]);
    expect((await call(dana, 'POST', `/requests/${byDana.id}/approve`, { duration: '1h' })).body.request).toMatchObject({ credential_id: null, decided_by: 'operator' });
    expect((await call(admin, 'POST', `/requests/${byAdmin.id}/deny`, {})).status).toBe(200);
    const r = await call(dana, 'GET', '/requests');
    expect(r.body.requests.map((x: any) => x.id).sort()).toEqual([byDana.id, byAdmin.id, open.id].sort());
    for (const x of r.body.requests) expect(x.credential_id).toBeNull();
    expect(r.body.requests.find((x: any) => x.id === byAdmin.id).decided_by).toBe('operator');
    expect(r.body.requests.find((x: any) => x.id === open.id).decided_by).toBeNull();
    for (const secret of [worker.cred, danaId, adminId]) expect(r.text).not.toContain(secret);
    // Filtered by status in SQL too, before the limit.
    expect((await call(dana, 'GET', '/requests?status=pending')).body.requests.map((x: any) => x.id)).toEqual([open.id]);
    // The admin's view keeps them.
    const all = (await call(admin, 'GET', '/requests')).body.requests;
    expect(all.find((x: any) => x.id === byDana.id)).toMatchObject({ credential_id: worker.cred, decided_by: danaId });
  });

  it('decisions: the answerer shows as operator, with no key id', async () => {
    const q = app.decisions.ask(who(coord), { team_id: one, question: 'Ship it?' }).id;
    expect((await call(admin, 'POST', `/decisions/${q}/answer`, { text: 'Yes.' })).body.decision.answered_by_name).toBe('admin');
    for (const path of [`/decisions/${q}`, `/decisions?team=${one}&status=all`]) {
      const r = await call(dana, 'GET', path);
      const d = r.body.decision ?? r.body.decisions.find((x: any) => x.id === q);
      expect(d).toMatchObject({ answered_by: 'operator', answered_by_name: 'operator', credential_id: null });
      for (const secret of [coord.cred, adminId]) expect(r.text).not.toContain(secret);
    }
    // A decider's own answer, in the answer itself.
    const q2 = app.decisions.ask(who(coord), { team_id: one, question: 'And this?' }).id;
    const a = await call(dana, 'POST', `/decisions/${q2}/answer`, { text: 'Fine.' });
    expect(a.body.decision).toMatchObject({ answered_by: 'operator', answered_by_name: 'operator', credential_id: null });
    expect(a.text).not.toContain(danaId);
  });

  it('task events and the work feed: the operator carries a null actor id', async () => {
    const task = app.teams.create_task(who(coord), { team_id: one, title: 'Scrub me', description: 'd' });
    const at = Date.now();
    app.db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,'open','blocked','admin',?,'task_block','held',?)").run(task.id, adminId, at);
    app.db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,note,created_at) VALUES (?,?,'review_request',1,'operator',?,'plan scrub',?)").run(cnv, one, danaId, at);
    const ev = await call(dana, 'GET', `/teams/${one}/tasks/${task.id}`);
    expect(ev.body.events.find((e: any) => e.note === 'held')).toMatchObject({ actor_kind: 'admin', actor_id: null });
    expect(ev.text).not.toContain(adminId);
    const feed = await call(dana, 'GET', '/work/recent?limit=50');
    expect(feed.body.events.find((e: any) => e.note === 'held').actor).toEqual({ kind: 'admin', id: null, label: 'Operator' });
    expect(feed.body.events.find((e: any) => e.note === 'plan scrub').actor).toEqual({ kind: 'operator', id: null, label: 'Operator' });
    for (const secret of [adminId, danaId]) expect(feed.text).not.toContain(secret);
    // Agents keep their ids; the admin sees every id.
    expect((await call(admin, 'GET', '/work/recent?limit=50')).body.events.find((e: any) => e.note === 'held').actor.id).toBe(adminId);
    expect((await call(admin, 'GET', `/teams/${one}/tasks/${task.id}`)).body.events.find((e: any) => e.note === 'held').actor_id).toBe(adminId);
  });
});

describe('admins and deciders', () => {
  it('promotion to admin takes the user off every decider list, and an admin row never counts as a decider', async () => {
    const p = await mkUser();
    expect((await call(admin, 'PUT', `/users/${p.id}/grants`, { grants: [{ project_id: cnv, components: ['tasks'] }] })).status).toBe(200);
    expect((await call(admin, 'PUT', `/teams/${two}/deciders`, { user_ids: [p.id] })).body.active_deciders).toEqual([p.id]);
    expect((await call(admin, 'PATCH', `/users/${p.id}`, { role: 'admin' })).body.user.decider_teams).toEqual([]);
    expect((await call(admin, 'GET', `/teams/${two}/deciders`)).body).toMatchObject({ deciders: [], active_deciders: [] });
    const audit = app.db.prepare("SELECT details FROM audit_events WHERE action='team.deciders_set' AND target_id=? ORDER BY id DESC LIMIT 1").get(two) as { details: string };
    expect(JSON.parse(audit.details)).toMatchObject({ removed: p.id, reason: 'promoted to admin' });
    // A row left for an admin (as earlier promotions did) is ignored: the admin decides plainly, with no override tag.
    app.db.prepare('INSERT INTO team_deciders(team_id,user_id,added_at) VALUES (?,?,?)').run(two, p.id, Date.now());
    expect(app.routing.activeDeciders(two)).toEqual([]);
    const q = app.decisions.ask(who(coord2), { team_id: two, question: 'Who decides?' }).id;
    await call(admin, 'POST', `/decisions/${q}/answer`, { text: 'the admin' });
    const ans = app.db.prepare("SELECT details FROM audit_events WHERE action='decision.answer' AND target_id=? ORDER BY id DESC LIMIT 1").get(q) as { details: string | null };
    expect(JSON.parse(ans.details ?? '{}')).not.toHaveProperty('via');
    app.db.prepare('DELETE FROM team_deciders WHERE user_id=?').run(p.id);
    await call(admin, 'POST', `/users/${p.id}/disable`, {});
  });

  it('an admin is never external', async () => {
    expect((await call(admin, 'POST', '/users', { username: `ext${++n}`, role: 'admin', external: true })).body.error).toBe('invalid_argument');
    const x = (await call(admin, 'POST', '/users', { username: `ext${++n}`, role: 'member', external: true })).body.user;
    const refused = await call(admin, 'PATCH', `/users/${x.id}`, { role: 'admin' });
    expect([refused.status, refused.body.message]).toEqual([400, expect.stringMatching(/never external/)]);
    const ok = await call(admin, 'PATCH', `/users/${x.id}`, { role: 'admin', external: false });
    expect(ok.body.user).toMatchObject({ role: 'admin', external: false, totp_required: true });
    await call(admin, 'POST', `/users/${x.id}/disable`, {});
  });

  it('an admin whose account expires anyway can be disabled', async () => {
    const b = await mkUser({ role: 'admin' });
    // Every admin has an expiry (a state the rule refuses to create, but one an older hub could hold).
    app.db.prepare('UPDATE admin_users SET expires_at=? WHERE id IN (?,?)').run(Date.now() + 10 * 86400_000, adminId, b.id);
    try {
      expect((await call(admin, 'POST', `/users/${b.id}/disable`, {})).status).toBe(200);
    } finally {
      app.db.prepare('UPDATE admin_users SET expires_at=NULL WHERE id=?').run(adminId);
    }
    // The admin with no expiry is still protected.
    const c = await mkUser({ role: 'admin' });
    await call(admin, 'POST', `/users/${c.id}/disable`, {});
    expect((await call(admin, 'PATCH', `/users/${adminId}`, { role: 'member' })).body.error).toBe('invalid_state');
  });
});

describe('TOTP codes work once', () => {
  it('a code spent by the setup page or a sign-in does not sign in again', async () => {
    const u = await mkUser({ totp_required: true });
    expect((await signIn(u.username, totp(u.secret!, u.at))).body.error).toBe('mfa_failed');
    const next = totp(u.secret!, u.at, 1);
    expect((await signIn(u.username, next)).status).toBe(200);
    expect((await signIn(u.username, next)).body.error).toBe('mfa_failed');
  });

  it('Reset refuses the code its admin just signed in with', async () => {
    const u = await mkUser({ role: 'admin', totp_required: true });
    const code = totp(u.secret!, u.at, 1);
    const s = await login(u.username, code);
    const r = await call(s, 'POST', '/reset', { parts: ['activity'], confirm: 'RESET', password: PW, totp: code });
    expect([r.status, r.body.error]).toEqual([400, 'invalid_credentials']);
  });

  it('enrolment: the confirming code is spent, and wrong codes are limited', async () => {
    const u = await mkUser();
    const s = await login(u.username);
    const en = (await call(s, 'POST', '/totp/enroll', {})).body;
    const wrong = totp(en.secret, Date.now() + 10 * 60_000);
    for (let i = 0; i < 10; i++) expect((await call(s, 'POST', '/totp/confirm', { code: wrong })).status).toBe(400);
    const blocked = await call(s, 'POST', '/totp/confirm', { code: totp(en.secret, Date.now()) });
    expect([blocked.status, blocked.body.error]).toEqual([429, 'rate_limited']);
    // Past the limit (a clean counter), the right code enrols and is then spent.
    app.db.prepare("DELETE FROM usage_counters WHERE metric='totp_confirm_fail'").run();
    const at = Date.now();
    expect((await call(s, 'POST', '/totp/confirm', { code: totp(en.secret, at) })).status).toBe(200);
    expect((await signIn(u.username, totp(en.secret, at))).body.error).toBe('mfa_failed');
    expect((await signIn(u.username, totp(en.secret, at, 1))).status).toBe(200);
  });
});

describe('restricted folders', () => {
  it('a grant on a subfolder of a restricted folder opens that subfolder only', async () => {
    const u = await mkUser();
    app.db.prepare('INSERT OR REPLACE INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Projects/Conclave/Restricted/', Date.now());
    const g = await call(admin, 'PUT', `/users/${u.id}/grants`, { grants: [{ project_id: cnv, components: ['vault'], vault_folders: ['/Projects/Conclave/', '/Projects/Conclave/Restricted/open/'] }] });
    expect(g.status).toBe(200);
    const m = new MemberScope(app.db, u.id, false);
    const seen = (p: string, folder = false) => m.canSee(p, folder);
    expect(seen('Projects/Conclave/notes/a.md')).toBe(true);
    expect(seen('Projects/Conclave/Restricted/open/a.md')).toBe(true);
    expect(seen('Projects/Conclave/Restricted/open', true)).toBe(true);
    expect(seen('Projects/Conclave/Restricted/secret.md')).toBe(false);
    expect(seen('Projects/Conclave/Restricted/other/b.md')).toBe(false);
    expect(seen('Projects/Conclave/Restricted', true)).toBe(false);
    expect(m.isAncestor('Projects/Conclave/Restricted')).toEqual(['/Projects/Conclave/Restricted/open/']);
    // The SQL filter agrees.
    const v = m.pathSql('p');
    const sql = (p: string) => (app.db.prepare(`SELECT ${v.sql} AS ok FROM (SELECT ? AS p)`).get(...v.args, p) as { ok: number }).ok;
    expect(['Projects/Conclave/notes/a.md', 'Projects/Conclave/Restricted/open/a.md', 'Projects/Conclave/Restricted/secret.md', 'Projects/Other/x.md'].map(sql)).toEqual([1, 1, 0, 0]);
    // Named outright, the restricted folder opens whole; an external user never sees it.
    await call(admin, 'PUT', `/users/${u.id}/grants`, { grants: [{ project_id: cnv, components: ['vault'], vault_folders: ['/Projects/Conclave/', '/Projects/Conclave/Restricted/'] }] });
    expect(new MemberScope(app.db, u.id, false).canSee('Projects/Conclave/Restricted/secret.md')).toBe(true);
    expect(new MemberScope(app.db, u.id, true).canSee('Projects/Conclave/Restricted/secret.md')).toBe(false);
  });
});

describe('agents and keys', () => {
  it('an agent in two running teams goes to the admin, whatever its task_ref', async () => {
    const both = mk('both'), xc = mk('x-coord');
    const x = await team(cnv, 'CNV X', [xc, both]);
    await team(cnv, 'CNV Y', [mk('y-coord'), both]);
    const t = app.teams.create_task(who(coord), { team_id: one, title: 'elsewhere', description: 'd' });
    const own = app.teams.create_task(who(xc), { team_id: x, title: 'own', description: 'd' });
    for (const task_ref of [undefined, t.id, own.id]) expect(app.access.request({ id: both.cred }, both.id, { actions: ['fs.read'], resource: 'path:/vault/Projects/Conclave/z/**', reason: 'r', task_ref }).team_id).toBeNull();
  });

  it('a key in an unsettled checkout move cannot be rotated', async () => {
    const a = mk('mover');
    const pc = app.keys.createMachine('target-pc', null, sys);
    const succ = app.keys.issueSuccessor(a.cred, pc.id, sys).credential;
    expect(() => app.keys.rotate(a.cred, sys)).toThrow(/checkout successor/);
    expect(() => app.keys.rotate(succ.id, sys)).toThrow(/successor in a checkout/);
    expect(app.keys.credentials({ kind: 'session_key' }).filter((c) => c.agent_id === a.id && c.status === 'active')).toHaveLength(2);
    app.keys.revertSuccessor(succ.id, 'cancelled', sys);
    const r = app.keys.rotate(a.cred, sys);
    expect(app.keys.credentials({ kind: 'session_key' }).filter((c) => c.agent_id === a.id && c.status === 'active').map((c) => c.id)).toEqual([r.credential.id]);
  });
});
