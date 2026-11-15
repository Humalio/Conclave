/**
 * The 1.0 baseline and how the runner treats a database (docs/proposals/v1-release.md §2, §5): the generated 0100 equals
 * the 0.x chain, a 0.x database at 69 is recognised, anything else is refused and left unchanged, and the 0.x runner
 * still starts on a 1.0 database (rollback).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, schemaSet, BASELINE } from '../src/db/db.js';
import { migrate0, V0_MIGRATIONS } from './fixtures/v0/db0.js';
// @ts-expect-error a plain .mjs script without types
import { dump } from '../scripts/v1-baseline.mjs';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
vi.spyOn(console, 'warn').mockImplementation(() => {});
/** The baseline alone, as 1.0.0 shipped it: what a 0.x database is recognised against and what a retag rollback needs (max 100). */
const BASE_ONLY = (() => { const d = mkdtempSync(join(tmpdir(), 'conclave-v1-base-')); dirs.push(d); copyFileSync(join(MIGRATIONS, '0100_v1_baseline.sql'), join(d, '0100_v1_baseline.sql')); return d; })();

/** A database built by the 0.x runner from the 56 files of 0.x, as both hubs have it (foreign keys on). */
function oldChain(dir = V0_MIGRATIONS): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate0(db, dir);
  return db;
}
function fresh(dir = BASE_ONLY): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db, dir);
  return db;
}
const versions = (db: DatabaseSync) => (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version);
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const rows = (db: DatabaseSync) => Object.fromEntries(tables(db).map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
const state = (db: DatabaseSync) => ({ schema: [...schemaSet(db)].sort(), migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), rows: rows(db) });

describe('the 1.0 baseline', () => {
  it('builds the same schema and seed rows as the 56 migrations of 0.x', () => {
    const a = fresh(), b = oldChain();
    expect([...schemaSet(a)].sort()).toEqual([...schemaSet(b)].sort());
    expect(rows(a)).toEqual(rows(b));
    expect(Object.keys(rows(a)).filter((t) => rows(a)[t]!.length).sort()).toEqual(['kg_budgets', 'team_role_defaults']);
    // The 0.x chain leaves bp_report_requests at seq 0 (0034 rebuilt it); a row at 0 and no row give the same next id.
    const seq = (db: DatabaseSync) => db.prepare('SELECT * FROM sqlite_sequence WHERE seq > 0 ORDER BY name').all();
    expect(seq(a)).toEqual(seq(b));
    expect(versions(a)).toEqual([BASELINE]);
    // The shipped folder: the baseline, then the later migrations on top.
    expect(versions(fresh(MIGRATIONS))[0]).toBe(BASELINE);
  });

  it('is the generated file, so it cannot drift from the 0.x chain', () => {
    expect(readFileSync(join(MIGRATIONS, '0100_v1_baseline.sql'), 'utf8')).toBe(dump(oldChain()));
    const files = readdirSync(MIGRATIONS).sort();
    expect(files[0]).toBe('0100_v1_baseline.sql');
    expect(files.slice(1).every((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) > BASELINE)).toBe(true);
  });

  it('runs later migrations (0101+) on top, and refuses an applied file that changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-v1-'));
    dirs.push(dir);
    copyFileSync(join(MIGRATIONS, '0100_v1_baseline.sql'), join(dir, '0100_v1_baseline.sql'));
    writeFileSync(join(dir, '0101_next.sql'), 'CREATE TABLE next_thing (id INTEGER PRIMARY KEY);\r\n');
    const db = new DatabaseSync(':memory:');
    migrate(db, dir);
    expect(versions(db)).toEqual([100, 101]);
    migrate(db, dir);
    expect(versions(db)).toEqual([100, 101]);
    writeFileSync(join(dir, '0101_next.sql'), 'CREATE TABLE next_thing (id INTEGER PRIMARY KEY, x TEXT);\n');
    expect(() => migrate(db, dir)).toThrow('migration 0101_next.sql changed after it was applied');
  });
});

