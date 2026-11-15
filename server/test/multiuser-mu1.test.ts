/**
 * Members (docs/multi-user.md §1, §2, §6): the route scope registry (fail closed), members on admin routes,
 * the 2FA requirement, expiry, users and grants, generated passwords and the own-password change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { ROUTE_SCOPES, CONDITIONAL_ROUTES, scopeOf } from '../src/admin/scopes.js';
import { totp } from '../src/util/crypto.js';
import Fastify from 'fastify';
import { registerDecisionsApi } from '../src/admin/decisionsApi.js';
import { registerBlueprintApi } from '../src/admin/blueprintApi.js';
import { testConfig } from './hub.js';

let app: App, base = '';
type Who = { cookie: string; csrf: string };
let admin: Who;
const call = async (who: Who | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const login = async (username: string, password: string, code?: string) => {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, ...(code ? { totp: code } : {}) }) });
  const b = (await r.json()) as any;
  return { status: r.status, body: b, who: r.ok ? { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: b.csrf as string } : null };
};
const PW = 'a long enough password 42';
let n = 0;
/**
 * Create a user through the API, sign in with the generated password (enrolling 2FA first when it is required) and
 * set the test's password; returns its id, username and TOTP secret.
 */
async function user(over: Record<string, unknown> = {}) {
  const username = `user${++n}`;
  const c = await call(admin, 'POST', '/users', { username, display_name: `User ${n}`, ...over });
  expect(c.status).toBe(200);
  const first = (await login(username, c.body.password)).who!;
  let secret: string | undefined;
  if (c.body.user.totp_required) {
    secret = (await call(first, 'POST', '/totp/enroll', {})).body.secret as string;
    expect((await call(first, 'POST', '/totp/confirm', { code: totp(secret, Date.now()) })).status).toBe(200);
  }
  expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
  return { id: c.body.user.id as string, username, secret };
}
let projA = '', projB = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahmu1-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = (await login('admin', 'correct horse battery')).who!;
  projA = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  projB = (await call(admin, 'POST', '/projects', { key: 'BRZ', name: 'Echo', kind: 'research' })).body.project.id;
});
afterAll(async () => { await app?.close(); });

describe('route scope registry', () => {
  it('declares every /api route the hub registers, and nothing that is not a route', () => {
    const registered = new Set(app.adminRoutes);
    expect(registered.size).toBeGreaterThan(150);
    const undeclared = [...registered].filter((r) => !ROUTE_SCOPES[r]);
    expect(undeclared).toEqual([]);
    const stale = Object.keys(ROUTE_SCOPES).filter((r) => !registered.has(r) && !CONDITIONAL_ROUTES.has(r));
    expect(stale).toEqual([]);
  });
  it('an undeclared route is admin-only (fail closed); HEAD answers as GET', () => {
    expect(scopeOf('GET', '/api/not-a-route')).toBeUndefined();
    expect(scopeOf('HEAD', '/api/me')).toBe('self');
    expect(scopeOf('POST', '/api/lockdown')).toBe('admin');
    expect(scopeOf('PUT', '/api/users/:id/grants')).toBe('admin');
    for (const r of ['accept', 'discard', 'demote']) expect(scopeOf('POST', `/api/teams/:id/tasks/:taskId/${r}`)).toBe('admin');
    expect(scopeOf('GET', '/api/tasks/backlog')).toBe('admin');
  });
});

