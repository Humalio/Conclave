/**
 * The vault items of the 10 Nov code review's "Unverified (a test would confirm)" list:
 * history after a rename out of a readable folder, case-only renames, Windows trailing dots and spaces,
 * the A->B->A patch race, and a symlink or junction swapped in during a write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey = '', vaultDir = '', outsideDir = '';

type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
const FILE_TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }];
const ALL_FS = ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.rename', 'fs.delete', 'fs.history', 'fs.restore', 'fs.conflicts'];
const READ_FS = ['fs.list', 'fs.read', 'fs.history'];

async function login(label: string, rules: Rules) {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [...FILE_TOOLS, ...rules], 'test', sys);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
  const token = (await call('session_login', { session_key: k.secret })).structuredContent.session_token as string;
  return (name: string, args: Record<string, unknown> = {}) => call(name, { session_token: token, ...args });
}
const disk = (p: string) => join(vaultDir, ...p.split('/'));
const rev = (r: Res) => r.structuredContent.revision as string;
const err = (r: Res) => r.structuredContent?.error as string | undefined;
const activeRows = (lower: string) => app.db.prepare('SELECT path FROM files WHERE lower(path)=? AND deleted_at IS NULL').all(lower) as { path: string }[];
let W: Awaited<ReturnType<typeof login>>;
let caseInsensitive = false;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahvu-'));
  vaultDir = join(dir, 'vault');
  outsideDir = join(dir, 'outside');
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(dir, 'Probe'), 'x');
  caseInsensitive = existsSync(join(dir, 'probe'));
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false,
  };
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!, csrf = ((await r.json()) as { csrf: string }).csrf;
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  W = await login('writer', [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }]);
});
afterAll(async () => { await app.close(); });

describe('1. history and diff after a rename out of a readable folder', () => {
  it('the old folder\'s reader loses the history, a reader of both keeps it, a reader of the new folder sees only what happened there', async () => {
    const P = await login('pub-reader', [{ effect: 'allow', actions: READ_FS, resource: 'path:/vault/Pub/**' }]);
    const S = await login('sec-reader', [{ effect: 'allow', actions: [...READ_FS, 'fs.restore'], resource: 'path:/vault/Sec/**' }]);
    const v1 = rev(await W('file_create', { path: '/vault/Pub/h.md', content: 'public draft\n' }));
    const v2 = rev(await W('file_update', { path: '/vault/Pub/h.md', content: 'public draft, edited\n', base_revision: v1 }));
    expect((await P('file_history', { path: '/vault/Pub/h.md' })).structuredContent.revisions.length).toBe(2);
    await W('file_rename', { from: '/vault/Pub/h.md', to: '/vault/Sec/h.md', base_revision: v2 });

    // The reader of the old folder: nothing at the old path any more, and the new path is denied.
    expect(err(await P('file_history', { path: '/vault/Pub/h.md' }))).toBe('not_found');
    expect(err(await P('file_diff', { path: '/vault/Pub/h.md', from_revision: v1 }))).toBe('not_found');
    expect(err(await P('file_history', { path: '/vault/Sec/h.md' }))).toBe('denied');

    // Allowed on both folders: the whole history, and diffs across the rename.
    const all = (await W('file_history', { path: '/vault/Sec/h.md' })).structuredContent;
    expect(all.revisions.map((r: any) => r.op)).toEqual(['rename', 'update', 'create']);
    expect((await W('file_diff', { path: '/vault/Sec/h.md', from_revision: v1 })).structuredContent.identical).toBe(false);

    // Allowed only on the new folder: revisions recorded at the old path are not shown, nor diffable.
    const sec = (await S('file_history', { path: '/vault/Sec/h.md' })).structuredContent;
    expect(sec.revisions.map((r: any) => [r.op, r.path])).toEqual([['rename', 'Sec/h.md']]);
    expect(JSON.stringify(sec)).not.toContain('Pub/');
    expect(err(await S('file_diff', { path: '/vault/Sec/h.md', from_revision: v1 }))).toBe('not_found');
    expect((await S('file_diff', { path: '/vault/Sec/h.md', from_revision: v2 })).structuredContent.identical).toBe(true);
    // Nor can it restore a revision from the old folder (and then read it): only revisions recorded where it may read.
    expect(err(await S('file_restore', { path: '/vault/Sec/h.md', revision: v1, base_revision: v2 }))).toBe('not_found');
    expect(readFileSync(disk('Sec/h.md'), 'utf8')).toBe('public draft, edited\n');
    expect((await S('file_restore', { path: '/vault/Sec/h.md', revision: v2, base_revision: v2 })).isError).toBeFalsy();
    // A reader of both folders can restore it.
    expect((await W('file_restore', { path: '/vault/Sec/h.md', revision: v1, base_revision: v2 })).structuredContent.revision).toBe(v1);
    expect(readFileSync(disk('Sec/h.md'), 'utf8')).toBe('public draft\n');

    // A new file at the old path has only its own history.
    await W('file_create', { path: '/vault/Pub/h.md', content: 'a new note\n' });
    expect((await P('file_history', { path: '/vault/Pub/h.md' })).structuredContent.revisions.map((r: any) => r.op)).toEqual(['create']);
  });
});

describe('2. case-only rename', () => {
  it('Note.md -> note.md leaves one active row, at the new name, with its history', async (ctx) => {
    if (!caseInsensitive) ctx.skip();
    const v = rev(await W('file_create', { path: '/vault/Case/Note.md', content: 'case\n' }));
    const r = await W('file_rename', { from: '/vault/Case/Note.md', to: '/vault/Case/note.md', base_revision: v });
    expect(r.isError).toBeFalsy();
    expect(readdirSync(disk('Case'))).toEqual(['note.md']);
    expect(activeRows('case/note.md')).toEqual([{ path: 'Case/note.md' }]);
    expect((await W('file_history', { path: '/vault/Case/note.md' })).structuredContent.revisions.map((x: any) => x.op)).toEqual(['rename', 'create']);
    expect(activeRows('case/note.md')).toEqual([{ path: 'Case/note.md' }]);
  });

  it('a renamed-away case variant still refuses a clashing create', async (ctx) => {
    if (!caseInsensitive) ctx.skip();
    expect(err(await W('file_create', { path: '/vault/Case/NOTE.md', content: 'other\n' }))).toBe('conflict');
    expect(activeRows('case/note.md').length).toBe(1);
  });
});

describe('3. trailing dots and spaces', () => {
  it('cannot reach a hidden folder or a denied file through a Windows alias', async () => {
    mkdirSync(disk('.obsidian'), { recursive: true });
    writeFileSync(disk('.obsidian/app.json'), '{"secret":true}');
    writeFileSync(disk('secret.md'), 'top secret\n');
    const D = await login('denied-secret', [
      { effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' },
      { effect: 'deny', actions: ['fs.*'], resource: 'path:/vault/secret.md' },
    ]);
    expect(err(await D('file_read', { path: '/vault/secret.md' }))).toBe('denied');
    const aliases = ['/vault/.obsidian./app.json', '/vault/.obsidian /app.json', '/vault/.obsidian.. /app.json', '/vault/secret.md.', '/vault/secret.md ', '/vault/secret.md. .'];
    for (const p of aliases) {
      const read = await D('file_read', { path: p });
      expect(read.isError, p).toBe(true);
      expect(['invalid_path', 'denied'], p).toContain(err(read));
      expect(JSON.stringify(read.structuredContent), p).not.toContain('secret');
      expect(['invalid_path', 'denied'], p).toContain(err(await D('file_update', { path: p, content: 'overwritten\n', base_revision: 'absent' })));
      expect(['invalid_path', 'denied'], p).toContain(err(await D('file_history', { path: p })));
    }
    expect(['invalid_path', 'denied']).toContain(err(await D('file_create', { path: '/vault/.obsidian./plugins.json', content: '{}' })));
    expect(['invalid_path', 'denied']).toContain(err(await D('file_list', { path: '/vault/.obsidian.' })));
    expect(['invalid_path', 'denied']).toContain(err(await D('file_rename', { from: '/vault/secret.md ', to: '/vault/public.md', base_revision: 'x' })));
    expect(readdirSync(disk('.obsidian'))).toEqual(['app.json']);
    expect(readFileSync(disk('secret.md'), 'utf8')).toBe('top secret\n');
    expect(existsSync(disk('public.md'))).toBe(false);
  });

  it('a file whose name ends in a dot or a space is not listed or indexed, so nothing points at an unreachable path', async () => {
    // Windows strips such names; the \\?\ prefix creates one anyway, as Linux or a sync tool could.
    const raw = (name: string) => (process.platform === 'win32' ? `\\\\?\\${disk(name)}` : disk(name));
    try { writeFileSync(raw('odd.'), 'odd\n'); writeFileSync(raw('odd2 '), 'odd\n'); } catch { return; }
    writeFileSync(disk('plain.md'), 'plain\n');
    const names = (await W('file_list', { path: '/vault' })).structuredContent.entries.map((e: any) => e.name);
    expect(names).toContain('plain.md');
    expect(names).not.toContain('odd.');
    expect(names).not.toContain('odd2 ');
    await app.store.scan();
    expect(app.db.prepare("SELECT path FROM files WHERE path IN ('odd.','odd2 ')").all()).toEqual([]);
  });
});

describe('2b. names that differ only by case (case-insensitive file systems)', () => {
  it('cannot read, write or rename a denied file through a case variant, and records no second row', async (ctx) => {
    if (!caseInsensitive) ctx.skip();
    writeFileSync(disk('Private.md'), 'private\n');
    const D = await login('denied-private', [
      { effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' },
      { effect: 'deny', actions: ['fs.*'], resource: 'path:/vault/Private.md' },
    ]);
    const before = (await W('file_history', { path: '/vault/Private.md' })).structuredContent.current_revision as string;
    for (const p of ['/vault/private.md', '/vault/PRIVATE.md']) {
      const read = await D('file_read', { path: p });
      expect(read.isError, p).toBe(true);
      expect(JSON.stringify(read.structuredContent), p).not.toContain('private\\n');
      expect(err(await D('file_update', { path: p, content: 'overwritten\n', base_revision: before }))).toBe('conflict');
      expect(err(await D('file_delete', { path: p, base_revision: before }))).toBe('conflict');
      expect(err(await D('file_rename', { from: p, to: '/vault/stolen.md', base_revision: before }))).toBe('conflict');
      expect(err(await D('file_history', { path: p }))).toBe('not_found');
    }
    expect(readFileSync(disk('Private.md'), 'utf8')).toBe('private\n');
    expect(existsSync(disk('stolen.md'))).toBe(false);
    expect(activeRows('private.md')).toEqual([{ path: 'Private.md' }]);
  });
});

describe('4. file_patch and an A->B->A race', () => {
  it('a base equal to the current content is accepted (revisions are content hashes); a stale one is refused', async () => {
    const a = rev(await W('file_create', { path: '/vault/aba.md', content: 'alpha\n' }));
    const b = rev(await W('file_update', { path: '/vault/aba.md', content: 'beta\n', base_revision: a }));
    expect(rev(await W('file_update', { path: '/vault/aba.md', content: 'alpha\n', base_revision: b }))).toBe(a);
    // Someone who read B now patches: refused, the content moved on.
    const stale = await W('file_patch', { path: '/vault/aba.md', base_revision: b, edits: [{ old: 'beta', new: 'gamma' }] });
    expect(err(stale)).toBe('conflict');
    expect(stale.structuredContent.current_revision).toBe(a);
    // Someone who read the first A: the bytes are exactly what they read, so the patch applies to them.
    const p = await W('file_patch', { path: '/vault/aba.md', base_revision: a, edits: [{ old: 'alpha', new: 'alpha, patched' }] });
    expect(p.isError).toBeFalsy();
    expect(readFileSync(disk('aba.md'), 'utf8')).toBe('alpha, patched\n');
    // History keeps the intermediate B, so the round trip is visible.
    expect((await W('file_history', { path: '/vault/aba.md' })).structuredContent.revisions.map((r: any) => r.op)).toEqual(['patch', 'update', 'update', 'create']);
  });
});

describe('5. a symlink or junction swapped in during a write', () => {
  const swap = (folder: string) => () => {
    renameSync(disk(folder), disk(`${folder}-real`));
    symlinkSync(outsideDir, disk(folder), 'junction');
  };
  const unswap = (folder: string) => { rmSync(disk(folder), { force: true, recursive: false }); renameSync(disk(`${folder}-real`), disk(folder)); };

  it('a create cannot land outside the vault when its folder becomes a link before the file is opened', async () => {
    await W('file_create', { path: '/vault/Swap1/keep.md', content: 'keep\n' });
    app.store.hooks.beforeTmp = swap('Swap1');
    try {
      const r = await W('file_create', { path: '/vault/Swap1/new.md', content: 'escaped?\n' });
      expect(r.isError).toBe(true);
    } finally { app.store.hooks.beforeTmp = undefined; }
    expect(readdirSync(outsideDir)).toEqual([]);
    unswap('Swap1');
    expect(readdirSync(disk('Swap1')).filter((n) => !n.endsWith('.hub-tmp'))).toEqual(['keep.md']);
  });

  it('an update cannot be committed through a folder that became a link after staging', async () => {
    const v = rev(await W('file_create', { path: '/vault/Swap2/a.md', content: 'inside\n' }));
    writeFileSync(join(outsideDir, 'a.md'), 'inside\n');
    app.store.hooks.afterTmp = swap('Swap2');
    try {
      const r = await W('file_update', { path: '/vault/Swap2/a.md', content: 'changed\n', base_revision: v });
      expect(r.isError).toBe(true);
    } finally { app.store.hooks.afterTmp = undefined; }
    expect(readFileSync(join(outsideDir, 'a.md'), 'utf8')).toBe('inside\n');
    expect(readdirSync(outsideDir)).toEqual(['a.md']);
    rmSync(join(outsideDir, 'a.md'));
    unswap('Swap2');
    expect(readFileSync(disk('Swap2/a.md'), 'utf8')).toBe('inside\n');
  });
});
