/**
 * The guards on the onboarding routes (docs/onboarding.md; acceptance gaps 1, 4, 5, 10 and 11):
 * - a lockdown refuses filing and pickup with 423, and the request's status stays readable (onboarding.md:90, :190);
 * - a suspended PC or PC key is refused everything (onboarding.md:190);
 * - 10 bad PC keys from one address in an hour: the next call is rate_limited, the onboarding_auth_fail alert fires and each
 *   failure is recorded (onboarding.md:90);
 * - request folders with .., a wildcard, a path outside /vault/ or over 400 characters get invalid_argument naming the field
 *   (onboarding.md:230, :682);
 * - approving a slot whose ceiling writes on the vault root needs confirm_root_write: true (onboarding.md:88).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { AUTH_FAILS_PER_HOUR } from '../src/onboarding/onboarding.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base: string, cookie = '', csrf = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
/** A call to /onboard/*; from= sets the client address (through the trusted loopback proxy). */
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.from) { headers['x-forwarded-for'] = o.from; headers['x-forwarded-proto'] = 'https'; }
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const nonce = () => `n${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24).padEnd(20, 'x');
let ipSeq = 1;
const freshIp = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

const addAndEnrol = async (name: string) => {
  const add = await api('POST', '/pcs/add', { name });
  expect(add.status).toBe(200);
  const n = nonce(), from = freshIp();
  const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
  expect(e.status).toBe(200);
  expect((await ob('POST', '/enrol/confirm', { body: { nonce: n }, from })).status).toBe(200);
  return { pc: add.body.pc.id as string, key: e.body.app_key as string, keyId: add.body.key.id as string };
};
let projSeq = 0;
const request = (folders: unknown[] = [{ path: '/vault/Grants', access: 'write' }]) => ({
  kind: 'new_team', project: { name: `Guard ${++projSeq}`, existing: false },
  team: { name: `Guard team ${projSeq}`, goal: 'Keep the grant calendar.' },
  roles: [
    { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans and assigns.' },
    { name: 'writer', team_role: 'worker', count: 1, job: 'Writes entries.', folders },
  ],
  prompt: 'a team that keeps our grant calendar',
  client: { app: 'claude-code', os: 'windows' },
});
const file = async (key: string, folders?: unknown[]) => {
  const f = await ob('POST', '/requests', { key, body: request(folders), from: freshIp() });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  return f.body as { request_id: string; version: number };
};
const lock = async (scope: string, id: string | undefined, on: boolean) => expect((await api('POST', '/lockdown', { scope, id, on })).status).toBe(200);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahobg-'));
  mkdirSync(join(dir, 'vault', 'Grants'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}}\n');
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('lockdown (gap 1)', () => {
  for (const [scope, label] of [['writes', 'all writes'], ['pc', 'this PC']] as const) {
    it(`a lockdown of ${label} refuses filing and pickup with 423; the request's status stays readable`, async () => {
      const pc = await addAndEnrol(`lock-${scope}`);
      const f = await file(pc.key);
      const ap = await api('POST', `/onboarding/${f.request_id}/approve`, { version: f.version });
      expect(ap.status, JSON.stringify(ap.body)).toBe(200);
      await lock(scope, scope === 'pc' ? pc.pc : undefined, true);
      try {
        const filed = await ob('POST', '/requests', { key: pc.key, body: request(), from: freshIp() });
        expect(filed.status).toBe(423);
        expect(filed.body.error).toBe('lockdown');
        const picked = await ob('POST', '/pickup', { key: pc.key, body: { request_id: f.request_id }, from: freshIp() });
        expect(picked.status).toBe(423);
        expect(picked.body.error).toBe('lockdown');
        expect(JSON.stringify(picked.body)).not.toMatch(/cnv_|ah_sess_/);
        const st = await ob('GET', `/requests/${f.request_id}`, { key: pc.key, from: freshIp() });
        expect(st.status, JSON.stringify(st.body)).toBe(200);
        expect(st.body.request_id ?? st.body.id).toBe(f.request_id);
        expect((await ob('GET', '/requests', { key: pc.key, from: freshIp() })).status).toBe(200);
      } finally { await lock(scope, scope === 'pc' ? pc.pc : undefined, false); }
      // Lifted: the pickup works again.
      expect((await ob('POST', '/pickup', { key: pc.key, body: { request_id: f.request_id }, from: freshIp() })).status).toBe(200);
    });
  }
});

