/**
 * Blueprint scoping (docs/multi-user.md §1.3, §2): proposals routed to the deciders of the one team that owns what
 * they touch, the operator acts a decider takes in their team's part, report requests for one part, `via` in audit,
 * the admin's fallback and override, and `export.md` with `may_export`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, dana: S, eve: S;
const PW = 'blueprint routing password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const login = (username: string): Promise<S> => adminLogin(base, username, username === 'admin' ? ADMIN_PASSWORD : PW);
const mk = (label: string) => {
  const a = app.keys.createAgent(label, null, sys);
  app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  return a.id;
};
const lastAudit = (action: string, target: string) => {
  const r = app.db.prepare('SELECT * FROM audit_events WHERE action=? AND target_id=? ORDER BY id DESC LIMIT 1').get(action, target) as { details: string; actor_id: string } | undefined;
  return r ? { ...JSON.parse(r.details ?? '{}'), actor_id: r.actor_id } : null;
};

let cnv = '', brz = '', one = '', two = '', other = '', coord = '', coord2 = '', danaId = '', eveId = '';
const team = (project: string, name: string, coordinator: string) => {
  const t = app.teams.create({ name, goal: `${name} goal`, members: [{ agent_id: coordinator, role: 'coordinator' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  return t.id;
};
const ver = (p = cnv) => app.blueprint.project(p)!.version;
const item = (key: string, p = cnv) => app.blueprint.item(p, key)!;
/** A coordinator's batch that needs the operator: it becomes an open proposal. */
const propose = (ops: Op[], agent = coord, teamId = one, p = cnv) => {
  const r = app.blueprint.submit(p, { version: ver(p), ops, reason: 'test', team_id: teamId }, agent);
  if (r.status !== 'proposed') throw new Error('expected a proposal');
  return r.proposal.id;
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbproute-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin');
  cnv = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  brz = (await call(admin, 'POST', '/projects', { key: 'BRZ', name: 'Echo' })).body.project.id;
  coord = mk('cnv-coord'); coord2 = mk('cnv2-coord');
  one = team(cnv, 'CNV One', coord); two = team(cnv, 'CNV Two', coord2); other = team(brz, 'BRZ One', mk('brz-coord'));
  const w = await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [
    { op: 'upsert', kind: 'module', key: 'ONE', title: 'Team one module', team_id: one },
    { op: 'upsert', kind: 'fr', key: 'FR-ONE-01', parent_key: 'ONE', title: 'First requirement' },
    { op: 'upsert', kind: 'fr', key: 'FR-ONE-02', parent_key: 'ONE', title: 'Second requirement' },
    { op: 'upsert', kind: 'module', key: 'TWO', title: 'Team two module', team_id: two },
    { op: 'upsert', kind: 'fr', key: 'FR-TWO-01', parent_key: 'TWO', title: 'Their requirement' },
    { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'Use SQLite', team_id: one },
    { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'The paper', team_id: one, status: 'drafting' },
    { op: 'upsert', kind: 'term', key: 'G-lead-time', title: 'Lead time' },
    { op: 'upsert', kind: 'module', key: 'SPARE', title: 'An empty track', team_id: one },
  ] });
  expect(w.status).toBe(200);
  expect((await call(admin, 'POST', `/projects/${brz}/ops`, { version: ver(brz), ops: [{ op: 'upsert', kind: 'module', key: 'BRZ', title: 'Echo module', team_id: other }] })).status).toBe(200);
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
  expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId] })).status).toBe(200);
});
afterAll(async () => { await app?.close(); });

