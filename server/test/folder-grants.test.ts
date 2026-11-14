/**
 * Folder grants (docs/multi-user.md §1.2a, docs/authorization.md#delegation): a vault folder shared with a person on its
 * own, without a project, Read by default or Contribute. Restricted folders inside stay hidden and unwritable, a grant
 * creates no key, and an owned agent with no team revises a shared note only while its owner's folder grant allows it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { OwnerScope } from '../src/policy/ownerScope.js';
import { ownerAllows } from '../src/policy/engine.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const CANARY = 'CANARY-fgrant-7c2a';
let app: App, base = '', admin = { cookie: '', csrf: '' }, appKey = '';
type Who = { cookie: string; csrf: string };
const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
type Res = { structuredContent?: any; isError?: boolean; content?: { text?: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
const text = (r: unknown) => JSON.stringify(r);
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
async function member(username: string): Promise<{ id: string; who: Who }> {
  const c = await api('POST', '/users', { username, role: 'member' });
  expect(c.status, text(c.body)).toBe(200);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: c.body.password }) });
  return { id: c.body.user.id, who: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as any).csrf } };
}
const setFolders = (userId: string, grants: unknown[]) => api('PUT', `/users/${userId}/folder-grants`, { grants });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]);
const MP3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 31) % 251))]);
/** A member's media request: inline playback, or the original as an attachment. */
const media = async (who: Who, path: string, as?: 'attachment') => {
  const r = await fetch(`${base}/api/vault/media?path=${encodeURIComponent(path)}${as ? '&as=attachment' : ''}`, { headers: { cookie: who.cookie } });
  await r.arrayBuffer();
  return r.status;
};
const keyCount = () => (app.db.prepare('SELECT count(*) n FROM credentials').get() as { n: number }).n;

let dana: { id: string; who: Who };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahfgrant-'));
  const v = (...p: string[]) => join(dir, 'vault', ...p);
  mkdirSync(v('Shared', 'Team', 'Hush'), { recursive: true });
  mkdirSync(v('Shared', 'Pub'), { recursive: true });
  mkdirSync(v('Secret'), { recursive: true });
  mkdirSync(v('Projects', 'FG'), { recursive: true });
  writeFileSync(v('Shared', 'Team', 'plan.md'), '# Plan\n');
  writeFileSync(v('Shared', 'Team', 'Hush', 'hidden.md'), `# ${CANARY}-hush\n`);
  writeFileSync(v('Shared', 'Pub', 'readme.md'), '# Readme\n');
  writeFileSync(v('Secret', 'canary.md'), `# ${CANARY}\n`);
  mkdirSync(v('Shared', 'Media', 'Inner'), { recursive: true });
  writeFileSync(v('Shared', 'Media', 'photo.png'), PNG);
  writeFileSync(v('Shared', 'Media', 'song.mp3'), MP3);
  writeFileSync(v('Shared', 'Media', 'Inner', 'pic.png'), PNG);
  writeFileSync(v('Shared', 'Team', 'Hush', 'pic.png'), PNG);
  writeFileSync(v('Shared', 'Pub', 'pic.png'), PNG);
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const pc = (await api('POST', '/pcs', { name: 'fg-pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Shared/Team/Hush/', Date.now());
  dana = await member('dana');
});
afterAll(async () => { await app.close(); });