describe('suspended PC or PC key (gap 4)', () => {
  const refusedEverywhere = async (key: string, requestId: string) => {
    const calls = [
      ob('POST', '/requests', { key, body: request(), from: freshIp() }),
      ob('GET', '/requests', { key, from: freshIp() }),
      ob('GET', `/requests/${requestId}`, { key, from: freshIp() }),
      ob('PUT', `/requests/${requestId}`, { key, body: { version: 1 }, from: freshIp() }),
      ob('POST', `/requests/${requestId}/withdraw`, { key, from: freshIp() }),
      ob('POST', '/pickup', { key, body: { request_id: requestId }, from: freshIp() }),
      ob('POST', '/key-pickup', { key, body: { code: 'cnv_pick_anything' }, from: freshIp() }),
      ob('POST', '/pickup/confirm', { key, body: { pickup_id: 'x', written: true }, from: freshIp() }),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status, JSON.stringify(r.body)).toBe(401);
      expect(r.body.error).toBe('unauthorized');
      expect(r.body.message).toBe('This PC or its key is suspended.');
    }
  };
  it('a suspended PC: every call with its key is refused', async () => {
    const pc = await addAndEnrol('susp-pc');
    const f = await file(pc.key);
    expect((await api('POST', `/onboarding/${f.request_id}/approve`, { version: f.version })).status).toBe(200);
    expect((await api('POST', `/pcs/${pc.pc}/suspend`)).status).toBe(200);
    await refusedEverywhere(pc.key, f.request_id);
  });
  it('a suspended PC key: every call with it is refused', async () => {
    const pc = await addAndEnrol('susp-key');
    const f = await file(pc.key);
    expect((await api('POST', `/onboarding/${f.request_id}/approve`, { version: f.version })).status).toBe(200);
    const s = await api('POST', `/keys/${pc.keyId}/suspend`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    await refusedEverywhere(pc.key, f.request_id);
  });
});

describe('brute force on the PC key (gap 5)', () => {
  it('10 bad keys from one address: the next call is rate_limited, onboarding_auth_fail fires, each failure is recorded', async () => {
    const pc = await addAndEnrol('brute');
    const from = '10.66.0.9';
    expect(AUTH_FAILS_PER_HOUR).toBe(10);
    for (let i = 0; i < AUTH_FAILS_PER_HOUR; i++) {
      const r = await ob('POST', '/requests', { key: `ah_app_aaaaaaaaaaa${i % 10}_notakey`, body: request(), from });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('unauthorized');
    }
    // The next call from that address is refused before the key is read, even the PC's real key.
    const next = await ob('POST', '/requests', { key: pc.key, body: request(), from });
    expect(next.status).toBe(429);
    expect(next.body.error).toBe('rate_limited');
    expect(next.body.retry_after_s).toBeGreaterThan(0);
    const alerts = app.db.prepare("SELECT * FROM security_alerts WHERE type='onboarding_auth_fail' AND subject=?").all(from) as { details: string }[];
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const failures = app.db.prepare("SELECT * FROM authentication_events WHERE subject_kind='app_key' AND source=? AND outcome<>'ok'").all(from);
    expect(failures).toHaveLength(AUTH_FAILS_PER_HOUR);
    // Another address is not held back.
    expect((await ob('GET', '/requests', { key: pc.key, from: freshIp() })).status).toBe(200);
  });
});

describe('request folder paths (gap 10)', () => {
  const bad: [string, string][] = [
    ['..', '/vault/Grants/../Secrets'],
    ['a wildcard', '/vault/Grants/*'],
    ['a path outside /vault/', '/etc/passwd'],
    ['more than 400 characters', `/vault/${'a'.repeat(400)}`],
  ];
  for (const [what, path] of bad) {
    it(`a folder with ${what} gets invalid_argument naming the field`, async () => {
      const pc = await addAndEnrol(`path-${what.replace(/\W+/g, '-')}`);
      const r = await ob('POST', '/requests', { key: pc.key, body: request([{ path, access: 'read' }]), from: freshIp() });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_argument');
      expect(r.body.message).toContain('roles[1].folders[0].path');
      expect(r.body.problems).toContainEqual(expect.objectContaining({ field: 'roles[1].folders[0].path' }));
    });
  }
});

describe('a write on the vault root (gap 11)', () => {
  it('approval is refused without confirm_root_write: true, and goes through with it', async () => {
    const pc = await addAndEnrol('root-write');
    const f = await file(pc.key, [{ path: '/vault', access: 'write' }]);
    const no = await api('POST', `/onboarding/${f.request_id}/approve`, { version: f.version });
    expect(no.status).toBe(400);
    expect(no.body.error).toBe('invalid_argument');
    expect(no.body.message).toMatch(/would write on the vault root; confirm with confirm_root_write: true/);
    const off = await api('POST', `/onboarding/${f.request_id}/approve`, { version: f.version, confirm_root_write: false });
    expect(off.status).toBe(400);
    const yes = await api('POST', `/onboarding/${f.request_id}/approve`, { version: f.version, confirm_root_write: true });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
  });
});
