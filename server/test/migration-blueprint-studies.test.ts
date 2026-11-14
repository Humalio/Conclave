/**
 * Migration 0122 (docs/blueprint.md §2.3): bp_links is rebuilt so its CHECK accepts `studies`; the rows and the
 * to_key index are kept, and an unknown relation is still refused.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const upTo = (last: number): string => {
  const d = mkdtempSync(join(tmpdir(), `conclave-0122-${last}-`)); dirs.push(d);
  for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= last) copyFileSync(join(MIGRATIONS, f), join(d, f));
  return d;
};
const link = (db: DatabaseSync, from: string, to: string, rel: string) =>
  db.prepare("INSERT INTO bp_links(project_id,from_key,to_key,rel,created_by_kind,created_by_id,created_at) VALUES ('prj_1',?,?,?,'operator',NULL,7)").run(from, to, rel);

describe('migration 0122: the studies link', () => {
  it('keeps every link, accepts studies and still refuses an unknown relation', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, upTo(121));
    db.prepare("INSERT INTO projects(id,key,name,kind,created_by_kind,created_at,updated_at) VALUES ('prj_1','P1','P','research','system',1,1)").run();
    link(db, 'F-L1-01', 'H-L1-01', 'evidence');
    link(db, 'M1', 'PAP-1', 'delivers');
    expect(() => link(db, 'PAP-1', 'H-L1-01', 'studies')).toThrow(/CHECK/);
    migrate(db, MIGRATIONS);
    expect(db.prepare('SELECT from_key, to_key, rel, created_at FROM bp_links ORDER BY rel').all().map((r) => ({ ...r }))).toEqual([
      { from_key: 'M1', to_key: 'PAP-1', rel: 'delivers', created_at: 7 }, { from_key: 'F-L1-01', to_key: 'H-L1-01', rel: 'evidence', created_at: 7 },
    ]);
    link(db, 'PAP-1', 'H-L1-01', 'studies');
    expect(() => link(db, 'PAP-1', 'H-L1-01', 'cites')).toThrow(/CHECK/);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='bp_links_to'").get()).toBeTruthy();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});