describe('proposals', () => {
  it('go to the deciders of the one team that owns what they touch; others go to the admin', async () => {
    const mine = propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-01', status: 'agreed' }]);
    const term = propose([{ op: 'upsert', kind: 'term', key: 'G-lead-time', title: 'Lead time, in days' }]);
    const both = propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'agreed' }, { op: 'upsert', kind: 'fr', key: 'FR-TWO-01', title: 'Their requirement, reworded' }]);
    const owner = propose([{ op: 'upsert', kind: 'paper', key: 'PAP-1', team_id: two }]);
    const track = propose([{ op: 'upsert', kind: 'module', key: 'NEW', title: 'A new track', team_id: one }]);
    const dropTrack = propose([{ op: 'remove', key: 'SPARE' }], coord2, two);
    // Dana's list, Needs you and attention hold only the proposal routed to her team.
    expect((await call(dana, 'GET', `/projects/${cnv}/proposals`)).body.proposals.map((p: any) => p.id)).toEqual([mine]);
    const ny = (await call(dana, 'GET', '/needs-you')).body.items.filter((i: any) => i.source.kind === 'bp_proposal');
    expect(ny.map((p: any) => [p.source.id, p.scope.team_id])).toEqual([[mine, one]]);
    const att = (await call(dana, 'GET', '/blueprint/attention')).body;
    expect([att.items.map((i: any) => i.id), att.counts.proposals]).toEqual([[mine], 1]);
    expect((await call(eve, 'GET', `/projects/${cnv}/proposals`)).body.total).toBe(0);
    // The admin's Needs you holds what no decider may decide.
    expect((await call(admin, 'GET', '/needs-you')).body.items.filter((i: any) => i.source.kind === 'bp_proposal').map((p: any) => p.source.id).sort()).toEqual([term, both, owner, track, dropTrack].sort());
    // Dana cannot decide what is not routed to her: it reads like an unknown proposal.
    for (const id of [term, both, owner, track, dropTrack]) {
      const r = await call(dana, 'POST', `/proposals/${id}/apply`, {});
      expect([r.status, r.body.message]).toEqual([404, 'No such proposal.']);
    }
    const eveTry = await call(eve, 'POST', `/proposals/${mine}/apply`, {});
    expect([eveTry.status, eveTry.body.message]).toEqual([404, 'No such proposal.']);
    // Dana applies hers, recorded via decider.
    const a = await call(dana, 'POST', `/proposals/${mine}/apply`, { note: 'agreed with the client' });
    expect(a.status).toBe(200);
    expect([a.body.proposal.status, a.body.proposal.decided_by, app.blueprint.proposal(mine)!.decided_by]).toEqual(['applied', 'operator', danaId]);
    expect(item('FR-ONE-01').status).toBe('agreed');
    expect(lastAudit('blueprint.proposal_decide', mine)).toMatchObject({ via: 'decider', via_team: one, status: 'applied', actor_id: danaId });
    // The admin decides the rest as before: no via for a team-less proposal.
    expect((await call(admin, 'POST', `/proposals/${term}/reject`, {})).status).toBe(200);
    expect(lastAudit('blueprint.proposal_decide', term)).toBeNull();
    for (const id of [both, owner, track, dropTrack]) expect((await call(admin, 'POST', `/proposals/${id}/reject`, {})).status).toBe(200);
  });

  it('the admin can act on a routed proposal (admin_override), and decides it when no decider can act (admin_fallback)', async () => {
    const p1 = propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'agreed' }]);
    expect((await call(admin, 'POST', `/proposals/${p1}/reject`, { note: 'no' })).status).toBe(200);
    expect(lastAudit('blueprint.proposal_decide', p1)).toMatchObject({ via: 'admin_override', via_team: one, status: 'rejected' });
    expect((await call(admin, 'POST', `/users/${danaId}/disable`)).status).toBe(200);
    const p2 = propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'agreed' }]);
    expect((await call(admin, 'GET', '/needs-you')).body.items.filter((i: any) => i.source.kind === 'bp_proposal').map((p: any) => p.source.id)).toEqual([p2]);
    expect((await call(admin, 'POST', `/proposals/${p2}/reject`, {})).status).toBe(200);
    expect(lastAudit('blueprint.proposal_decide', p2)).toMatchObject({ via: 'admin_fallback', via_team: one });
    expect((await call(admin, 'POST', `/users/${danaId}/enable`)).status).toBe(200);
    dana = await login('dana');
  });
});

