/**
 * Migration 0102 (docs/proposals/blueprint-readability.md §1.3, docs/blueprint.md §2.7): the blueprint writing rule joins
 * the coordinator and worker playbooks, only where a copy still equals the shipped text, and switchMode() keeps working.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { buildApp } from '../src/app.js';
import { ON_DEMAND_PLAYBOOKS, BP_RULE_COORDINATOR, BP_RULE_WORKER, HANDOFF_LINE, REFINE_LINE } from '../src/teams/teams.js';
import { migrate0, V0_MIGRATIONS } from './fixtures/v0/db0.js';
import { testConfig } from './hub.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const FILE = '0102_blueprint_plain_writing.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
vi.spyOn(console, 'warn').mockImplementation(() => {});

const RULE = { coordinator: BP_RULE_COORDINATOR, worker: BP_RULE_WORKER } as const;
/** The on-demand text before this change: the constant without the rule, and without the hand-off line 0107 added later. */
const before0107 = (s: string) => s.replace(' ' + REFINE_LINE, '').replace(' ' + HANDOFF_LINE, '');
const OLD = { coordinator: before0107(ON_DEMAND_PLAYBOOKS.coordinator!).replace(' ' + BP_RULE_COORDINATOR, ''), worker: before0107(ON_DEMAND_PLAYBOOKS.worker!).replace(' ' + BP_RULE_WORKER, '') };
const BASE_ONLY = tmp('conclave-0102-base-');
copyFileSync(join(MIGRATIONS, '0100_v1_baseline.sql'), join(BASE_ONLY, '0100_v1_baseline.sql'));

const defaults = (db: DatabaseSync, role: string) => (db.prepare('SELECT playbook FROM team_role_defaults WHERE role=?').get(role) as { playbook: string }).playbook;
const copy = (db: DatabaseSync, team: string, role: string) => (db.prepare('SELECT playbook FROM team_roles WHERE team_id=? AND role=?').get(team, role) as { playbook: string }).playbook;
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** A 1.0 database before 0102 with four teams: polling and on-demand copies left as shipped, one edited copy each role. */
function before(db: DatabaseSync): { oldPoll: Record<string, string> } {
  const oldPoll = { coordinator: defaults(db, 'coordinator'), worker: defaults(db, 'worker') };
  const team = db.prepare('INSERT INTO teams(id,name,goal,created_at,updated_at,delivery_mode) VALUES (?,?,?,1,1,?)');
  const role = db.prepare('INSERT INTO team_roles(team_id,role,playbook) VALUES (?,?,?)');
  team.run('team_poll', 'Poll', 'g', 'poll'); team.run('team_od', 'On demand', 'g', 'on_demand'); team.run('team_edit', 'Edited', 'g', 'poll'); team.run('team_odedit', 'Edited OD', 'g', 'on_demand');
  for (const r of ['coordinator', 'worker'] as const) {
    role.run('team_poll', r, oldPoll[r]);
    role.run('team_od', r, OLD[r]);
    role.run('team_edit', r, oldPoll[r] + ' Also water the plants.');
    role.run('team_odedit', r, 'Our own words: ' + OLD[r]);
  }
  role.run('team_poll', 'reviewer', defaults(db, 'reviewer'));
  return { oldPoll };
}

