/**
 * Three owner gaps closed before owner enforcement goes live (docs/authorization.md#owner-enforcement): a notice about
 * a task reaches only agents whose owner may do team work in its team; another owner's agent that edits a task's text
 * becomes its origin, with the old one kept in the history; and an owner whose account expires by date has their
 * agents told at the hub's next regular check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', admin = { cookie: '', csrf: '' }, appKey = '', project = '', team = '', other = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Res = { structuredContent?: any; isError?: boolean };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
function agent(label: string): { id: string; secret: string } {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, secret: k.secret };
}
const member = async (username: string, display_name: string) => (await api('POST', '/users', { username, display_name, role: 'member' })).body.user.id as string;
/** A grant on the project with the tasks component; `teams` are the teams delegated to the person's agents. */
const grant = (userId: string, teams: string[]) => api('PUT', `/users/${userId}/grants`, { grants: [{ project_id: project, components: ['tasks', 'messages'], delegation: { teams } }] });
const notices = (agentId: string, taskId: string) => (app.db.prepare("SELECT kind FROM agent_notices WHERE agent_id=? AND ref_kind='task' AND ref_id=?").all(agentId, taskId) as { kind: string }[]).map((n) => n.kind);
const permNotices = (agentId: string) => (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='permissions_changed' AND body LIKE 'Your owner %'").all(agentId) as { body: string }[]).map((n) => n.body);

let carol = '', dave = '', erin = '';
let coordC: ReturnType<typeof agent>, coordD: ReturnType<typeof agent>, workD: ReturnType<typeof agent>, workB: ReturnType<typeof agent>, workE: ReturnType<typeof agent>;
let CC: Call, CD: Call;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahowngaps-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const pc = (await api('POST', '/pcs', { name: 'gaps-pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
  project = (await api('POST', '/projects', { key: 'GAP', name: 'GAP' })).body.project.id;
  carol = await member('carol', 'Carol'); dave = await member('dave', 'Dave'); erin = await member('erin', 'Erin');
  coordC = agent('Carol coord'); coordD = agent('Dave coord'); workD = agent('Dave worker'); workB = agent('Bruno worker'); workE = agent('Erin worker');
  const t = app.teams.create({ name: 'Mixed team', goal: 'goal', members: [{ agent_id: coordC.id, role: 'coordinator' }, { agent_id: coordD.id, role: 'coordinator' },
    { agent_id: workD.id, role: 'worker' }, { agent_id: workB.id, role: 'worker' }, { agent_id: workE.id, role: 'worker' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  team = t.id;
  // Another team of the project, so a delegation can name a team that is not this one.
  const o = app.teams.create({ name: 'Other team', goal: 'goal', members: [{ agent_id: agent('Other coord').id, role: 'coordinator' }] }, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, o.id);
  other = o.id;
  // Carol and Erin have team work in the mixed team; Dave's grant delegates only the other team.
  for (const [u, ts] of [[carol, [team]], [dave, [other]], [erin, [team]]] as const) { const g = await grant(u, [...ts]); expect(g.status, JSON.stringify(g.body)).toBe(200); }
  expect((await api('POST', '/agent-owners/claim')).status).toBe(200);
  for (const [a, u] of [[coordC, carol], [coordD, dave], [workD, dave], [workE, erin]] as const) expect((await api('PATCH', `/agents/${a.id}`, { owner_id: u })).status).toBe(200);
  CC = await loginWith(coordC.secret); CD = await loginWith(coordD.secret);
});
afterAll(async () => { await app.close(); });

describe('owner gaps', () => {
  it('with enforcement off, a notice about a task reaches every agent it is for', async () => {
    expect(app.keys.ownerEnforcement()).toBe(false);
    const r = await CC('task_create', { team_id: team, title: 'Open for anyone', claimable: true, operator_request: { source: 'test' } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const id = app.teams.tasks(team).find((k) => k.title === 'Open for anyone')!.id;
    for (const a of [workD, workB, workE]) expect(notices(a.id, id), a.id).toEqual(['task_open']);
  });

  it('with enforcement on, a notice about one owner\'s work skips the agents of an owner who has no team work there', async () => {
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).body.enforcement).toBe(true);
    // Carol's agent opens a task in the mixed team; Dave's grant delegates another team only.
    const r = await CC('task_create', { team_id: team, title: 'Carol\'s work', claimable: true, operator_request: { source: 'test' } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const id = app.teams.tasks(team).find((k) => k.title === 'Carol\'s work')!.id;
    expect(notices(workD.id, id)).toEqual([]);
    // Erin has team work there, and the admin's agent has no ceiling: both hear it.
    expect(notices(workE.id, id)).toEqual(['task_open']);
    expect(notices(workB.id, id)).toEqual(['task_open']);
    // A notice about the agent itself still reaches Dave's agent.
    app.keys.notify(workD.id, 'role_changed', 'Your role is now "worker".');
    expect((app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='role_changed'").get(workD.id) as { n: number }).n).toBe(1);
    // Once Dave delegates the mixed team, his agents hear about its tasks again.
    expect((await grant(dave, [team, other])).status).toBe(200);
    const s = await CC('task_create', { team_id: team, title: 'After delegation', claimable: true, operator_request: { source: 'test' } });
    expect(s.isError, JSON.stringify(s)).toBeFalsy();
    expect(notices(workD.id, app.teams.tasks(team).find((k) => k.title === 'After delegation')!.id)).toEqual(['task_open']);
  });

  it('another owner\'s agent that edits a task\'s text becomes its origin owner, and the history keeps the old one', async () => {
    const r = await CC('task_create', { team_id: team, title: 'Draft', description: 'Carol wrote this', operator_request: { source: 'test' } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const t0 = app.teams.tasks(team).find((k) => k.title === 'Draft')!;
    expect(t0.origin_owner_id).toBe(carol);
    // Dave's agent rewrites the text: the origin moves to Dave.
    const e = await CD('task_update', { task_id: t0.id, version: t0.version, description: 'Dave rewrote this' });
    expect(e.isError, JSON.stringify(e)).toBeFalsy();
    const t1 = app.teams.task(t0.id)!;
    expect(t1.origin_owner_id).toBe(dave);
    expect(app.teams.originLabel(t1)).toBe('Dave');
    const hist = (app.db.prepare("SELECT note FROM task_events WHERE task_id=? AND tool='task_update'").all(t0.id) as { note: string }[]).map((x) => x.note);
    expect(hist).toContain('origin owner Dave, was Carol');
    const aud = app.db.prepare("SELECT details FROM audit_events WHERE action='task.origin_owner' AND target_id=? ORDER BY id").all(t0.id) as { details: string }[];
    expect(JSON.parse(aud.at(-1)!.details)).toMatchObject({ owner: dave, from: carol });
    // An edit by the origin owner's own agent, or one that leaves the text as it is, changes nothing.
    const same = await CD('task_update', { task_id: t0.id, version: t1.version, description: 'Dave again' });
    expect(same.isError, JSON.stringify(same)).toBeFalsy();
    const t2 = app.teams.task(t0.id)!;
    const back = await CC('task_update', { task_id: t0.id, version: t2.version, description: 'Dave again' });
    expect(back.isError, JSON.stringify(back)).toBeFalsy();
    expect(app.teams.task(t0.id)!.origin_owner_id).toBe(dave);
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='task.origin_owner' AND target_id=?").get(t0.id) as { n: number }).n).toBe(2);
  });

  it('an owner whose account expires by date has their agents told at the next regular check, once', async () => {
    const soon = Date.now() + 60_000;
    expect((await api('PATCH', `/users/${erin}`, { expires_at: soon })).status).toBe(200);
    expect(permNotices(workE.id)).toEqual([]);
    // The hub's regular check (app.ts upkeep) runs after the date has passed.
    expect(app.users.sweepExpired(soon + 1)).toBe(1);
    const told = permNotices(workE.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("Your owner Erin's console account expired");
    expect(told[0]).toContain('access_list');
    // Other owners' agents are not told, and a second check tells nobody again.
    expect(permNotices(workD.id)).toEqual([]);
    expect(app.users.sweepExpired(soon + 60_000)).toBe(0);
    expect(permNotices(workE.id)).toHaveLength(1);
  });

  it('an expired owner whose expiry is lifted, or moved later, has their agents told they work within the grant again', async () => {
    const back = (id: string) => permNotices(id).filter((b) => b.includes('is active again'));
    // Erin's account is expired now (her date is in the past).
    app.db.prepare('UPDATE admin_users SET expires_at=? WHERE id=?').run(Date.now() - 1000, erin);
    expect((await api('PATCH', `/users/${erin}`, { expires_at: null })).status).toBe(200);
    expect(back(workE.id)).toHaveLength(1);
    expect(back(workE.id)[0]).toContain("you work within Erin's grant again");
    // Moved later from an expired date: told again. Moved from one future date to another: no change, nobody told.
    app.db.prepare('UPDATE admin_users SET expires_at=? WHERE id=?').run(Date.now() - 1000, erin);
    expect((await api('PATCH', `/users/${erin}`, { expires_at: Date.now() + 86_400_000 })).status).toBe(200);
    expect(back(workE.id)).toHaveLength(2);
    expect((await api('PATCH', `/users/${erin}`, { expires_at: Date.now() + 2 * 86_400_000 })).status).toBe(200);
    expect(back(workE.id)).toHaveLength(2);
    expect(back(workD.id)).toEqual([]);
  });

  it('a notice about a task with no team is delivered as with enforcement off', () => {
    expect(app.keys.ownerEnforcement()).toBe(true);
    const loose = agent('No owner');
    app.db.prepare('UPDATE agents SET owner_user_id=NULL WHERE id=?').run(loose.id);
    const now = Date.now();
    // A task needs a team or a room: a room task (the older kind) is the one without a team.
    const room = (app.db.prepare('SELECT id FROM rooms LIMIT 1').get() as { id: string }).id;
    app.db.prepare("INSERT INTO tasks(id,room_id,team_id,title,status,claimable,created_at,updated_at) VALUES ('task_noteam',?,NULL,'No team','open',0,?,?)").run(room, now, now);
    app.keys.notify(loose.id, 'task_open', 'A task with no team.', { task: 'task_noteam', state: 'open' });
    expect(notices(loose.id, 'task_noteam')).toEqual(['task_open']);
    // The same unowned agent hears nothing about a team's task: its owner (none) has no team work there.
    const teamTask = app.teams.tasks(team)[0]!;
    app.keys.notify(loose.id, 'task_open', 'A team task.', { task: teamTask.id, state: teamTask.status });
    expect(notices(loose.id, teamTask.id)).toEqual([]);
  });

  it('disabling an owner tells their agents the same way, and so does enabling them again; with enforcement off nobody is told', async () => {
    expect((await api('POST', `/users/${dave}/disable`)).status).toBe(200);
    for (const a of [workD, coordD]) expect(permNotices(a.id)[0]).toContain("Your owner Dave's console account was disabled");
    const enabled = (id: string) => permNotices(id).filter((b) => b.includes('was enabled again'));
    expect((await api('POST', `/users/${dave}/enable`)).status).toBe(200);
    for (const a of [workD, coordD]) expect(enabled(a.id)[0]).toContain("you work within Dave's grant again");
    // A disabled account that has also expired stays unusable when enabled: nobody is told until its expiry is lifted.
    expect((await api('POST', `/users/${dave}/disable`)).status).toBe(200);
    app.db.prepare('UPDATE admin_users SET expires_at=? WHERE id=?').run(Date.now() - 1000, dave);
    expect((await api('POST', `/users/${dave}/enable`)).status).toBe(200);
    expect(enabled(workD.id)).toHaveLength(1);
    expect((await api('PATCH', `/users/${dave}`, { expires_at: null })).status).toBe(200);
    expect(permNotices(workD.id).filter((b) => b.includes('is active again'))).toHaveLength(1);
    expect((await api('PUT', '/agent-owners/enforcement', { on: false })).body.enforcement).toBe(false);
    expect((await api('POST', `/users/${carol}/disable`)).status).toBe(200);
    expect(permNotices(coordC.id)).toEqual([]);
  });
});
