/**
 * People writing in the vault from the console (docs/vault.md "People writing in the vault"): new note, upload, edit
 * with a base, rename, remove and restore; refused paths; a stale console save that records no conflict; the person as
 * author through crash recovery and in agents' file_history; the write pause; audit; and members, refused until
 * Contribute exists and checked against the switch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { totp } from '../src/util/crypto.js';
import { testConfig, adminLogin } from './hub.js';
import { refusedPath, withNoteExtension } from '../src/admin/vaultWrite.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', vaultDir = '', appKey = '';
type S = { cookie: string; csrf: string };
let admin: S;
const ids: Record<string, string> = {};
const PW = 'vault editing password 1234';
const call = async (who: S, method: string, path: string, body?: unknown, raw?: Buffer) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any, text, h: r.headers };
};
const text = (who: S, path: string) => fetch(`${base}/api/vault/media?${new URLSearchParams({ path, as: 'text' })}`, { headers: { cookie: who.cookie } });
const rows = (action: string) => (app.db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY id').all(action) as any[]).map((r) => ({ ...r, details: JSON.parse(r.details ?? '{}') }));
const put = (rel: string, bytes: Buffer | string) => { const abs = join(vaultDir, ...rel.split('/')); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, bytes); };
const disk = (rel: string) => join(vaultDir, ...rel.split('/'));
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const V = (rel: string) => `/vault/${rel}`;
const conflicts = () => (app.db.prepare("SELECT COUNT(*) n FROM file_conflicts WHERE status='open'").get() as { n: number }).n;
const revs = (rel: string) => app.store.revisions(app.store.fileByPath(rel, true)!.id, 100);
const agentWrite = async (rel: string, body: string) => app.store.write(rel.split('/'), Buffer.from(body), (await app.store.observe(rel.split('/'))), 'update', { agentId: ids.agent });

async function agentSession() {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const agent = app.keys.createAgent('Reader', null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: 'Reader' }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.read', 'fs.history'], resource: 'path:/vault/**' }], 'test', sys);
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as any).structuredContent.session_token as string;
  return async (name: string, args: Record<string, unknown>) => ((await c.callTool({ name, arguments: { session_token: token, ...args } })) as any).structuredContent;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahedit-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  put('Notes/Plan.md', '# Plan\n\nFirst line.\n');
  put('Notes/Brief.md', 'See [[Plan]].\n');
  put('Notes/Team/Shared.md', 'shared\n');
  put('Notes/Team/Read.md', 'read only\n');
  put('Notes/Team/Restricted/Secret.md', 'Links to [[Plan]].\n');
  put('Notes/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  put('99 Conclave/README.md', 'hub page\n');
  const config: Config = testConfig(dir, { vaultDir, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  ids.admin = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
  ids.agent = app.keys.createAgent('Developer 3', null, sys).id;
  const pc = (await call(admin, 'POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code' }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('refused paths', () => {
  const hidden = (s: string) => ['.obsidian', '.trash', '.git', 'shares'].includes(s.toLowerCase());
  it('refuses the hub folder in any case, hidden, reserved and trailing names', () => {
    expect(refusedPath(['99 Conclave', 'a.md'], hidden)?.reason).toBe('reserved');
    expect(refusedPath(['99 conclave', 'a.md'], hidden)?.reason).toBe('reserved');
    expect(refusedPath(['Notes', '.obsidian', 'a.md'], hidden)?.reason).toBe('hidden');
    for (const n of ['CON', 'con.md', 'Nul.txt', 'COM1', 'lpt9.md', 'aux']) expect(refusedPath(['Notes', n], hidden)?.reason).toBe('windows_reserved');
    expect(refusedPath(['Notes', 'a.md.'], hidden)?.reason).toBe('trailing');
    expect(refusedPath(['Notes ', 'a.md'], hidden)?.reason).toBe('trailing');
    expect(refusedPath(['Notes', 'a?.md'], hidden)?.reason).toBe('bad_char');
    expect(refusedPath(['Notes', 'console.md'], hidden)).toBeNull();
    expect(refusedPath(['Notes', 'COM10.md'], hidden)).toBeNull();
  });
  it('adds .md to a note name without an extension', () => {
    expect(withNoteExtension(['Notes', 'Meeting'])).toEqual(['Notes', 'Meeting.md']);
    expect(withNoteExtension(['Notes', 'todo.txt'])).toEqual(['Notes', 'todo.txt']);
  });
  it('the routes refuse them before the store, at both ends of a rename', async () => {
    const plan = await app.store.observe(['Notes', 'Plan.md']);
    for (const p of ['99 Conclave/x.md', '99 conclave/x.md', '.obsidian/x.md', 'Notes/CON.md', 'Notes/x.md.']) {
      const r = await call(admin, 'POST', '/vault/files', { path: V(p), text: 'x' });
      expect(r.status, p).toBe(400);
      expect(r.body.error).toBe('invalid_path');
    }
    expect((await call(admin, 'POST', '/vault/files', { path: V('99 conclave/x.md'), text: 'x' })).body.message).toContain('nobody can write there');
    for (const to of ['99 conclave/Plan.md', 'Notes/.trash/Plan.md', 'Notes/LPT1.md']) {
      expect((await call(admin, 'POST', '/vault/files/rename', { from: V('Notes/Plan.md'), to: V(to), base_revision: plan })).status, to).toBe(400);
    }
    const hub = await app.store.observe(['99 Conclave', 'README.md']);
    expect((await call(admin, 'POST', '/vault/files/rename', { from: V('99 Conclave/README.md'), to: V('Notes/R.md'), base_revision: hub })).status).toBe(400);
    expect((await call(admin, 'PUT', '/vault/files', { path: V('99 Conclave/README.md'), text: 'x', base_revision: hub })).status).toBe(400);
    expect((await call(admin, 'DELETE', `/vault/files?${new URLSearchParams({ path: V('99 Conclave/README.md'), base_revision: hub })}`)).status).toBe(400);
    expect(existsSync(disk('Notes/Plan.md'))).toBe(true);
    expect(readFileSync(disk('99 Conclave/README.md'), 'utf8')).toBe('hub page\n');
  });
  it('refuses a case alias of an existing file', async () => {
    const r = await call(admin, 'POST', '/vault/files', { path: V('Notes/plan.md'), text: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('case_mismatch');
  });
});

describe('the operator writes', () => {
  it('creates a note, adding .md, as the operator, audited', async () => {
    const r = await call(admin, 'POST', '/vault/files', { path: V('Notes/Meeting'), text: '# Meeting\n' });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(V('Notes/Meeting.md'));
    expect(readFileSync(disk('Notes/Meeting.md'), 'utf8')).toBe('# Meeting\n');
    const rv = revs('Notes/Meeting.md')[0]!;
    expect(rv.author_kind).toBe('operator');
    expect(rv.user_id).toBe(ids.admin);
    const a = rows('vault.file.create').at(-1)!;
    expect(a.details).toMatchObject({ path: V('Notes/Meeting.md'), revision: r.body.revision, author_kind: 'operator' });
    // A taken name is refused and nothing is overwritten.
    const again = await call(admin, 'POST', '/vault/files', { path: V('Notes/Meeting.md'), text: 'other' });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('exists');
    expect(readFileSync(disk('Notes/Meeting.md'), 'utf8')).toBe('# Meeting\n');
  });

  it('uploads raw bytes, refusing a taken name and anything over 2 MB', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1_500_000, 9)]);
    const r = await call(admin, 'POST', `/vault/files?${new URLSearchParams({ path: V('Notes/big.png') })}`, undefined, png);
    expect(r.status).toBe(200);
    expect(readFileSync(disk('Notes/big.png')).equals(png)).toBe(true);
    expect(rows('vault.file.create').at(-1)!.details).toMatchObject({ upload: true, bytes: png.length });
    expect((await call(admin, 'POST', `/vault/files?${new URLSearchParams({ path: V('Notes/big.png') })}`, undefined, Buffer.from('x'))).status).toBe(409);
    expect((await call(admin, 'POST', `/vault/files?${new URLSearchParams({ path: V('Notes/huge.bin') })}`, undefined, Buffer.alloc(2 * 1024 * 1024 + 10))).status).toBe(413);
    expect(existsSync(disk('Notes/huge.bin'))).toBe(false);
  });

  it('reads text to edit through the media path and saves with its base', async () => {
    const t = await text(admin, V('Notes/Plan.md'));
    expect(t.status).toBe(200);
    expect(t.headers.get('content-type')).toContain('text/plain');
    const base = t.headers.get('x-revision')!;
    expect(await t.text()).toBe('# Plan\n\nFirst line.\n');
    expect((await text(admin, V('Notes/photo.png'))).status).toBe(400);
    const s = await call(admin, 'PUT', '/vault/files', { path: V('Notes/Plan.md'), text: '# Plan\n\nEdited.\n', base_revision: base });
    expect(s.status).toBe(200);
    expect(readFileSync(disk('Notes/Plan.md'), 'utf8')).toBe('# Plan\n\nEdited.\n');
    expect(revs('Notes/Plan.md')[0]).toMatchObject({ op: 'update', author_kind: 'operator', revision: s.body.revision });
    expect(rows('vault.file.update').at(-1)!.details).toMatchObject({ path: V('Notes/Plan.md'), revision: s.body.revision, author_kind: 'operator' });
    // The file's Activity lists the person's change.
    const act = await call(admin, 'GET', `/vault/activity?${new URLSearchParams({ path: V('Notes/Plan.md'), exact: '1' })}`);
    expect(act.body.revisions[0]).toMatchObject({ revision: s.body.revision, author: { kind: 'operator', label: 'Operator' } });
  });

  it('a stale save writes nothing and records no conflict; Keep mine writes over it, keeping theirs in History', async () => {
    const base = await app.store.observe(['Notes', 'Plan.md']);
    const before = conflicts();
    const theirs = await agentWrite('Notes/Plan.md', '# Plan\n\nAgent change.\n');
    const r = await call(admin, 'PUT', '/vault/files', { path: V('Notes/Plan.md'), text: '# Plan\n\nMine.\n', base_revision: base });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: 'changed', current_revision: theirs.revision, base_revision: base });
    expect(r.body.conflict_id).toBeUndefined();
    expect(conflicts()).toBe(before);
    expect(readFileSync(disk('Notes/Plan.md'), 'utf8')).toBe('# Plan\n\nAgent change.\n');
    // Keep mine: saves with the base it just read.
    const keep = await call(admin, 'PUT', '/vault/files', { path: V('Notes/Plan.md'), text: '# Plan\n\nMine.\n', base_revision: r.body.current_revision });
    expect(keep.status).toBe(200);
    expect(readFileSync(disk('Notes/Plan.md'), 'utf8')).toBe('# Plan\n\nMine.\n');
    expect(revs('Notes/Plan.md').map((x) => x.revision)).toContain(theirs.revision);
    // An agent's stale write is still recorded as before.
    await expect(app.store.write(['Notes', 'Plan.md'], Buffer.from('late'), base, 'update', { agentId: ids.agent })).rejects.toThrow();
    expect(conflicts()).toBe(before + 1);
  });

  it('renames with a base, keeping history, and counts only links the viewer can read', async () => {
    const plan = await app.store.observe(['Notes', 'Plan.md']);
    const fid = app.store.fileByPath('Notes/Plan.md')!.id;
    const src = (p: string) => app.store.fileByPath(p)!.id;
    await app.store.observe(['Notes', 'Brief.md']); await app.store.observe(['Notes', 'Team', 'Restricted', 'Secret.md']);
    const ins = app.db.prepare("INSERT OR REPLACE INTO kg_signals(src_file,src_anchor,dst_file,dst_anchor,kind,weight,seen_at) VALUES (?,'',?,'','link',1,?)");
    ins.run(src('Notes/Brief.md'), fid, Date.now()); ins.run(src('Notes/Team/Restricted/Secret.md'), fid, Date.now());
    expect((await call(admin, 'GET', `/vault/backlinks?${new URLSearchParams({ path: V('Notes/Plan.md') })}`)).body.count).toBe(2);
    expect((await call(admin, 'POST', '/vault/files/rename', { from: V('Notes/Plan.md'), to: V('Notes/Brief.md'), base_revision: plan })).body.reason).toBe('exists');
    const r = await call(admin, 'POST', '/vault/files/rename', { from: V('Notes/Plan.md'), to: V('Archive/Plan 2026.md'), base_revision: plan });
    expect(r.status).toBe(200);
    expect(existsSync(disk('Archive/Plan 2026.md'))).toBe(true);
    expect(app.store.fileByPath('Archive/Plan 2026.md')!.id).toBe(fid);
    expect(rows('vault.file.rename').at(-1)!.details).toMatchObject({ from: V('Notes/Plan.md'), path: V('Archive/Plan 2026.md'), author_kind: 'operator' });
    // A case-only rename of the same file is not an alias of another one.
    const cur = await app.store.observe(['Archive', 'Plan 2026.md']);
    expect((await call(admin, 'POST', '/vault/files/rename', { from: V('Archive/Plan 2026.md'), to: V('Archive/plan 2026.md'), base_revision: cur })).status).toBe(200);
  });

  it('removes as a tombstone and restores it; a taken path is refused and another name works', async () => {
    const base = await app.store.observe(['Notes', 'Meeting.md']);
    const stale = await call(admin, 'DELETE', `/vault/files?${new URLSearchParams({ path: V('Notes/Meeting.md'), base_revision: 'sha256:old' })}`);
    expect(stale.status).toBe(409);
    const d = await call(admin, 'DELETE', `/vault/files?${new URLSearchParams({ path: V('Notes/Meeting.md'), base_revision: base })}`);
    expect(d.status).toBe(200);
    expect(existsSync(disk('Notes/Meeting.md'))).toBe(false);
    expect(revs('Notes/Meeting.md')[0]).toMatchObject({ revision: 'tombstone', author_kind: 'operator' });
    expect(rows('vault.file.delete').at(-1)!.details).toMatchObject({ path: V('Notes/Meeting.md'), author_kind: 'operator' });
    const r = await call(admin, 'POST', '/vault/files/restore', { path: V('Notes/Meeting.md'), revision: base, base_revision: 'absent' });
    expect(r.status).toBe(200);
    expect(readFileSync(disk('Notes/Meeting.md'), 'utf8')).toBe('# Meeting\n');
    expect(revs('Notes/Meeting.md').map((x) => x.revision).slice(0, 3)).toEqual([base, 'tombstone', base]);
    expect(rows('vault.file.restore').at(-1)!.details).toMatchObject({ restored_from: base, author_kind: 'operator' });
    // Removed again, then the path is taken by a new note: the restore is refused, another name works.
    await call(admin, 'DELETE', `/vault/files?${new URLSearchParams({ path: V('Notes/Meeting.md'), base_revision: base })}`);
    await call(admin, 'POST', '/vault/files', { path: V('Notes/Meeting.md'), text: 'new one\n' });
    const taken = await call(admin, 'POST', '/vault/files/restore', { path: V('Notes/Meeting.md'), revision: base, base_revision: 'absent' });
    expect(taken.status).toBe(409);
    expect(taken.body.reason).toBe('taken');
    expect(readFileSync(disk('Notes/Meeting.md'), 'utf8')).toBe('new one\n');
    const other = await call(admin, 'POST', '/vault/files/restore', { path: V('Notes/Meeting.md'), revision: base, base_revision: 'absent', to: V('Notes/Meeting (restored).md') });
    expect(other.status).toBe(200);
    expect(readFileSync(disk('Notes/Meeting (restored).md'), 'utf8')).toBe('# Meeting\n');
  });

  it('the write pause refuses every console write with its reason', async () => {
    const base = await app.store.observe(['Notes', 'Brief.md']);
    expect((await call(admin, 'POST', '/lockdown', { writes_disabled: true })).status).toBe(200);
    try {
      const r = await call(admin, 'PUT', '/vault/files', { path: V('Notes/Brief.md'), text: 'x', base_revision: base });
      expect(r.status).toBe(423);
      expect(r.body).toMatchObject({ error: 'lockdown', reason: 'writes_paused' });
      expect((await call(admin, 'POST', '/vault/files', { path: V('Notes/Paused.md'), text: 'x' })).status).toBe(423);
      expect(existsSync(disk('Notes/Paused.md'))).toBe(false);
    } finally { await call(admin, 'POST', '/lockdown', { writes_disabled: false }); }
  });
});

describe('the person as author', () => {
  it('a console write recovered after a crash keeps its author', async () => {
    const bytes = Buffer.from('recovered\n');
    put('Notes/crash.md', bytes);
    app.db.prepare("INSERT INTO write_intents(id,op,path,base_revision,new_revision,tmp_name,agent_id,credential_id,author_kind,user_id,revision_op,origin,created_at) VALUES ('int_crash','write','Notes/crash.md','absent',?,NULL,NULL,NULL,'operator',?,'create','platform',?)")
      .run(sha(bytes), ids.admin, Date.now());
    await app.store.recover();
    expect(revs('Notes/crash.md')[0]).toMatchObject({ recovered: 1, author_kind: 'operator', user_id: ids.admin });
  });

  it("agents' file_history shows the kind and a label, never a console user id", async () => {
    app.db.prepare("UPDATE admin_users SET display_name='Mara' WHERE id=?").run(ids.admin);
    const base = await app.store.observe(['Notes', 'Brief.md']);
    await app.store.write(['Notes', 'Brief.md'], Buffer.from('collab edit\n'), base, 'update', { person: { kind: 'collaborator', userId: ids.admin } });
    const T = await agentSession();
    const h = await T('file_history', { path: V('Notes/Brief.md') });
    expect(h.revisions[0].by).toEqual({ kind: 'collaborator', label: 'Mara (collaborator)' });
    const ops = await T('file_history', { path: V('Notes/crash.md') });
    expect(ops.revisions[0].by).toEqual({ kind: 'operator', label: 'Operator' });
    expect(JSON.stringify([h, ops])).not.toContain(ids.admin);
  });
});

describe('members', () => {
  // ana reads Notes/Team through a project grant; cara and eve (external) hold Contribute on it through a folder grant.
  let ana: S, cara: S, eve: S;
  const contribute = (who: string, mode: 'read' | 'contribute') => call(admin, 'PUT', `/users/${ids[who]}/folder-grants`, { grants: [{ path: '/Notes/Team/', mode }] });
  beforeAll(async () => {
    const p = (await call(admin, 'POST', '/projects', { key: 'EDT', name: 'Editing' })).body.project.id;
    app.db.prepare('UPDATE projects SET vault_roots=? WHERE id=?').run(JSON.stringify(['/Notes/Team/']), p);
    app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Notes/Team/Restricted/', Date.now());
    const mk = async (username: string, over: Record<string, unknown>, project = true): Promise<S> => {
      const c = await call(admin, 'POST', '/users', { username, ...over });
      const first = await adminLogin(base, username, c.body.password);
      let secret: string | undefined;
      if (c.body.user.totp_required) {
        secret = (await call(first, 'POST', '/totp/enroll', {})).body.secret as string;
        expect((await call(first, 'POST', '/totp/confirm', { code: totp(secret, Date.now()) })).status).toBe(200);
      }
      expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
      if (project) expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: p, components: ['vault'], vault_folders: ['/Notes/Team/'], may_export: false }] })).status).toBe(200);
      ids[username] = c.body.user.id;
      return adminLogin(base, username, PW, secret ? totp(secret, Date.now(), 1) : undefined);
    };
    ana = await mk('ana', {});
    cara = await mk('cara', {}, false);
    eve = await mk('eve', { external: true, org: 'Partner' }, false);
    for (const u of ['cara', 'eve']) { const r = await contribute(u, 'contribute'); expect(r.status, JSON.stringify(r.body)).toBe(200); }
  });

  it('a member who only reads gets read only on create, save and the editor read; the other actions stay the operator\'s', async () => {
    const created = await call(ana, 'POST', '/vault/files', { path: V('Notes/Team/new.md'), text: 'x' });
    expect([created.status, created.body.error]).toEqual([403, 'read_only']);
    const ro = await call(ana, 'PUT', '/vault/files', { path: V('Notes/Team/Read.md'), text: 'x', base_revision: await app.store.observe(['Notes', 'Team', 'Read.md']) });
    expect([ro.status, ro.body.error]).toEqual([403, 'read_only']);
    expect(readFileSync(disk('Notes/Team/Read.md'), 'utf8')).toBe('read only\n');
    const t = await text(ana, V('Notes/Team/Shared.md'));
    expect(t.status).toBe(403);
    expect(((await t.json()) as any).error).toBe('read_only');
    expect((await text(ana, V('Notes/Brief.md'))).status).toBe(404);
    for (const [m, p, b] of [['DELETE', `/vault/files?${new URLSearchParams({ path: V('Notes/Team/Shared.md'), base_revision: 'x' })}`, undefined],
      ['POST', '/vault/files/rename', { from: V('Notes/Team/Shared.md'), to: V('Notes/Team/S2.md'), base_revision: 'x' }],
      ['POST', '/vault/files/restore', { path: V('Notes/Team/Shared.md'), revision: 'x', base_revision: 'x' }]] as const) {
      expect((await call(cara, m, p, b)).body.error, p).toBe('admin_only');
    }
  });

  it('a member with Contribute edits and creates notes as a collaborator; uploads stay the operator\'s', async () => {
    const t = await text(cara, V('Notes/Team/Shared.md'));
    expect(t.status).toBe(200);
    const r = await call(cara, 'PUT', '/vault/files', { path: V('Notes/Team/Shared.md'), text: 'by cara\n', base_revision: t.headers.get('x-revision') });
    expect(r.status).toBe(200);
    expect(revs('Notes/Team/Shared.md')[0]).toMatchObject({ author_kind: 'collaborator', user_id: ids.cara });
    expect(rows('vault.file.update').at(-1)!.details.author_kind).toBe('collaborator');
    expect((await call(cara, 'POST', '/vault/files', { path: V('Notes/Team/new'), text: 'hi' })).status).toBe(200);
    expect((await call(cara, 'POST', `/vault/files?${new URLSearchParams({ path: V('Notes/Team/up.png') })}`, undefined, Buffer.from('x'))).body.error).toBe('admin_only');
  });

  it('never in a restricted folder or outside the grant, and a hidden file is never named', async () => {
    expect((await call(cara, 'PUT', '/vault/files', { path: V('Notes/Team/Restricted/Secret.md'), text: 'x', base_revision: 'sha256:x' })).status).toBe(404);
    expect((await call(cara, 'POST', '/vault/files', { path: V('Notes/Team/Restricted/new.md'), text: 'x' })).status).toBe(404);
    expect((await call(cara, 'PUT', '/vault/files', { path: V('Notes/Brief.md'), text: 'x', base_revision: 'sha256:x' })).status).toBe(404);
    // Same name as the restricted file in other capitals: refused, without its path.
    const alias = await call(cara, 'POST', '/vault/files', { path: V('Notes/Team/restricted/SECRET.md'), text: 'x' });
    expect([alias.status, alias.body.reason]).toEqual([409, 'case_mismatch']);
    expect(JSON.stringify(alias.body)).not.toMatch(/Restricted|Secret\.md/);
    // The operator is told which file it is.
    expect((await call(admin, 'POST', '/vault/files', { path: V('Notes/Team/restricted/SECRET.md'), text: 'x' })).body.path).toBe(V('Notes/Team/Restricted/Secret.md'));
  });

  it('Contribute removed after the editor opened: the save is refused and nothing is written', async () => {
    const t = await text(cara, V('Notes/Team/Shared.md'));
    const base = t.headers.get('x-revision')!;
    expect((await contribute('cara', 'read')).status).toBe(200);
    try {
      const r = await call(cara, 'PUT', '/vault/files', { path: V('Notes/Team/Shared.md'), text: 'late\n', base_revision: base });
      expect([r.status, r.body.error]).toEqual([403, 'read_only']);
      expect(readFileSync(disk('Notes/Team/Shared.md'), 'utf8')).toBe('by cara\n');
    } finally { await contribute('cara', 'contribute'); }
  });

  it("the link count is the operator's: it counts every note, and a member is refused it", async () => {
    const shared = app.store.fileByPath('Notes/Team/Shared.md')!.id;
    const ins = app.db.prepare("INSERT OR REPLACE INTO kg_signals(src_file,src_anchor,dst_file,dst_anchor,kind,weight,seen_at) VALUES (?,'',?,'','link',1,?)");
    ins.run(app.store.fileByPath('Notes/Team/Read.md')!.id, shared, Date.now());
    ins.run(app.store.fileByPath('Notes/Team/Restricted/Secret.md')!.id, shared, Date.now());
    expect((await call(admin, 'GET', `/vault/backlinks?${new URLSearchParams({ path: V('Notes/Team/Shared.md') })}`)).body.count).toBe(2);
    expect((await call(ana, 'GET', `/vault/backlinks?${new URLSearchParams({ path: V('Notes/Team/Shared.md') })}`)).body.error).toBe('admin_only');
  });

  it("an external member's edit read is audited like a preview, once per revision", async () => {
    const before = rows('vault.preview').length;
    expect((await text(eve, V('Notes/Team/Shared.md'))).status).toBe(200);
    expect((await text(eve, V('Notes/Team/Shared.md'))).status).toBe(200);
    const after = rows('vault.preview');
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.details).toMatchObject({ path: V('Notes/Team/Shared.md'), edit: true });
    expect((await text(cara, V('Notes/Team/Shared.md'))).status).toBe(200);
    expect(rows('vault.preview').length).toBe(before + 1);
  });
});
