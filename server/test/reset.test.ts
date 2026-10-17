import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';

const sys = { kind: 'system' as const, id: null };
const PASSWORD = 'correct horse battery';
let app: App, base: string, cookie = '', csrf = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const count = (t: string) => (app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

/** A small populated hub: two PCs with app keys, two agents with keys, a link, a team with a task, a lockdown. */
function populate() {
  const pcA = app.keys.createMachine('pc-a', null, sys), pcB = app.keys.createMachine('pc-b', null, sys);
  app.keys.createAppKey({ machineId: pcA.id, appName: 'claude-code' }, sys);
  app.keys.createAppKey({ machineId: pcB.id, appName: 'codex' }, sys);
  const a = app.keys.createAgent('Arden', 'Hearing', sys), b = app.keys.createAgent('Ilex', 'Hearing', sys);
  const ka = app.keys.createSessionKey({ agentId: a.id, label: 'arden' }, sys), kb = app.keys.createSessionKey({ agentId: b.id, label: 'ilex' }, sys);
  app.links.create({ from: a.id, to: b.id, kind: 'peer', grantsMessaging: true }, sys);
  const team = app.teams.create({ name: 'The Last Playback', goal: 'Decide R-17.', members: [{ agent_id: a.id, role: 'coordinator', credential_id: ka.credential.id }, { agent_id: b.id, role: 'worker', credential_id: kb.credential.id }] }, sys);
  app.lockdown.set('writes', undefined, true, 'test');
  return { pcA, pcB, a, b, team };
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahr-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(join(vaultDir, 'note.md'), '# Note\n');
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: PASSWORD, publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
  };
  app = await buildApp(config);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await r.json()) as { csrf: string }).csrf;
});
afterEach(async () => { await app.close(); });

describe('reset', () => {
  it('lists the parts', async () => {
    const r = await api('GET', '/reset/parts');
    expect(r.body.parts.map((p: { key: string }) => p.key)).toEqual(['activity', 'conversations', 'teams', 'agents', 'devices', 'shares', 'vault', 'lockdown']);
  });

  it('plans without changing anything, and shows rows pulled in from other parts', async () => {
    populate();
    const before = count('credentials');
    const r = await api('GET', '/reset/plan?parts=agents');
    expect(r.status).toBe(200);
    expect(r.body.plan.tables.credentials).toBe(4);
    // Team members point at the agents, so the teams part loses rows too and says so.
    expect(r.body.plan.implied).toContain('teams');
    // Per-table rows explain each part's number and add up to the total.
    const bt = r.body.plan.byTable as { table: string; part: string; rows: number }[];
    expect(bt.find((x) => x.table === 'credentials')).toMatchObject({ part: 'agents', rows: 4 });
    expect(bt.find((x) => x.table === 'team_members')?.part).toBe('teams');
    expect(bt.reduce((n, x) => n + x.rows, 0)).toBe(r.body.plan.total);
    expect(count('credentials')).toBe(before);
  });

  it('removes one PC with its own app keys only', async () => {
    const { pcA } = populate();
    const r = await api('POST', '/reset', { parts: ['devices'], confirm: 'RESET', password: PASSWORD });
    expect(r.status).toBe(200);
    expect(count('machines')).toBe(0);
    // Both app keys belonged to the PCs; the two session keys survive.
    expect(count("credentials WHERE kind='app_key'")).toBe(0);
    expect(count("credentials WHERE kind='session_key'")).toBe(2);
    expect(count('agents')).toBe(2);
    expect(r.body.result.parts).toEqual(['devices']);
    expect(pcA.id).toBeTruthy();
  });

  it('clears lockdown switches without touching anything else', async () => {
    populate();
    expect(app.lockdown.writes()).toBe(true);
    const r = await api('POST', '/reset', { parts: ['lockdown'], confirm: 'RESET', password: PASSWORD });
    expect(r.status).toBe(200);
    expect(app.lockdown.writes()).toBe(false);
    expect(count('agents')).toBe(2);
  });

  it('resets everything but keeps the admin, leaves no dangling references, and audits it', async () => {
    populate();
    const templates = count("permission_policies WHERE kind='template'");
    expect(templates).toBeGreaterThan(0);
    const r = await api('POST', '/reset', { parts: ['all'], confirm: 'RESET', password: PASSWORD });
    expect(r.status).toBe(200);
    for (const t of ['agents', 'credentials', 'machines', 'teams', 'team_members', 'agent_links']) expect(count(t)).toBe(0);
    // Key policies go with their keys; permission templates are configuration and stay.
    expect(count("permission_policies WHERE kind='credential'")).toBe(0);
    expect(count("permission_policies WHERE kind='template'")).toBe(templates);
    expect(count("permission_rules WHERE policy_id IN (SELECT id FROM permission_policies WHERE kind='template')")).toBeGreaterThan(0);
    expect(count('admin_users')).toBe(1);
    expect(app.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The audit trail is append-only and survives; the reset itself is recorded there.
    expect(count("audit_events WHERE action='agent.create'")).toBeGreaterThan(0);
    const ev = app.db.prepare("SELECT details FROM audit_events WHERE action='system.reset'").get() as { details: string };
    expect(JSON.parse(ev.details).parts).toContain('agents');
    // The session that ran it still works.
    expect((await api('GET', '/me')).status).toBe(200);
  });

  it('refuses without the confirmation word or the right password', async () => {
    populate();
    expect((await api('POST', '/reset', { parts: ['agents'], confirm: 'reset', password: PASSWORD })).status).toBe(400);
    expect((await api('POST', '/reset', { parts: ['agents'], confirm: 'RESET', password: 'wrong' })).body.error).toBe('invalid_credentials');
    expect((await api('POST', '/reset', { parts: ['nonsense'], confirm: 'RESET', password: PASSWORD })).status).toBe(400);
    expect(count('agents')).toBe(2);
  });
});