describe('a 0.x database at migration 69', () => {
  it('is recognised: 100 is recorded without running it, rows 1 to 69 and the data stay', () => {
    const db = oldChain();
    db.prepare("INSERT INTO teams(id,name,goal,created_at,updated_at) VALUES ('team_a','A','g',1,1)").run();
    const before = state(db);
    migrate(db, BASE_ONLY);
    const after = state(db);
    expect(versions(db)).toEqual([...versions(oldChain()), BASELINE]);
    expect(versions(db)).toHaveLength(57);
    expect(after.schema).toEqual(before.schema);
    expect(after.rows).toEqual(before.rows);
    expect(db.prepare("SELECT name FROM teams WHERE id='team_a'").get()).toEqual({ name: 'A' });
    migrate(db, BASE_ONLY); // a second start is the normal path
    expect(versions(db)).toHaveLength(57);
  });

  it('is recognised after ANALYZE and PRAGMA optimize, whose statistics tables are not compared', () => {
    const db = oldChain();
    db.prepare("INSERT INTO teams(id,name,goal,created_at,updated_at) VALUES ('team_s','S','g',1,1)").run();
    db.exec('ANALYZE; PRAGMA optimize;');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").all().length).toBeGreaterThan(0);
    migrate(db);
    expect(versions(db)).toContain(BASELINE);
  });

  it('is recognised when its objects sit in another order in sqlite_master', () => {
    const src = oldChain();
    const objs = src.prepare("SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND tbl_name <> 'schema_migrations' ORDER BY rowid DESC").all() as { type: string; sql: string }[];
    const db = new DatabaseSync(':memory:');
    for (const type of ['table', 'index', 'view', 'trigger']) for (const o of objs.filter((r) => r.type === type)) db.exec(o.sql);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)');
    const ins = db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)');
    for (const r of src.prepare('SELECT * FROM schema_migrations').all() as { version: number; name: string; applied_at: number; checksum: string }[]) ins.run(r.version, r.name, r.applied_at, r.checksum);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY rowid LIMIT 1").get()).not.toEqual(src.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY rowid LIMIT 1").get());
    migrate(db);
    expect(versions(db)).toContain(BASELINE);
  });

  it('is recognised when migrations 15 and 26 are recorded with the checksum of their text before two comments were reworded', () => {
    const db = oldChain();
    const set = db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?');
    set.run('4334507576d6263178944ba0d36a619b6df40f4cde5664c3bb6a09b95c97074e', 15);
    set.run('7528db371e66d9ad66158e001727c3cc3a6d55a81be7e8f403619b000e2dda19', 26);
    migrate(db);
    expect(versions(db)).toContain(BASELINE);
  });

  const refused: [string, (db: DatabaseSync) => void, RegExp][] = [
    ['one changed column', (db) => {
      db.exec(`CREATE TABLE trd_copy AS SELECT * FROM team_role_defaults; DROP TABLE team_role_defaults;
        CREATE TABLE team_role_defaults (role TEXT PRIMARY KEY, playbook TEXT NOT NULL DEFAULT '');
        INSERT INTO team_role_defaults SELECT * FROM trd_copy; DROP TABLE trd_copy;`);
    }, /differs table team_role_defaults/],
    ['an extra index', (db) => { db.exec('CREATE INDEX idx_extra ON teams(name)'); }, /extra index idx_extra/],
    ['an extra trigger', (db) => { db.exec("CREATE TRIGGER trg_extra AFTER INSERT ON teams BEGIN SELECT 1; END"); }, /extra trigger trg_extra/],
    ['an extra version (70)', (db) => { db.prepare("INSERT INTO schema_migrations VALUES (70,'0070_x.sql',1,'x')").run(); }, /migration 70 is recorded but is not one of 0\.x/],
    ['a changed checksum', (db) => { db.prepare("UPDATE schema_migrations SET checksum='x' WHERE version=5").run(); }, /migration 5 is recorded with another checksum/],
    ['a missing version', (db) => { db.prepare('DELETE FROM schema_migrations WHERE version=42').run(); }, /migration 42 of 0\.x is not recorded/],
    ['a foreign key violation', (db) => {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare("INSERT INTO tasks(id,team_id,title,status,created_at,updated_at) VALUES ('task_o','tm_gone','x','open',1,1)").run();
      db.exec('PRAGMA foreign_keys=ON');
    }, /foreign_key_check: 1 violation/],
  ];
  for (const [label, change, why] of refused) {
    it(`is refused and left unchanged with ${label}`, () => {
      const db = oldChain();
      change(db);
      const before = state(db);
      expect(() => migrate(db)).toThrow(/is at migration 69 but is not the 0\.x schema.*Nothing was changed/s);
      expect(() => migrate(db)).toThrow(why);
      expect(state(db)).toEqual(before);
      expect(db.isTransaction).toBe(false);
    });
  }
});

describe('other databases', () => {
  it('refuses tables with no migration rows, and changes nothing', () => {
    const db = oldChain();
    db.exec('DELETE FROM schema_migrations');
    const before = state(db);
    expect(() => migrate(db)).toThrow(/has \d+ table\(s\), index\(es\) or trigger\(s\) but no recorded migrations.*Nothing was changed/s);
    expect(state(db)).toEqual(before);
  });

  it('refuses an older 0.x hub (at 42) with the upgrade message, and changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-v0-42-'));
    dirs.push(dir);
    for (const f of readdirSync(V0_MIGRATIONS)) if (Number(f.slice(0, 4)) <= 42) copyFileSync(join(V0_MIGRATIONS, f), join(dir, f));
    const db = oldChain(dir);
    const before = state(db);
    expect(() => migrate(db)).toThrow('the database is at migration 42 of 0.x: upgrade to 0.x (0c507c8) first, then to 1.0.');
    expect(state(db)).toEqual(before);
  });
});

describe('rollback', () => {
  it('the 0.x runner with the 0c507c8 files starts on a recognised 1.0 database and changes nothing', () => {
    const db = oldChain();
    migrate(db, BASE_ONLY); // a retag rollback works only while max(version) is 100 (later migrations: restore the backup)
    const before = state(db);
    expect(() => migrate0(db, V0_MIGRATIONS)).not.toThrow();
    expect(state(db)).toEqual(before);
    expect(db.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: BASELINE });
  });
});
