/**
 * A vault agent from onboarding (docs/onboarding.md#a-vault-agent; next release §2, "Two people share a vault folder"):
 * 1. a vault_agent request names one agent, its folders and the user's words, and nothing of a team;
 * 2. the approval needs an owner whose folder grants hold every folder (Contribute for a write, never a restricted
 *    folder), delegates those folders within the grants, and creates no key;
 * 3. pickup issues one bounded key with a teamless playbook; confirm joins no team;
 * 4. the agent revises a shared note with its base revision, loses its owner's grant, and its next edit is denied;
 *    only hub-wide directives reach it, never a project's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error: a plain ES module without types
import { validateRequest } from '../../deploy/client/setup.mjs';

const CANARY = 'CANARY-vaultagent-41d9';
let app: App, base = '', cookie = '', csrf = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': o.from ?? '10.9.0.1' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let ip = 1;
const enrol = async (name: string) => {
  const add = await api('POST', '/pcs/add', { name });
  const n = `n${Math.random().toString(36).slice(2)}`.padEnd(22, 'x'), from = `10.9.3.${ip++}`;
  const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  expect((await ob('POST', '/enrol/confirm', { body: { nonce: n }, from })).status).toBe(200);
  return e.body.app_key as string;
};
type Res = { structuredContent?: any; isError?: boolean };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
async function loginWith(appKey: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const text = (r: unknown) => JSON.stringify(r);
const VAULT_REQ = { kind: 'vault_agent', agent: { name: 'Dana notes', job: 'Keeps the shared plan up to date.' }, folders: [{ path: '/vault/Shared/Team', access: 'write' }], prompt: 'an agent for my shared notes' };
const keyCount = () => (app.db.prepare('SELECT count(*) n FROM credentials').get() as { n: number }).n;
let dana = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahvaultagent-'));
  const v = (...p: string[]) => join(dir, 'vault', ...p);
  mkdirSync(v('Shared', 'Team', 'Hush'), { recursive: true });
  mkdirSync(v('Shared', 'Pub'), { recursive: true });
  mkdirSync(v('Secret'), { recursive: true });
  writeFileSync(v('Shared', 'Team', 'plan.md'), '# Plan\n');
  writeFileSync(v('Shared', 'Team', 'Hush', 'hidden.md'), `# ${CANARY}-hush\n`);
  writeFileSync(v('Secret', 'canary.md'), `# ${CANARY}\n`);
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Shared/Team/Hush/', Date.now());
  const u = await api('POST', '/users', { username: 'dana', role: 'member' });
  dana = u.body.user.id;
  expect((await api('PUT', `/users/${dana}/folder-grants`, { grants: [{ path: '/Shared/Team/', mode: 'contribute' }, { path: '/Shared/Pub/' }] })).status).toBe(200);
});
afterAll(async () => { await app.close(); });

describe('a vault agent request', () => {
  it('names one agent, its folders and the words; nothing of a team, in the hub and in the PC client', () => {
    expect(app.onboarding.validate(VAULT_REQ, null).problems).toEqual([]);
    // Its folders are checked against the owner's grants at approval: no "never granted" warning, fields named as filed.
    expect(app.onboarding.validate(VAULT_REQ, null).warnings.map((w) => w.code)).not.toContain('folder_never_granted');
    for (const w of app.onboarding.validate(VAULT_REQ, null).warnings) expect(w.field.startsWith('folders[')).toBe(true);
    expect(validateRequest(VAULT_REQ)).toEqual([]);
    for (const extra of [{ team: { name: 'x' } }, { roles: [] }, { rules: [] }, { project: { name: 'P', existing: false } }]) {
      expect(app.onboarding.validate({ ...VAULT_REQ, ...extra }, null).problems.map((p) => p.field)).toContain(Object.keys(extra)[0]);
      expect(validateRequest({ ...VAULT_REQ, ...extra }).map((p: { field: string }) => p.field)).toContain(Object.keys(extra)[0]);
    }
    for (const bad of [{ folders: [] }, { folders: [{ path: '/elsewhere/x', access: 'write' }] }, { agent: { name: '', job: 'x' } }]) {
      expect(app.onboarding.validate({ ...VAULT_REQ, ...bad }, null).problems.length).toBeGreaterThan(0);
      expect(validateRequest({ ...VAULT_REQ, ...bad }).length).toBeGreaterThan(0);
    }
  });
});

describe('a vault agent, from request to a denied edit', () => {
  let key = '', id = '', version = 0;
  beforeAll(async () => {
    key = await enrol('dana-pc');
    const f = await ob('POST', '/requests', { key, body: VAULT_REQ });
    expect(f.status, text(f.body)).toBe(200);
    id = f.body.request_id; version = f.body.version;
  });
  const approve = (extra: Record<string, unknown> = {}) => api('POST', `/onboarding/${id}/approve`, { version, ...extra });
  const folders = (fs: { path: string; access: string }[]) => ({ edits: { roles: [{ name: 'vault_agent', team_role: 'worker', count: 1, job: VAULT_REQ.agent.job, folders: fs }] } });

  it('waits in Needs you as a vault agent request from its PC, with no team', async () => {
    const item = (await api('GET', '/needs-you?limit=200')).body.items.find((x: { kind: string; source: { id: string } }) => x.kind === 'onboarding' && x.source.id === id);
    expect(item, 'a Needs you row for the request').toMatchObject({ title: 'Vault agent request from dana-pc', reason: 'One agent for shared folders, no team' });
  });

  it('refuses an approval without a collaborator owner, or with a folder outside, restricted or above the owner\'s grant; nothing is created', async () => {
    const agents = (app.db.prepare('SELECT count(*) n FROM agents').get() as { n: number }).n;
    expect((await approve()).status).toBe(400);
    const adminId = (await api('GET', '/me')).body.id;
    expect((await approve({ owner_id: adminId })).status).toBe(400);
    for (const fs of [[{ path: '/vault/Secret', access: 'read' }], [{ path: '/vault/Shared/Team/Hush', access: 'read' }], [{ path: '/vault/Shared/Pub', access: 'write' }], [{ path: '/vault', access: 'read' }]]) {
      const r = await approve({ owner_id: dana, ...folders(fs) });
      expect(r.status, text(fs)).toBe(400);
    }
    expect((app.db.prepare('SELECT count(*) n FROM agents').get() as { n: number }).n).toBe(agents);
    expect((await api('GET', `/onboarding/${id}`)).body.request.state).toBe('submitted');
  });

  it('approves within the owner\'s grants: delegates the folders, creates the agent and no key', async () => {
    const keys = keyCount();
    const r = await approve({ owner_id: dana });
    expect(r.status, text(r.body)).toBe(200);
    expect(r.body.request.state).toBe('approved');
    expect(keyCount()).toBe(keys);
    const g = (await api('GET', `/users/${dana}/folder-grants`)).body.folder_grants.find((x: any) => x.path === '/Shared/Team/');
    expect(g.delegation.folders).toEqual([{ path: '/Shared/Team/', mode: 'contribute' }]);
    const slot = r.body.slots[0];
    const agent = app.keys.agent(slot.agent_id)!;
    expect(agent.project).toBeNull();
    expect((app.db.prepare('SELECT owner_user_id o FROM agents WHERE id=?').get(agent.id) as { o: string }).o).toBe(dana);
  });

  it('picks up one bounded key with a teamless playbook, joins no team, and is cut off when the owner\'s grant goes', async () => {
    const p = await ob('POST', '/pickup', { key, body: { request_id: id } });
    expect(p.status, text(p.body)).toBe(200);
    expect(p.body.team).toBeNull();
    expect(p.body.agents).toHaveLength(1);
    const a = p.body.agents[0];
    expect(a.instructions).toContain('no `work_next`');
    expect(a.instructions).toContain('base_revision');
    expect(a.instructions).toContain('/vault/Shared/Team/');
    expect(a.instructions).not.toMatch(/## Playbook|Team goal/);
    const c = await ob('POST', '/pickup/confirm', { key, body: { pickup_id: p.body.pickup_id, written: [a.session_var], transport: 'https' } });
    expect(c.status, text(c.body)).toBe(200);
    expect(c.body).toMatchObject({ state: 'collected', team_id: null });
    expect(app.teams.teamsOf(a.agent_id)).toEqual([]);

    // Directives: a hub-wide one reaches it, a project's never does.
    expect((await api('POST', '/directives', { title: 'For every agent', body: 'Hub-wide rule.', scope: { kind: 'hub' } })).status).toBe(200);
    // A project rule names a real project (directive reach resolves it); it still never reaches a teamless vault agent.
    app.blueprint.createProject({ key: 'ATL', name: 'Atlas' }, { kind: 'operator', id: null });
    expect((await api('POST', '/directives', { title: 'Only the Atlas project', body: 'Project rule.', scope: { kind: 'project', ref: 'Atlas' } })).status).toBe(200);

    // Owner enforcement on: the owner's folder grant bounds the agent too.
    expect((await api('POST', '/agent-owners/claim')).status).toBe(200);
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).body.enforcement).toBe(true);
    const A = await loginWith(key, a.secret);
    const d = await A('directives_read', {});
    expect(d.isError, text(d)).toBeFalsy();
    expect(text(d)).toContain('For every agent');
    expect(text(d)).not.toContain('Only the Atlas project');

    const r = await A('file_read', { path: '/vault/Shared/Team/plan.md' });
    expect(r.isError, text(r)).toBeFalsy();
    const u = await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# Plan v2\n', base_revision: r.structuredContent.revision });
    expect(u.isError, text(u)).toBeFalsy();
    // Outside its folders, and in the restricted folder inside them: refused, the canary never shows.
    expect((await A('file_create', { path: '/vault/Secret/x.md', content: 'x' })).isError).toBe(true);
    expect((await A('file_create', { path: '/vault/Shared/Team/Hush/x.md', content: 'x' })).isError).toBe(true);
    expect(text(await A('file_read', { path: '/vault/Shared/Team/Hush/hidden.md' }))).not.toContain(CANARY);
    expect(text(await A('file_read', { path: '/vault/Secret/canary.md' }))).not.toContain(CANARY);
    // No team work at all.
    expect((await A('task_list', {})).isError).toBe(true);

    // The owner loses the grant: the next edit is denied.
    expect((await api('PUT', `/users/${dana}/folder-grants`, { grants: [{ path: '/Shared/Pub/' }] })).status).toBe(200);
    const denied = await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# Plan v3\n', base_revision: u.structuredContent.revision });
    expect(denied.isError).toBe(true);
  });
});

describe('a vault agent inside nested shares', () => {
  it('is approved with Contribute on an inner folder under a Read parent, and refused for the parent; the console agrees', async () => {
    const u = await api('POST', '/users', { username: 'omar', role: 'member' });
    const omar = u.body.user.id as string;
    expect((await api('PUT', `/users/${omar}/folder-grants`, { grants: [{ path: '/Shared/' }, { path: '/Shared/Team/', mode: 'contribute' }] })).status).toBe(200);
    const key = await enrol('omar-pc');
    const f = await ob('POST', '/requests', { key, body: { ...VAULT_REQ, agent: { name: 'Omar notes', job: 'Keeps the plan.' } } });
    expect(f.status, text(f.body)).toBe(200);
    const approve = (path: string) => api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, owner_id: omar,
      edits: { roles: [{ name: 'vault_agent', team_role: 'worker', count: 1, job: 'Keeps the plan.', folders: [{ path, access: 'write' }] }] } });
    const parent = await approve('/vault/Shared');
    expect(parent.status, text(parent.body)).toBe(400);
    expect(text(parent.body)).toContain('is Read');
    const inner = await approve('/vault/Shared/Team');
    expect(inner.status, text(inner.body)).toBe(200);
    const g = (await api('GET', `/users/${omar}/folder-grants`)).body.folder_grants;
    expect(g.find((x: any) => x.path === '/Shared/Team/').delegation.folders).toEqual([{ path: '/Shared/Team/', mode: 'contribute' }]);
    expect(g.find((x: any) => x.path === '/Shared/').delegation.folders ?? []).toEqual([]);

    // The console's fit check (app.js, the vault agent approval) reads the same most specific share.
    const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes('const fit = (f, u) =>'))!;
    const fit = new Function('rel', 'ownLabel', `${line.trim()}; return fit;`)((p: string) => p.slice('/vault'.length).replace(/\/?$/, '/').toLowerCase(), () => 'Omar') as (f: unknown, u: unknown) => string;
    const user = { folder_grants: [{ path: '/Shared/', mode: 'read' }, { path: '/Shared/Team/', mode: 'contribute' }] };
    expect(fit({ path: '/vault/Shared/Team', access: 'write' }, user)).toBe('');
    expect(fit({ path: '/vault/Shared', access: 'write' }, user)).toBe('Omar has Read only');
    expect(fit({ path: '/vault/Secret', access: 'read' }, user)).toBe('Not shared with Omar');
  });
});