describe('folder grants', () => {
  it('shares a folder without a project, Read by default, and creates no key', async () => {
    const keys = keyCount();
    const r = await setFolders(dana.id, [{ path: 'Shared/Team' }]);
    expect(r.status, text(r.body)).toBe(200);
    expect(r.body.user.folder_grants).toEqual([expect.objectContaining({ path: '/Shared/Team/', mode: 'read', may_export: false })]);
    // The restricted folder inside is named in the answer, and stays hidden.
    expect(r.body.notes.join(' ')).toContain('/Shared/Team/Hush/');
    expect(keyCount()).toBe(keys);
    const me = await call(dana.who, 'GET', '/me');
    expect(me.body.grants).toEqual([]);
    expect(me.body.folder_grants.map((g: any) => g.path)).toEqual(['/Shared/Team/']);
    // Audited with before and after.
    const a = app.db.prepare("SELECT details FROM audit_events WHERE action='user.folder_grant_set' ORDER BY rowid DESC LIMIT 1").get() as { details: string } | undefined;
    expect(a?.details).toContain('/Shared/Team/');
  });

  it('the person sees and previews the shared folder only; restricted descendants stay hidden', async () => {
    const root = await call(dana.who, 'GET', '/vault/tree');
    expect(root.status, text(root.body)).toBe(200);
    expect(text(root.body)).toContain('Shared');
    expect(text(root.body)).not.toContain('Secret');
    const team = await call(dana.who, 'GET', '/vault/tree?path=' + encodeURIComponent('/vault/Shared/Team/'));
    expect(text(team.body)).toContain('plan.md');
    expect(text(team.body)).not.toContain('Hush');
    expect((await call(dana.who, 'GET', '/vault/preview?path=' + encodeURIComponent('/vault/Shared/Team/plan.md'))).status).toBe(200);
    for (const p of ['/vault/Shared/Team/Hush/hidden.md', '/vault/Secret/canary.md', '/vault/Shared/Pub/readme.md']) {
      const r = await call(dana.who, 'GET', '/vault/preview?path=' + encodeURIComponent(p));
      expect(r.status, p).toBe(404);
      expect(text(r.body)).not.toContain(CANARY);
    }
  });

  it('Read refuses an edit as read only; Contribute edits through the version check, and never in a restricted folder', async () => {
    // One edit path for people (docs/vault.md "People writing in the vault"): PUT /api/vault/files saves, POST creates.
    const text0 = await call(dana.who, 'GET', '/vault/media?' + new URLSearchParams({ path: '/vault/Shared/Team/plan.md', as: 'text' }));
    expect(text0.status).toBe(403);
    expect(text0.body.error).toBe('read_only');
    const pv = (await call(dana.who, 'GET', '/vault/preview?path=' + encodeURIComponent('/vault/Shared/Team/plan.md'))).body;
    const save = (path: string, text: string, base_revision: string) => call(dana.who, 'PUT', '/vault/files', { path, text, base_revision });
    const create = (path: string, text: string) => call(dana.who, 'POST', '/vault/files', { path, text });
    const ro = await save('/vault/Shared/Team/plan.md', '# Read only\n', pv.revision);
    expect(ro.status).toBe(403);
    expect(ro.body.error).toBe('read_only');
    expect((await create('/vault/Shared/Team/ro.md', 'x')).body.error).toBe('read_only');
    expect((await setFolders(dana.id, [{ path: '/Shared/Team/', mode: 'contribute' }])).status).toBe(200);
    const ok = await save('/vault/Shared/Team/plan.md', '# Plan v2\n', pv.revision);
    expect(ok.status, text(ok.body)).toBe(200);
    // A stale base is refused: nothing is overwritten.
    const stale = await save('/vault/Shared/Team/plan.md', '# Lost\n', pv.revision);
    expect(stale.status).toBe(409);
    expect((await call(dana.who, 'GET', '/vault/preview?path=' + encodeURIComponent('/vault/Shared/Team/plan.md'))).body.preview.content).toBe('# Plan v2\n');
    // The author is recorded as a collaborator, with the person's user id.
    const rev = app.db.prepare('SELECT author_kind, user_id FROM file_revisions WHERE revision=?').get(ok.body.revision) as { author_kind: string; user_id: string };
    expect(rev).toEqual({ author_kind: 'collaborator', user_id: dana.id });
    // A new note; not in a restricted folder, not outside the grant, text notes only.
    expect((await create('/vault/Shared/Team/new.md', 'hi')).status).toBe(200);
    expect((await save('/vault/Shared/Team/Hush/hidden.md', 'x', 'absent')).status).toBe(404);
    expect((await create('/vault/Shared/Team/Hush/new.md', 'x')).status).toBe(404);
    expect((await create('/vault/Secret/new.md', 'x')).status).toBe(404);
    expect((await create('/vault/Shared/Team/pic.png', 'x')).status).toBe(400);
    // Uploads, rename, remove and restore stay the operator's.
    expect((await call(dana.who, 'POST', '/vault/files/rename', { from: '/vault/Shared/Team/new.md', to: '/vault/Shared/Team/n2.md', base_revision: 'x' })).status).toBe(403);
    // 2c's own note route is gone: one edit path.
    expect((await call(dana.who, 'PUT', '/vault/note', { path: '/vault/Shared/Team/plan.md', content: 'x', base_revision: 'absent' })).status).toBe(404);
  });

  it('a name that matches, in other capitals, a file the person cannot see is refused without naming it', async () => {
    const r = await call(dana.who, 'POST', '/vault/files', { path: '/vault/Shared/Team/hush/HIDDEN.md', text: 'x' });
    expect([r.status, r.body.reason]).toEqual([409, 'case_mismatch']);
    expect(text(r.body)).not.toContain('Hush');
    expect(text(r.body)).not.toContain('hidden.md');
    expect(text(r.body)).not.toContain(CANARY);
    expect(r.body.path).toBeUndefined();
  });

  it('refuses the vault root, the hub folder, a delegation outside the grant, and Contribute delegated by a Read grant or a project grant', async () => {
    expect((await setFolders(dana.id, [{ path: '/' }])).status).toBe(400);
    expect((await setFolders(dana.id, [{ path: '/99 Conclave/' }])).status).toBe(400);
    expect((await setFolders(dana.id, [{ path: '/Shared/Team/', delegation: { folders: [{ path: '/Secret/', mode: 'read' }] } }])).status).toBe(400);
    expect((await setFolders(dana.id, [{ path: '/Shared/Team/', mode: 'read', delegation: { folders: [{ path: '/Shared/Team/', mode: 'contribute' }] } }])).status).toBe(400);
    const project = (await api('POST', '/projects', { key: 'FG', name: 'FG' })).body.project.id;
    const g = await api('PUT', `/users/${dana.id}/grants`, { grants: [{ project_id: project, components: ['vault', 'blueprint'], vault_folders: ['/Projects/FG/'], delegation: { folders: [{ path: '/Projects/FG/', mode: 'contribute' }] } }] });
    expect(g.status, text(g.body)).toBe(400);
    // A person may hold both kinds.
    expect((await api('PUT', `/users/${dana.id}/grants`, { grants: [{ project_id: project, components: ['vault', 'blueprint'], vault_folders: ['/Projects/FG/'] }] })).status).toBe(200);
    const me = (await call(dana.who, 'GET', '/me')).body;
    expect(me.grants.length).toBe(1);
    expect(me.folder_grants.length).toBe(1);
    // The admin user record carries both too.
    expect((await api('GET', `/users/${dana.id}`)).body.user.folder_grants[0].mode).toBe('contribute');
  });

  it('an external user never gets a restricted folder', async () => {
    const eve = await member('eve');
    expect((await api('PATCH', `/users/${eve.id}`, { external: true })).status).toBe(200);
    expect((await setFolders(eve.id, [{ path: '/Shared/Team/Hush/' }])).status).toBe(400);
    expect((await setFolders(eve.id, [{ path: '/Shared/Team/' }])).status).toBe(200);
    // Nor becomes external while holding one.
    const fay = await member('fay');
    expect((await setFolders(fay.id, [{ path: '/Shared/Team/Hush/' }])).status).toBe(200);
    expect((await api('PATCH', `/users/${fay.id}`, { external: true })).status).toBe(400);
  });
});

