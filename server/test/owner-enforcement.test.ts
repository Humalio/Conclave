/**
 * Owner enforcement (docs/authorization.md#owner-enforcement; next release §2, enforcement contract points 2 to 4): while
 * the setting is on, an agent acts only within its owner's delegated grant, whatever its key allows, and work handed over
 * by another owner's agent is trusted only up to that owner's grant. Every decision reads the grants again, so a change
 * applies to the next operation and to a write that is still committing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const CANARY = 'CANARY-owner-9f3c1e';
let app: App, base = '', admin = { cookie: '', csrf: '' }, adminId = '', appKey = '', project = '', team = '';
type Who = { cookie: string; csrf: string };
const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
type Res = { structuredContent?: any; isError?: boolean; content?: { text?: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const text = (r: Res) => JSON.stringify(r);
/** An agent whose key allows every tool and the whole vault: only an owner ceiling can narrow it. */
function agent(label: string): { id: string; cred: string; secret: string } {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [
    { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' },
    { effect: 'allow', actions: ['fs.*'], resource: 'path:/vault/**' },
    { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }, { effect: 'allow', actions: ['message.send', 'message.receive'], resource: 'agent:*' },
  ], 'test', sys);
  return { id: a.id, cred: k.credential.id, secret: k.secret };
}
let carol = { id: '', who: { cookie: '', csrf: '' } as Who };
/** Carol's access: the project grant delegates the team and Read on Shared; Contribute comes from a folder grant on it (2c). */
const grant = async (mode: 'read' | 'contribute', extra: Record<string, unknown> = {}) => {
  const p = await call(admin, 'PUT', `/users/${carol.id}/grants`, {
    grants: [{ project_id: project, components: ['tasks', 'vault', 'messages', 'blueprint'], vault_folders: ['/Projects/ENF/Shared/'], delegation: { teams: [team], folders: [{ path: '/Projects/ENF/Shared/', mode: 'read' }] }, ...extra }],
  });
  if (p.status !== 200) return p;
  return call(admin, 'PUT', `/users/${carol.id}/folder-grants`, {
    grants: mode === 'contribute' ? [{ path: '/Projects/ENF/Shared/', mode: 'contribute', delegation: { folders: [{ path: '/Projects/ENF/Shared/', mode: 'contribute' }] } }] : [],
  });
};