describe('members', () => {
  it('reach self routes; admin routes answer 403 admin_only; scoped reads are filtered; decider routes show only what is routed to them', async () => {
    const u = await user();
    const m = (await login(u.username, PW)).who!;
    const me = await call(m, 'GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: 'member', external: false, grants: [], decider_teams: [] });
    expect(me.body).not.toHaveProperty('public_url');
    expect(me.body).not.toHaveProperty('demo');
    for (const [m_, p] of [['GET', '/keys'], ['GET', '/audit'], ['POST', '/lockdown'], ['GET', '/users'], ['GET', '/pcs'], ['GET', '/settings/blueprint'],
      // The operator's backlog moves and the task intake stay admin-only.
      ['GET', '/tasks/backlog'], ['POST', '/teams/tm_x/tasks/task_x/accept'], ['POST', '/teams/tm_x/tasks/task_x/discard'], ['POST', '/teams/tm_x/tasks/task_x/demote'], ['PATCH', `/projects/${projA}`],
      // Tell the agent (the agent page, Message on a Members row) is admin-only.
      ['POST', '/agents/ag_x/notices'],
      // Keeping a directive off an agent, team or project, and applying it again, are the operator's (6.A8).
      ['POST', '/directives/dir_x/exemptions'], ['DELETE', '/directives/dir_x/exemptions/dex_x']] as const) {
      const r = await call(m, m_, p, m_ === 'GET' ? undefined : {});
      expect([p, r.status, r.body.error]).toEqual([p, 403, 'admin_only']);
    }
    expect((await call(m, 'GET', '/teams')).body).toEqual({ teams: [] });
    expect((await call(m, 'GET', '/projects')).body).toMatchObject({ projects: [], total: 0 }); // granted projects only
    expect((await call(m, 'GET', '/requests')).body).toEqual({ requests: [] }); // nothing routed to a member who decides for no team
    expect((await call(m, 'PUT', '/teams/organize', { organize: '' })).status).not.toBe(403);
    // The admin is unchanged.
    expect((await call(admin, 'GET', '/keys')).status).toBe(200);
    expect((await call(admin, 'GET', '/me')).body).toMatchObject({ role: 'admin', public_url: 'http://hub.test' });
  });
  it('the audit records the actor role', async () => {
    const u = await user();
    const m = (await login(u.username, PW)).who!;
    await call(m, 'POST', '/totp/enroll', {});
    const row = app.db.prepare("SELECT actor_kind, actor_role FROM audit_events WHERE action='user.password_changed' AND target_id=?").get(u.id) as { actor_kind: string; actor_role: string };
    expect(row).toEqual({ actor_kind: 'admin', actor_role: 'member' });
    const a = app.db.prepare("SELECT actor_role FROM audit_events WHERE action='user.create' AND target_id=?").get(u.id) as { actor_role: string };
    expect(a.actor_role).toBe('admin');
  });
});

describe('2FA required and expiry', () => {
  it('an external user without TOTP reaches only /api/me, /api/totp/* and /api/logout', async () => {
    // A user without 2FA who is made external afterwards: the next sign-in must enrol first.
    const u = await user();
    expect((await call(admin, 'PATCH', `/users/${u.id}`, { external: true })).body.user).toMatchObject({ external: true, totp_required: true, totp_enrolled: false });
    const l = await login(u.username, PW);
    expect(l.status).toBe(200);
    expect(l.body).toMatchObject({ setup_needed: true, totp_required: true });
    const m = l.who!;
    expect((await call(m, 'GET', '/me')).body.setup_needed).toBe(true);
    expect((await call(m, 'PUT', '/teams/organize', { organize: '' })).body.error).toBe('totp_required');
    const en = await call(m, 'POST', '/totp/enroll', {});
    expect(en.status).toBe(200);
    expect((await call(m, 'POST', '/totp/confirm', { code: totp(en.body.secret, Date.now()) })).status).toBe(200);
    expect((await call(m, 'PUT', '/teams/organize', { organize: '' })).status).toBe(200);
    // From now on the login needs the code.
    expect((await login(u.username, PW)).body.error).toBe('mfa_required');
  });
  it('a user past expires_at cannot sign in, live sessions end, and decider rows go; audited once', async () => {
    const u = await user({ expires_at: Date.now() + 3600_000 });
    const m = (await login(u.username, PW)).who!;
    const team = app.db.prepare('SELECT id FROM teams LIMIT 1').get() as { id: string } | undefined;
    if (team) app.db.prepare('INSERT INTO team_deciders(team_id,user_id,added_at) VALUES (?,?,?)').run(team.id, u.id, Date.now());
    app.db.prepare('UPDATE admin_users SET expires_at=? WHERE id=?').run(Date.now() - 1000, u.id);
    const r = await call(m, 'GET', '/me');
    expect([r.status, r.body.error]).toEqual([401, 'expired']);
    expect((await call(m, 'GET', '/me')).body.error).toBe('unauthenticated');
    expect((await login(u.username, PW)).body.error).toBe('expired');
    expect(app.db.prepare('SELECT COUNT(*) n FROM team_deciders WHERE user_id=?').get(u.id)).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='user.expired' AND target_id=?").get(u.id)).toEqual({ n: 1 });
    expect((await call(admin, 'GET', `/users/${u.id}`)).body.user.expired).toBe(true);
  });
  it('the maintenance sweep expires users nobody is using', async () => {
    const u = await user({ expires_at: Date.now() + 3600_000 });
    app.db.prepare('UPDATE admin_users SET expires_at=? WHERE id=?').run(Date.now() - 1, u.id);
    expect(app.users.sweepExpired()).toBe(1);
    expect(app.users.sweepExpired()).toBe(0);
  });
  it('a disabled user is signed out; the last active admin cannot be disabled or demoted', async () => {
    const u = await user();
    const m = (await login(u.username, PW)).who!;
    expect((await call(admin, 'POST', `/users/${u.id}/disable`, {})).body.user.status).toBe('disabled');
    expect((await call(m, 'GET', '/me')).status).toBe(401);
    const adminId = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
    expect((await call(admin, 'POST', `/users/${adminId}/disable`, {})).status).toBe(400);
    expect((await call(admin, 'PATCH', `/users/${adminId}`, { role: 'member' })).status).toBe(409);
    // No lockout by expiry: another active admin with no expiry must always remain.
    const exp = await call(admin, 'PATCH', `/users/${adminId}`, { expires_at: Date.now() + 90 * 86400_000 });
    expect([exp.status, exp.body.message]).toEqual([409, 'Cannot set an expiry on the last active admin without an expiry: another active admin with no expiry must remain.']);
    // A takes an expiry while B has none; B then cannot take one too, even an earlier one (A would be left alone at T1).
    const b = await user({ role: 'admin' });
    expect((await call(admin, 'PATCH', `/users/${adminId}`, { expires_at: Date.now() + 30 * 86400_000 })).status).toBe(200);
    expect((await call(admin, 'PATCH', `/users/${b.id}`, { expires_at: Date.now() + 10 * 86400_000 })).status).toBe(409);
    // Nor can the only admin with no expiry be disabled or demoted while the other has one.
    expect((await call(admin, 'POST', `/users/${b.id}/disable`, {})).status).toBe(409);
    expect((await call(admin, 'PATCH', `/users/${b.id}`, { role: 'member' })).status).toBe(409);
    // A user becoming an admin with an expiry is held to the same rule (B is the only no-expiry admin, so that is fine).
    const c = await user();
    expect((await call(admin, 'PATCH', `/users/${c.id}`, { role: 'admin', expires_at: Date.now() + 5 * 86400_000 })).status).toBe(200);
    // With two admins without an expiry, one can take an expiry.
    expect((await call(admin, 'PATCH', `/users/${adminId}`, { expires_at: null })).status).toBe(200);
    expect((await call(admin, 'PATCH', `/users/${b.id}`, { expires_at: Date.now() + 10 * 86400_000 })).status).toBe(200);
    await call(admin, 'POST', `/users/${b.id}/disable`, {});
    await call(admin, 'POST', `/users/${c.id}/disable`, {});
  });
  it('the administrator-only guards check the role, not the actor kind', async () => {
    // A member is recorded as actor_kind 'admin' with role 'member'. Mount the two routers behind an actor with that role
    // (no scope hook in front): their own guards must still refuse it.
    const f = Fastify();
    f.setErrorHandler((e: any, _req, reply) => { reply.code(e.code === 'admin_only' ? 403 : 400).send({ error: e.code ?? 'error', message: String(e.message).slice(0, 200) }); });
    const member = () => ({ kind: 'admin' as const, id: 'adm_member', role: 'member' as const });
    registerDecisionsApi(f, { db: app.db, decisions: app.decisions, teams: app.teams, vault: app.vault }, member);
    registerBlueprintApi(f, { db: app.db, blueprint: app.blueprint }, member);
    const ans = await f.inject({ method: 'POST', url: '/api/decisions/dec_x/answer', payload: { option: 'a' } });
    // The same answer as the scope hook gives a member on an admin-only route.
    expect(ans.statusCode).toBe(403);
    expect(ans.json()).toEqual({ error: 'admin_only', message: 'Only an admin can do this.' });
    const ops = await f.inject({ method: 'POST', url: `/api/projects/${projA}/ops`, payload: { version: 0, ops: [{ op: 'upsert', kind: 'stakeholder', key: 'SH-*', title: 'x' }] } });
    expect(ops.json()).toEqual({ error: 'admin_only', message: 'Only an admin can do this.' });
    await f.close();
  });

});

describe('generated passwords (§1.4)', () => {
  it('create returns a generated password once; only its hash is stored and it signs in', async () => {
    const username = `gen${++n}`;
    const c = await call(admin, 'POST', '/users', { username, role: 'member' });
    expect(c.status).toBe(200);
    expect(Object.keys(c.body).sort()).toEqual(['password', 'user']);
    const pw = c.body.password as string;
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
    expect(pw.toLowerCase()).not.toContain(username.toLowerCase());
    expect(c.body.user).toMatchObject({ username, password_set: true, role: 'member' });
    expect(JSON.stringify(app.db.prepare('SELECT * FROM admin_users WHERE id=?').get(c.body.user.id))).not.toContain(pw);
    // It is never shown again: not in the user view, the list or the audit.
    expect(JSON.stringify((await call(admin, 'GET', `/users/${c.body.user.id}`)).body)).not.toContain(pw);
    expect(JSON.stringify((await call(admin, 'GET', '/users')).body)).not.toContain(pw);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all())).not.toContain(pw);
    const l = await login(username, pw);
    expect(l.status).toBe(200);
    expect(l.body).toMatchObject({ setup_needed: false, role: 'member', totp_required: false });
    // Two users never get the same password.
    expect((await call(admin, 'POST', '/users', { username: `gen${++n}` })).body.password).not.toBe(pw);
  });
  it('a user who must use 2FA signs in with it and enrols in their own view first', async () => {
    const c = await call(admin, 'POST', '/users', { username: `ext${++n}`, external: true, org: 'Partner Lab' });
    expect(c.body.user).toMatchObject({ external: true, totp_required: true, totp_enrolled: false, org: 'Partner Lab' });
    const l = await login(c.body.user.username, c.body.password);
    expect(l.body).toMatchObject({ setup_needed: true, totp_required: true, totp_enrolled: false });
    const m = l.who!;
    expect((await call(m, 'POST', '/me/password', { current: c.body.password, new: PW })).body.error).toBe('totp_required');
    const en = await call(m, 'POST', '/totp/enroll', {});
    expect(en.body.otpauth_uri).toContain('otpauth://totp/');
    const at = Date.now();
    expect((await call(m, 'POST', '/totp/confirm', { code: totp(en.body.secret, at) })).status).toBe(200);
    expect((await call(m, 'GET', '/me')).body.setup_needed).toBe(false);
    // The enrolment code is spent: sign in with the next one.
    expect((await login(c.body.user.username, c.body.password, totp(en.body.secret, at))).body.error).toBe('mfa_failed');
    expect((await login(c.body.user.username, c.body.password, totp(en.body.secret, at, 1))).body).toMatchObject({ setup_needed: false, role: 'member' });
  });
  it('reset-password gives a new password once, ends every session, and the old one stops working', async () => {
    const c = await call(admin, 'POST', '/users', { username: `reset${++n}` });
    const old = c.body.password as string;
    const s1 = (await login(c.body.user.username, old)).who!, s2 = (await login(c.body.user.username, old)).who!;
    expect((await call(s1, 'GET', '/me')).status).toBe(200);
    const r = await call(admin, 'POST', `/users/${c.body.user.id}/reset-password`, {});
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['password']);
    expect(r.body.password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
    expect(r.body.password).not.toBe(old);
    expect((await call(s1, 'GET', '/me')).status).toBe(401);
    expect((await call(s2, 'GET', '/me')).status).toBe(401);
    expect((await login(c.body.user.username, old)).status).toBe(401);
    expect((await login(c.body.user.username, r.body.password)).status).toBe(200);
    expect(app.db.prepare("SELECT actor_role FROM audit_events WHERE action='user.password_reset' AND target_id=?").get(c.body.user.id)).toEqual({ actor_role: 'admin' });
    expect(JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all())).not.toContain(r.body.password);
    // A disabled user gets no new password; an unknown one is 404.
    await call(admin, 'POST', `/users/${c.body.user.id}/disable`, {});
    expect((await call(admin, 'POST', `/users/${c.body.user.id}/reset-password`, {})).body.error).toBe('invalid_state');
    expect((await call(admin, 'POST', '/users/nope/reset-password', {})).status).toBe(404);
  });
  it('the setup-link routes are gone', async () => {
    expect(ROUTE_SCOPES['GET /api/setup/:token']).toBeUndefined();
    expect(ROUTE_SCOPES['POST /api/users/:id/setup-link']).toBeUndefined();
    expect((await call(null, 'GET', '/setup/anything')).status).toBe(404);
    expect((await call(admin, 'POST', `/users/${(await user()).id}/setup-link`, {})).status).toBe(404);
  });
  it('admin-only: members cannot create users or reset passwords', async () => {
    const u = await user();
    const m = (await login(u.username, PW)).who!;
    expect((await call(m, 'POST', '/users', { username: 'sneaky' })).status).toBe(403);
    expect((await call(m, 'POST', `/users/${u.id}/reset-password`, {})).status).toBe(403);
  });
});