describe('export and nested shares through folder grants', () => {
  let gil: { id: string; who: Who };
  beforeAll(async () => { gil = await member('gil'); });
  const note = (path: string) => call(gil.who, 'POST', '/vault/files', { path, text: '# New\n' });

  it('an export-allowed folder grant plays and downloads images and audio; without export, outside or in a restricted folder it stays refused', async () => {
    expect((await setFolders(gil.id, [{ path: '/Shared/Media/' }])).status).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Media/photo.png')).toBe(403);
    expect(await media(gil.who, '/vault/Shared/Media/song.mp3', 'attachment')).toBe(403);
    expect((await setFolders(gil.id, [{ path: '/Shared/Media/', may_export: true }])).status).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Media/photo.png')).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Media/song.mp3')).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Media/photo.png', 'attachment')).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Media/Inner/pic.png')).toBe(200);
    // Outside the grant: not even there.
    expect(await media(gil.who, '/vault/Shared/Pub/pic.png')).toBe(404);
    // An inner share without export wins over the outer share with it.
    expect((await setFolders(gil.id, [{ path: '/Shared/Media/', may_export: true }, { path: '/Shared/Media/Inner/' }])).status).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Media/Inner/pic.png')).toBe(403);
    expect(await media(gil.who, '/vault/Shared/Media/photo.png')).toBe(200);
    // A restricted folder: hidden under an export-allowed parent; named on its own, only its own export counts.
    expect((await setFolders(gil.id, [{ path: '/Shared/Team/', may_export: true }])).status).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Team/Hush/pic.png')).toBe(404);
    expect((await setFolders(gil.id, [{ path: '/Shared/Team/', may_export: true }, { path: '/Shared/Team/Hush/' }])).status).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Team/Hush/pic.png')).toBe(403);
    expect((await setFolders(gil.id, [{ path: '/Shared/Team/' }, { path: '/Shared/Team/Hush/', may_export: true }])).status).toBe(200);
    expect(await media(gil.who, '/vault/Shared/Team/Hush/pic.png')).toBe(200);
  });

  it('the most specific share decides a write: Contribute inside Read saves, Read inside Contribute is read only', async () => {
    expect((await setFolders(gil.id, [{ path: '/Shared/' }, { path: '/Shared/Pub/', mode: 'contribute' }])).status).toBe(200);
    const inner = await note('/vault/Shared/Pub/inner.md');
    expect(inner.status, text(inner.body)).toBe(200);
    expect((await note('/vault/Shared/outer.md')).body.error).toBe('read_only');
    expect((await setFolders(gil.id, [{ path: '/Shared/', mode: 'contribute' }, { path: '/Shared/Pub/' }])).status).toBe(200);
    expect((await note('/vault/Shared/outer.md')).status).toBe(200);
    expect((await note('/vault/Shared/Pub/inner2.md')).body.error).toBe('read_only');
  });
});

