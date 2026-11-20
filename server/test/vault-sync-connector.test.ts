/**
 * Vault sync, connector side against a real hub (docs/vault-sync.md, "The connector side"): the mirror engine from
 * deploy/client talks to an in-process hub over HTTP. 1,000 files, a note edited (hint to local copy under 5 s), a rename, a
 * delete, a scope change, a hub restart, a dropped stream, a reader removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const sys = { kind: 'system' as const, id: null };
const client = (f: string) => pathToFileURL(join(__dirname, '..', '..', 'deploy', 'client', 'connector', f)).href;
let app: App, base = '', port = 0, dir = '', vaultDir = '', config: Config, cookie = '', csrf = '', agentId = '';
let engineMod: any, storeMod: any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !ok()) await sleep(20); return ok(); };
const adm = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const put = (rel: string, body: string) => { const abs = join(vaultDir, ...rel.split('/')); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, body); };
const write = async (rel: string, body: string) => app.store.write(rel.split('/'), Buffer.from(body), await app.store.observe(rel.split('/')), 'update', { agentId });
const mv = async (from: string, to: string) => app.store.rename(from.split('/'), to.split('/'), await app.store.observe(from.split('/')), { agentId });
const del = async (rel: string) => app.store.delete(rel.split("/"), await app.store.observe(rel.split("/")), { agentId });

/** The same two calls the connector's syncapi.mjs offers, over plain HTTP to the test hub. */
const makeApi = (key: string) => ({
  async json(method: string, path: string, body?: unknown) {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  },
  async download(path: string, dest: string) {
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
    if (r.status !== 200) return { status: r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(dest, buf);
    return { status: 200, revision: r.headers.get('x-conclave-revision'), sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  },
});

let n = 0;
async function reader(scope: { effect: 'allow' | 'deny'; resource: string }[]) {
  const i = ++n;
  const pc = (await adm('POST', '/pcs', { name: `vc-pc-${i}` })).body.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code' }, sys).secret;
  const made = await adm('POST', '/vault-readers', { name: `Mirror ${i}`, pc_id: pc, owner: null, scope });
  const nonce = `nonce-${i}-aaaaaaaaaaaaaaaa`;
  const j = async (p: string, b: unknown) => (await fetch(`${base}/vault-sync/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as Promise<any>;
  const paired = await j('/pair', { code: made.body.code, nonce });
  await j('/pair/confirm', { nonce });
  return { id: made.body.reader.id as string, appKey, key: paired.key as string };
}
async function sse(key: string) {
  const ac = new AbortController();
  const r = await fetch(`${base}/connector/v1/stream?installation=inst-vconn1`, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' }, signal: ac.signal });
  const s = { hints: 0, cancel: () => ac.abort() };
  const rd = r.body!.getReader(), dec = new TextDecoder();
  void (async () => { try { for (;;) { const { done, value } = await rd.read(); if (done) return; s.hints += (dec.decode(value).match(/event: vault_changed/g) ?? []).length; } } catch { /* aborted */ } })();
  return s;
}
const mirror = (id: string, folder: string, home: string) => {
  storeMod.addSync(home, { id, name: id, hub_id: 'hub-t', ca_sha256: 'a'.repeat(64), folder, label: `vsync-${id}`, reader_id: id });
  return storeMod.findSync(home, id);
};
const engineFor = (home: string, id: string, key: string, now?: () => Date) => engineMod.createEngine({ home, rec: storeMod.findSync(home, id), api: makeApi(key), now });
const SCOPE = [{ effect: 'allow' as const, resource: 'path:/vault/Notes/**' }];

async function boot() {
  app = await buildApp(config);
  await app.store.ready;
  await app.store.scan();
  await app.fastify.listen({ port, host: '127.0.0.1' });
  port = (app.fastify.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  engineMod = await import(/* @vite-ignore */ client('syncengine.mjs'));
  storeMod = await import(/* @vite-ignore */ client('syncstore.mjs'));
  dir = mkdtempSync(join(tmpdir(), 'ahvconn-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  for (let i = 0; i < 1000; i++) put(`Notes/bulk/f${String(i).padStart(4, '0')}.md`, `# note ${i}\n`);
  put('Notes/Plan/plan.md', 'plan v1'); put('Notes/Plan/old.md', 'old'); put('Notes/Secret/s.md', 'secret'); put('99 Conclave/README.md', 'hub');
  config = testConfig(dir, { vaultDir, maintenanceSeconds: undefined });
  await boot();
  ({ cookie, csrf } = await adminLogin(base));
  agentId = app.keys.createAgent('Writer', null, sys).id;
});
afterAll(async () => { await app.close(); });

describe('a mirror against a real hub', () => {
  it('1,000 files, a note edited with a hint, a rename, a delete, a scope change, a dropped stream, a hub restart, a removed reader', async () => {
    const r = await reader(SCOPE);
    const home = mkdtempSync(join(tmpdir(), 'ahvconn-home-')), folder = mkdtempSync(join(tmpdir(), 'ahvconn-mirror-'));
    mirror('m1', folder, home);
    const s1 = await sse(r.appKey);
    const text = (p: string) => readFileSync(join(folder, ...p.split('/')), 'utf8');

    // the first run: everything in scope, nothing outside it
    const first = await engineFor(home, 'm1', r.key).runOnce();
    expect(first.full).toBe(true);
    expect(first.files).toBe(1003);
    expect(text('Notes/bulk/f0999.md')).toBe('# note 999\n');
    expect(existsSync(join(folder, '99 Conclave'))).toBe(false);
    expect(readdirSync(folder).sort()).toEqual(['.conclave-trash', 'Notes'].sort());

    // a note edited on the hub: a hint, then the local copy within 5 s
    const hintsBefore = s1.hints;
    const t0 = Date.now();
    await write('Notes/Plan/plan.md', 'plan v2');
    expect(await until(() => s1.hints > hintsBefore, 5000)).toBe(true);
    await engineFor(home, 'm1', r.key).runOnce();
    expect(text('Notes/Plan/plan.md')).toBe('plan v2');
    expect(Date.now() - t0).toBeLessThan(5000);

    // a rename and a delete
    await mv('Notes/Plan/old.md', 'Notes/Plan/older.md');
    await del('Notes/bulk/f0001.md');
    const step = await engineFor(home, 'm1', r.key).runOnce();
    expect(step.renamed).toBe(1);
    expect(existsSync(join(folder, 'Notes/Plan/old.md'))).toBe(false);
    expect(text('Notes/Plan/older.md')).toBe('old');
    expect(existsSync(join(folder, 'Notes/bulk/f0001.md'))).toBe(false);
    const trashed = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.tmp' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); })(join(folder, '.conclave-trash'));
    expect(trashed.some((f) => f.endsWith('f0001.md'))).toBe(true);

    // a local edit, then a hub change to the same note: the edit is kept, the mirror matches the hub
    writeFileSync(join(folder, 'Notes/Plan/plan.md'), 'my local edit');
    writeFileSync(join(folder, 'my-own-file.md'), 'mine');
    await write('Notes/Plan/plan.md', 'plan v3');
    const kept = await engineFor(home, 'm1', r.key).runOnce();
    expect(kept.kept).toBe(1);
    expect(text('Notes/Plan/plan.md')).toBe('plan v3');
    expect(text('my-own-file.md')).toBe('mine');

    // a scope change: Secret is denied, so it leaves the mirror for the trash
    await engineFor(home, 'm1', r.key).runOnce();
    expect(text('Notes/Secret/s.md')).toBe('secret');
    expect((await adm('PATCH', `/vault-readers/${r.id}`, { scope: [...SCOPE, { effect: 'deny', resource: 'path:/vault/Notes/Secret/**' }] })).status).toBe(200);
    const scoped = await engineFor(home, 'm1', r.key).runOnce();
    expect(scoped.full).toBe(true);
    expect(existsSync(join(folder, 'Notes/Secret/s.md'))).toBe(false);
    expect(text('Notes/Plan/plan.md')).toBe('plan v3');

    // a dropped stream: the hint is lost, the next poll still catches up
    s1.cancel();
    await write('Notes/Plan/plan.md', 'plan v4');
    await sleep(300);
    await engineFor(home, 'm1', r.key).runOnce();
    expect(text('Notes/Plan/plan.md')).toBe('plan v4');

    // a hub restart: the cursor survives and the next run is a plain follow, not a reset
    const cursor = storeMod.findSync(home, 'm1').cursor;
    expect(cursor).toBeTruthy();
    await app.close();
    await sleep(200);
    await boot();
    ({ cookie, csrf } = await adminLogin(base));
    await write('Notes/Plan/plan.md', 'plan v5');
    const after = await engineFor(home, 'm1', r.key).runOnce();
    expect(text('Notes/Plan/plan.md')).toBe('plan v5');
    expect(after.full).toBe(false);

    // the reader removed: the sync stops with a clear message, the files and the trash stay
    expect((await adm('DELETE', `/vault-readers/${r.id}`)).status).toBe(200);
    const gone = await engineFor(home, 'm1', r.key).runOnce();
    expect(gone.revoked).toBe(true);
    const rec = storeMod.findSync(home, 'm1');
    expect(rec.state).toBe('revoked');
    expect(rec.last_error).toMatch(/still on disk/);
    expect(text('Notes/Plan/plan.md')).toBe('plan v5');
    expect(existsSync(join(folder, '.conclave-trash'))).toBe(true);
  });
});