let reviewerId = '';
let coord: ReturnType<typeof agent>, worker: ReturnType<typeof agent>, C: Call, W: Call;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahownenf-'));
  mkdirSync(join(dir, 'vault', 'Projects', 'ENF', 'Shared'), { recursive: true });
  mkdirSync(join(dir, 'vault', 'Secret'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Projects', 'ENF', 'Shared', 'plan.md'), '# Plan\n');
  writeFileSync(join(dir, 'vault', 'Secret', 'canary.md'), `# ${CANARY}\n`);
  // A restricted folder inside the delegated one: hidden from Carol, so from her agent too.
  mkdirSync(join(dir, 'vault', 'Projects', 'ENF', 'Shared', 'Hush'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Projects', 'ENF', 'Shared', 'Hush', 'hidden.md'), `# ${CANARY}-hush\n`);
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  adminId = (await api('GET', '/me')).body.id;
  const pc = (await api('POST', '/pcs', { name: 'enf-pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
  project = (await api('POST', '/projects', { key: 'ENF', name: 'ENF' })).body.project.id;
  // Carol, a collaborator: Read on the Shared folder only.
  const c = await api('POST', '/users', { username: 'carol', display_name: 'Carol', role: 'member' });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'carol', password: c.body.password }) });
  carol = { id: c.body.user.id, who: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as any).csrf } };
  // Carol's agent coordinates; the operator's agent (the admin's, after the claim) works.
  coord = agent('Carol coord'); worker = agent('Ben worker'); const rev = agent('Reviewer');
  const t = app.teams.create({ name: 'Enf team', goal: 'goal', members: [{ agent_id: coord.id, role: 'coordinator' }, { agent_id: worker.id, role: 'worker' }, { agent_id: rev.id, role: 'reviewer' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  team = t.id; reviewerId = rev.id;
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Projects/ENF/Shared/Hush/', Date.now());
  { const g = await grant('read'); expect(g.status, JSON.stringify(g.body)).toBe(200); }
  C = await loginWith(coord.secret); W = await loginWith(worker.secret);
});
afterAll(async () => { await app.close(); });

describe('owner enforcement', () => {
  it('while it is off, every agent keeps the rules its key has', async () => {
    expect(app.keys.ownerEnforcement()).toBe(false);
    const r = await C('file_read', { path: '/vault/Secret/canary.md' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(CANARY);
  });

  it('once on, the owner\'s grant caps the key: the canary outside it never leaks, and Read refuses writes', async () => {
    expect((await api('POST', '/agent-owners/claim')).status).toBe(200);
    expect((await api('PATCH', `/agents/${coord.id}`, { owner_id: carol.id })).status).toBe(200);
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).body.enforcement).toBe(true);
    // Shared is delegated for Read.
    const ok = await C('file_read', { path: '/vault/Projects/ENF/Shared/plan.md' });
    expect(ok.isError, text(ok)).toBeFalsy();
    // The canary: not readable, not listed, not found, not downloadable, though the key allows the whole vault.
    for (const [tool, args] of [['file_read', { path: '/vault/Secret/canary.md' }], ['file_list', { path: '/vault/Secret/' }], ['file_search', { query: CANARY }], ['file_list', { path: '/vault/' }], ['file_history', { path: '/vault/Secret/canary.md' }]] as const) {
      const r = await C(tool, args);
      expect(text(r), tool).not.toContain(CANARY);
      expect(text(r), tool).not.toContain('canary.md');
    }
    expect((await C('file_read', { path: '/vault/Secret/canary.md' })).isError).toBe(true);
    // A restricted folder inside the delegated folder: not even its name shows, though the admin's agent sees it.
    expect(text(await W('file_list', { path: '/vault/Projects/ENF/Shared/' }))).toContain('Hush');
    for (const [tool, args] of [['file_list', { path: '/vault/Projects/ENF/Shared/' }], ['file_list', { path: '/vault/Projects/ENF/Shared/Hush/' }], ['file_read', { path: '/vault/Projects/ENF/Shared/Hush/hidden.md' }], ['file_search', { query: `${CANARY}-hush` }]] as const) {
      const r = await C(tool, args);
      expect(text(r), tool).not.toContain('Hush');
      expect(text(r), tool).not.toContain('hidden.md');
    }
    // Read refuses writes, in and out of the delegated folder.
    expect((await C('file_create', { path: '/vault/Projects/ENF/Shared/new.md', content: 'x' })).isError).toBe(true);
    expect((await C('file_create', { path: '/vault/Secret/new.md', content: 'x' })).isError).toBe(true);
    // The admin's own agent has no ceiling.
    expect(text(await W('file_read', { path: '/vault/Secret/canary.md' }))).toContain(CANARY);
  });

  it('Contribute allows creating and revising notes in the delegated folder only; destructive and unmapped operations stay refused', async () => {
    expect((await grant('contribute')).status).toBe(200);
    const c = await C('file_create', { path: '/vault/Projects/ENF/Shared/carol.md', content: 'hello' });
    expect(c.isError, text(c)).toBeFalsy();
    expect((await C('file_create', { path: '/vault/Secret/carol.md', content: 'x' })).isError).toBe(true);
    expect((await C('file_delete', { path: '/vault/Projects/ENF/Shared/carol.md', base_revision: c.structuredContent.revision })).isError).toBe(true);
    // Machine use has no mapping: refused.
    const ch = await C('channel_open', { target: `agent:${worker.id}`, size: 3, sha256: 'a'.repeat(64) });
    expect(ch.isError, text(ch)).toBe(true);
  });

  it('a narrowed grant applies to the next call, and to a write that is still committing', async () => {
    // Next call.
    expect((await grant('read')).status).toBe(200);
    expect((await C('file_create', { path: '/vault/Projects/ENF/Shared/next.md', content: 'x' })).isError).toBe(true);
    // At commit: the grant is narrowed after the write was allowed and before it lands.
    expect((await grant('contribute')).status).toBe(200);
    const store = app.store as unknown as { putBlob: (...a: unknown[]) => Promise<unknown> };
    const orig = store.putBlob.bind(app.store);
    let narrowed = false;
    store.putBlob = async (...a: unknown[]) => { if (!narrowed) { narrowed = true; expect((await grant('read')).status).toBe(200); } return orig(...a); };
    try {
      const r = await C('file_create', { path: '/vault/Projects/ENF/Shared/commit.md', content: 'late' });
      expect(narrowed).toBe(true);
      expect(r.isError, text(r)).toBe(true);
    } finally { store.putBlob = orig; }
    const after = await W('file_read', { path: '/vault/Projects/ENF/Shared/commit.md' });
    expect(after.isError).toBe(true);
  });

  it('work handed over by a collaborator\'s agent is capped at her grant: Ben\'s agent cannot write through her task', async () => {
    // Carol has Read on Shared. Her agent asks the operator's agent to write there.
    const cr = await C('task_create', { team_id: team, title: 'Write the plan', description: 'Overwrite Shared/plan.md and read Secret/canary.md', operator_request: { source: 'test' } });
    expect(cr.isError, text(cr)).toBeFalsy();
    const task = app.teams.tasks(team).find((t) => t.title === 'Write the plan')!;
    // The hub records the originating owner and labels the task with her.
    expect((task as { origin_owner_id?: string | null }).origin_owner_id).toBe(carol.id);
    expect(app.teams.originLabel(task)).toBe('Carol');
    { const s = await C('task_assign', { task_id: task.id, agent_id: worker.id, reviewer: reviewerId }); expect(s.isError, text(s)).toBeFalsy(); }
    const listed = await W('task_list', { assignee: 'me' });
    expect(text(listed)).toContain("from Carol's agent");
    // Already while it is only assigned (before task_start), her grant caps the operator's agent.
    const queued = (await W('file_read', { path: '/vault/Projects/ENF/Shared/plan.md' })).structuredContent;
    expect((await W('file_update', { path: '/vault/Projects/ENF/Shared/plan.md', content: 'early', base_revision: queued.revision })).isError).toBe(true);
    expect(text(await W('file_read', { path: '/vault/Secret/canary.md' }))).not.toContain(CANARY);
    expect((await W('task_start', { task_id: task.id })).isError).toBeFalsy();
    // While the operator's agent works on it, it can neither write Shared nor read the canary.
    const plan = (await W('file_read', { path: '/vault/Projects/ENF/Shared/plan.md' })).structuredContent;
    expect(plan).toBeTruthy();
    expect((await W('file_update', { path: '/vault/Projects/ENF/Shared/plan.md', content: 'overwritten', base_revision: plan.revision })).isError).toBe(true);
    const leak = await W('file_read', { path: '/vault/Secret/canary.md' });
    expect(leak.isError).toBe(true);
    expect(text(leak)).not.toContain(CANARY);
    // The inspector shows the ceiling and the task it comes from.
    const eff = await api('GET', `/keys/${worker.cred}/effective`);
    expect(eff.body.owner_ceilings).toEqual([expect.objectContaining({ owner_id: carol.id, owner: 'Carol', basis: 'task', task_id: task.id })]);
    const sim = await api('POST', '/simulate', { credential_id: worker.cred, action: 'fs.update', resource: '/vault/Projects/ENF/Shared/plan.md' });
    expect(sim.body.decision).toMatchObject({ allowed: false, source: 'owner_grant' });
    // Once the work is handed back, the operator's agent has its own rules again.
    { const s = await W('task_submit', { task_id: task.id, summary: 'Could not write it.' }); expect(s.isError, text(s)).toBeFalsy(); }
    expect(text(await W('file_read', { path: '/vault/Secret/canary.md' }))).toContain(CANARY);
    expect((await api('GET', `/keys/${worker.cred}/effective`)).body.owner_ceilings).toEqual([]);
  });

  it('the inspector shows the agent\'s own owner\'s ceiling; an agent without an owner gets none of the vault', async () => {
    const eff = await api('GET', `/keys/${coord.cred}/effective`);
    expect(eff.body.owner_ceilings).toEqual([expect.objectContaining({ owner_id: carol.id, basis: 'owner' })]);
    const loose = agent('No owner');
    app.db.prepare('UPDATE agents SET owner_user_id=NULL WHERE id=?').run(loose.id);
    const L = await loginWith(loose.secret);
    expect((await L('file_read', { path: '/vault/Projects/ENF/Shared/plan.md' })).isError).toBe(true);
  });

  it('disabling the owner stops the agent on its next call; the answer names the agents, and the admin hands them on', async () => {
    expect((await C('file_read', { path: '/vault/Projects/ENF/Shared/plan.md' })).isError).toBeFalsy();
    const d = await api('POST', `/users/${carol.id}/disable`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.owned_agents).toEqual([expect.objectContaining({ id: coord.id, label: 'Carol coord' })]);
    expect((await C('file_read', { path: '/vault/Projects/ENF/Shared/plan.md' })).isError).toBe(true);
    expect((await api('GET', `/agent-owners/${carol.id}/agents`)).body.agents).toEqual([expect.objectContaining({ id: coord.id, archived: false })]);
    // Only an admin hands agents on, and only to an active person.
    expect((await call(carol.who, 'POST', `/agent-owners/${carol.id}/reassign`, { to: adminId })).status).toBeGreaterThanOrEqual(401);
    expect((await api('POST', `/agent-owners/${carol.id}/reassign`, { to: carol.id })).status).toBe(400);
    const h = await api('POST', `/agent-owners/${carol.id}/reassign`, { to: adminId });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(h.body.agents).toBe(1);
    expect(app.keys.agent(coord.id)!.owner_user_id).toBe(adminId);
    expect(text(await C('file_read', { path: '/vault/Secret/canary.md' }))).toContain(CANARY);
    const audit = app.db.prepare("SELECT details FROM audit_events WHERE action='agent.owner_reassign'").all() as { details: string }[];
    expect(audit).toHaveLength(1);
  });
});

describe('Code Reviewer 1\'s notes on agent owners', () => {
  it('a rename and an owner change in one request land together or not at all', async () => {
    const a = app.keys.createAgent('Atomic', null, sys);
    const orig = app.keys.updateAgent.bind(app.keys);
    app.keys.updateAgent = () => { throw new Error('rename failed'); };
    try {
      const r = await api('PATCH', `/agents/${a.id}`, { label: 'Renamed', owner_id: adminId });
      expect(r.status).toBeGreaterThanOrEqual(400);
    } finally { app.keys.updateAgent = orig; }
    expect(app.keys.agent(a.id)).toMatchObject({ label: 'Atomic', owner_user_id: null });
    const ok = await api('PATCH', `/agents/${a.id}`, { label: 'Renamed', owner_id: adminId });
    expect(ok.status).toBe(200);
    expect(app.keys.agent(a.id)).toMatchObject({ label: 'Renamed', owner_user_id: adminId });
  });

  it('only the admin or the hub makes an agent, never a member or an agent', () => {
    expect(() => app.keys.createAgent('By member', null, { kind: 'admin', id: carol.id, role: 'member' } as never)).toThrow(/admin/i);
    expect(() => app.keys.createAgent('By agent', null, { kind: 'agent', id: coord.id } as never)).toThrow(/admin/i);
    expect(app.keys.createAgent('By hub', null, sys).label).toBe('By hub');
  });
});
