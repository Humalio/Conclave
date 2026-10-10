import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../util/crypto.js';

export type Db = DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));
/** Migrations live in src/db/migrations; the build copies them to dist/db/migrations. */
function migrationsDir(): string { return join(here, 'migrations'); }

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;`);
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`);
  const applied = new Map<number, string>();
  for (const row of db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: number; checksum: string }[]) {
    applied.set(row.version, row.checksum);
  }
  const files = readdirSync(migrationsDir()).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const version = Number(f.slice(0, 4));
    const sql = readFileSync(join(migrationsDir(), f), 'utf8');
    const checksum = sha256Hex(sql);
    const prev = applied.get(version);
    if (prev !== undefined) {
      if (prev !== checksum) throw new Error(`migration ${f} changed after it was applied`);
      continue;
    }
    tx(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES (?,?,?,?)')
        .run(version, f, Date.now(), checksum);
    });
  }
}

/** Run fn in a transaction (BEGIN IMMEDIATE so writers serialize cleanly). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
