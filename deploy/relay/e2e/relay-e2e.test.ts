/**
 * Relay end to end (docs/relay.md, "Testing"), run only by deploy/relay/e2e/run-on-5.sh: a throwaway hub in this container, the hub's own
 * Caddy (`hubtls`, internal CA, name hub.test) and the real relay.Caddyfile in front. Every PC-side request goes
 * PC -> relay (by IP, relay CA pinned) -> hubtls -> hub. Steps wait on files in /shared that run.sh answers.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error plain JS test helper
import { testCa } from './test-ca.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 120_000 });

const SH = '/shared';
const HOLD_MS = Number(process.env.STREAM_HOLD_S ?? 360) * 1000;
const RELAY_IP = '172.31.77.10', HUBTLS_IP = '172.31.77.11';
const RELAY = `https://${RELAY_IP}:9443`;
const MY_IP = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && a.address.startsWith('172.31.77.'))!.address;
let app: App, base = '', cookie = '', csrf = '', relayPem = '', relaySha = '', secret = '', appKey = '', pcId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signal = (name: string) => writeFileSync(join(SH, name), '');
const waitFor = async (name: string, ms = 90_000) => { const t0 = Date.now(); while (!existsSync(join(SH, name))) { if (Date.now() - t0 > ms) throw new Error(`no ${name}`); await sleep(200); } };
/** Strings the relay log must not hold; run.sh greps for each. */
const needle = (s: string) => appendFileSync(join(SH, 'needles'), s + '\n');

type Res = { status: number; headers: http.IncomingHttpHeaders; text: string };
/** A request to the relay as a PC sends it: by IP (no SNI), with the relay's CA pinned. */
const viaRelay = (method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}) => new Promise<Res>((resolve, reject) => {
  const req = https.request({ host: RELAY_IP, port: 9443, path, method, ca: relayPem, headers: { ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}), ...o.headers } }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (o.body !== undefined) req.write(o.body);
  req.end();
});
const json = (r: Res) => { try { return JSON.parse(r.text); } catch { return {}; } };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const failures = (ip: string) => (app.db.prepare("SELECT COALESCE(SUM(count),0) n FROM usage_counters WHERE scope=? AND metric='admin_login_fail_ip'").get(`ip:${ip}`) as { n: number }).n;

/** The push stream through the relay: counts `event: orders` and heartbeats; `ended` resolves when the connection ends. */
function openStream(key: string) {
  const s = { status: 0, text: '', orders: 0, beats: 0, ended: null as Promise<string> | null, req: null as http.ClientRequest | null };
  return new Promise<typeof s>((resolve, reject) => {
    let done: (why: string) => void = () => {};
    s.ended = new Promise((r) => { done = r; });
    s.req = https.request({ host: RELAY_IP, port: 9443, path: '/connector/v1/stream?installation=inst-e2e001', method: 'GET', ca: relayPem, headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' } }, (res) => {
      s.status = res.statusCode!;
      res.on('data', (c: Buffer) => { s.text += c.toString(); s.orders = (s.text.match(/event: orders/g) ?? []).length; s.beats = (s.text.match(/: hb/g) ?? []).length; });
      res.on('end', () => done('end'));
      res.on('error', () => done('error'));
      res.on('close', () => done('close'));
      resolve(s);
    });
    s.req.on('error', (e) => { done('error'); if (!s.status) reject(e); });
    s.req.end();
  });
}
const until = async (f: () => boolean, ms: number) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(50); return f(); };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrelay-e2e-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  mkdirSync(join(dir, 'releases'), { recursive: true });
  const ca = testCa();
  writeFileSync(join(dir, 'ca.pem'), ca.caPem);
  writeFileSync(join(dir, 'releases', 'conclave-connector-9.9.9.json'), '{"version":"9.9.9"}');
  const config: Config = testConfig(dir, { publicUrl: 'https://hub.test', caCertFile: join(dir, 'ca.pem'), connectorReleaseDir: join(dir, 'releases'), maintenanceSeconds: undefined, trustProxy: HUBTLS_IP });
  // As in production (deploy/docker-compose.https.yml, TRUST_PROXY): the hub trusts only its own Caddy's forwarded headers.
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 8080, host: '0.0.0.0' });
  base = 'http://127.0.0.1:8080';
  ({ cookie, csrf } = await adminLogin(base));
  needle(cookie.split('=').slice(1).join('=').split(';')[0]!);
  needle(csrf);
  signal('hub-up');
  await waitFor('relay-up');
  // A new PC fetches the relay's CA over plain HTTP and checks it against the fingerprint in its prompt.
  relayPem = await new Promise<string>((res, rej) => http.get(`http://${RELAY_IP}:9080/onboard/ca.crt`, (r) => { let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => res(t)); }).on('error', rej));
  relaySha = createHash('sha256').update(new X509Certificate(relayPem).raw).digest('hex');
});
afterAll(async () => { signal('done'); await app.close(); });

