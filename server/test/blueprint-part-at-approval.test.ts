/** A team's Blueprint part opens when the operator approves the team (ADR-001, docs/blueprint.md §4).
 * A project's only team gets no part unless the operator says more teams will join (FR-PLAN-12, docs/blueprint.md §3). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', dir = '', adminId = '';
const opr = () => ({ kind: 'operator' as const, id: adminId });
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const tracks = (teamId: string) => app.db.prepare("SELECT key, kind, title, team_id, status, fields, created_by_kind FROM bp_items WHERE team_id=? AND kind IN ('module','line') AND deleted_at IS NULL").all(teamId) as { key: string; kind: string; title: string; team_id: string; status: string | null; fields: string; created_by_kind: string }[];
const agent = (label: string) => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  return { id: a.id, cred: k.credential.id };
};

let seq = 0;
/** A team with one coordinator, created by the hub (no part yet). */
const mkTeam = (name: string) => { const c = agent(`coord-${++seq}`); return app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }] }, sys).id; };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahbpopen-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
});
afterAll(async () => { await app?.close(); });

describe('the part opens at approval', () => {
  it('a team the operator creates owns a module named after it, written by the operator', async () => {
    const c = agent('grant-coord');
    const r = await api('POST', '/teams', { name: 'Grant Desk', goal: 'Keep the grant calendar.', more_teams: true, members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const t = tracks(r.body.team.id);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ key: 'GD', kind: 'module', title: 'Grant Desk', created_by_kind: 'operator' });
  });

  it("the coordinator's first requirements then apply as drafts in its part instead of becoming one proposal", () => {
    const c = agent('ledger-coord');
    const team = app.teams.create({ name: 'Ledger', goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }] }, sys).id;
    app.teams.start(team, sys);
    const P = app.blueprint.ensureTeamProject(team).id;
    // Without a part, a first requirement needs a track, and opening one is the operator's: the plan becomes a proposal.
    const before = app.blueprint.submit(P, { version: app.blueprint.project(P)!.version, ops: [{ op: 'upsert', kind: 'module', key: 'LDG', title: 'Ledger', team_id: team }, { op: 'upsert', kind: 'fr', key: 'FR-LDG-01', parent_key: 'LDG', title: 'Entries balance' }] }, c.id);
    expect(before.status).toBe('proposed');
    if (before.status === 'proposed') app.blueprint.rejectProposal(before.proposal.id, opr(), null);
    const key = app.blueprint.openTeamPart(team, opr(), { moreTeams: true });
    expect(key).toBe('LEDG');
    const after = app.blueprint.submit(P, { version: app.blueprint.project(P)!.version, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-LEDG-01', parent_key: 'LEDG', title: 'Entries balance' }] }, c.id);
    expect(after.status).toBe('applied');
    expect(app.blueprint.item(P, 'FR-LEDG-01')).toMatchObject({ status: 'draft', team_id: team });
  });

  it('opens once: a team that owns a track keeps it, and a second call adds nothing', () => {
    const team = mkTeam('Grant Desk');
    const first = app.blueprint.openTeamPart(team, opr(), { moreTeams: true });
    expect(first).toMatch(/^[A-Z]{2,6}$/);
    expect(app.blueprint.openTeamPart(team, opr(), { moreTeams: true })).toBeNull();
    expect(tracks(team)).toHaveLength(1);
  });

  it('a module key already used in the project, even a deleted one, is not reused', () => {
    const a = mkTeam('Signal Room');
    const P = app.blueprint.ensureTeamProject(a).id;
    expect(app.blueprint.openTeamPart(a, opr(), { moreTeams: true })).toBe('SR');
    app.blueprint.write(P, { version: app.blueprint.project(P)!.version, ops: [{ op: 'remove', key: 'SR' }] }, opr());
    const b = mkTeam('Second Room');
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, b);
    expect(app.blueprint.openTeamPart(b, opr())).toBe('SRAA');
  });

  it('a research project gets a validate line; a closed project gets nothing', () => {
    const r = mkTeam('Echo Study');
    const P = app.blueprint.ensureTeamProject(r).id;
    app.blueprint.updateProject(P, { kind: 'research' }, opr());
    expect(app.blueprint.openTeamPart(r, opr(), { moreTeams: true })).toBe('L1');
    expect(tracks(r)[0]).toMatchObject({ kind: 'line', title: 'Echo Study', status: 'active' });
    expect(JSON.parse(tracks(r)[0]!.fields)).toMatchObject({ mode: 'validate' });
    const z = mkTeam('Old Team');
    const Q = app.blueprint.ensureTeamProject(z).id;
    app.blueprint.updateProject(Q, { status: 'closed' }, opr());
    expect(app.blueprint.openTeamPart(z, opr(), { moreTeams: true })).toBeNull();
    expect(tracks(z)).toHaveLength(0);
  });
});