describe('operator acts in a team part', () => {
  it('a decider agrees and drops requirements, settles a decision entry and submits a paper in their team only', async () => {
    const ops = (body: unknown, who = dana, p = cnv) => call(who, 'POST', `/projects/${p}/ops`, body);
    // Drop the agreed requirement, agree the draft one.
    const r = await ops({ version: ver(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-ONE-01', status: 'dropped' }, { op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'agreed' }] });
    expect(r.status).toBe(200);
    expect([item('FR-ONE-01').status, item('FR-ONE-02').status]).toEqual(['dropped', 'agreed']);
    expect(lastAudit('blueprint.write', cnv)).toMatchObject({ via: 'decider', via_team: one, actor_id: danaId });
    expect((await ops({ version: ver(), ops: [{ op: 'upsert', kind: 'decision', key: 'ADR-001', status: 'accepted' }] })).status).toBe(200);
    expect((await ops({ version: ver(), ops: [{ op: 'upsert', kind: 'paper', key: 'PAP-1', status: 'submitted' }] })).status).toBe(200);
    expect([item('ADR-001').status, item('PAP-1').status]).toEqual(['accepted', 'submitted']);
    // Anything else is the admin's: text, other moves, project-level items, another team's part.
    const refused = [
      [{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', title: 'Reworded' }],
      [{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'built' }],
      [{ op: 'upsert', kind: 'term', key: 'G-lead-time', title: 'Lead' }],
      [{ op: 'upsert', kind: 'fr', key: 'FR-TWO-01', status: 'agreed' }],
      [{ op: 'remove', key: 'FR-ONE-02' }],
    ];
    for (const o of refused) expect((await ops({ version: ver(), ops: o })).body.error).toBe('not_decider');
    // Not a decider: 403 in a visible project; another project answers like an unknown one.
    expect((await ops({ version: ver(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'dropped' }] }, eve)).body.error).toBe('not_decider');
    const hidden = await ops({ version: ver(brz), ops: [{ op: 'upsert', kind: 'module', key: 'BRZ', title: 'x' }] }, dana, brz);
    const unknown = await ops({ version: 0, ops: [{ op: 'upsert', kind: 'module', key: 'BRZ', title: 'x' }] }, dana, 'prj_nope');
    expect([hidden.status, hidden.text]).toEqual([unknown.status, unknown.text]);
    // The admin's same act in a part with a decider is an override.
    expect((await ops({ version: ver(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'dropped' }] }, admin)).status).toBe(200);
    expect(lastAudit('blueprint.write', cnv)).toMatchObject({ via: 'admin_override', via_team: one });
  });

  it('a decider\'s acts are the rights table\'s operator acts, except on items an open re-plan marks', async () => {
    const ops = (o: Op[]) => call(dana, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: o });
    // Agreeing from dropped, and taking an agreed requirement back to draft, are operator acts.
    expect((await ops([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'agreed' }])).status).toBe(200);
    expect((await ops([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'draft' }])).status).toBe(200);
    expect((await ops([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-01', status: 'agreed' }])).status).toBe(200);
    const rp = (await call(admin, 'POST', `/projects/${cnv}/replan`, { team_id: one, kinds: ['fr'] })).body.replan.id as string;
    expect(item('FR-ONE-01')).toMatchObject({ status: 'draft', replan_id: rp });
    // Agreeing an item the re-plan reset is approving the re-plan: the admin's.
    const r = await ops([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-01', status: 'agreed' }]);
    expect([r.status, r.body.error]).toEqual([403, 'not_decider']);
    expect(item('FR-ONE-01').status).toBe('draft');
    expect((await call(admin, 'POST', `/replans/${rp}/cancel`, {})).status).toBe(200);
    expect(item('FR-ONE-01')).toMatchObject({ status: 'agreed', replan_id: null });
  });

  it('Home attention leaves out a routed proposal in a project granted without the blueprint', async () => {
    const pr = propose([{ op: 'upsert', kind: 'fr', key: 'FR-ONE-02', status: 'agreed' }]);
    expect((await call(dana, 'GET', '/blueprint/attention')).body.items.map((i: any) => i.id)).toContain(pr);
    // A grant stored without the blueprint component (the grants API always adds it).
    app.db.prepare("UPDATE user_project_grants SET components='[\"tasks\"]' WHERE user_id=? AND project_id=?").run(danaId, cnv);
    try {
      const att = await call(dana, 'GET', '/blueprint/attention');
      expect([att.status, att.body.items, att.body.counts.proposals]).toEqual([200, [], 0]);
    } finally {
      app.db.prepare("UPDATE user_project_grants SET components='[\"blueprint\",\"tasks\"]' WHERE user_id=? AND project_id=?").run(danaId, cnv);
    }
    expect((await call(admin, 'POST', `/proposals/${pr}/reject`, {})).status).toBe(200);
  });

  it('report requests: a decider asks their own team; the admin asks one team or all', async () => {
    expect((await call(dana, 'POST', `/projects/${cnv}/report-request`, {})).status).toBe(400);
    expect((await call(dana, 'POST', `/projects/${cnv}/report-request`, { team_id: two })).body.error).toBe('not_decider');
    expect((await call(dana, 'POST', `/projects/${cnv}/report-request`, { team_id: other })).status).toBe(404);
    const r = await call(dana, 'POST', `/projects/${cnv}/report-request`, { team_id: one, note: 'before Friday' });
    expect([r.status, r.body.teams]).toEqual([200, [one]]);
    expect(lastAudit('blueprint.report_request', cnv)).toMatchObject({ via: 'decider', via_team: one, teams: 1 });
    expect((await call(admin, 'POST', `/projects/${cnv}/report-request`, {})).body.teams.sort()).toEqual([one, two].sort());
    expect((await call(admin, 'POST', `/projects/${cnv}/report-request`, { team_id: other })).status).toBe(400);
    // The Team status panel reads the same request rows: a project-wide request shows, then a team's own newer one.
    const st = (await call(admin, 'GET', `/teams/${two}/status`)).body;
    expect([st.request_scope, typeof st.requested_at, st.request_note]).toEqual(['project', 'number', null]);
    expect((await call(admin, 'POST', `/teams/${two}/status-request`, { note: 'how is the coil?' })).status).toBe(200);
    expect((await call(admin, 'GET', `/teams/${two}/status`)).body).toMatchObject({ request_scope: 'team', request_note: 'how is the coil?' });
    const asked = app.db.prepare("SELECT COUNT(*) n FROM bp_report_requests WHERE team_id=? AND answered_at IS NULL").get(two) as { n: number };
    expect(asked.n).toBe(2);
  });
});

describe('reads', () => {
  it('export.md needs may_export; the project list holds granted projects only', async () => {
    expect((await call(dana, 'GET', `/projects/${cnv}/export.md`)).body.error).toBe('export_denied');
    expect((await call(admin, 'PUT', `/users/${eveId}/grants`, { grants: [{ project_id: cnv, components: ['blueprint'], may_export: true }] })).status).toBe(200);
    const x = await call(eve, 'GET', `/projects/${cnv}/export.md`);
    expect([x.status, x.text.includes('First requirement')]).toEqual([200, true]);
    expect((await call(eve, 'GET', '/projects')).body.projects.map((p: any) => p.id)).toEqual([cnv]);
    // A decider's act is written with their user id: other members (and the decider) see plain "operator", never an id.
    const adminId = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
    for (const path of [`/projects/${cnv}/items/FR-ONE-01`, `/projects/${cnv}/items/FR-ONE-01/history`, `/projects/${cnv}/blueprint?detail=full`, `/projects/${cnv}/export.md`]) {
      const t = (await call(eve, 'GET', path)).text;
      expect([path, t.includes(danaId), t.includes(adminId)]).toEqual([path, false, false]);
    }
    expect((await call(eve, 'GET', `/projects/${cnv}/items/FR-ONE-01`)).body.item.updated_by).toBe('operator');
    const listed = (await call(dana, 'GET', `/projects/${cnv}/proposals?status=applied`)).text;
    expect([listed.includes('"decided_by":"operator"'), listed.includes(danaId)]).toEqual([true, false]);
    expect((await call(eve, 'GET', `/projects/${brz}/blueprint`)).status).toBe(404);
    // Admin-only Blueprint routes stay closed to members.
    expect((await call(dana, 'GET', '/settings/blueprint')).status).toBe(403);
    expect((await call(dana, 'POST', `/projects/${cnv}/replan`, {})).status).toBe(403);
  });
});
