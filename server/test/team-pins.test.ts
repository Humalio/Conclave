/**
 * Home Teams card pins (docs/dashboard-ux.md): per operator, in pin order, stored in the hub (system_settings), so
 * they follow the operator across browsers. GET/PUT /api/teams/pins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { hashPassword } from '../src/util/crypto.js';
import { MAX_PINS } from '../src/admin/teams.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base = '';
const sys = { kind: 'system' as const, id: null };
type Op = { cookie: string; csrf: string };
let ops: { a: Op; b: Op };
const teamIds: string[] = [];

const signIn = (username: string, password: string): Promise<Op> => adminLogin(base, username, password);
const api = async (op: Op | null, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (op) { headers.cookie = op.cookie; headers['x-csrf-token'] = op.csrf; }
  const r = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const team = (name: string) => {
  const agent = app.keys.createAgent(`${name}-lead`, null, sys);
  app.keys.createSessionKey({ agentId: agent.id, label: name }, sys);
  return app.teams.create({ name, goal: 'g', members: [{ agent_id: agent.id, role: 'coordinator' }] }, sys).id;
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahpins-'));
  mkdirSync(join(dir, 'vault'));
  const config: Config = testConfig(dir, { publicUrl: 'http://127.0.0.1', maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  // A second operator, to show pins are per operator.
  app.db.prepare('INSERT INTO admin_users(id,username,password_hash,created_at) VALUES (?,?,?,?)').run('adm_second', 'second', hashPassword('another long passphrase'), Date.now());
  ops = { a: await signIn('admin', 'correct horse battery'), b: await signIn('second', 'another long passphrase') };
  for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta']) teamIds.push(team(n));
});
afterAll(async () => { await app?.close(); });

describe('team pins', () => {
  it('start empty, keep the pin order, and drop duplicates', async () => {
    expect((await api(ops.a, 'GET', '/teams/pins')).body).toEqual({ team_ids: [] });
    const [a, b, c] = teamIds as [string, string, string];
    const put = await api(ops.a, 'PUT', '/teams/pins', { team_ids: [c, a, c] });
    expect(put.status).toBe(200);
    expect(put.body.team_ids).toEqual([c, a]);
    expect((await api(ops.a, 'GET', '/teams/pins')).body.team_ids).toEqual([c, a]);
    // Unpinning is a PUT without it; pinning another appends in pin order.
    expect((await api(ops.a, 'PUT', '/teams/pins', { team_ids: [a, b] })).body.team_ids).toEqual([a, b]);
  });

  it('are stored in the hub per operator, not per browser', async () => {
    const row = app.db.prepare("SELECT value FROM system_settings WHERE key='home.pinned_teams:' || (SELECT id FROM admin_users WHERE username='admin')").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual([teamIds[0], teamIds[1]]);
    // Another sign-in of the same operator (another browser or PC) sees the same pins.
    const again = await signIn('admin', 'correct horse battery');
    expect((await api(again, 'GET', '/teams/pins')).body.team_ids).toEqual([teamIds[0], teamIds[1]]);
    // Another operator has their own.
    expect((await api(ops.b, 'GET', '/teams/pins')).body.team_ids).toEqual([]);
    await api(ops.b, 'PUT', '/teams/pins', { team_ids: [teamIds[3]] });
    expect((await api(ops.a, 'GET', '/teams/pins')).body.team_ids).toEqual([teamIds[0], teamIds[1]]);
    expect((await api(ops.b, 'GET', '/teams/pins')).body.team_ids).toEqual([teamIds[3]]);
  });

  it('refuse unknown teams, too many pins and extra fields, and keep what was there', async () => {
    const bad = await api(ops.a, 'PUT', '/teams/pins', { team_ids: [teamIds[2], 'team_nope'] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/team_nope/);
    expect((await api(ops.a, 'PUT', '/teams/pins', { team_ids: Array.from({ length: MAX_PINS + 1 }, (_, i) => `t${i}`) })).status).toBe(400);
    expect((await api(ops.a, 'PUT', '/teams/pins', { team_ids: [], extra: 1 })).status).toBe(400);
    expect((await api(ops.a, 'PUT', '/teams/pins', { team_ids: 'x' })).status).toBe(400);
    expect((await api(ops.a, 'GET', '/teams/pins')).body.team_ids).toEqual([teamIds[0], teamIds[1]]);
  });

  it('leave out a pinned team that no longer exists', async () => {
    const id = (app.db.prepare('SELECT id FROM admin_users WHERE username=?').get('second') as { id: string }).id;
    app.db.prepare('UPDATE system_settings SET value=? WHERE key=?').run(JSON.stringify(['team_gone', teamIds[3]]), `home.pinned_teams:${id}`);
    expect((await api(ops.b, 'GET', '/teams/pins')).body.team_ids).toEqual([teamIds[3]]);
  });

  it('need a signed-in operator and the CSRF token', async () => {
    expect((await api(null, 'GET', '/teams/pins')).status).toBe(401);
    const r = await fetch(`${base}/api/teams/pins`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: ops.a.cookie }, body: JSON.stringify({ team_ids: [] }) });
    expect(r.status).toBe(403);
    expect((await api(ops.a, 'GET', '/teams/pins')).body.team_ids).toEqual([teamIds[0], teamIds[1]]);
  });
});