describe('relay end to end', () => {
  it('serves its own CA, and passes requests on before it has a secret, as direct ones', async () => {
    expect(new X509Certificate(relayPem).subject).toMatch(/Caddy Local Authority/);
    const r = await viaRelay('GET', '/connector/v1/hub');
    expect(r.status).toBe(200);
    expect(json(r).origin).toBe('https://hub.test');
  });

  it('once registered and given its secret, answers the relay origin', async () => {
    const reg = await api('POST', '/relays', { name: 'e2e-relay', origin: RELAY, ca_sha256: relaySha });
    expect(reg.status).toBe(200);
    secret = reg.body.secret;
    needle(secret);
    writeFileSync(join(SH, 'secret'), secret);
    signal('secret-ready');
    await waitFor('relay-restarted');
    const r = await viaRelay('GET', '/connector/v1/hub');
    expect(json(r).origin).toBe(RELAY);
    const seen = (await api('GET', '/relays')).body.relays.find((x: any) => x.name === 'e2e-relay');
    expect(seen.last_seen_ip).toBe(MY_IP);
  });

  it('a forged relay header from the PC changes nothing', async () => {
    const r = await viaRelay('GET', '/connector/v1/hub', { headers: { 'x-conclave-relay-client': '203.0.113.9', 'x-conclave-relay-secret': 'ah_rly_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'x-forwarded-for': '203.0.113.8' } });
    expect(json(r).origin).toBe(RELAY);
    const seen = (await api('GET', '/relays')).body.relays.find((x: any) => x.name === 'e2e-relay');
    expect(seen.last_seen_ip).toBe(MY_IP);
  });

  it('a wrong login counts the user\'s address, not the relay\'s or the hub proxy\'s', async () => {
    const before = failures(MY_IP);
    const r = await viaRelay('POST', '/api/login', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'definitely-wrong' }) });
    expect(r.status).toBe(401);
    expect(failures(MY_IP)).toBe(before + 1);
    expect(failures(RELAY_IP)).toBe(0);
    expect(failures(HUBTLS_IP)).toBe(0);
  });

  it('pairs a PC through the relay, pinning the relay\'s origin and CA', async () => {
    const add = (await api('POST', '/pcs/add', { name: 'e2e-pc', relay_id: (await api('GET', '/relays')).body.relays.find((x: any) => x.name === 'e2e-relay').id })).body;
    expect(add.pairing.hub_origin).toBe(RELAY);
    expect(add.prompt.text ?? add.prompt).toContain(relaySha);
    needle(add.code);
    const p = await viaRelay('POST', '/connector/v1/pair', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairing_code: add.code, hub_origin: RELAY, hub_ca_sha256: relaySha, platform: 'linux-x64', version: '1.0.0' }) });
    expect(p.status, p.text).toBe(200);
    appKey = json(p).app_key;
    pcId = json(p).pc.id;
    needle(appKey);
    const t = await viaRelay('GET', '/connector/v1/setup', { headers: { authorization: `Bearer ${appKey}` } });
    expect(t.status).toBe(200);
    expect(json(t).steps[1]).toMatchObject({ step: 'paired', state: 'done' });
  });

  it('carries MCP: initialize and tools/list with the PC\'s app key', async () => {
    const h = { authorization: `Bearer ${appKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await viaRelay('POST', '/mcp', { headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } }) });
    expect(init.status, init.text).toBe(200);
    expect(init.text).toContain('serverInfo');
    const sid = init.headers['mcp-session-id'] as string | undefined;
    const h2 = { ...h, ...(sid ? { 'mcp-session-id': sid } : {}), 'mcp-protocol-version': '2025-06-18' };
    await viaRelay('POST', '/mcp', { headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const list = await viaRelay('POST', '/mcp', { headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(list.status, list.text).toBe(200);
    expect(list.text).toContain('session_login');
  });

  it('passes the signed release files on', async () => {
    const r = await viaRelay('GET', '/connector/v1/release/v9.9.9/conclave-connector-9.9.9.json');
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"version":"9.9.9"}');
  });

  it('carries a file at the hub\'s limit, and the hub refuses one byte more', async () => {
    const max = 2 * 1024 * 1024;
    const h = { cookie, 'x-csrf-token': csrf, origin: RELAY, 'content-type': 'application/octet-stream' };
    const ok = await viaRelay('POST', '/api/vault/files?path=/vault/e2e-relay-limit.md', { headers: h, body: Buffer.alloc(max, 0x61) });
    expect(ok.status, ok.text.slice(0, 300)).toBe(200);
    expect(app.db.prepare("SELECT details FROM audit_events WHERE action='vault.file.create' ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({ details: expect.stringContaining(`"bytes":${max}`) });
    const over = await viaRelay('POST', '/api/vault/files?path=/vault/e2e-relay-over.md', { headers: h, body: Buffer.alloc(max + 2, 0x61) });
    expect(over.status).toBe(413);
  });

  it('keeps the push stream open past the 65 s silence, tells at once, and comes back after a forced drop', async () => {
    const a = app.keys.createAgent('e2e-agent', null, { kind: 'system' as const, id: null });
    app.keys.createSessionKey({ agentId: a.id, label: 'k', machineId: pcId }, { kind: 'system' as const, id: null });
    const s = await openStream(appKey);
    expect(s.status).toBe(200);
    expect(await until(() => s.orders >= 1, 5000)).toBe(true);
    const t0 = Date.now();
    app.keys.notify(a.id, 'task_assigned', 'x', { task: 'task_e2e', state: 'assigned' });
    expect(await until(() => s.orders >= 2, 3000)).toBe(true);
    const tell = Date.now() - t0;
    expect(tell).toBeLessThan(2000);
    // Hold it past Caddy's old 5-minute read_body (6 min by default, STREAM_HOLD_S): heartbeats flow and no relay timeout closes it.
    const still = await Promise.race([s.ended!.then(() => false), sleep(HOLD_MS).then(() => true)]);
    expect(still).toBe(true);
    expect(s.beats).toBeGreaterThanOrEqual(Math.floor(HOLD_MS / 20_000) - 1);
    // Forced drop: run.sh restarts the relay container; the stream ends, and a new one opens through the new relay.
    signal('drop');
    const why = await Promise.race([s.ended!, sleep(30_000).then(() => 'still open')]);
    expect(why).not.toBe('still open');
    await waitFor('relay-back');
    let again: Awaited<ReturnType<typeof openStream>> | null = null;
    for (let i = 0; i < 20 && !again; i++) { try { const x = await openStream(appKey); if (x.status === 200) again = x; else await sleep(500); } catch { await sleep(500); } }
    expect(again?.status).toBe(200);
    expect(await until(() => (again?.orders ?? 0) >= 1, 5000)).toBe(true);
    again!.req!.destroy();
    writeFileSync(join(SH, 'report'), `tell_ms=${tell} held_s=${HOLD_MS / 1000} beats=${s.beats} drop=${why}\n`);
  });
});