describe('migration 0102', () => {
  it('quotes the rules and the old on-demand text verbatim', () => {
    expect(SQL).toContain(BP_RULE_COORDINATOR);
    expect(SQL).toContain(BP_RULE_WORKER);
    expect(SQL).toContain(`playbook='${OLD.coordinator.replace(/'/g, "''")}'`);
    expect(SQL).toContain(`playbook='${OLD.worker.replace(/'/g, "''")}'`);
    expect(OLD.coordinator).not.toBe(ON_DEMAND_PLAYBOOKS.coordinator);
    expect(OLD.worker).not.toBe(ON_DEMAND_PLAYBOOKS.worker);
    expect(BP_RULE_COORDINATOR + BP_RULE_WORKER).not.toContain("'");
  });

  it('runs after 0100 and 0101 on a fresh database and on a 0.x database recognised at 100', () => {
    const fresh = new DatabaseSync(':memory:');
    migrate(fresh);
    const v = (db: DatabaseSync) => (db.prepare('SELECT version FROM schema_migrations WHERE version >= 100 ORDER BY version').all() as { version: number }[]).map((r) => r.version);
    expect(v(fresh).slice(0, 3)).toEqual([100, 101, 102]); // later migrations (0103 keywords) follow
    expect(count(defaults(fresh, 'coordinator'), BP_RULE_COORDINATOR)).toBe(1);
    expect(count(defaults(fresh, 'worker'), BP_RULE_WORKER)).toBe(1);
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys=ON');
    migrate0(old, V0_MIGRATIONS);
    migrate(old);
    expect(v(old).slice(0, 3)).toEqual([100, 101, 102]);
    expect(defaults(old, 'coordinator')).toBe(defaults(fresh, 'coordinator'));
    // Rollback (D61): the 0.x runner still starts on a database that has run 0102.
    expect(() => migrate0(old, V0_MIGRATIONS)).not.toThrow();
  });

  it('adds the rule to unedited copies only, and the defaults', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, BASE_ONLY);
    const { oldPoll } = before(db);
    migrate(db);
    for (const r of ['coordinator', 'worker'] as const) {
      expect(count(defaults(db, r), RULE[r])).toBe(1);
      expect(copy(db, 'team_poll', r)).toBe(defaults(db, r));
      expect(copy(db, 'team_od', r)).toBe(ON_DEMAND_PLAYBOOKS[r]);
      expect(copy(db, 'team_edit', r)).toBe(oldPoll[r] + ' Also water the plants.');
      expect(copy(db, 'team_odedit', r)).toBe('Our own words: ' + OLD[r]);
    }
    expect(copy(db, 'team_poll', 'reviewer')).toBe(defaults(db, 'reviewer'));
  });

  it('does not double the rule when its four updates run twice', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, BASE_ONLY);
    before(db);
    migrate(db);
    db.exec(SQL);
    for (const r of ['coordinator', 'worker'] as const) {
      expect(count(defaults(db, r), RULE[r])).toBe(1);
      expect(count(copy(db, 'team_poll', r), RULE[r])).toBe(1);
      expect(copy(db, 'team_od', r)).toBe(ON_DEMAND_PLAYBOOKS[r]);
    }
  });

  it('WRITING names agents by their label, and every agent sees it in the server instructions', async () => {
    const { WRITING } = await import('../src/mcp/writing.js');
    const { INSTRUCTIONS, HEADER_INSTRUCTIONS } = await import('../src/mcp/tools.js');
    expect(WRITING).toContain('Name agents by their label, not their id.');
    expect(INSTRUCTIONS).toContain(WRITING);
    expect(HEADER_INSTRUCTIONS).toContain(WRITING);
  });

  it('leaves migrated copies that switchMode() still swaps both ways', async () => {
    const dir = tmp('conclave-0102-app-');
    mkdirSync(join(dir, 'data')); mkdirSync(join(dir, 'vault'));
    const config = testConfig(dir);
    const db = new DatabaseSync(config.dbFile);
    migrate(db, BASE_ONLY);
    before(db);
    db.close();
    const app = await buildApp(config);
    await app.store.ready;
    try {
      const sys = { kind: 'system' as const, id: null };
      const pb = (team: string, role: string) => copy(app.db as unknown as DatabaseSync, team, role);
      const poll = { coordinator: pb('team_poll', 'coordinator'), worker: pb('team_poll', 'worker') };
      app.teams.update('team_poll', { delivery_mode: 'on_demand' }, sys);
      expect(pb('team_poll', 'coordinator')).toBe(ON_DEMAND_PLAYBOOKS.coordinator);
      expect(pb('team_poll', 'worker')).toBe(ON_DEMAND_PLAYBOOKS.worker);
      app.teams.update('team_poll', { delivery_mode: 'poll' }, sys);
      expect(pb('team_poll', 'coordinator')).toBe(poll.coordinator);
      expect(pb('team_poll', 'worker')).toBe(poll.worker);
      app.teams.update('team_od', { delivery_mode: 'poll' }, sys);
      expect(pb('team_od', 'coordinator')).toBe(poll.coordinator);
      app.teams.update('team_od', { delivery_mode: 'on_demand' }, sys);
      expect(pb('team_od', 'coordinator')).toBe(ON_DEMAND_PLAYBOOKS.coordinator);
    } finally {
      await app.close?.();
    }
  });
});
