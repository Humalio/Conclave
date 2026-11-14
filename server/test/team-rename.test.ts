/**
 * Renaming a team: the hub checks the name (trimmed, 1 to 80 characters, not another team's, case-insensitive), keeps the id,
 * renames the team room, writes one team.rename audit event (old and new name) and gives each member one notice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';

const sys = { kind: 'system' as const, id: null };
let app: App;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-team-rename-')), vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp({ dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 'test.db'), vaultDir, vaultAlias: 'vault', host: '127.0.0.1', port: 0,
    pepper: 'test', publicUrl: 'http://fixture.test', production: false, adminUsername: 'admin', adminPassword: 'fixture password',
    publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0 });
  intakeOpen(app);
  await app.store.ready;
});
afterAll(async () => { await app.close(); });

const agent = (label: string) => { const a = app.keys.createAgent(label, null, sys); app.keys.createSessionKey({ agentId: a.id, label }, sys); return a; };
const mk = (name: string) => {
  const a = agent(`${name} lead`), b = agent(`${name} dev`);
  const t = app.teams.create({ name, goal: 'Rename me', members: [{ agent_id: a.id, role: 'coordinator' }, { agent_id: b.id, role: 'worker' }] }, sys);
  return { t, ids: [a.id, b.id] };
};
const notices = (agent: string) => app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='team_renamed'").all(agent) as { body: string }[];
const audits = (action: string, target: string) => (app.db.prepare('SELECT details FROM audit_events WHERE action=? AND target_id=?').all(action, target) as { details: string }[]).map((r) => JSON.parse(r.details));

describe('renaming a team', () => {
  let t: ReturnType<typeof mk>['t'], ids: string[];
  beforeAll(() => { const m = mk('Mapping'); t = m.t; ids = m.ids; mk('Surveying'); });
  it('saves the trimmed name, keeps the id, renames the team room, and writes one team.rename event', () => {
    const r = app.teams.update(t.id, { name: '  Cartography  ' }, sys);
    expect(r.id).toBe(t.id);
    expect(r.name).toBe('Cartography');
    expect((app.db.prepare("SELECT name FROM rooms WHERE team_id=? AND kind='team'").get(t.id) as { name: string }).name).toBe('Team: Cartography');
    expect(audits('team.rename', t.id)).toEqual([{ from: 'Mapping', to: 'Cartography' }]);
    expect(audits('team.update', t.id)).toEqual([]);
  });
  it('gives each member one notice that names the new name and says PC files keep the old one', () => {
    for (const id of ids) {
      const n = notices(id);
      expect(n).toHaveLength(1);
      expect(n[0]!.body).toContain('Your team is now called "Cartography"');
      expect(n[0]!.body).toMatch(/CLAUDE\.md or AGENTS\.override\.md, keep the old name until the next setup or resume/);
    }
  });
  it('refuses a name another team has (any case), and an empty or too long one, and changes nothing', () => {
    expect(() => app.teams.update(t.id, { name: 'surveying' }, sys)).toThrow(/already called "Surveying"/);
    expect(() => app.teams.update(t.id, { name: '   ' }, sys)).toThrow(/1 to 80 characters/);
    expect(() => app.teams.update(t.id, { name: 'x'.repeat(81) }, sys)).toThrow(/1 to 80 characters/);
    expect(app.teams.team(t.id)!.name).toBe('Cartography');
    expect(audits('team.rename', t.id)).toHaveLength(1);
    expect(ids.every((id) => notices(id).length === 1)).toBe(true);
  });
  it('allows the team\'s own name again (a case change) and other settings without a rename', () => {
    app.teams.update(t.id, { name: 'cartography' }, sys);
    expect(app.teams.team(t.id)!.name).toBe('cartography');
    app.teams.update(t.id, { goal: 'A new goal' }, sys);
    expect(audits('team.rename', t.id)).toHaveLength(2);
    expect(audits('team.update', t.id)).toEqual([{ goal: 'A new goal' }]);
    expect(app.teams.update(t.id, { name: 'cartography', goal: 'Again' }, sys).name).toBe('cartography');
    expect(audits('team.rename', t.id)).toHaveLength(2);
  });
  it('the admin API refuses a clash with a clear message', async () => {
    const login = await app.fastify.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'fixture password' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!, csrf = login.json().csrf;
    const res = await app.fastify.inject({ method: 'PATCH', url: `/api/teams/${t.id}`, headers: { cookie, 'x-csrf-token': csrf }, payload: { name: 'SURVEYING' } });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toMatch(/already called/);
    const empty = await app.fastify.inject({ method: 'PATCH', url: `/api/teams/${t.id}`, headers: { cookie, 'x-csrf-token': csrf }, payload: { name: '  ' } });
    expect(empty.statusCode).toBe(400);
  });
});
