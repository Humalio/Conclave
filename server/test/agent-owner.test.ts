/**
 * Agent owners (docs/authorization.md#agent-owners; next release, slice 2b-1): every issuance path keeps a verified owner,
 * the admin claims the agents that had none in one audited step, and owner enforcement stays off until that claim, so
 * agents keep today's rules.
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
let app: App, base = '', admin = { cookie: '', csrf: '' }, adminId = '', appKey = '', pcId = '';
type Who = { cookie: string; csrf: string };
const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
const ob = async (path: string, key: string, body: unknown, from = '10.7.0.1') => {
  const r = await fetch(`${base}/onboard${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-forwarded-for': from, 'x-forwarded-proto': 'https' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ structuredContent?: any; isError?: boolean }>;
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const owner = (agentId: string) => app.keys.agent(agentId)!.owner_user_id ?? null;
const audits = (action: string) => app.db.prepare('SELECT actor_kind, actor_id, actor_role, target_id, details FROM audit_events WHERE action=? ORDER BY id').all(action) as { actor_kind: string; actor_id: string; actor_role: string | null; target_id: string; details: string }[];
let n = 0;
/** A console member signed in with its own password (the generated one is fine for these calls). */
async function member(): Promise<{ id: string; who: Who }> {
  const c = await api('POST', '/users', { username: `owner${++n}`, display_name: `Owner ${n}`, role: 'member' });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `owner${n}`, password: c.body.password }) });
  const b = (await r.json()) as any;
  return { id: c.body.user.id, who: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: b.csrf } };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahown-'));
  mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Notes', 'a.md'), '# A\n');
  const client = join(dir, 'client');
  mkdirSync(client);
  for (const f of ['agent-hub-headers.mjs', 'setup.mjs']) writeFileSync(join(client, f), 'export const x = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} setup {{SETUP_SHA256}} helper {{HELPER_SHA256}} code {{ENROL_CODE}} pc {{PC_NAME}}\n');
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  adminId = (await api('GET', '/me')).body.id;
  pcId = (await api('POST', '/pcs', { name: 'owner-pc' })).body.pc.id;
  const ak = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 500 }, sys);
  appKey = ak.secret;
  app.keys.setOnboarding(ak.credential.id, true, sys); // recruits' keys are picked up on this PC
});
afterAll(async () => { await app.close(); });