describe('a teamless vault agent', () => {
  let agentId = '', A: Call, appRules: any[] = [];
  beforeAll(async () => {
    // An agent with no team, task board or Blueprint, owned by Dana; its key allows the whole vault.
    const a = app.keys.createAgent('Dana notes', null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 'Dana notes key' }, sys);
    appRules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'allow', actions: ['fs.*'], resource: 'path:/vault/**' }];
    app.keys.setRules(k.credential.policy_id, appRules, 'test', sys);
    agentId = a.id;
    expect((await api('POST', '/agent-owners/claim')).status).toBe(200);
    expect((await api('PATCH', `/agents/${agentId}`, { owner_id: dana.id })).status).toBe(200);
    expect((await api('PUT', '/agent-owners/enforcement', { on: true })).body.enforcement).toBe(true);
    A = await loginWith(k.secret);
  });

  it('revises an authorized note with its base revision, then is denied once the grant is narrowed or removed', async () => {
    const fg = (mode: 'read' | 'contribute', dmode: 'read' | 'contribute') => setFolders(dana.id, [{ path: '/Shared/Team/', mode, delegation: { folders: [{ path: '/Shared/Team/', mode: dmode }] } }]);
    expect((await fg('contribute', 'contribute')).status).toBe(200);
    const r = await A('file_read', { path: '/vault/Shared/Team/plan.md' });
    expect(r.isError, text(r)).toBeFalsy();
    const u = await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# Plan v3\n', base_revision: r.structuredContent.revision });
    expect(u.isError, text(u)).toBeFalsy();
    // Outside the grant and in the restricted folder inside it: refused, though the key allows the whole vault.
    expect((await A('file_create', { path: '/vault/Secret/x.md', content: 'x' })).isError).toBe(true);
    expect((await A('file_create', { path: '/vault/Shared/Team/Hush/x.md', content: 'x' })).isError).toBe(true);
    expect(text(await A('file_read', { path: '/vault/Shared/Team/Hush/hidden.md' }))).not.toContain(CANARY);
    // A Contribute grant that delegates Read caps the agent at Read.
    expect((await fg('contribute', 'read')).status).toBe(200);
    expect((await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# no\n', base_revision: u.structuredContent.revision })).isError).toBe(true);
    // A grant narrowed to Read (its Contribute delegation kept) caps the agent at Read too.
    expect((await fg('contribute', 'contribute')).status).toBe(200);
    expect((await setFolders(dana.id, [{ path: '/Shared/Team/', mode: 'read' }])).status).toBe(200);
    expect((await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# no\n', base_revision: u.structuredContent.revision })).isError).toBe(true);
    // Back to Contribute: the next edit lands; the grant removed: the next edit is denied, and so is reading.
    expect((await fg('contribute', 'contribute')).status).toBe(200);
    const u2 = await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# Plan v4\n', base_revision: u.structuredContent.revision });
    expect(u2.isError, text(u2)).toBeFalsy();
    expect((await setFolders(dana.id, [])).status).toBe(200);
    expect((await A('file_update', { path: '/vault/Shared/Team/plan.md', content: '# no\n', base_revision: u2.structuredContent.revision })).isError).toBe(true);
    expect((await A('file_read', { path: '/vault/Shared/Team/plan.md' })).isError).toBe(true);
  });

  it('judges each operation against its own folder: export and write never combine across grants', async () => {
    expect((await setFolders(dana.id, [
      { path: '/Shared/Team/', mode: 'contribute', may_export: false, delegation: { folders: [{ path: '/Shared/Team/', mode: 'contribute' }] } },
      { path: '/Shared/Pub/', mode: 'read', may_export: true, delegation: { folders: [{ path: '/Shared/Pub/', mode: 'read' }] } },
    ])).status).toBe(200);
    const cap = new OwnerScope(app.db, 'vault').cap(agentId, appRules as never);
    expect(ownerAllows(cap, 'fs.update', 'path:/vault/Shared/Team/plan.md')).toBe(true);
    expect(ownerAllows(cap, 'fs.download', 'path:/vault/Shared/Team/plan.md')).toBe(false);
    expect(ownerAllows(cap, 'fs.download', 'path:/vault/Shared/Pub/readme.md')).toBe(true);
    expect(ownerAllows(cap, 'fs.update', 'path:/vault/Shared/Pub/readme.md')).toBe(false);
    expect(ownerAllows(cap, 'fs.read', 'path:/vault/Shared/Team/Hush/hidden.md')).toBe(false);
    const w = await A('file_update', { path: '/vault/Shared/Pub/readme.md', content: 'x', base_revision: (await A('file_read', { path: '/vault/Shared/Pub/readme.md' })).structuredContent.revision });
    expect(w.isError).toBe(true);
  });

  it('the most specific share bounds the agent: a Read or no-export share inside a Contribute one takes back write and export there', async () => {
    expect((await setFolders(dana.id, [
      { path: '/Shared/', mode: 'contribute', may_export: true, delegation: { folders: [{ path: '/Shared/', mode: 'contribute' }] } },
      { path: '/Shared/Team/', mode: 'read', delegation: { folders: [{ path: '/Shared/Team/', mode: 'read' }] } },
    ])).status).toBe(200);
    const cap = new OwnerScope(app.db, 'vault').cap(agentId, appRules as never);
    expect(ownerAllows(cap, 'fs.update', 'path:/vault/Shared/Pub/readme.md')).toBe(true);
    expect(ownerAllows(cap, 'fs.download', 'path:/vault/Shared/Pub/readme.md')).toBe(true);
    expect(ownerAllows(cap, 'fs.read', 'path:/vault/Shared/Team/plan.md')).toBe(true);
    expect(ownerAllows(cap, 'fs.update', 'path:/vault/Shared/Team/plan.md')).toBe(false);
    expect(ownerAllows(cap, 'fs.create', 'path:/vault/Shared/Team/new.md')).toBe(false);
    expect(ownerAllows(cap, 'fs.download', 'path:/vault/Shared/Team/plan.md')).toBe(false);
    expect((await A('file_create', { path: '/vault/Shared/Team/agent.md', content: 'x' })).isError).toBe(true);
    const ok = await A('file_create', { path: '/vault/Shared/Pub/agent.md', content: 'x' });
    expect(ok.isError, text(ok)).toBeFalsy();
  });

  it('a project grant delegates Read only: a Contribute delegation stored before 2c fails closed to Read', async () => {
    expect((await setFolders(dana.id, [])).status).toBe(200);
    const project = (app.db.prepare("SELECT id FROM projects WHERE key='FG'").get() as { id: string }).id;
    // A row as the 2b-2 mapping could have saved it (the API now refuses it): Contribute delegated by a project grant.
    app.db.prepare('UPDATE user_project_grants SET delegation=? WHERE user_id=? AND project_id=?')
      .run(JSON.stringify({ folders: [{ path: '/Projects/FG/', mode: 'contribute' }] }), dana.id, project);
    const cap = new OwnerScope(app.db, 'vault').cap(agentId, appRules as never);
    expect(ownerAllows(cap, 'fs.read', 'path:/vault/Projects/FG/a.md')).toBe(true);
    expect(ownerAllows(cap, 'fs.create', 'path:/vault/Projects/FG/a.md')).toBe(false);
    expect(ownerAllows(cap, 'fs.update', 'path:/vault/Projects/FG/a.md')).toBe(false);
    expect((await A('file_create', { path: '/vault/Projects/FG/a.md', content: 'x' })).isError).toBe(true);
  });
});
