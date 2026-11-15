/**
 * The connector's service is the bridge (docs/transfers.md, docs/connector.md "File transfers"): the hub accepts the PC's
 * app key on the bridge's poll and channel routes, for that PC's own transfers and approved folders only, refuses it
 * once the PC is suspended, and never lets it pair. A key of another kind is refused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const bridge = async (method: string, path: string, key: string | null, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/bridge${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const newPc = async (name: string, folder?: string) => {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  if (folder) app.db.prepare("INSERT INTO machine_folders(machine_id,path,status,proposed_at,decided_at) VALUES (?,?,'approved',?,?)").run(id, folder, Date.now(), Date.now());
  return { id, key: app.keys.createAppKey({ machineId: id, appName: 'conclave-connector', maxLiveSessions: 10 }, sys).secret };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbrapp-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir, { maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('the bridge routes take the PC app key', () => {
  it('polls with the app key: that PC\'s approved folders only, and it counts as a bridge heartbeat', async () => {
    const folder = process.platform === 'win32' ? 'C:\\Users\\dev\\shared' : '/home/dev/shared';
    const a = await newPc('appkey-poll-a', folder);
    await newPc('appkey-poll-b', process.platform === 'win32' ? 'C:\\Users\\other\\x' : '/home/other/x');
    const r = await bridge('POST', '/poll', a.key, { version: '0.9.0', wait_s: 0, os: process.platform });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jobs: [], allowed_folders: [folder] });
    const seen = app.db.prepare('SELECT bridge_last_seen_at, bridge_version FROM machines WHERE id=?').get(a.id) as { bridge_last_seen_at: number | null; bridge_version: string | null };
    expect(seen.bridge_last_seen_at).not.toBeNull();
    expect(seen.bridge_version).toBe('0.9.0');
  });

  it('answers a channel route with the app key as with the bridge key: an unknown channel is not found, not unauthorized', async () => {
    const a = await newPc('appkey-channel');
    const r = await bridge('GET', '/channels/chn_doesnotexist?role=send', a.key);
    expect(r.status).not.toBe(401);
  });

  it('refuses the app key once the PC is suspended', async () => {
    const a = await newPc('appkey-suspended');
    expect((await bridge('POST', '/poll', a.key, { wait_s: 0 })).status).toBe(200);
    expect((await api('POST', `/pcs/${a.id}/suspend`, {})).status).toBe(200);
    expect((await bridge('POST', '/poll', a.key, { wait_s: 0 })).status).toBe(401);
    expect((await bridge('GET', '/channels/chn_x?role=send', a.key)).status).toBe(401);
  });

  it('refuses a key that is no app key or bridge key, and a revoked app key', async () => {
    expect((await bridge('POST', '/poll', 'ah_ses_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { wait_s: 0 })).status).toBe(401);
    expect((await bridge('POST', '/poll', null, { wait_s: 0 })).status).toBe(401);
    const a = await newPc('appkey-revoked');
    const cred = app.db.prepare("SELECT id FROM credentials WHERE machine_id=? AND kind='app_key'").get(a.id) as { id: string };
    app.keys.setStatus(cred.id, 'revoked', 'test', sys);
    expect((await bridge('POST', '/poll', a.key, { wait_s: 0 })).status).toBe(401);
  });

  it('never pairs with an app key: pairing takes a pairing code only', async () => {
    const a = await newPc('appkey-pair');
    const r = await bridge('POST', '/pair', a.key, { pairing_code: a.key.slice(0, 40) });
    expect(r.status).toBe(401);
    expect(r.body.bridge_key).toBeUndefined();
  });
});
