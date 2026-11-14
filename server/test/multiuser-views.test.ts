/**
 * Member views audit (docs/multi-user.md §3): a member's Blueprint or conversation export records `export.read`, an
 * external user's vault preview records `vault.preview`. The admin's exports and a non-external member's previews are
 * not audited, and a refused export leaves no row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { totp } from '../src/util/crypto.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, ana: S, jonas: S;
const PW = 'member views password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const login = (username: string, code?: string): Promise<S> => adminLogin(base, username, username === 'admin' ? ADMIN_PASSWORD : PW, code);
type Row = { action: string; actor_id: string; actor_role: string; target_kind: string; target_id: string; details: Record<string, unknown> };
const rows = (action: string): Row[] => (app.db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY id').all(action) as any[])
  .map((r) => ({ ...r, details: JSON.parse(r.details ?? '{}') }));

let project = '', room = '', anaId = '', jonasId = '';
const note = '/vault/Projects/Conclave/plan.md';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahviews-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin');
  project = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  const a = app.keys.createAgent('cnv-coord', null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: 'cnv-coord key' }, sys);
  const t = app.teams.create({ name: 'CNV One', goal: 'goal', members: [{ agent_id: a.id, role: 'coordinator' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  room = app.teams.team(t.id)!.room_id!;
  app.messaging.insert({ roomId: room, agentId: a.id, credId: k.credential.id, kind: 'text', body: 'hello team', replyTo: null, clientMsgId: 'm1' });
  expect((await call(admin, 'POST', `/projects/${project}/ops`, { version: app.blueprint.project(project)!.version, ops: [{ op: 'upsert', kind: 'module', key: 'ONE', title: 'Module one', team_id: t.id }] })).status).toBe(200);
  await app.store.write(['Projects', 'Conclave', 'plan.md'], Buffer.from('# Plan\n'), 'absent', 'create', { agentId: a.id, credentialId: null as never });

  const mkUser = async (username: string, over: Record<string, unknown>, mayExport: boolean) => {
    const c = await call(admin, 'POST', '/users', { username, ...over });
    const first = await adminLogin(base, username, c.body.password);
    let secret: string | undefined;
    if (c.body.user.totp_required) {
      secret = (await call(first, 'POST', '/totp/enroll', {})).body.secret as string;
      expect((await call(first, 'POST', '/totp/confirm', { code: totp(secret, Date.now()) })).status).toBe(200);
    }
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: project, components: ['blueprint', 'messages', 'vault'], vault_folders: ['/Projects/Conclave/'], may_export: mayExport }] })).status).toBe(200);
    return { id: c.body.user.id as string, secret };
  };
  const anaU = await mkUser('ana', {}, true);
  const jonasU = await mkUser('jonas', { external: true, org: 'Partner' }, false);
  anaId = anaU.id; jonasId = jonasU.id;
  ana = await login('ana');
  jonas = await login('jonas', totp(jonasU.secret!, Date.now(), 1)); // enrolment spent the current code
});
afterAll(async () => { await app?.close(); });

describe('member views audit', () => {
  it("the admin's exports are not audited", async () => {
    expect((await call(admin, 'GET', `/projects/${project}/export.md`)).status).toBe(200);
    expect((await call(admin, 'GET', `/conversations/${room}/export`)).status).toBe(200);
    expect(rows('export.read')).toEqual([]);
  });

  it("a member's Blueprint export records export.read", async () => {
    const r = await call(ana, 'GET', `/projects/${project}/export.md`);
    expect(r.status).toBe(200);
    const [e] = rows('export.read');
    expect(e).toMatchObject({ actor_id: anaId, actor_role: 'member', target_kind: 'project', target_id: project });
    expect(e!.details).toMatchObject({ what: 'blueprint', project_id: project, bytes: Buffer.byteLength(r.text) });
  });

  it("a member's conversation export records export.read with the room's project", async () => {
    const r = await call(ana, 'GET', `/conversations/${room}/export`);
    expect(r.status).toBe(200);
    const e = rows('export.read').at(-1)!;
    expect(e).toMatchObject({ actor_id: anaId, actor_role: 'member', target_kind: 'room', target_id: room });
    expect(e.details).toMatchObject({ what: 'conversation', project_id: project, messages: r.body.messages.length });
  });

  it('a refused export leaves no row', async () => {
    const before = rows('export.read').length;
    expect((await call(jonas, 'GET', `/projects/${project}/export.md`)).body.error).toBe('export_denied');
    expect((await call(jonas, 'GET', `/conversations/${room}/export`)).body.error).toBe('export_denied');
    expect(rows('export.read').length).toBe(before);
    expect(rows('export.read').some((e) => e.actor_id === jonasId)).toBe(false);
  });

  it("an external user's vault preview records vault.preview; a member's does not", async () => {
    expect((await call(ana, 'GET', `/vault/preview?path=${encodeURIComponent(note)}`)).status).toBe(200);
    expect(rows('vault.preview')).toEqual([]);
    const r = await call(jonas, 'GET', `/vault/preview?path=${encodeURIComponent(note)}`);
    expect(r.status).toBe(200);
    const [e] = rows('vault.preview');
    expect(e).toMatchObject({ actor_id: jonasId, target_kind: 'vault_file', target_id: r.body.path });
    expect(e!.details).toMatchObject({ path: r.body.path, bytes: Buffer.byteLength(r.body.preview.content) });
  });
});
