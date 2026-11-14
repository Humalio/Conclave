/**
 * The 0.x migration runner as it shipped in 0c507c8 (src/db/db.ts), kept as a test fixture with the 56 migration files
 * beside it. It builds the old chain that the 1.0 baseline must equal, and proves a rollback: the 0.x runner still starts
 * on a 1.0 database (docs/proposals/v1-release.md §2.4, §5). Self-contained so scripts/v1-baseline.mjs can import it too.
 * Not used by the hub.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Db = DatabaseSync;
const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const V0_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
export function normaliseEol(sql: string): string { return sql.replace(/\r\n/g, '\n'); }

/** Checksum of a migration's text, independent of its line endings. */
export function migrationChecksum(sql: string): string { return sha256Hex(normaliseEol(sql)); }

/**
 * Before checksums were normalised, the raw file was hashed, so a stored checksum may be
 * of the CRLF form (deploys packed from a Windows checkout) as well as the LF form.
 */
function crlfChecksum(sql: string): string { return sha256Hex(normaliseEol(sql).replace(/\n/g, '\r\n')); }

export function migrate0(db: Db, dir: string = V0_MIGRATIONS): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`);
  const applied = new Map<number, string>();
  for (const row of db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: number; checksum: string }[]) {
    applied.set(row.version, row.checksum);
  }
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const pending: { version: number; f: string; sql: string; checksum: string }[] = [];
  const rehash: { version: number; f: string; checksum: string }[] = [];
  for (const f of files) {
    const version = Number(f.slice(0, 4));
    const sql = normaliseEol(readFileSync(join(dir, f), 'utf8'));
    const checksum = migrationChecksum(sql);
    const prev = applied.get(version);
    if (prev === undefined) { pending.push({ version, f, sql, checksum }); continue; }
    if (prev === checksum) continue;
    if (prev !== crlfChecksum(sql)) throw new Error(`migration ${f} changed after it was applied`);
    rehash.push({ version, f, checksum });
  }
  if (rehash.length) {
    // One-time: rewrite checksums stored from the CRLF form to the normalised hash.
    tx(db, () => {
      const upd = db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?');
      for (const r of rehash) upd.run(r.checksum, r.version);
    });
    console.warn(`[db] normalised line-ending checksums of ${rehash.length} applied migration(s): ${rehash.map((r) => r.f).join(', ')}`);
  }
  for (const m of pending) {
    BEFORE[m.version]?.(db);
    // A migration that rebuilds a table other tables reference (SQLite cannot change a CHECK in place) has the line
    // "-- migrate: foreign_keys off" (new migrations use this form; 0051 starts with the older FK_OFF form, also accepted):
    // foreign keys are off while it runs (the pragma is a no-op inside a transaction), and foreign_key_check must find no
    // violation the migration made before it commits. Orphans that were there before (in any table) are logged, not
    // fatal: an old stray row elsewhere must not stop the hub from starting.
    const fkOff = /^-- migrate: foreign_keys off$/m.test(m.sql) || m.sql.startsWith(FK_OFF);
    const fkWasOn = fkOff && (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys=OFF');
    try {
      tx(db, () => {
        // Counted per (table, parent table): a rebuilt table may renumber its rowids and its foreign keys.
        const fkCount = (): Map<string, number> => {
          const n = new Map<string, number>();
          for (const r of db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[]) { const k = `${r.table}|${r.parent}`; n.set(k, (n.get(k) ?? 0) + 1); }
          return n;
        };
        const before = fkOff ? fkCount() : null;
        if (before?.size) console.warn(`[db] ${[...before.values()].reduce((a, b) => a + b, 0)} foreign key violation(s) predate migration ${m.f}; left as they are`);
        db.exec(m.sql);
        if (before) {
          const added = [...fkCount()].reduce((a, [k, n]) => a + Math.max(0, n - (before.get(k) ?? 0)), 0);
          if (added) throw new Error(`migration ${m.f} left ${added} new foreign key violation(s)`);
        }
        db.prepare('INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES (?,?,?,?)')
          .run(m.version, m.f, Date.now(), m.checksum);
      });
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys=ON');
    }
  }
}
const FK_OFF = '-- migrate:foreign-keys-off';

/** Checks that must pass before a migration runs. Each stops the hub with what to do, so no data is lost. */
const BEFORE: Record<number, (db: Db) => void> = {
  // 0039 drops the team plan tables. Builds from the Blueprint up to 0039 copied every team plan into its team's part
  // of the project blueprint at start (keeping each row's id as origin_id, and each event's id as legacy_id); this build
  // has no copier. A plan row is copied when an item carries its id, or its key is taken in the team's project.
  39: (db) => {
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!has('team_plan_items')) return;
    const items = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT p.team_id) AS teams FROM team_plan_items p
      WHERE NOT EXISTS (SELECT 1 FROM bp_items i WHERE i.origin_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM bp_items i JOIN teams t ON t.project_id = i.project_id WHERE t.id = p.team_id AND i.key = p.key)`).get() as { n: number; teams: number };
    const events = has('team_plan_events')
      ? (db.prepare('SELECT COUNT(*) AS n FROM team_plan_events e WHERE NOT EXISTS (SELECT 1 FROM bp_events b WHERE b.legacy_id = e.id)').get() as { n: number }).n
      : 0;
    if (!items.n && !events) return;
    throw new Error(`migration 0039_drop_team_plan.sql would drop ${items.n} team plan item(s) of ${items.teams} team(s) and ${events} plan event(s) `
      + 'not yet copied into the project blueprint. Start the hub once with a build that still copies team plans, then start this one '
      + '(docs/blueprint.md §5, "Upgrading a hub with team plans").');
  },
};

/** Run fn in a transaction (BEGIN IMMEDIATE so writers serialize cleanly). */
function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