describe('claim all existing agents as mine, and the enforcement setting', () => {
  // First: the agents a hub has before owners exist are unowned, and nothing has been claimed.
  it('existing agents keep today\'s rules while unowned and after the claim; only the admin claims, once audited', async () => {
    const old = app.keys.createAgent('Old worker', null, sys);
    const k = app.keys.createSessionKey({ agentId: old.id, label: 'old key' }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Notes/**' }], 'test', sys);
    const archived = app.keys.createAgent('Archived one', null, sys);
    app.db.prepare("UPDATE agents SET status='archived' WHERE id=?").run(archived.id);
    const before = await api('GET', '/agent-owners');
    expect(before.body).toMatchObject({ claim: null, enforcement: false });
    expect(before.body.unowned).toBeGreaterThanOrEqual(2);
    // Owner enforcement cannot go on before the claim.
    expect(await api('PUT', '/agent-owners/enforcement', { on: true })).toMatchObject({ status: 409, body: { error: 'invalid_state' } });
    expect(app.keys.ownerEnforcement()).toBe(false);
    const C = await loginWith(k.secret);
    const read = async () => (await C('file_read', { path: '/vault/Notes/a.md' })).structuredContent;
    const secret = async () => (await C('file_read', { path: '/vault/Other/b.md' })).structuredContent;
    const was = [await read(), await secret()];
    expect(was[0].content).toBe('# A\n');
    expect(was[1].error).toBeDefined();

    // A member cannot claim or switch enforcement, and no agent tool reaches either.
    const m = await member();
    expect(await call(m.who, 'POST', '/agent-owners/claim')).toMatchObject({ status: 403, body: { error: 'admin_only' } });
    expect((await call(m.who, 'PUT', '/agent-owners/enforcement', { on: false })).status).toBe(403);
    expect(() => app.keys.claimUnowned({ kind: 'admin', id: m.id, role: 'member' })).toThrow(/Only an admin/);
    expect(() => app.keys.claimUnowned({ kind: 'agent', id: old.id })).toThrow(/Only an admin/);
    const tools = await new Client({ name: 't', version: '1' });
    await tools.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
    expect((await tools.listTools()).tools.map((t) => t.name).filter((x) => /owner|claim_all|agent_claim/.test(x))).toEqual([]);
    expect(owner(old.id)).toBeNull();

    // The admin claims: every unowned agent, archived ones too; an agent that already has an owner keeps it.
    const kept = app.keys.createAgent('Member agent', null, { kind: 'admin', id: adminId }, m.id);
    const unowned = before.body.unowned as number;
    const r = await api('POST', '/agent-owners/claim');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ claimed: unowned, unowned: 0, enforcement: false, claim: { by: adminId, agents: unowned, by_label: expect.any(String) } });
    expect([owner(old.id), owner(archived.id), owner(kept.id)]).toEqual([adminId, adminId, m.id]);
    const a = audits('agent.owner_claim');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_kind: 'admin', actor_id: adminId });
    expect(JSON.parse(a[0]!.details)).toMatchObject({ agents: unowned });

    // With enforcement off, the agent's calls answer exactly as before the claim.
    expect([await read(), await secret()]).toEqual(was);
    expect(app.keys.ownerEnforcement()).toBe(false);

    // After the claim the admin may switch enforcement on and off, each change audited.
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).body).toMatchObject({ enforcement: true });
    expect((await api('PUT', '/agent-owners/enforcement', { on: false })).body).toMatchObject({ enforcement: false });
    expect(audits('agent_owner.enforcement').map((e) => JSON.parse(e.details))).toEqual([{ from: false, to: true }, { from: true, to: false }]);
    // Run again later, it claims only what is unowned since.
    const late = app.keys.createAgent('Late', null, sys);
    expect((await api('POST', '/agent-owners/claim')).body).toMatchObject({ claimed: 1, unowned: 0 });
    expect(owner(late.id)).toBe(adminId);
    expect(owner(kept.id)).toBe(m.id);
  });
});

describe('every issuance path keeps a verified owner', () => {
  it('manual issuance: the admin names the owner; an unknown or disabled user is refused; omitted, the agent is unowned', async () => {
    const m = await member();
    const a = await api('POST', '/agents', { label: 'By hand', owner_id: m.id });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(owner(a.body.agent.id)).toBe(m.id);
    const k = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'With key', owner_id: adminId }, label: 'with key' });
    expect(k.status, JSON.stringify(k.body)).toBe(200);
    expect(owner(k.body.key.agent_id)).toBe(adminId);
    expect(owner((await api('POST', '/agents', { label: 'Nobody' })).body.agent.id)).toBeNull();
    expect((await api('POST', '/agents', { label: 'Ghost', owner_id: 'adm_nobody' })).body.error).toBe('invalid_argument');
    const gone = await member();
    await api('POST', `/users/${gone.id}/disable`);
    expect((await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'Gone', owner_id: gone.id }, label: 'gone' })).body.error).toBe('invalid_state');
    expect(app.keys.agents().some((x) => x.label === 'Gone')).toBe(false);
    // Changing the owner: the admin only, audited; null clears it.
    expect((await call(m.who, 'PATCH', `/agents/${a.body.agent.id}`, { owner_id: m.id })).status).toBe(403);
    expect((await api('PATCH', `/agents/${a.body.agent.id}`, { owner_id: adminId })).body.agent.owner_user_id).toBe(adminId);
    expect((await api('PATCH', `/agents/${a.body.agent.id}`, { owner_id: null, label: 'By hand 2' })).body.agent).toMatchObject({ owner_user_id: null, label: 'By hand 2' });
    expect(audits('agent.owner').filter((e) => e.target_id === a.body.agent.id).map((e) => JSON.parse(e.details))).toEqual([{ from: m.id, to: adminId }, { from: adminId, to: null }]);
    // The agent page shows the owner.
    expect((await api('GET', `/sessions/${k.body.key.agent_id}`)).body.owner).toMatchObject({ id: adminId, status: 'active' });
  });

  it('key rotation and a checkout successor key keep the agent and its owner', async () => {
    const m = await member();
    const agent = app.keys.createAgent('Rotating', null, sys, m.id);
    const k = app.keys.createSessionKey({ agentId: agent.id, label: 'r' }, sys);
    const rot = app.keys.rotate(k.credential.id, sys);
    expect(rot.credential.agent_id).toBe(agent.id);
    const next = app.keys.issueSuccessor(rot.credential.id, pcId, sys);
    expect(next.credential.agent_id).toBe(agent.id);
    expect(owner(agent.id)).toBe(m.id);
  });

  it('recruitment: a recruit gets its recruiting coordinator\'s owner, in auto and in propose mode', async () => {
    const m = await member();
    const coord = app.keys.createAgent('Recruiter', null, sys, m.id);
    const ck = app.keys.createSessionKey({ agentId: coord.id, label: 'c' }, sys);
    app.keys.setRules(ck.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Notes/**' }], 'test', sys);
    const t = await api('POST', '/teams', { name: 'owners team', goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }] });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const tid = t.body.team.id as string;
    await api('POST', `/teams/${tid}/start`);
    await api('PATCH', `/teams/${tid}`, { recruiting: 'auto', recruit_max: 3 });
    const C = await loginWith(ck.secret);
    const r = (await C('team_recruit', { team_id: tid, label: 'Recruit A', role: 'worker', purpose: 'helps' })).structuredContent;
    expect(r.status, JSON.stringify(r)).toBe('created');
    expect(owner(r.agent_id)).toBe(m.id);
    await api('PATCH', `/teams/${tid}`, { recruiting: 'propose' });
    const q = (await C('team_recruit', { team_id: tid, label: 'Recruit B', role: 'worker', purpose: 'helps too' })).structuredContent;
    expect(q.status).toBe('pending');
    // A recruit keeps its coordinator's owner even when that person was disabled meanwhile (enforcement decides later).
    await api('POST', `/users/${m.id}/disable`);
    const ap = await api('POST', `/recruits/${q.request_id}/approve`);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const b = app.keys.agents().find((x) => x.label === 'Recruit B')!;
    expect(owner(b.id)).toBe(m.id);
  });

  it('onboarding: the approval names the owner of every agent it creates; a reissued pickup keeps it', async () => {
    const enrol = async (name: string, ip: string) => {
      const add = await api('POST', '/pcs/add', { name });
      expect(add.status).toBe(200);
      const nonce = `${name}-nonce-0123456789`, h = { 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-forwarded-proto': 'https' };
      const e = await fetch(`${base}/onboard/enrol`, { method: 'POST', headers: h, body: JSON.stringify({ code: add.body.code, nonce }) }).then((x) => x.json()) as any;
      await fetch(`${base}/onboard/enrol/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ nonce }) });
      return e.app_key as string;
    };
    const key = await enrol('owner-onb-pc', '10.7.0.2');
    const request = (name: string) => ({ kind: 'new_team', project: { name, existing: false }, team: { name: `${name} team`, goal: 'Keep notes.' },
      roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'writer', team_role: 'worker', count: 1, job: 'Writes.' }],
      prompt: 'a small notes team', client: { app: 'claude-code', os: 'windows' } });
    const m = await member();
    const f = await ob('/requests', key, request('Owned'));
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    // An owner that is not an active console user is refused before anything is made.
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, owner_id: 'adm_nobody' })).body.error).toBe('invalid_argument');
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, owner_id: m.id });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const ids = a.body.slots.map((s: { agent_id: string }) => s.agent_id) as string[];
    expect(ids).toHaveLength(2);
    expect(ids.map(owner)).toEqual([m.id, m.id]);
    expect(JSON.parse(audits('onboarding.approve').at(-1)!.details).owner).toBe(m.id);
    const p1 = await ob('/pickup', key, { request_id: f.body.request_id });
    expect(p1.status, JSON.stringify(p1.body)).toBe(200);
    expect((await api('POST', `/onboarding/${f.body.request_id}/reissue-pickup`)).status).toBeLessThan(500);
    const p2 = await ob('/pickup', key, { request_id: f.body.request_id });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    for (const s of p2.body.agents) expect(owner(app.keys.verifyKey(s.secret, 'session_key').agent_id!)).toBe(m.id);
    // Without owner_id the agents are unowned: the hub never guesses one.
    const g = await ob('/requests', await enrol('unowned-onb-pc', '10.7.0.3'), request('Unowned'));
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const u = await api('POST', `/onboarding/${g.body.request_id}/approve`, { version: g.body.version });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.slots.map((s: { agent_id: string }) => owner(s.agent_id))).toEqual([null, null]);
  });
});
