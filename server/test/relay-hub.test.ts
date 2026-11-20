/**
 * Relays on the hub (docs/relay.md): a registered relay has its own secret; only with it does the hub believe the client address the
 * relay reports; pairing through a relay pins the relay's origin and CA; prompts can be made through a relay; a removed relay's
 * origin and secret stop working; the secret is shown once and never lands in the audit trail, the list or the leak guard.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { redact } from '../src/audit/audit.js';
import { RELAY_SECRET_RE, clientAddress } from '../src/relay/relays.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error plain JS test helper
import { testCa } from './test-ca.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HUB = 'https://hub.test';
const RELAY = 'https://192.168.50.5:8443';
let app: App, base = '', cookie = '', csrf = '', hubCa = '', relayCa = '', dir = '';
let ipSeq = 1;
const freshIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
/** A request as the relay's Caddy sends it: the connection is the relay's, the headers carry its secret and the user's address. */
const via = async (method: string, path: string, o: { secret?: string; client?: string; body?: unknown; origin?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' };
  if (o.secret) headers['x-conclave-relay-secret'] = o.secret;
  if (o.client) headers['x-conclave-relay-client'] = o.client;
  if (o.origin) headers.origin = o.origin;
  const r = await fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const failures = (ip: string) => (app.db.prepare("SELECT COALESCE(SUM(count),0) n FROM usage_counters WHERE scope=? AND metric='admin_login_fail_ip'").get(`ip:${ip}`) as { n: number }).n;
const wrongLogin = (user: string, o: { secret?: string; client?: string }) => via('POST', '/api/login', { ...o, body: { username: user, password: 'definitely-wrong' } });
const register = async (name = 'relay-a', origin = RELAY, ca = relayCa) => (await api('POST', '/relays', { name, origin, ca_sha256: ca })).body as { relay: any; secret: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahrelay-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  mkdirSync(join(dir, 'releases'), { recursive: true });
  const ca = testCa(), other = testCa();
  writeFileSync(join(dir, 'ca.pem'), ca.caPem);
  hubCa = ca.caSha256; relayCa = other.caSha256;
  writeFileSync(join(dir, 'releases', 'conclave-connector-1.2.3.json'), '{"version":"1.2.3"}');
  const config: Config = testConfig(dir, { publicUrl: HUB, caCertFile: join(dir, 'ca.pem'), connectorReleaseDir: join(dir, 'releases'), maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('registering a relay', () => {
  it('makes a secret once, lists the relay without it, and audits without it', async () => {
    const r = await register('reg-a', 'https://10.0.0.1:8443');
    expect(r.secret).toMatch(RELAY_SECRET_RE);
    expect(r.relay).toMatchObject({ name: 'reg-a', origin: 'https://10.0.0.1:8443', ca_sha256: relayCa, last_seen_at: null, release_base: 'https://10.0.0.1:8443/connector/v1/release' });
    const list = (await api('GET', '/relays')).body;
    expect(JSON.stringify(list)).not.toContain(r.secret);
    expect(JSON.stringify(list)).not.toMatch(/ah_rly_/);
    const rows = JSON.stringify(app.db.prepare("SELECT details FROM audit_events WHERE action LIKE 'relay.%'").all());
    expect(rows).toContain('reg-a');
    expect(rows).not.toContain(r.secret.slice(8));
    expect(JSON.stringify(app.db.prepare('SELECT * FROM relays').all())).not.toContain(r.secret.slice(8));
  });
  it('refuses a bad origin, a bad fingerprint and a duplicate', async () => {
    expect((await api('POST', '/relays', { name: 'bad1', origin: 'http://10.0.0.2:8443', ca_sha256: relayCa })).status).toBe(400);
    expect((await api('POST', '/relays', { name: 'bad2', origin: 'https://10.0.0.2:8443/path', ca_sha256: relayCa })).status).toBe(400);
    expect((await api('POST', '/relays', { name: 'bad3', origin: 'https://10.0.0.2:8443', ca_sha256: 'abc' })).status).toBe(400);
    expect((await api('POST', '/relays', { name: 'reg-a', origin: 'https://10.0.0.9:8443', ca_sha256: relayCa })).status).toBe(409);
  });
  it('the secret is an issued key shape for the leak guard and the redaction', async () => {
    const r = await register('leak-a', 'https://10.0.0.3:8443');
    expect(app.guard.scan({ note: `the relay secret is ${r.secret}` })).toMatchObject({ issued: true });
    expect(app.guard.scan({ note: 'ah_rly_' + 'a'.repeat(12) + '_' + 'b'.repeat(32) })).toMatchObject({ issued: false });
    expect(JSON.stringify(redact({ text: `x ${r.secret} y` }))).not.toContain(r.secret.slice(8));
  });
});

describe('the real user address', () => {
  it('ignores X-Conclave-Relay-Client without the secret, or with a wrong one', async () => {
    const r = await register('addr-a', 'https://10.0.0.4:8443');
    await wrongLogin('nobody-1', { client: '203.0.113.50' });
    expect(failures('203.0.113.50')).toBe(0);
    expect(failures('198.51.100.7')).toBeGreaterThan(0); // the connection's own (forwarded by the test proxy) address counted instead
    const wrong = r.secret.slice(0, -1) + (r.secret.endsWith('a') ? 'b' : 'a');
    await wrongLogin('nobody-2', { secret: wrong, client: '203.0.113.51' });
    expect(failures('203.0.113.51')).toBe(0);
    expect((await api('GET', '/relays')).body.relays.find((x: any) => x.name === 'addr-a').last_seen_at).toBeNull();
  });
  it('counts the user\'s address with a valid secret, and records the relay as seen', async () => {
    const r = await register('addr-b', 'https://10.0.0.5:8443');
    await wrongLogin('nobody-3', { secret: r.secret, client: '203.0.113.60' });
    expect(failures('203.0.113.60')).toBe(1);
    const seen = (await api('GET', '/relays')).body.relays.find((x: any) => x.name === 'addr-b');
    expect(seen.last_seen_at).toBeGreaterThan(Date.now() - 60_000);
    expect(seen.last_seen_ip).toBe('203.0.113.60');
    // Another user behind the same relay is not locked out by the first one's failures.
    for (let i = 0; i < 12; i++) await wrongLogin(`nobody-x${i}`, { secret: r.secret, client: '203.0.113.61' });
    expect((await wrongLogin('nobody-4', { secret: r.secret, client: '203.0.113.61' })).status).toBe(429);
    expect((await wrongLogin('nobody-5', { secret: r.secret, client: '203.0.113.62' })).status).toBe(401);
  });
  it('takes only a plain address: anything else keeps the connection address', async () => {
    const r = await register('addr-c', 'https://10.0.0.6:8443');
    expect(clientAddress('203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(clientAddress('203.0.113.9, 10.0.0.1')).toBeNull();
    expect(clientAddress('evil\r\nx: y')).toBeNull();
    await wrongLogin('nobody-6', { secret: r.secret, client: '203.0.113.9, 10.0.0.1' });
    expect(failures('203.0.113.9, 10.0.0.1')).toBe(0);
  });
});

describe('pairing through a relay', () => {
  it('answers the relay\'s origin to a request with a valid secret, and the hub\'s to any other', async () => {
    const r = await register('pair-a', 'https://10.0.0.7:8443');
    const hub = (await via('GET', '/connector/v1/hub')).body;
    expect(hub.origin).toBe(HUB);
    expect((await via('GET', '/connector/v1/hub', { secret: r.secret, client: freshIp() })).body).toEqual({ hub_id: hub.hub_id, origin: 'https://10.0.0.7:8443' });
  });
  it('a code made "through relay" pairs with the relay\'s origin and CA, and only through the relay', async () => {
    const r = await register('pair-b', 'https://10.0.0.8:8443');
    const add = (await api('POST', '/pcs/add', { name: 'pc-relay', relay_id: r.relay.id })).body;
    expect(add.pairing).toMatchObject({ code: add.code, hub_origin: 'https://10.0.0.8:8443', relay: { id: r.relay.id, name: 'pair-b', release_base: 'https://10.0.0.8:8443/connector/v1/release' } });
    expect(add.connector_prompt).toContain('through relay "pair-b"');
    expect(add.prompt.text).toContain(relayCa);
    expect(add.prompt.text).not.toContain(hubCa);
    expect(add.prompt.text).toContain('https://10.0.0.8:8443/connector/v1/release');
    const body = { pairing_code: add.code, hub_origin: 'https://10.0.0.8:8443', hub_ca_sha256: relayCa, platform: 'win32-x64', version: '1.0.0' };
    // Without the secret the relay's origin is not this hub's: refused (and the code is voided, so the next attempt needs a new one).
    expect((await via('POST', '/connector/v1/pair', { body, client: freshIp() })).status).toBe(401);
    const add2 = (await api('POST', '/pcs/add', { name: 'pc-relay2', relay_id: r.relay.id })).body;
    const ok = await via('POST', '/connector/v1/pair', { secret: r.secret, client: freshIp(), body: { ...body, pairing_code: add2.code } });
    expect(ok.status).toBe(200);
    expect(ok.body.hub).toMatchObject({ origin: 'https://10.0.0.8:8443' });
    // Through the relay, the hub's own origin and CA no longer match.
    const add3 = (await api('POST', '/pcs/add', { name: 'pc-relay3' })).body;
    expect((await via('POST', '/connector/v1/pair', { secret: r.secret, client: freshIp(), body: { ...body, pairing_code: add3.code, hub_origin: HUB, hub_ca_sha256: hubCa } })).status).toBe(401);
  });
  it('Re-enrol and a key rotation can be made through a relay, and an unknown relay is refused', async () => {
    const r = await register('pair-c', 'https://10.0.0.10:8443');
    const add = (await api('POST', '/pcs/add', { name: 'pc-relay4' })).body;
    const re = (await api('POST', `/pcs/${add.pc.id}/re-enrol`, { relay_id: r.relay.id })).body;
    expect(re.pairing).toMatchObject({ hub_origin: 'https://10.0.0.10:8443', relay: { name: 'pair-c' } });
    expect((await api('POST', '/pcs/add', { name: 'pc-relay5', relay_id: 'rly_nope' })).status).toBe(404);
  });
});

describe('the console and MCP origin', () => {
  it('a registered relay\'s origin is allowed for MCP while it is registered, and not after', async () => {
    const origin = 'https://10.0.0.11:8443';
    const before = await via('POST', '/mcp', { origin, body: {} });
    expect(before.body.error).toBe('forbidden_origin');
    const r = await register('origin-a', origin);
    expect((await via('POST', '/mcp', { origin, body: {} })).body.error).not.toBe('forbidden_origin');
    expect((await api('DELETE', `/relays/${r.relay.id}`)).status).toBe(200);
    expect((await via('POST', '/mcp', { origin, body: {} })).body.error).toBe('forbidden_origin');
  });
});

describe('rotate and remove', () => {
  it('a rotated secret replaces the old one at once', async () => {
    const r = await register('rot-a', 'https://10.0.0.12:8443');
    const n = (await api('POST', `/relays/${r.relay.id}/rotate`, {})).body;
    expect(n.secret).toMatch(RELAY_SECRET_RE);
    expect(n.secret).not.toBe(r.secret);
    expect(app.relays.verify(r.secret)).toBeNull();
    expect(app.relays.verify(n.secret)?.id).toBe(r.relay.id);
  });
  it('a removed relay\'s secret fails and its origin is no longer allowed', async () => {
    const r = await register('rm-a', 'https://10.0.0.13:8443');
    expect(app.relays.verify(r.secret)?.name).toBe('rm-a');
    expect((await api('DELETE', `/relays/${r.relay.id}`)).status).toBe(200);
    expect(app.relays.verify(r.secret)).toBeNull();
    expect(app.relays.origins()).not.toContain('https://10.0.0.13:8443');
    await wrongLogin('nobody-7', { secret: r.secret, client: '203.0.113.70' });
    expect(failures('203.0.113.70')).toBe(0);
    expect((await api('DELETE', `/relays/${r.relay.id}`)).status).toBe(404);
  });
  it('is the administrator\'s: no session, no relays', async () => {
    const r = await fetch(`${base}/api/relays`);
    expect(r.status).toBe(401);
  });
});

describe('the signed release files', () => {
  const get = (p: string) => fetch(`${base}/connector/v1/release/${p}`, { headers: { 'x-forwarded-proto': 'https' } });
  it('serves a named release file under any tag, and only those', async () => {
    const ok = await get('v1.2.3/conclave-connector-1.2.3.json');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('1.2.3');
    expect((await get('v1.2.3/conclave-connector-9.9.9.json')).status).toBe(404);
    expect((await get('v1.2.3/secret.txt')).status).toBe(404);
    expect((await get('v1.2.3/..%2F..%2Fca.pem')).status).toBe(404);
    expect((await get('..%2Fx/conclave-connector-1.2.3.json')).status).toBe(404);
  });
});
