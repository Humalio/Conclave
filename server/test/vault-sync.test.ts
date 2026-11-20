/**
 * Vault sync, hub side (docs/vault-sync.md): a reader scoped to one folder, its own change feed and cursor, the rules checked
 * on every page and download, renames across the scope's edge, the coalesced hint, removal, external edits, read-only rules, audit.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const sys = { kind: 'system' as const, id: null };
let app: App, base = '', vaultDir = '', cookie = '', csrf = '', agentId = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const vs = async (method: string, path: string, key: string | null, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/vault-sync/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* bytes */ }
  return { status: r.status, body: json, bytes: buf };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const put = (rel: string, body: string) => { const abs = join(vaultDir, ...rel.split('/')); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, body); };
const V = (rel: string) => rel; // the feed's paths are relative to the vault's root
const audits = (action: string) => (app.db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY id').all(action) as any[]).map((r) => ({ ...r, details: JSON.parse(r.details ?? '{}') }));
const write = async (rel: string, body: string) => app.store.write(rel.split('/'), Buffer.from(body), await app.store.observe(rel.split('/')), 'update', { agentId });
const mv = async (from: string, to: string) => app.store.rename(from.split('/'), to.split('/'), await app.store.observe(from.split('/')), { agentId });

let n = 0;
/** A PC with its app key, and a paired reader on it with the given scope. */
async function reader(scope: { effect: 'allow' | 'deny'; resource: string }[], owner: string | null = null) {
  const i = ++n;
  const pc = (await api('POST', '/pcs', { name: `vs-pc-${i}` })).body.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code' }, sys).secret;
  const made = await api('POST', '/vault-readers', { name: `Notes mirror ${i}`, pc_id: pc, owner, scope });
  expect(made.status).toBe(200);
  const nonce = `nonce-${i}-aaaaaaaaaaaaaaaa`;
  const paired = await vs('POST', '/pair', null, { code: made.body.code, nonce });
  expect(paired.status).toBe(200);
  expect((await vs('POST', '/pair/confirm', null, { nonce })).status).toBe(200);
  return { id: made.body.reader.id as string, pc, appKey, key: paired.body.key as string, code: made.body.code as string };
}
/** Opens the PC's push stream and counts `vault_changed` events. */
async function sse(key: string) {
  const ac = new AbortController();
  const r = await fetch(`${base}/connector/v1/stream?installation=inst-vsync1`, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' }, signal: ac.signal });
  const s = { status: r.status, text: '', hints: () => (s.text.match(/event: vault_changed/g) ?? []).length, cancel: () => ac.abort() };
  const rd = r.body!.getReader(), dec = new TextDecoder();
  void (async () => { try { for (;;) { const { done, value } = await rd.read(); if (done) return; s.text += dec.decode(value); } } catch { /* aborted */ } })();
  return s;
}
const A = [{ effect: 'allow' as const, resource: 'path:/vault/Notes/A/**' }];
const changes = async (key: string, cursor: string | null) => (await vs('GET', `/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, key)).body;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahvsync-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  for (const f of ['Notes/A/one.md', 'Notes/A/two.md', 'Notes/A/Sub/deep.md', 'Notes/B/other.md', 'Notes/B/more.md', '99 Conclave/README.md']) put(f, `# ${f}\n`);
  const config: Config = testConfig(dir, { vaultDir, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.store.scan();
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  agentId = app.keys.createAgent('Writer', null, sys).id;
});
afterAll(async () => { await app.close(); });

describe('identity and pairing', () => {
  it('a reader is a teamless agent with one PC-bound key; the code is single use; the console lists it', async () => {
    const r = await reader(A);
    const c = app.keys.credentials({ kind: 'session_key' }).find((x) => x.bound_machine_id === r.pc)!;
    expect(c.bound_machine_id).toBe(r.pc);
    expect(app.teams.teamsOf?.(c.agent_id!) ?? []).toEqual([]);
    expect((await vs('POST', '/pair', null, { code: r.code, nonce: 'another-nonce-aaaaaaaaaaaa' })).status).toBe(409); // used and confirmed
    const list = (await api('GET', '/vault-readers')).body.readers as any[];
    const row = list.find((x) => x.id === r.id);
    expect(row).toMatchObject({ state: 'active', pairing: 'confirmed', scope: [{ effect: 'allow', resource: 'path:/vault/Notes/A/**' }] });
    expect(row).toHaveProperty('last_sync_at'); expect(row).toHaveProperty('files'); expect(row).toHaveProperty('bytes');
    expect(JSON.stringify(row)).not.toMatch(/ah_ses_|cnv_vsync_/); // no key or code shown again
  });
  it('a wrong code is refused and counted; a reader that is not confirmed cannot sync; a reader key cannot log in', async () => {
    expect((await vs('POST', '/pair', null, { code: 'cnv_vsync_aaaaaaaaaaaaaaaaaaaaaaaaaa', nonce: 'nonce-zzzzzzzzzzzzzzzz' })).status).toBe(401);
    const pc = (await api('POST', '/pcs', { name: 'vs-pc-pend' })).body.pc.id as string;
    const made = await api('POST', '/vault-readers', { name: 'pending', pc_id: pc, scope: A });
    const issued = await vs('POST', '/pair', null, { code: made.body.code, nonce: 'nonce-pending-aaaaaaaa' });
    expect((await vs('GET', '/files', issued.body.key)).status).toBe(401); // not confirmed yet
    const r = await reader(A);
    const appCred = app.keys.verifyKey(r.appKey, 'app_key');
    expect(() => app.keys.login(appCred, r.key)).toThrow(/vault reader/);
  });
  it('version 1 only', async () => {
    const r = await reader(A);
    expect((await vs('GET', '/files?version=2', r.key)).status).toBe(426);
    expect((await vs('GET', '/changes?version=2', r.key)).status).toBe(426);
    expect((await vs('GET', '/files?version=1', r.key)).status).toBe(200);
  });
});

describe('scope is policy, read-only in code', () => {
  it('lists only what the rules allow: the scope folder, never the hub folder or a sibling', async () => {
    const r = await reader(A);
    const f = (await vs('GET', '/files', r.key)).body;
    expect(f.files.map((x: any) => x.path)).toEqual([V('Notes/A/Sub/deep.md'), V('Notes/A/one.md'), V('Notes/A/two.md')]);
    expect(typeof f.cursor).toBe('string');
    const wide = await reader([{ effect: 'allow', resource: 'path:/vault/**' }]);
    expect((await vs('GET', '/files', wide.key)).body.files.some((x: any) => x.path.startsWith('99 Conclave'))).toBe(false); // reserved: the ordinary decision
  });
  it('refuses a rule that allows anything but reading, by any way of editing it', async () => {
    const r = await reader(A);
    const cred = app.keys.credentials({ kind: 'session_key' }).find((x) => x.bound_machine_id === r.pc)!;
    expect(() => app.keys.setRules(cred.policy_id, [{ effect: 'allow', actions: ['fs.update'], resource: 'path:/vault/**' }], 'x', sys)).toThrow(/read-only/);
    expect(() => app.keys.setRules(cred.policy_id, [{ effect: 'allow', actions: ['fs.read', 'fs.download'], resource: 'path:/vault/Notes/**' }], 'x', sys)).not.toThrow();
    expect((await api('PATCH', `/vault-readers/${r.id}`, { scope: [{ effect: 'allow', resource: 'path:/vault/Notes/A/**' }] })).status).toBe(200);
  });
  it('mirroring is an export: without fs.download a file is not in scope', async () => {
    const r = await reader(A);
    const cred = app.keys.credentials({ kind: 'session_key' }).find((x) => x.bound_machine_id === r.pc)!;
    app.keys.setRules(cred.policy_id, [{ effect: 'allow', actions: ['fs.read', 'fs.list'], resource: 'path:/vault/Notes/A/**' }], 'no export', sys);
    expect((await vs('GET', '/files', r.key)).body.files).toEqual([]);
    expect((await vs('GET', `/files/content?path=${encodeURIComponent(V('Notes/A/one.md'))}`, r.key)).status).toBe(403);
  });
});

describe('the change feed', () => {
  it('a change outside the scope leaves no entry, no gap and no hint; one inside does', async () => {
    const r = await reader(A);
    const s = await sse(r.appKey);
    const c0 = (await vs('GET', '/files', r.key)).body.cursor as string;
    await sleep(100);
    await write('Notes/B/other.md', 'changed outside');
    await write('Notes/B/more.md', 'changed outside again');
    await sleep(400);
    expect(s.hints()).toBe(0);
    const out = await changes(r.key, c0);
    expect(out).toMatchObject({ changes: [], reset: false, more: false });
    await write('Notes/A/one.md', 'changed inside');
    await until(() => s.hints() >= 1);
    expect(s.hints()).toBe(1);
    expect(s.text).not.toMatch(/Notes|\.md/); // no paths in the hint
    const inside = await changes(r.key, out.cursor);
    expect(inside.changes).toHaveLength(1);
    expect(inside.changes[0]).toMatchObject({ kind: 'put', path: V('Notes/A/one.md') });
    expect(Object.keys(inside)).not.toContain('seq'); // the vault-wide sequence is never shown
    expect(inside.cursor).not.toBe(out.cursor);
    s.cancel();
  });
  it('hints are coalesced: at most one every 2 seconds per reader', async () => {
    const r = await reader(A);
    const s = await sse(r.appKey);
    await sleep(100);
    await write('Notes/A/two.md', '1'); await write('Notes/A/two.md', '2'); await write('Notes/A/two.md', '3');
    await sleep(500);
    expect(s.hints()).toBe(1);
    expect(await until(() => s.hints() >= 2, 3000)).toBe(true); // the rest, as one
    await sleep(2300);
    expect(s.hints()).toBe(2);
    s.cancel();
  });
  it('a note moved out of the scope is a delete, never the new path; moved in is a put; inside is a rename', async () => {
    const r = await reader(A);
    let cur = (await vs('GET', '/files', r.key)).body.cursor as string;
    await mv('Notes/A/two.md', 'Notes/B/two-moved.md');
    let c = await changes(r.key, cur); cur = c.cursor;
    expect(c.changes).toEqual([{ kind: 'delete', path: V('Notes/A/two.md') }]);
    expect(JSON.stringify(c)).not.toContain('two-moved');
    await mv('Notes/B/two-moved.md', 'Notes/A/two.md');
    c = await changes(r.key, cur); cur = c.cursor;
    expect(c.changes).toMatchObject([{ kind: 'put', path: V('Notes/A/two.md') }]);
    await mv('Notes/A/two.md', 'Notes/A/Sub/two.md');
    c = await changes(r.key, cur);
    expect(c.changes).toMatchObject([{ kind: 'rename', path: V('Notes/A/Sub/two.md'), from: V('Notes/A/two.md') }]);
  });
  it('a delete in scope is a delete', async () => {
    const r = await reader(A);
    const cur = (await vs('GET', '/files', r.key)).body.cursor as string;
    put('Notes/A/gone.md', 'x'); await app.store.scan();
    await app.store.delete(['Notes', 'A', 'gone.md'], await app.store.observe(['Notes', 'A', 'gone.md']), { agentId });
    const c = await changes(r.key, cur);
    expect(c.changes.map((e: any) => e.kind)).toEqual(['put', 'delete']);
  });
  it('an external edit (the watcher and the scan) appears in the reader\'s changes', async () => {
    const r = await reader(A);
    const cur = (await vs('GET', '/files', r.key)).body.cursor as string;
    put('Notes/A/external.md', 'made outside Conclave');
    put('Notes/B/external-b.md', 'made outside, elsewhere');
    await app.store.reconcile(['Notes/A/external.md', 'Notes/B/external-b.md']); // what the watcher calls
    const c = await changes(r.key, cur);
    expect(c.changes).toMatchObject([{ kind: 'put', path: V('Notes/A/external.md') }]);
    put('Notes/A/Sub/scanned.md', 'found by the scan');
    await app.store.scan();
    expect((await changes(r.key, c.cursor)).changes.map((e: any) => e.path)).toEqual([V('Notes/A/Sub/scanned.md')]);
  });
  it('a cursor is opaque: a forged or another reader\'s cursor is a reset, never a position', async () => {
    const r1 = await reader(A), r2 = await reader(A);
    const c1 = (await vs('GET', '/files', r1.key)).body.cursor as string;
    expect((await changes(r2.key, c1)).reset).toBe(true);
    expect((await changes(r1.key, 'AAAA')).reset).toBe(true);
    expect((await changes(r1.key, null)).reset).toBe(true);
    expect((await changes(r1.key, c1)).reset).toBe(false);
  });
});

describe('the rules are checked again on every page and every download', () => {
  it('a deny rule added for a note in the scope refuses its download at once, and the cursor must list again', async () => {
    const r = await reader(A);
    const c0 = (await vs('GET', '/files', r.key)).body.cursor as string;
    const url = `/files/content?path=${encodeURIComponent(V('Notes/A/one.md'))}`;
    const ok = await vs('GET', url, r.key);
    expect(ok.status).toBe(200);
    expect(ok.bytes.length).toBeGreaterThan(0);
    expect((await api('PATCH', `/vault-readers/${r.id}`, { scope: [...A, { effect: 'deny', resource: 'path:/vault/Notes/A/one.md' }] })).status).toBe(200);
    expect((await vs('GET', url, r.key)).status).toBe(403);
    const c = await changes(r.key, c0);
    expect(c.reset).toBe(true);
    expect(c.changes).toEqual([]);
    const f = (await vs('GET', '/files', r.key)).body;
    expect(f.files.map((x: any) => x.path)).not.toContain(V('Notes/A/one.md'));
    expect((await vs('GET', `/files/content?path=${encodeURIComponent(V('Notes/A/Sub/deep.md'))}`, r.key)).status).toBe(200);
  });
  it('a note outside the scope, and the hub folder, are refused', async () => {
    const r = await reader(A);
    for (const p of ['Notes/B/other.md', '99 Conclave/README.md', 'Notes/missing.md']) expect([403]).toContain((await vs('GET', `/files/content?path=${encodeURIComponent(V(p))}`, r.key)).status);
  });
});

describe('pause, remove, and audit', () => {
  it('a paused reader is refused until resumed; a removed one fails on its next request', async () => {
    const r = await reader(A);
    expect((await vs('GET', '/files', r.key)).status).toBe(200);
    expect((await api('POST', `/vault-readers/${r.id}/pause`, {})).status).toBe(200);
    expect((await vs('GET', '/files', r.key)).status).toBe(403);
    expect((await api('POST', `/vault-readers/${r.id}/resume`, {})).status).toBe(200);
    expect((await vs('GET', '/files', r.key)).status).toBe(200);
    expect((await api('DELETE', `/vault-readers/${r.id}`)).status).toBe(200);
    expect((await vs('GET', '/files', r.key)).status).toBe(401);
    expect((await vs('GET', '/changes', r.key)).status).toBe(401);
    expect((await vs('GET', `/files/content?path=${encodeURIComponent(V('Notes/A/one.md'))}`, r.key)).status).toBe(401);
    expect(((await api('GET', '/vault-readers')).body.readers as any[]).some((x) => x.id === r.id)).toBe(false);
  });
  it('one audit entry per sync run; an external owner gets a per-file export.read; an internal one does not', async () => {
    const ext = app.users.create({ username: 'vs-external', external: true, role: 'member', org: 'Partner' }, sys as never) as any;
    const extId = (ext.user?.id ?? ext.id) as string;
    const r = await reader(A, extId), plain = await reader(A);
    const before = audits('export.read').length;
    for (const p of ['Notes/A/one.md', 'Notes/A/Sub/deep.md']) {
      expect((await vs('GET', `/files/content?path=${encodeURIComponent(V(p))}`, r.key)).status).toBe(200);
      expect((await vs('GET', `/files/content?path=${encodeURIComponent(V(p))}`, plain.key)).status).toBe(200);
    }
    const exp = audits('export.read').slice(before);
    expect(exp).toHaveLength(2);
    expect(exp.map((e) => e.details.path).sort()).toEqual([V('Notes/A/Sub/deep.md'), V('Notes/A/one.md')]);
    expect(exp[0].details).toMatchObject({ what: 'vault_file' });
    expect((await vs('POST', '/runs', r.key, { files: 3, bytes: 1234 })).status).toBe(200);
    const runs = audits('vault_sync.run').filter((e) => e.details.reader === `Notes mirror ${n - 1}`);
    expect(runs).toHaveLength(1);
    expect(runs[0].details).toMatchObject({ files: 2, mirror_files: 3, mirror_bytes: 1234 });
    const row = ((await api('GET', '/vault-readers')).body.readers as any[]).find((x) => x.id === r.id);
    expect(row).toMatchObject({ files: 3, bytes: 1234 });
    expect(row.last_sync_at).toBeGreaterThan(0);
  });
});

const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(20); return f(); };
