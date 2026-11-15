/**
 * Agent delegation in the console (docs/authorization.md#owner-enforcement, next release §2 point 4): the grant editor's
 * preview shows the exact operations a delegation permits before save, from the policy service's own mapping; the access
 * inspector names the owner ceilings, the task and its originating owner, and the ceiling that refused a decision; and a
 * collaborator's Account lists their agents by label with their effective scope, with no PC, key or credential.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';
import { FOLDER_CONTRIBUTE, FOLDER_READ } from '../src/policy/ownerScope.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', admin = { cookie: '', csrf: '' }, appKey = '', project = '', team = '', other = '', otherTeam = '';
type Who = { cookie: string; csrf: string };
const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
type Res = { structuredContent?: any; isError?: boolean };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
function agent(label: string): { id: string; cred: string; secret: string } {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'allow', actions: ['fs.*'], resource: 'path:/vault/**' }], 'test', sys);
  return { id: a.id, cred: k.credential.id, secret: k.secret };
}
let dana = { id: '', who: { cookie: '', csrf: '' } as Who };
let coord: ReturnType<typeof agent>, worker: ReturnType<typeof agent>, reviewer = '';
const SHARED = '/Projects/DLG/Shared/';
const grantBody = (mode: 'read' | 'contribute', teams = [team]) => ({ grants: [{ project_id: project, components: ['tasks', 'vault', 'blueprint'], vault_folders: [SHARED], may_export: false, delegation: { teams, folders: [{ path: SHARED, mode }] } }] });
const folderBody = (mode: 'read' | 'contribute', agents: 'read' | 'contribute') => ({ grants: [{ path: SHARED, mode, delegation: { folders: [{ path: SHARED, mode: agents }] } }] });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahdlg-'));
  mkdirSync(join(dir, 'vault', 'Projects', 'DLG', 'Shared'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Projects', 'DLG', 'Shared', 'plan.md'), '# Plan\n');
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const pc = (await api('POST', '/pcs', { name: 'dlg-pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
  project = (await api('POST', '/projects', { key: 'DLG', name: 'DLG' })).body.project.id;
  other = (await api('POST', '/projects', { key: 'OTH', name: 'OTH' })).body.project.id;
  const c = await api('POST', '/users', { username: 'dana', display_name: 'Dana', role: 'member' });
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'dana', password: c.body.password }) });
  dana = { id: c.body.user.id, who: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as any).csrf } };
  coord = agent('Dana coord'); worker = agent('Ben worker'); const rev = agent('Reviewer'); reviewer = rev.id;
  const t = app.teams.create({ name: 'Dlg team', goal: 'goal', members: [{ agent_id: coord.id, role: 'coordinator' }, { agent_id: worker.id, role: 'worker' }, { agent_id: rev.id, role: 'reviewer' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  team = t.id;
  // A team of another project: never delegable in this grant.
  const o = app.teams.create({ name: 'Other team', goal: 'goal', members: [{ agent_id: rev.id, role: 'coordinator' }] }, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(other, o.id); otherTeam = o.id;
  { const g = await api('PUT', `/users/${dana.id}/grants`, { grants: [{ project_id: project, components: ['tasks', 'vault', 'blueprint'], vault_folders: [SHARED] }] }); expect(g.status, JSON.stringify(g.body)).toBe(200); }
  expect((await api('POST', '/agent-owners/claim')).status).toBe(200);
  expect((await api('PATCH', `/agents/${coord.id}`, { owner_id: dana.id })).status).toBe(200);
});
afterAll(async () => { await app.close(); });

describe('the grant editor preview', () => {
  it('a new grant delegates nothing, and the preview says what each team and folder permits before save, saving nothing', async () => {
    expect(app.users.grants(dana.id)[0]!.delegation).toEqual({});
    const before = JSON.stringify(app.users.grants(dana.id));
    const p = await api('POST', `/users/${dana.id}/grants/preview`, grantBody('read'));
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const v = p.body.grants[0];
    expect(v.teams).toEqual([expect.objectContaining({ id: team, name: 'Dlg team', agents: ['Dana coord'] })]);
    // Tasks and Blueprint are in the grant, Messages and Graph are not: exactly those operations.
    const acts = v.teams[0].operations.flatMap((o: { actions: string[] }) => o.actions);
    expect(acts).toEqual(expect.arrayContaining(['task.*', 'blueprint.write']));
    expect(acts).not.toContain('room.post');
    expect(acts).not.toContain('graph.read');
    // A project grant's folders are Read for its agents: no write.
    expect(v.folders).toEqual([{ path: SHARED, mode: 'read', operations: [expect.objectContaining({ actions: FOLDER_READ })] }]);
    // Never delegated, whatever is ticked.
    expect(p.body.never.flatMap((n: { actions: string[] }) => n.actions)).toEqual(expect.arrayContaining(['fs.delete', 'fs.rename', 'fs.restore', 'channel.use']));
    // Contribute on a project grant is refused, as the save refuses it; nothing was saved.
    expect((await api('POST', `/users/${dana.id}/grants/preview`, grantBody('contribute'))).status).toBe(400);
    expect(JSON.stringify(app.users.grants(dana.id))).toBe(before);
  });

  it('a folder grant previews Contribute only while the grant is Contribute, inside its path', async () => {
    const before = JSON.stringify(app.users.folderGrants(dana.id));
    const c = await api('POST', `/users/${dana.id}/folder-grants/preview`, folderBody('contribute', 'contribute'));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.folder_grants).toEqual([{ path: SHARED, mode: 'contribute', folders: [{ path: SHARED, mode: 'contribute', operations: [expect.objectContaining({ actions: FOLDER_READ }), expect.objectContaining({ actions: FOLDER_CONTRIBUTE })] }] }]);
    expect(c.body.never.length).toBeGreaterThan(0);
    const r = await api('POST', `/users/${dana.id}/folder-grants/preview`, folderBody('read', 'read'));
    expect(r.body.folder_grants[0].folders[0].operations.flatMap((o: { actions: string[] }) => o.actions)).not.toContain('fs.create');
    // A Read grant caps its agents at Read, and an agent folder stays inside the grant's path.
    expect((await api('POST', `/users/${dana.id}/folder-grants/preview`, folderBody('read', 'contribute'))).status).toBe(400);
    expect((await api('POST', `/users/${dana.id}/folder-grants/preview`, { grants: [{ path: SHARED, mode: 'contribute', delegation: { folders: [{ path: '/Projects/DLG/', mode: 'read' }] } }] })).status).toBe(400);
    expect((await call(dana.who, 'POST', `/users/${dana.id}/folder-grants/preview`, folderBody('read', 'read'))).status).toBe(403);
    expect(JSON.stringify(app.users.folderGrants(dana.id))).toBe(before);
  });

  it('refuses what a save refuses, and only the admin may ask', async () => {
    const t = await api('POST', `/users/${dana.id}/grants/preview`, { grants: [{ ...grantBody('read').grants[0], delegation: { teams: [otherTeam] } }] });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_argument');
    const f = await api('POST', `/users/${dana.id}/grants/preview`, { grants: [{ ...grantBody('read').grants[0], delegation: { folders: [{ path: '/Elsewhere/', mode: 'read' }] } }] });
    expect(f.status).toBe(400);
    expect((await call(dana.who, 'POST', `/users/${dana.id}/grants/preview`, grantBody('read'))).status).toBe(403);
  });
});

describe('the access inspector and Account', () => {
  it('shows the owner ceiling, reflects a narrowed grant at once, and names the ceiling that refused', async () => {
    expect((await api('PUT', `/users/${dana.id}/grants`, grantBody('read'))).status).toBe(200);
    expect((await api('PUT', `/users/${dana.id}/folder-grants`, folderBody('contribute', 'contribute'))).status).toBe(200);
    // Off: no ceilings, and Account says it is not enforced yet.
    expect((await api('GET', `/keys/${coord.cred}/effective`)).body.owner_ceilings).toBeNull();
    expect((await call(dana.who, 'GET', '/me')).body.owner_enforcement).toBe(false);
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).body.enforcement).toBe(true);
    const allows = async () => ((await api('GET', `/keys/${coord.cred}/effective`)).body.owner_ceilings[0].allows as { actions: string[] }[]).flatMap((a) => a.actions);
    const eff = await api('GET', `/keys/${coord.cred}/effective`);
    expect(eff.body.owner_ceilings).toEqual([expect.objectContaining({ owner_id: dana.id, owner: 'Dana', basis: 'owner', task: null, via: null })]);
    expect(await allows()).toContain('fs.create');
    const ok = await api('POST', '/simulate', { credential_id: coord.cred, action: 'fs.create', resource: `/vault${SHARED}new.md` });
    expect(ok.body.decision).toMatchObject({ allowed: true });
    // The folder grant narrowed to Read: the inspector shows it on the next read, and the decision names Dana's grant.
    expect((await api('PUT', `/users/${dana.id}/folder-grants`, folderBody('read', 'read'))).status).toBe(200);
    expect(await allows()).not.toContain('fs.create');
    const no = await api('POST', '/simulate', { credential_id: coord.cred, action: 'fs.create', resource: `/vault${SHARED}new.md` });
    expect(no.body.decision).toMatchObject({ allowed: false, source: 'owner_grant', owner: { owner_id: dana.id, owner: 'Dana', basis: 'owner', task: null } });
  });

  it('names the task and its originating owner when another owner\'s agent handed over the work', async () => {
    const C = await loginWith(coord.secret);
    const cr = await C('task_create', { team_id: team, title: 'Revise the plan', description: 'Revise Shared/plan.md', operator_request: { source: 'test' } });
    expect(cr.isError, JSON.stringify(cr)).toBeFalsy();
    const task = app.teams.tasks(team).find((t) => t.title === 'Revise the plan')!;
    expect((await C('task_assign', { task_id: task.id, agent_id: worker.id, reviewer })).isError).toBeFalsy();
    const eff = await api('GET', `/keys/${worker.cred}/effective`);
    expect(eff.body.owner_ceilings).toEqual([expect.objectContaining({ owner: 'Dana', basis: 'task', via: 'origin', task: { id: task.id, title: 'Revise the plan', status: 'assigned', team_id: team, origin_owner: 'Dana' } })]);
    const sim = await api('POST', '/simulate', { credential_id: worker.cred, action: 'fs.update', resource: `/vault${SHARED}plan.md` });
    expect(sim.body.decision).toMatchObject({ allowed: false, source: 'owner_grant', owner: { owner: 'Dana', basis: 'task', via: 'origin', task: { id: task.id, origin_owner: 'Dana' } } });
  });

  it('Account lists their agents by label with their effective scope, and no PC, key or credential', async () => {
    expect((await api('PUT', `/users/${dana.id}/folder-grants`, folderBody('contribute', 'contribute'))).status).toBe(200);
    const me = (await call(dana.who, 'GET', '/me')).body;
    expect(me.owner_enforcement).toBe(true);
    // The project grant's folder is Read; the folder grant's is Contribute, as that grant is.
    // One list (admin/accountView.ts): each delegated team adds what the delegation permits there. The folder is Contribute,
    // as the folder grant is; the project grant alone would make it Read.
    expect(me.agents).toEqual([{ id: coord.id, label: 'Dana coord', teams: [{ id: team, name: 'Dlg team', project_name: 'DLG', operations: expect.any(Array) }], folders: [{ path: SHARED, mode: 'contribute' }] }]);
    expect(me.agents[0].teams[0].operations.flatMap((o: { actions: string[] }) => o.actions)).toEqual(expect.arrayContaining(['task.*', 'blueprint.write']));
    const raw = JSON.stringify(me.agents);
    for (const leak of [coord.cred, coord.secret, 'machine', 'credential', 'pc_']) expect(raw).not.toContain(leak);
  });
});

describe('an external person and a restricted folder', () => {
  it('refuses an agent folder at or inside a restricted folder, in the preview and the save, for project and folder grants alike', async () => {
    const HUSH = '/Projects/DLG/Shared/Hush/';
    app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run(HUSH, Date.now());
    const c = await api('POST', '/users', { username: 'erik', display_name: 'Erik', role: 'member', external: true, org: 'Partner' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const erik = c.body.user.id as string;
    const proj = { grants: [{ project_id: project, components: ['tasks', 'vault', 'blueprint'], vault_folders: [SHARED], delegation: { teams: [], folders: [{ path: HUSH, mode: 'read' }] } }] };
    const fold = { grants: [{ path: SHARED, mode: 'read', delegation: { folders: [{ path: HUSH, mode: 'read' }] } }] };
    for (const [path, body] of [[`/users/${erik}/grants`, proj], [`/users/${erik}/folder-grants`, fold]] as const) {
      const p = await api('POST', `${path}/preview`, body);
      expect(p.status, JSON.stringify(p.body)).toBe(400);
      expect(p.body.message).toContain('restricted folder');
      expect((await api('PUT', path, body)).status).toBe(400);
    }
    // The grant's own folder, outside the restricted one, is still fine for their agents.
    const ok = await api('POST', `/users/${erik}/folder-grants/preview`, { grants: [{ path: SHARED, mode: 'read', delegation: { folders: [{ path: SHARED, mode: 'read' }] } }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // A member who is not external may still delegate it: the rule is for external people only.
    expect((await api('POST', `/users/${dana.id}/folder-grants/preview`, fold)).status).toBe(200);
  });
});

describe('a folder restricted after the delegation was saved', () => {
  const LATER = '/Projects/DLG/Shared/Later/';
  it('the preview lists it as not permitted, with the reason, as enforcement drops it', async () => {
    const body = { grants: [{ path: SHARED, mode: 'contribute', delegation: { folders: [{ path: SHARED, mode: 'contribute' }, { path: LATER, mode: 'contribute' }] } }] };
    expect((await api('PUT', `/users/${dana.id}/folder-grants`, body)).status).toBe(200);
    const before = (await api('POST', `/users/${dana.id}/folder-grants/preview`, body)).body.folder_grants[0].folders;
    expect(before.map((f: { refused?: string }) => f.refused)).toEqual([undefined, undefined]);
    app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run(LATER, Date.now());
    const p = await api('POST', `/users/${dana.id}/folder-grants/preview`, body);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const [shared, later] = p.body.folder_grants[0].folders;
    expect(shared).toMatchObject({ path: SHARED, mode: 'contribute' });
    expect(shared.refused).toBeUndefined();
    expect(later).toMatchObject({ path: LATER, operations: [] });
    expect(later.refused).toMatch(/restricted folder \/Projects\/DLG\/Shared\/Later\/.*unless a grant names it/);
    // Enforcement agrees: the agent may write in the shared folder, and nothing in the restricted one.
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).status).toBe(200);
    expect((await api('POST', '/simulate', { credential_id: coord.cred, action: 'fs.create', resource: `/vault${SHARED}a.md` })).body.decision).toMatchObject({ allowed: true });
    expect((await api('POST', '/simulate', { credential_id: coord.cred, action: 'fs.read', resource: `/vault${LATER}a.md` })).body.decision).toMatchObject({ allowed: false });
    // Granting the restricted folder by name opens it: the preview reads the grants as proposed, not as saved.
    const named = await api('POST', `/users/${dana.id}/folder-grants/preview`, { grants: [...body.grants, { path: LATER, mode: 'read', delegation: { folders: [{ path: LATER, mode: 'read' }] } }] });
    expect(named.body.folder_grants.find((g: { path: string }) => g.path === LATER).folders[0].refused).toBeUndefined();
    expect(named.body.folder_grants.find((g: { path: string }) => g.path === SHARED).folders[1].refused).toBeUndefined();
  });

  it('an external person: a project grant\'s agent folder restricted later is not permitted, and says why', async () => {
    const LATE2 = '/Projects/DLG/Shared/Late2/';
    const c = await api('POST', '/users', { username: 'fern', display_name: 'Fern', role: 'member', external: true, org: 'Partner' });
    const fern = c.body.user.id as string;
    const body = { grants: [{ project_id: project, components: ['tasks', 'vault', 'blueprint'], vault_folders: [SHARED], delegation: { teams: [], folders: [{ path: LATE2, mode: 'read' }] } }] };
    expect((await api('PUT', `/users/${fern}/grants`, body)).status).toBe(200);
    app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run(LATE2, Date.now());
    // The save now refuses it, as for any restricted folder; the preview of what is saved explains it rather than listing it.
    const p = await api('POST', `/users/${fern}/grants/preview`, { grants: [{ ...body.grants[0], delegation: undefined }] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.grants[0].folders).toEqual([{ path: LATE2, mode: 'read', operations: [], refused: expect.stringMatching(/restricted folder .*external person never sees/) }]);
  });
});