describe('own password (POST /api/me/password)', () => {
  it('changes the password, keeps this session and ends the others; audited', async () => {
    const c = await call(admin, 'POST', '/users', { username: `own${++n}` });
    const u = { id: c.body.user.id as string, username: c.body.user.username as string, pw: c.body.password as string };
    const keep = (await login(u.username, u.pw)).who!, other = (await login(u.username, u.pw)).who!;
    const r = await call(keep, 'POST', '/me/password', { current: u.pw, new: PW });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect((await call(keep, 'GET', '/me')).status).toBe(200);
    expect((await call(other, 'GET', '/me')).status).toBe(401);
    expect((await login(u.username, u.pw)).status).toBe(401);
    expect((await login(u.username, PW)).status).toBe(200);
    expect(app.db.prepare("SELECT actor_id, actor_role FROM audit_events WHERE action='user.password_changed' AND target_id=?").get(u.id)).toEqual({ actor_id: u.id, actor_role: 'member' });
  });
  it('refuses a wrong current password, a short one and one that holds the username', async () => {
    const c = await call(admin, 'POST', '/users', { username: `Rules${++n}` });
    const pw = c.body.password as string, name = c.body.user.username as string;
    const m = (await login(name, pw)).who!;
    const wrong = await call(m, 'POST', '/me/password', { current: 'not the password', new: PW });
    expect([wrong.status, wrong.body.error]).toEqual([400, 'invalid_credentials']);
    const short = await call(m, 'POST', '/me/password', { current: pw, new: 'elevenchars' });
    expect([short.status, short.body.error]).toEqual([400, 'invalid_argument']);
    const named = await call(m, 'POST', '/me/password', { current: pw, new: `my ${name.toLowerCase()} password` });
    expect([named.status, named.body.error, named.body.message]).toEqual([400, 'invalid_argument', 'The password must not contain the username.']);
    // Nothing changed.
    expect((await login(name, pw)).status).toBe(200);
    // The admin changes their own the same way (and back, for the rest of the suite).
    expect((await call(admin, 'POST', '/me/password', { current: 'correct horse battery', new: 'a different operator phrase' })).status).toBe(200);
    expect((await call(admin, 'POST', '/me/password', { current: 'a different operator phrase', new: 'correct horse battery' })).status).toBe(200);
  });
  it('a wrong current password is audited like a failed sign-in; past the limit it answers 429, audited too', async () => {
    const c = await call(admin, 'POST', '/users', { username: `limit${++n}` });
    const id = c.body.user.id as string, name = c.body.user.username as string, pw = c.body.password as string;
    const m = (await login(name, pw)).who!;
    const events = (outcome: string) => (app.db.prepare('SELECT COUNT(*) n FROM authentication_events WHERE subject_kind=? AND admin_id=? AND outcome=?').get('admin', id, outcome) as { n: number }).n;
    for (let i = 0; i < 10; i++) expect((await call(m, 'POST', '/me/password', { current: `wrong ${i}`, new: PW })).body.error).toBe('invalid_credentials');
    expect(events('invalid')).toBe(10);
    const blocked = await call(m, 'POST', '/me/password', { current: pw, new: PW });
    expect([blocked.status, blocked.body.error]).toEqual([429, 'rate_limited']);
    expect(events('rate_limited')).toBe(1);
    // From a signed-in session, so also an audit event with the reason and never the submitted value.
    const fails = app.db.prepare("SELECT actor_id, details FROM audit_events WHERE action='user.password_change_failed' AND target_id=?").all(id) as { actor_id: string; details: string }[];
    expect(fails).toHaveLength(11);
    expect(fails.filter((f) => f.details.includes('rate_limited'))).toHaveLength(1);
    expect(fails.every((f) => f.actor_id === id && !f.details.includes('wrong ') && !f.details.includes(pw))).toBe(true);
    expect((await login(name, pw)).status).toBe(429);
    app.db.prepare("DELETE FROM usage_counters WHERE metric='admin_login_fail_ip'").run(); // the per-address count is shared by the suite
  });
  it('a successful change clears the sign-in failure count for that username', async () => {
    const c = await call(admin, 'POST', '/users', { username: `clear${++n}` });
    const name = c.body.user.username as string, pw = c.body.password as string;
    const m = (await login(name, pw)).who!;
    app.db.prepare("DELETE FROM usage_counters WHERE metric='admin_login_fail_ip'").run();
    for (let i = 0; i < 9; i++) expect((await login(name, `wrong ${i}`)).status).toBe(401);
    const count = () => (app.db.prepare("SELECT COALESCE(SUM(count),0) n FROM usage_counters WHERE scope=? AND metric='admin_login_fail'").get(name) as { n: number }).n;
    expect(count()).toBe(9);
    expect((await call(m, 'POST', '/me/password', { current: pw, new: PW })).status).toBe(200);
    expect(count()).toBe(0);
    app.db.prepare("DELETE FROM usage_counters WHERE metric='admin_login_fail_ip'").run(); // the per-address count is not this test's
    // Two more wrong guesses would have blocked the old count; now they do not.
    for (let i = 0; i < 2; i++) expect((await login(name, `wrong again ${i}`)).status).toBe(401);
    expect((await login(name, PW)).status).toBe(200);
    app.db.prepare("DELETE FROM usage_counters WHERE metric='admin_login_fail_ip'").run();
  });
  it('records when the password was set: on create, reset and own change; /api/me says whether it is locked', async () => {
    const t0 = Date.now();
    const c = await call(admin, 'POST', '/users', { username: `dated${++n}` });
    const id = c.body.user.id as string;
    expect(c.body.user.password_changed_at).toBeGreaterThanOrEqual(t0);
    app.db.prepare('UPDATE admin_users SET password_changed_at=1 WHERE id=?').run(id);
    const r = await call(admin, 'POST', `/users/${id}/reset-password`, {});
    expect(r.status).toBe(200);
    expect((await call(admin, 'GET', `/users/${id}`)).body.user.password_changed_at).toBeGreaterThanOrEqual(t0);
    app.db.prepare('UPDATE admin_users SET password_changed_at=1 WHERE id=?').run(id);
    const m = (await login(c.body.user.username, r.body.password)).who!;
    expect((await call(m, 'POST', '/me/password', { current: r.body.password, new: PW })).status).toBe(200);
    const me = (await call(m, 'GET', '/me')).body;
    expect(me.password_changed_at).toBeGreaterThanOrEqual(t0);
    expect(me.password_locked).toBe(false);
    expect((await call(admin, 'GET', '/me')).body.password_locked).toBe(false);
  });
  it('on a demo hub the operator cannot change the password from .env; other users can', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahmu1demo-'));
    mkdirSync(join(dir, 'vault'), { recursive: true });
    const demo = await buildApp(testConfig(dir, { demoMode: true }));
    try {
      await demo.fastify.listen({ port: 0, host: '127.0.0.1' });
      const b = `http://127.0.0.1:${(demo.fastify.server.address() as { port: number }).port}`;
      const signIn = async (username: string, password: string): Promise<Who> => {
        const r = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const j = (await r.json()) as any;
        return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: j.csrf as string };
      };
      const post = async (who: Who, path: string, body: unknown) => {
        const r = await fetch(`${b}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: JSON.stringify(body) });
        return { status: r.status, body: (await r.json()) as any };
      };
      const op = await signIn('admin', 'correct horse battery');
      const refused = await post(op, '/me/password', { current: 'correct horse battery', new: 'a different operator phrase' });
      expect(refused).toEqual({ status: 409, body: { error: 'invalid_state', message: "On a demo hub the operator's password comes from .env; Replay signs in with it." } });
      const get = async (who: Who, path: string) => (await (await fetch(`${b}/api${path}`, { headers: { cookie: who.cookie } })).json()) as any;
      expect((await get(op, '/me')).password_locked).toBe(true);
      const c = await post(op, '/users', { username: 'colleague' });
      const m = await signIn('colleague', c.body.password);
      expect((await post(m, '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
      expect((await get(m, '/me')).password_locked).toBe(false);
    } finally { await demo.close(); }
  });
});

describe('grants (§1.2)', () => {
  it('blueprint is always on; dependencies, folders within the vault roots and restricted folders are checked', async () => {
    const u = await user();
    const put = (grants: unknown[]) => call(admin, 'PUT', `/users/${u.id}/grants`, { grants });
    const ok = await put([{ project_id: projA, components: ['tasks', 'feed'] }]);
    expect(ok.status).toBe(200);
    expect(ok.body.user.grants).toEqual([expect.objectContaining({ project_id: projA, project_key: 'CNV', components: ['blueprint', 'tasks', 'feed'], vault_folders: [], may_export: false })]);
    expect((await put([{ project_id: projA, components: ['everything'] }])).body.message).toMatch(/Unknown component everything/);
    expect((await put([{ project_id: projA, components: ['graph'] }])).body.message).toMatch(/graph component needs vault/);
    expect((await put([{ project_id: projA, components: ['topology'] }])).body.message).toMatch(/topology component needs tasks/);
    expect((await put([{ project_id: projA, components: ['vault'] }])).body.message).toMatch(/at least one folder/);
    expect((await put([{ project_id: projA, components: [], vault_folders: ['/Projects/Conclave/'] }])).body.message).toMatch(/need the vault component/);
    expect((await put([{ project_id: projA, components: ['vault'], vault_folders: ['/Projects/Echo/'] }])).body.message).toMatch(/outside the project's vault roots \(\/Projects\/Conclave\/\)/);
    expect((await put([{ project_id: projA, components: ['vault'], vault_folders: ['/Projects/Conclave/../Echo'] }])).status).toBe(400);
    expect((await put([{ project_id: projA }, { project_id: projA }])).body.message).toMatch(/listed twice/);
    expect((await put([{ project_id: 'prj_nope' }])).status).toBe(404);
    // A restricted folder inside the grant stays hidden unless named; the answer says so.
    app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Projects/Conclave/Restricted/', Date.now());
    const v = await put([{ project_id: projA, components: ['vault', 'graph'], vault_folders: ['Projects/Conclave'], may_export: true }, { project_id: projB }]);
    expect(v.body.user.grants.map((g: any) => [g.project_key, g.vault_folders, g.may_export])).toEqual([['BRZ', [], false], ['CNV', ['/Projects/Conclave/'], true]]);
    expect(v.body.notes).toEqual(['/Projects/Conclave/Restricted/ is restricted and stays hidden inside /Projects/Conclave/']);
    // The member sees its grants in /api/me.
    const m = (await login(u.username, PW)).who!;
    expect((await call(m, 'GET', '/me')).body.grants.map((g: any) => g.project_key)).toEqual(['BRZ', 'CNV']);
    // vault_roots set on the project replace the default.
    app.db.prepare('UPDATE projects SET vault_roots=? WHERE id=?').run(JSON.stringify(['/Labs/BRZ']), projB);
    expect((await put([{ project_id: projB, components: ['vault'], vault_folders: ['/Labs/BRZ/data/'] }])).status).toBe(200);
  });
  it('an external user never gets restricted folders', async () => {
    const c = await call(admin, 'POST', '/users', { username: `extg${++n}`, external: true });
    const r = await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: projA, components: ['vault'], vault_folders: ['/Projects/Conclave/Restricted/notes/'] }] });
    expect(r.body.message).toMatch(/restricted folder \/Projects\/Conclave\/Restricted\/; an external user never gets restricted folders/);
    // Turning a member with a restricted folder into an external user is refused too.
    const u = await user();
    expect((await call(admin, 'PUT', `/users/${u.id}/grants`, { grants: [{ project_id: projA, components: ['vault'], vault_folders: ['/Projects/Conclave/Restricted/'] }] })).status).toBe(200);
    expect((await call(admin, 'PATCH', `/users/${u.id}`, { external: true })).body.message).toMatch(/remove \/Projects\/Conclave\/Restricted\/ from the grants first/);
  });
  it('removing a grant removes the user as decider of that project\'s teams (audited); admins take no grants', async () => {
    const u = await user();
    await call(admin, 'PUT', `/users/${u.id}/grants`, { grants: [{ project_id: projA }] });
    const coord = app.keys.createAgent(`coord${++n}`, null, { kind: 'system', id: null });
    app.keys.createSessionKey({ agentId: coord.id, label: 'coord key' }, { kind: 'system', id: null });
    const t = await call(admin, 'POST', '/teams', { name: `dec${n}`, goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }] });
    expect(t.status).toBe(201);
    const teamId = t.body.team.id as string;
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(projA, teamId);
    app.db.prepare('INSERT INTO team_deciders(team_id,user_id,added_at) VALUES (?,?,?)').run(teamId, u.id, Date.now());
    expect((await call(admin, 'GET', `/users/${u.id}`)).body.user.decider_teams).toEqual([teamId]);
    await call(admin, 'PUT', `/users/${u.id}/grants`, { grants: [] });
    expect((await call(admin, 'GET', `/users/${u.id}`)).body.user.decider_teams).toEqual([]);
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='team.deciders_set' AND target_id=?").get(teamId)).toEqual({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='user.grant_set' AND target_id=?").get(u.id)).toEqual({ n: 2 });
    const adminId = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
    expect((await call(admin, 'PUT', `/users/${adminId}/grants`, { grants: [{ project_id: projA }] })).status).toBe(400);
  });
});
