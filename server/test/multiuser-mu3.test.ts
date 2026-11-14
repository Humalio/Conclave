/**
 * Decider routing (docs/multi-user.md §1.3, §4 item 6): deciders and the request ceiling, questions, task acts,
 * access requests inside the ceiling, admin fallback and override (`via` in audit), escalation, and Needs you.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Who } from '../src/teams/teams.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, dana: S, eve: S;
const PW = 'routing test password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
// Needs you rows of one source kind, by source id.
const needs = async (s: S, kind: string): Promise<string[]> => (await call(s, 'GET', '/needs-you')).body.items.filter((i: any) => i.source.kind === kind).map((i: any) => i.source.id);
const login = (username: string): Promise<S> => adminLogin(base, username, username === 'admin' ? ADMIN_PASSWORD : PW);
type A = { id: string; cred: string };
const mk = (label: string): A => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, cred: k.credential.id };
};
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
const lastAudit = (action: string, target: string) => {
  const r = app.db.prepare('SELECT * FROM audit_events WHERE action=? AND target_id=? ORDER BY id DESC LIMIT 1').get(action, target) as { details: string; actor_role: string } | undefined;
  return r ? { ...JSON.parse(r.details ?? '{}'), actor_role: r.actor_role } : null;
};

let cnv = '', brz = '', one = '', two = '', other = '', coord: A, coord2: A, worker: A, brzCoord: A, danaId = '', eveId = '';
const team = async (project: string, name: string, members: A[]) => {
  const t = app.teams.create({ name, goal: `${name} goal`, members: members.map((m, i) => ({ agent_id: m.id, role: i ? 'worker' : 'coordinator' })) }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  return t.id;
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahroute-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin');
  cnv = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  brz = (await call(admin, 'POST', '/projects', { key: 'BRZ', name: 'Biraz' })).body.project.id;
  coord = mk('cnv-coord'); worker = mk('cnv-worker'); brzCoord = mk('brz-coord');
  one = await team(cnv, 'CNV One', [coord, worker]);
  coord2 = mk('cnv2-coord');
  two = await team(cnv, 'CNV Two', [coord2]);
  other = await team(brz, 'BRZ One', [brzCoord]);
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Projects/Conclave/Restricted/', Date.now());
  const mkUser = async (username: string) => {
    const c = await call(admin, 'POST', '/users', { username });
    // Sign in once with the password the hub generated, then choose the test's own.
    const first = await adminLogin(base, username, c.body.password);
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: cnv, components: ['tasks'] }] })).status).toBe(200);
    return c.body.user.id as string;
  };
  danaId = await mkUser('dana'); eveId = await mkUser('eve');
  dana = await login('dana'); eve = await login('eve');
});
afterAll(async () => { await app?.close(); });

describe('deciders and the ceiling (admin)', () => {
  it('PUT /teams/:id/deciders checks users and the ceiling, and audits before and after', async () => {
    const adminId = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
    expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [adminId] })).status).toBe(400);
    expect((await call(admin, 'PUT', `/teams/${other}/deciders`, { user_ids: [danaId] })).body.message).toMatch(/no grant/);
    expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId], ceiling: { folders: ['/Projects/Conclave/Restricted/'] } })).body.message).toMatch(/restricted/);
    expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId], ceiling: { folders: ['/Projects/Biraz/'] } })).body.message).toMatch(/outside the project/);
    expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId], ceiling: { actions: ['keys.rotate'] } })).status).toBe(400);
    expect((await call(dana, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId] })).status).toBe(403);
    const r = await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deciders: [danaId], active_deciders: [danaId], ceiling_is_default: true, ceiling: { max_s: 7 * 86400, folders: null } });
    expect(lastAudit('team.deciders_set', one)).toMatchObject({ before: { deciders: [] }, after: { deciders: [danaId] } });
    expect((await call(dana, 'GET', '/me')).body.deciding_now).toEqual([one]);
  });
});

describe('questions', () => {
  it('go to the team\'s deciders; a decider answers (via decider), others cannot, out-of-grant reads like unknown', async () => {
    const q1 = app.decisions.ask(who(coord), { team_id: one, question: 'Ship it?' }).id;
    expect(lastAudit('decision.routed', q1)).toMatchObject({ team: one, to: [danaId] });
    // Needs you lists it for Dana, not for Eve.
    expect((await needs(dana, 'decision'))).toContain(q1);
    expect((await call(eve, 'GET', '/needs-you')).body).toMatchObject({ items: [], total: 0 });
    expect((await call(eve, 'POST', `/decisions/${q1}/answer`, { text: 'no' })).status).toBe(403);
    const a = await call(dana, 'POST', `/decisions/${q1}/answer`, { text: 'Yes, ship it.' });
    expect(a.status).toBe(200);
    expect(lastAudit('decision.answer', q1)).toMatchObject({ via: 'decider', via_team: one, actor_role: 'member' });
    // A question of a team she does not decide for (but can see): 403. Another project's: like an unknown id.
    const q2 = app.decisions.ask(who(coord2), { team_id: two, question: 'Other team?' }).id;
    expect((await call(dana, 'POST', `/decisions/${q2}/answer`, { text: 'x' })).body.error).toBe('not_decider');
    const q3 = app.decisions.ask(who(brzCoord), { team_id: other, question: 'Biraz?' }).id;
    const hidden = await call(dana, 'POST', `/decisions/${q3}/answer`, { text: 'x' }), unknown = await call(dana, 'POST', '/decisions/dec_nope/answer', { text: 'x' });
    expect([hidden.status, hidden.text]).toEqual([unknown.status, unknown.text]);
    expect((await call(dana, 'GET', `/decisions/${q3}`)).status).toBe(404);
    // No deciders on team Two: no routing record, and the admin acts as before (no via).
    expect(lastAudit('decision.routed', q2)).toBeNull();
    await call(admin, 'POST', `/decisions/${q2}/answer`, { text: 'ok' });
    expect(lastAudit('decision.answer', q2)).not.toHaveProperty('via');
  });

  it('the member question page: its data comes from GET /decisions/:id, one Choose answers, and a question outside the grant is refused', async () => {
    // The page draws the operator's layout from the decision alone: question, context in full, options with the
    // recommended one, team, asker and age (server/public/app.js decHead, decForm, decBind).
    const opts = [{ key: 'a', label: 'Rerun', effect: 'Costs a day.' }, { key: 'b', label: 'Park' }];
    const q = app.decisions.ask(who(coord), { team_id: one, question: 'Rerun or park?', context: 'The run stopped at step 4.\n\nThe log is attached.', options: opts, recommended: 'b' }).id;
    const page = await call(dana, 'GET', `/decisions/${q}`);
    expect(page.status).toBe(200);
    expect(page.body.decision).toMatchObject({ id: q, status: 'open', question: 'Rerun or park?', context: 'The run stopped at step 4.\n\nThe log is attached.', options: opts, recommended: 'b', team_id: one, team_name: 'CNV One', agent_label: 'cnv-coord' });
    expect(typeof page.body.decision.created_at).toBe('number');
    // One click on Choose A sends the option with no note, the same request as the operator's page.
    const a = await call(dana, 'POST', `/decisions/${q}/answer`, { option: 'a', text: null });
    expect(a.status).toBe(200);
    expect((await call(dana, 'GET', `/decisions/${q}`)).body.decision).toMatchObject({ status: 'answered', answer_option: 'a', answer_text: null });
    expect(lastAudit('decision.answer', q)).toMatchObject({ via: 'decider', actor_role: 'member' });
    // Answered once: a second click does not change it.
    expect((await call(dana, 'POST', `/decisions/${q}/answer`, { option: 'b', text: null })).status).toBeGreaterThanOrEqual(400);
    expect((await call(dana, 'GET', `/decisions/${q}`)).body.decision.answer_option).toBe('a');
    // An option the question does not offer is refused.
    const q2 = app.decisions.ask(who(coord), { team_id: one, question: 'Which?', options: opts }).id;
    expect((await call(dana, 'POST', `/decisions/${q2}/answer`, { option: 'z', text: null })).status).toBe(400);
    // Outside the grant: another project's question reads like an unknown one, for the page and for Choose.
    const out = app.decisions.ask(who(brzCoord), { team_id: other, question: 'Biraz option?', options: opts, recommended: 'a' }).id;
    const [seen, nope] = [await call(dana, 'GET', `/decisions/${out}`), await call(dana, 'GET', '/decisions/dec_nope')];
    expect([seen.status, seen.text]).toEqual([nope.status, nope.text]);
    const [hid, unk] = [await call(dana, 'POST', `/decisions/${out}/answer`, { option: 'a', text: null }), await call(dana, 'POST', '/decisions/dec_nope/answer', { option: 'a', text: null })];
    expect([hid.status, hid.text]).toEqual([unk.status, unk.text]);
    expect(app.decisions.get(out).status).toBe('open');
    // A member who sees the project but does not decide for the team is refused too.
    expect((await call(eve, 'POST', `/decisions/${q2}/answer`, { option: 'a', text: null })).status).toBe(403);
  });

  it('the admin overrides an active decider, and falls back when none can act', async () => {
    const q = app.decisions.ask(who(coord), { team_id: one, question: 'Override?' }).id;
    await call(admin, 'POST', `/decisions/${q}/answer`, { text: 'admin says' });
    expect(lastAudit('decision.answer', q)).toMatchObject({ via: 'admin_override', via_team: one, actor_role: 'admin' });
    // Dana disabled: no active decider; the question routes to the admin, whose answer is a fallback.
    await call(admin, 'POST', `/users/${danaId}/disable`, {});
    const f = app.decisions.ask(who(coord), { team_id: one, question: 'Fallback?' }).id;
    expect(lastAudit('decision.routed', f)).toMatchObject({ to: 'admin', reason: 'no_active_decider' });
    expect((await needs(admin, 'decision'))).toContain(f);
    await call(admin, 'POST', `/decisions/${f}/answer`, { text: 'fallback' });
    expect(lastAudit('decision.answer', f)).toMatchObject({ via: 'admin_fallback' });
    await call(admin, 'POST', `/users/${danaId}/enable`, {});
    dana = await login('dana');
  });

  it('escalates once to the admin after needed_by or 24 h with no answer', async () => {
    const q = app.decisions.ask(who(coord), { team_id: one, question: 'Slow?' }).id;
    app.db.prepare('UPDATE decisions SET created_at=? WHERE id=?').run(Date.now() - 25 * 3600_000, q);
    const quick = app.decisions.ask(who(coord), { team_id: one, question: 'Due soon?', needed_by: Date.now() + 1000 }).id;
    expect(app.routing.escalate()).toBe(1);
    expect(app.routing.escalate(Date.now() + 2000)).toBe(1);
    expect(app.routing.escalate(Date.now() + 2000)).toBe(0);
    expect(lastAudit('decision.escalated', q)).toMatchObject({ team: one, reason: 'no_answer_24h' });
    expect(lastAudit('decision.escalated', quick)).toMatchObject({ reason: 'needed_by' });
    const mine = (await needs(admin, 'decision'));
    expect(mine).toEqual(expect.arrayContaining([q, quick]));
    // Escalation does not take the item from the decider.
    expect((await needs(dana, 'decision'))).toEqual(expect.arrayContaining([q, quick]));
  });
});

describe('task acts', () => {
  it('a decider requests status and a plan, and switches review only under per_task', async () => {
    const st = await call(dana, 'POST', `/teams/${one}/status-request`, { note: 'where are we?' });
    expect(st.status).toBe(200);
    expect(st.body.team).not.toHaveProperty('members.0.credential_id');
    expect(JSON.stringify(st.body)).not.toMatch(/cred_|policy_id/);
    expect((await call(dana, 'POST', `/teams/${one}/plan-request`, {})).status).toBe(200);
    expect((await call(eve, 'POST', `/teams/${one}/status-request`, {})).body.error).toBe('not_decider');
    expect((await call(dana, 'POST', `/teams/${other}/status-request`, {})).status).toBe(404);
    const task = app.teams.create_task(who(coord), { team_id: one, title: 'Write it', description: 'd' });
    const review = { review: 'none', reason: 'small change' };
    expect((await call(dana, 'POST', `/teams/${one}/tasks/${task.id}/review`, review)).body.error).toBe('not_decider');
    app.db.prepare("UPDATE projects SET review_policy='per_task' WHERE id=?").run(cnv);
    expect((await call(dana, 'POST', `/teams/${one}/tasks/${task.id}/review`, review)).status).toBe(200);
    expect(lastAudit('task.review_change', task.id)).toMatchObject({ via: 'decider', via_team: one });
    // Approve reaches the task as a decider (the task is not ready, so the task rule answers).
    expect((await call(dana, 'POST', `/teams/${one}/tasks/${task.id}/approve`, {})).status).not.toBe(403);
  });
});

describe('access requests and the ceiling (D1)', () => {
  it('route to the team, inside the ceiling for the decider, everything else to the admin', async () => {
    const ask = (actions: string[], resource: string, duration?: string, task_ref?: string) => app.access.request({ id: worker.cred }, worker.id, { actions, resource, reason: 'need it', duration, task_ref });
    const ok = ask(['fs.update'], 'path:/vault/Projects/Conclave/notes/**', '2h');
    expect(ok.team_id).toBe(one);
    const del = ask(['fs.delete'], 'path:/vault/Projects/Conclave/notes/**');
    const restricted = ask(['fs.read'], 'path:/vault/Projects/Conclave/**');
    const outside = ask(['fs.read'], 'path:/vault/Projects/Biraz/**');
    const list = (await call(dana, 'GET', '/requests')).body.requests.map((r: any) => r.id);
    expect(list).toEqual([ok.id]);
    expect((await needs(dana, 'access_request'))).toEqual([ok.id]);
    const adminNeeds = (await needs(admin, 'access_request'));
    expect(adminNeeds).toEqual(expect.arrayContaining([del.id, restricted.id, outside.id]));
    expect(adminNeeds).not.toContain(ok.id);
    // Beyond the ceiling reads like an unknown request for the decider.
    const beyond = await call(dana, 'POST', `/requests/${del.id}/approve`, {}), unknown = await call(dana, 'POST', '/requests/req_nope/approve', {});
    expect([beyond.status, beyond.text]).toEqual([unknown.status, unknown.text]);
    // A longer grant than the ceiling allows is refused at decision time.
    await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId], ceiling: { max_hours: 24 } });
    expect((await call(dana, 'POST', `/requests/${ok.id}/approve`, { duration: '2d' })).body.error).toBe('not_decider');
    const ap = await call(dana, 'POST', `/requests/${ok.id}/approve`, { duration: '3h' });
    expect(ap.status).toBe(200);
    expect(lastAudit('access.approve', ok.id)).toMatchObject({ via: 'decider', via_team: one, seconds: 3 * 3600 });
    expect((await call(eve, 'POST', `/requests/${del.id}/deny`, {})).status).toBe(404);
    await call(admin, 'POST', `/requests/${del.id}/deny`, {});
    expect(lastAudit('access.deny', del.id)).not.toHaveProperty('via');
  });

  it('an agent in several teams goes to the admin, whatever its task_ref', async () => {
    const both = mk('both');
    const bc = mk('b-coord');
    await team(cnv, 'CNV A', [mk('a-coord'), both]);
    const tB = await team(cnv, 'CNV B', [bc, both]);
    const task = app.teams.create_task(who(bc), { team_id: tB, title: 't', description: 'd' });
    expect(app.access.request({ id: both.cred }, both.id, { actions: ['fs.read'], resource: 'path:/vault/Projects/Conclave/x/**', reason: 'r' }).team_id).toBeNull();
    // The agent does not pick whose deciders and ceiling apply.
    expect(app.access.request({ id: both.cred }, both.id, { actions: ['fs.read'], resource: 'path:/vault/Projects/Conclave/y/**', reason: 'r', task_ref: task.id }).team_id).toBeNull();
  });
});
