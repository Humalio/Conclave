/**
 * The fixes from the vault stress test on the demo hub (no corruption and no loss were found; these were the rough edges):
 * audit rows for agent writes and refused writes, a clear reason for a text over the limit, names too long, characters that
 * would be stored changed or read differently (unpaired surrogates, NUL, bidirectional controls), stale-base records that
 * do not pile up, and a rename an editor cannot starve.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey = '';

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
  const f = (name: string, args: Record<string, unknown> = {}) => call(name, { session_token: token, ...args });
  return Object.assign(f, { agentId: agent.id });
}
const rev = (r: Res) => r.structuredContent?.revision as string;
const err = (r: Res) => r.structuredContent?.error as string | undefined;
const msg = (r: Res) => (r.structuredContent?.message ?? r.content[0]?.text ?? '') as string;
const audits = (agentId: string, like = 'vault.file.%') => app.db.prepare("SELECT action, target_id, details FROM audit_events WHERE actor_kind='agent' AND actor_id=? AND action LIKE ? ORDER BY id").all(agentId, like) as { action: string; target_id: string; details: string }[];
const openFor = (path: string) => app.store.conflicts('open').filter((c) => c.path === path);
let W: Awaited<ReturnType<typeof login>>, W2: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahvs-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const { cookie, csrf } = await adminLogin(base);
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  W = await login('writer', [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }]);
  W2 = await login('writer-2', [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }]);
});
afterAll(async () => { await app.close(); });

describe('1. audit rows for agent vault writes, and for refused ones', () => {
  it('every kind of write that lands is an audit event of the agent, with the path and the revisions', async () => {
    const A = await login('audited', [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }]);
    const v1 = rev(await A('file_create', { path: '/vault/Aud/a.md', content: 'one\n' }));
    const v2 = rev(await A('file_update', { path: '/vault/Aud/a.md', content: 'two\n', base_revision: v1 }));
    const v3 = rev(await A('file_patch', { path: '/vault/Aud/a.md', base_revision: v2, edits: [{ old: 'two', new: 'three' }] }));
    const v4 = rev(await A('file_rename', { from: '/vault/Aud/a.md', to: '/vault/Aud/b.md', base_revision: v3 }));
    await A('file_delete', { path: '/vault/Aud/b.md', base_revision: v4 });
    await A('file_restore', { path: '/vault/Aud/b.md', revision: v1, base_revision: 'absent' });
    const rows = audits(A.agentId);
    expect(rows.map((r) => r.action)).toEqual(['vault.file.create', 'vault.file.update', 'vault.file.update', 'vault.file.rename', 'vault.file.delete', 'vault.file.restore']);
    const d = rows.map((r) => JSON.parse(r.details));
    expect(d[0]).toMatchObject({ path: '/vault/Aud/a.md', revision: v1, author_kind: 'agent', tool: 'file_create' });
    expect(d[2]).toMatchObject({ tool: 'file_patch', previous_revision: v2, revision: v3 });
    expect(d[3]).toMatchObject({ from: '/vault/Aud/a.md', path: '/vault/Aud/b.md' });
    expect(rows[3]!.target_id).toBe('/vault/Aud/b.md');
  });

  it('a refused write is recorded with its code and reason: no rights, a read-only agent, a stale base, a bad path', async () => {
    const RO = await login('readonly', [{ effect: 'allow', actions: READ_FS, resource: 'path:/vault/**' }]);
    const base0 = rev(await W('file_create', { path: '/vault/Aud/ro.md', content: 'x\n' }));
    expect(err(await RO('file_update', { path: '/vault/Aud/ro.md', content: 'y\n', base_revision: base0 }))).toBe('denied');
    expect(err(await RO('file_create', { path: '/vault/Aud/new.md', content: 'y\n' }))).toBe('denied');
    expect(err(await RO('file_delete', { path: '/vault/Aud/ro.md', base_revision: base0 }))).toBe('denied');
    const refused = audits(RO.agentId);
    expect(refused.map((r) => r.action)).toEqual(['vault.file.refused', 'vault.file.refused', 'vault.file.refused']);
    expect(refused.map((r) => JSON.parse(r.details).tool)).toEqual(['file_update', 'file_create', 'file_delete']);
    expect(JSON.parse(refused[0]!.details)).toMatchObject({ code: 'denied', path: '/vault/Aud/ro.md' });

    expect(err(await W('file_update', { path: '/vault/Aud/ro.md', content: 'z\n', base_revision: 'sha256:' + '0'.repeat(64) }))).toBe('conflict');
    expect(err(await W('file_create', { path: '/vault/Aud/../../etc/x.md', content: 'z\n' }))).toBe('invalid_path');
    const mine = audits(W.agentId, 'vault.file.refused').map((r) => JSON.parse(r.details));
    expect(mine.some((d) => d.code === 'conflict' && d.tool === 'file_update')).toBe(true);
    expect(mine.some((d) => d.code === 'invalid_path' && d.tool === 'file_create')).toBe(true);
  });
});

describe('2. a text over the limit says so', () => {
  it('exactly 2 MiB is accepted; one byte more answers too_large with the limit and the size', async () => {
    const ok = await W('file_create', { path: '/vault/Big/two.md', content: 'x'.repeat(2 * 1024 * 1024) });
    expect(err(ok)).toBeUndefined();
    const over = await W('file_create', { path: '/vault/Big/over.md', content: 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(err(over)).toBe('too_large');
    expect(msg(over)).toMatch(/2097153 bytes/);
    expect(msg(over)).toMatch(/2 MiB/);
    expect(over.structuredContent).toMatchObject({ limit_bytes: 2 * 1024 * 1024, size_bytes: 2 * 1024 * 1024 + 1 });
  });
  it('the limit counts bytes, not characters: a text of multi-byte characters under 2 MiB of characters is refused for its size', async () => {
    const r = await W('file_create', { path: '/vault/Big/bytes.md', content: 'é'.repeat(1_048_577) });
    expect(err(r)).toBe('too_large');
    expect(msg(r)).toMatch(/2097154 bytes/);
  });
  it('a request body over the route\'s limit is refused with 413 and a reason (never an empty message)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'file_create', arguments: { path: '/vault/Big/x.md', content: 'x'.repeat(2 * 1024 * 1024 + 200 * 1024) } } });
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${appKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
    expect(r.status).toBe(413);
    // /mcp answers in the shape an MCP client reads (a JSON-RPC error), with the size and the limit in the message.
    const j = (await r.json()) as { jsonrpc: string; id: null; error: { code: number; message: string; data: Record<string, number | string> } };
    expect(j.jsonrpc).toBe('2.0');
    expect(j.error.message).toMatch(/^too_large:/);
    expect(j.error.message).toMatch(/2162688 bytes/);
    expect(j.error.message).toMatch(new RegExp(`The request was ${Buffer.byteLength(body)} bytes`));
    expect(j.error.message).toMatch(/2 MiB/);
    expect(j.error.data).toMatchObject({ error: 'too_large', limit_bytes: 2 * 1024 * 1024 + 64 * 1024, text_limit_bytes: 2 * 1024 * 1024, size_bytes: Buffer.byteLength(body) });
  });
  it('an MCP client that sends such a call gets an error whose message says the size and the limit (never an empty one)', async () => {
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
    let text = '';
    try { await c.callTool({ name: 'file_create', arguments: { path: '/vault/Big/y.md', content: 'x'.repeat(2 * 1024 * 1024 + 200 * 1024) } }); } catch (e) { text = e instanceof Error ? e.message : String(e); }
    expect(text).not.toBe('');
    expect(text).toMatch(/too_large/);
    expect(text).toMatch(/2162688/);
    expect(text).toMatch(/2097152/);
  });
  it('a patch that would grow the file past the limit is refused with the same reason', async () => {
    const v = rev(await W('file_create', { path: '/vault/Big/patch.md', content: 'seed\n' + 'y'.repeat(2 * 1024 * 1024 - 20) }));
    const r = await W('file_patch', { path: '/vault/Big/patch.md', base_revision: v, edits: [{ old: 'seed', new: 'z'.repeat(100) }] });
    expect(err(r)).toBe('too_large');
    expect(msg(r)).toMatch(/patched file is \d+ bytes/);
  });
});

describe('3. names too long', () => {
  it('a name over 255 bytes answers invalid_path with the limit, for a file and for a folder', async () => {
    for (const path of ['/vault/Names/' + 'a'.repeat(253) + '.md', '/vault/Names/' + 'a'.repeat(300) + '.md', '/vault/Names/' + 'd'.repeat(256) + '/x.md']) {
      const r = await W('file_create', { path, content: 'x' });
      expect(err(r), path.slice(0, 40)).toBe('invalid_path');
      expect(msg(r)).toMatch(/at most 255 bytes/);
    }
  });
  it('the limit is in bytes of UTF-8: 90 three-byte characters are 270 bytes', async () => {
    const r = await W('file_create', { path: '/vault/Names/' + '漢'.repeat(90) + '.md', content: 'x' });
    expect(err(r)).toBe('invalid_path');
  });
  it('a name of exactly 255 bytes is created, read and replaced (the temporary file no longer carries the name)', async () => {
    if (process.platform === 'win32') return; // the full path would pass Windows\' 260-character limit
    const path = '/vault/Names/' + 'b'.repeat(252) + '.md';
    const v1 = rev(await W('file_create', { path, content: 'one' }));
    expect(err(await W('file_update', { path, content: 'two', base_revision: v1 }))).toBeUndefined();
    expect((await W('file_read', { path })).structuredContent.content).toBe('two');
  });
  it('a long name in a read or a delete is a refusal too, never an internal error', async () => {
    const path = '/vault/Names/' + 'c'.repeat(300) + '.md';
    expect(err(await W('file_read', { path }))).toBe('invalid_path');
    expect(err(await W('file_delete', { path, base_revision: 'absent' }))).toBe('invalid_path');
  });
});

describe('4. characters that would be stored changed or read differently', () => {
  it('an unpaired surrogate in a new name is refused; a well-formed pair (an emoji) is fine', async () => {
    const r = await W('file_create', { path: '/vault/Chars/x\ud800y.md', content: 'x' });
    expect(err(r)).toBe('invalid_path');
    expect(msg(r)).toMatch(/surrogate/);
    expect(err(await W('file_create', { path: '/vault/Chars/\u{1F600}.md', content: 'x' }))).toBeUndefined();
  });
  it('a bidirectional control in a new name is refused (a file or a folder, override or isolate), a right-to-left name is fine', async () => {
    for (const bad of ['‮', '‪', '⁦', '⁩']) {
      const r = await W('file_create', { path: `/vault/Chars/x${bad}gpj.md`, content: 'x' });
      expect(err(r), JSON.stringify(bad)).toBe('invalid_path');
      expect(msg(r)).toMatch(/bidirectional/);
    }
    expect(err(await W('file_create', { path: '/vault/Chars/‮/x.md', content: 'x' }))).toBe('invalid_path');
    expect(err(await W('file_create', { path: '/vault/Chars/שלום.md', content: 'x' }))).toBeUndefined();
    const v = rev(await W('file_create', { path: '/vault/Chars/mv.md', content: 'x' }));
    expect(err(await W('file_rename', { from: '/vault/Chars/mv.md', to: '/vault/Chars/mv‮.md', base_revision: v }))).toBe('invalid_path');
  });
  it('an unpaired surrogate in the text is refused with its position, in create, update and patch', async () => {
    const c = await W('file_create', { path: '/vault/Chars/t1.md', content: 'ab\ud800cd' });
    expect(err(c)).toBe('invalid_argument');
    expect(msg(c)).toMatch(/unpaired surrogate at character 2/);
    const v = rev(await W('file_create', { path: '/vault/Chars/t2.md', content: 'fine\n' }));
    expect(err(await W('file_update', { path: '/vault/Chars/t2.md', content: 'bad\udfff', base_revision: v }))).toBe('invalid_argument');
    const p = await W('file_patch', { path: '/vault/Chars/t2.md', base_revision: v, edits: [{ old: 'fine', new: 'x\ud800' }] });
    expect(err(p)).toBe('invalid_argument');
    expect(msg(p)).toMatch(/edit 0/);
    expect((await W('file_read', { path: '/vault/Chars/t2.md' })).structuredContent.content).toBe('fine\n');
  });
  it('a NUL character in the text is refused with the reason (it would be stored, then unreadable as text)', async () => {
    const r = await W('file_create', { path: '/vault/Chars/nul.md', content: 'a\u0000b' });
    expect(err(r)).toBe('invalid_argument');
    expect(msg(r)).toMatch(/NUL/);
    expect(err(await W('file_read', { path: '/vault/Chars/nul.md' }))).not.toBe(undefined); // nothing was created
  });
  it('a bidirectional override or embedding in the text is refused; isolates, used by right-to-left writing, are accepted', async () => {
    for (const bad of ['‮', '‭', '‪', '‫', '‬']) {
      const r = await W('file_create', { path: '/vault/Chars/bidi.md', content: `if (admin${bad}) {` });
      expect(err(r), JSON.stringify(bad)).toBe('invalid_argument');
      expect(msg(r)).toMatch(/bidirectional/);
    }
    expect(err(await W('file_create', { path: '/vault/Chars/rtl.md', content: 'abc ⁧שלום⁩ def\n' }))).toBeUndefined();
  });
});

describe('5. a lost race that the writer recovered from leaves no open conflict', () => {
  it('a stale write records a conflict; the same agent\'s next write on the file closes it', async () => {
    const v1 = rev(await W('file_create', { path: '/vault/Race/a.md', content: 'v1\n' }));
    rev(await W('file_update', { path: '/vault/Race/a.md', content: 'v2 by W\n', base_revision: v1 }));
    const lost = await W2('file_update', { path: '/vault/Race/a.md', content: 'v2 by W2\n', base_revision: v1 });
    expect(err(lost)).toBe('conflict');
    expect(lost.structuredContent.conflict_id).toBeTruthy();
    expect(openFor('Race/a.md')).toHaveLength(1);
    const cur = lost.structuredContent.current_revision as string;
    expect(err(await W2('file_update', { path: '/vault/Race/a.md', content: 'v3 by W2\n', base_revision: cur }))).toBeUndefined();
    expect(openFor('Race/a.md')).toHaveLength(0);
    const row = app.db.prepare("SELECT status, resolution FROM file_conflicts WHERE id=?").get(lost.structuredContent.conflict_id) as { status: string; resolution: string };
    expect(row.status).toBe('resolved');
    expect(JSON.parse(row.resolution)).toMatchObject({ auto: 'superseded' });
  });
  it('losers of one race share one record, which closes when the first of them recovers; a loser that never retries leaves its own open', async () => {
    const v0 = rev(await W('file_create', { path: '/vault/Race/many.md', content: 'start\n' }));
    const others = await Promise.all([1, 2, 3, 4].map((n) => login(`racer-${n}`, [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }])));
    const results = await Promise.all(others.map((o, i) => o('file_update', { path: '/vault/Race/many.md', content: `by ${i}\n`, base_revision: v0 })));
    const losers = others.filter((_, i) => err(results[i]!) === 'conflict');
    expect(results.filter((r) => !err(r))).toHaveLength(1);
    expect(losers).toHaveLength(3);
    expect(openFor('Race/many.md')).toHaveLength(1); // one lost race, one record
    const first = losers.find((l) => l.agentId === openFor('Race/many.md')[0]!.agent_id)!;
    const cur = rev(await first('file_read', { path: '/vault/Race/many.md' }));
    expect(err(await first('file_update', { path: '/vault/Race/many.md', content: 'recovered\n', base_revision: cur }))).toBeUndefined();
    expect(openFor('Race/many.md')).toHaveLength(0);
  });
  it('an agent that lost several races and then writes has every one of its records closed; another agent\'s stays', async () => {
    const X = await login('loser-x', [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }]);
    const Y = await login('loser-y', [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }]);
    let cur = rev(await W('file_create', { path: '/vault/Race/multi.md', content: 'v0\n' }));
    const staleX = cur;
    let staleY = '';
    for (let i = 1; i <= 3; i++) {
      cur = rev(await W('file_update', { path: '/vault/Race/multi.md', content: `v${i}\n`, base_revision: cur }));
      if (i === 1) staleY = cur;
      expect(err(await X('file_update', { path: '/vault/Race/multi.md', content: 'x\n', base_revision: staleX }))).toBe('conflict');
    }
    expect(err(await Y('file_update', { path: '/vault/Race/multi.md', content: 'y\n', base_revision: staleY }))).toBe('conflict');
    expect(openFor('Race/multi.md').length).toBeGreaterThanOrEqual(3);
    expect(err(await X('file_update', { path: '/vault/Race/multi.md', content: 'x done\n', base_revision: cur }))).toBeUndefined();
    const left = openFor('Race/multi.md');
    expect(left.length).toBeGreaterThanOrEqual(1);
    expect(left.every((c) => c.agent_id !== X.agentId)).toBe(true);
  });
  it('a stale write of exactly what is already there loses nothing and leaves no record', async () => {
    const v1 = rev(await W('file_create', { path: '/vault/Race/same.md', content: 'v1\n' }));
    rev(await W('file_update', { path: '/vault/Race/same.md', content: 'v2\n', base_revision: v1 }));
    const r = await W2('file_update', { path: '/vault/Race/same.md', content: 'v2\n', base_revision: v1 });
    expect(err(r)).toBe('conflict');
    expect(r.structuredContent.conflict_id).toBeUndefined();
    expect(openFor('Race/same.md')).toHaveLength(0);
  });
});

describe('6. a rename an editor cannot starve', () => {
  it('without base_revision the file is moved whatever its content is now; with a stale one it is still refused', async () => {
    const v1 = rev(await W('file_create', { path: '/vault/Ren/busy.md', content: 'v1\n' }));
    rev(await W2('file_update', { path: '/vault/Ren/busy.md', content: 'v2 edited meanwhile\n', base_revision: v1 }));
    expect(err(await W('file_rename', { from: '/vault/Ren/busy.md', to: '/vault/Ren/early.md', base_revision: v1 }))).toBe('conflict');
    const ok = await W('file_rename', { from: '/vault/Ren/busy.md', to: '/vault/Ren/moved.md' });
    expect(err(ok)).toBeUndefined();
    expect((await W('file_read', { path: '/vault/Ren/moved.md' })).structuredContent.content).toBe('v2 edited meanwhile\n');
    expect(err(await W('file_read', { path: '/vault/Ren/busy.md' }))).toBeTruthy();
  });
  it('three editors racing one renamer: the renamer\'s move lands on the first try', async () => {
    await W('file_create', { path: '/vault/Ren/race.md', content: 'start\n' });
    const editors = await Promise.all([1, 2, 3].map((n) => login(`editor-${n}`, [{ effect: 'allow', actions: ALL_FS, resource: 'path:/vault/**' }])));
    let landed = 0;
    const edits = (async () => {
      for (let i = 0; i < 6; i++) {
        await Promise.all(editors.map(async (e) => {
          const cur = rev(await e('file_read', { path: '/vault/Ren/race.md' }));
          if (!cur) return; // the file has moved
          if (!err(await e('file_update', { path: '/vault/Ren/race.md', content: `edit ${i} ${e.agentId}\n`, base_revision: cur }))) landed++;
        }));
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    const mv = await W('file_rename', { from: '/vault/Ren/race.md', to: '/vault/Ren/race-moved.md' });
    await edits;
    expect(err(mv)).toBeUndefined();
    expect(landed).toBeGreaterThanOrEqual(0); // how many edits got in first depends on timing; the move is what matters
    expect(err(await W('file_read', { path: '/vault/Ren/race.md' }))).toBeTruthy();
    expect((await W('file_read', { path: '/vault/Ren/race-moved.md' })).structuredContent.content).toMatch(/^(start|edit d)/);
  });
});
