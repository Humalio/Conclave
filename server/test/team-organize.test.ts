/**
 * Teams Organize choice: per operator, stored in the hub (system_settings) like the pins. GET/PUT /api/teams/organize.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { hashPassword } from '../src/util/crypto.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base = '';
type Op = { cookie: string; csrf: string };
let ops: { a: Op; b: Op };

const signIn = (username: string, password: string): Promise<Op> => adminLogin(base, username, password);
const api = async (op: Op | null, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (op) { headers.cookie = op.cookie; headers['x-csrf-token'] = op.csrf; }
  const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const settingValue = (key: string) => (app.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
const adminId = (username: string) => (app.db.prepare('SELECT id FROM admin_users WHERE username=?').get(username) as { id: string }).id;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahorg-'));
  mkdirSync(join(dir, 'vault'));
  const config: Config = testConfig(dir, { publicUrl: 'http://127.0.0.1', maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  // A second operator, to show the choice is per operator.
  app.db.prepare('INSERT INTO admin_users(id,username,password_hash,created_at) VALUES (?,?,?,?)').run('adm_second', 'second', hashPassword('another long passphrase'), Date.now());
  ops = { a: await signIn('admin', 'correct horse battery'), b: await signIn('second', 'another long passphrase') };
});
afterAll(async () => { await app?.close(); });

describe('teams organize choice', () => {
  it('defaults to the empty string (Attention)', async () => {
    expect((await api(ops.a, 'GET', '/teams/organize')).body).toEqual({ organize: '' });
  });

  it('stores each valid value and reads it back', async () => {
    for (const v of ['status', 'project', 'name', '']) {
      const put = await api(ops.a, 'PUT', '/teams/organize', { organize: v });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ organize: v });
      expect((await api(ops.a, 'GET', '/teams/organize')).body).toEqual({ organize: v });
    }
  });

  it('keeps the choice per operator', async () => {
    await api(ops.a, 'PUT', '/teams/organize', { organize: 'project' });
    expect((await api(ops.b, 'GET', '/teams/organize')).body).toEqual({ organize: '' });
    await api(ops.b, 'PUT', '/teams/organize', { organize: 'name' });
    expect((await api(ops.a, 'GET', '/teams/organize')).body).toEqual({ organize: 'project' });
    expect((await api(ops.b, 'GET', '/teams/organize')).body).toEqual({ organize: 'name' });
  });

  it('is stored in system_settings under teams.organize:<admin id>', async () => {
    expect(settingValue(`teams.organize:${adminId('admin')}`)).toBe('"project"');
    expect(settingValue(`teams.organize:${adminId('second')}`)).toBe('"name"');
  });

  it('refuse an unknown value or an extra field with 400 and keep the old value', async () => {
    const bad = await api(ops.a, 'PUT', '/teams/organize', { organize: 'owner' });
    expect(bad.status).toBe(400);
    expect((await api(ops.a, 'PUT', '/teams/organize', { organize: 'status', extra: 1 })).status).toBe(400);
    expect((await api(ops.a, 'PUT', '/teams/organize', { organize: 1 })).status).toBe(400);
    expect((await api(ops.a, 'GET', '/teams/organize')).body).toEqual({ organize: 'project' });
  });

  it('read an unreadable or unknown stored value as the empty string', async () => {
    const key = `teams.organize:${adminId('admin')}`;
    app.db.prepare('UPDATE system_settings SET value=? WHERE key=?').run('"bogus"', key);
    expect((await api(ops.a, 'GET', '/teams/organize')).body).toEqual({ organize: '' });
    app.db.prepare('UPDATE system_settings SET value=? WHERE key=?').run('{"not":"a string"}', key);
    expect((await api(ops.a, 'GET', '/teams/organize')).body).toEqual({ organize: '' });
  });

  it('need a signed-in operator and the CSRF token', async () => {
    await api(ops.a, 'PUT', '/teams/organize', { organize: 'project' });
    expect((await api(null, 'GET', '/teams/organize')).status).toBe(401);
    expect((await api(null, 'PUT', '/teams/organize', { organize: 'status' })).status).toBe(401);
    const r = await fetch(`${base}/api/teams/organize`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: ops.a.cookie }, body: JSON.stringify({ organize: 'status' }) });
    expect(r.status).toBe(403);
    expect(settingValue(`teams.organize:${adminId('admin')}`)).toBe('"project"');
  });
});
