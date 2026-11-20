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

/** Line endings normalised to LF, so CRLF and LF checkouts of a migration hash the same. */
export function normaliseEol(sql: string): string { return sql.replace(/\r\n/g, '\n'); }

/** Checksum of a migration's text, independent of its line endings. */
export function migrationChecksum(sql: string): string { return sha256Hex(normaliseEol(sql)); }

/**
 * The 1.0 baseline (docs/proposals/v1-release.md §2): one generated file (scripts/v1-baseline.mjs) holding the whole
 * schema and seed rows of 0.x. Later migrations are 0101 and up.
 */
export const BASELINE = 100;
const BASELINE_FILE = '0100_v1_baseline.sql';
const UNCHANGED = 'Nothing was changed. See docs/getting-started.md, "Upgrading to 1.0".';

/**
 * The (version, checksum) of the 56 migrations of 0.x (the last 0.x version), as a 0.x hub at migration 69 records them. A database
 * with exactly these rows and the baseline's schema is adopted: 100 is recorded as applied without running it.
 * Printed by scripts/v1-baseline.mjs --legacy.
 */
const LEGACY_0X: readonly (readonly [number, string])[] = [
  [1, 'a27927f18502b071d14d8d03488121ef3e34885643c0b0c88288ccf687b9a97c'],
  [2, 'b241334c915c0d32115f7ede93b30746d4d8b4042924b0cd16e069b4fc85f142'],
  [3, '95c5fccae5b39a1205dae4b9e738585cd3d5dfb11f0700f528a66e387f5028f4'],
  [4, '0f02648ab1365aa5588c00325391a6fc766a238f7487fdc7f42506ae5b26e599'],
  [5, '54314c1d7d5c3ae6dab4786192a294f7fe938a8eddfe52d2aff552ec0aa48401'],
  [6, '655395717482090228f166907bb5aa5b1daf369b17aac056ec019cf7e4db004f'],
  [7, 'd9834bbd1b969992109d66aa98e2985539693229319c831791d9129576d020a9'],
  [8, 'f31d95f52e992fd68b72ccf2de0d73ac3a51a964b9fa08257bfeac14d3a92e21'],
  [9, 'dde46699bc14b56fe035ce1101c49b80e62921be12f1b1b0b555cb25f7405c6b'],
  [10, '2df41f02abd845f25e27e1631151279a26c8c0f3f965a4b811c123cba6e164ab'],
  [11, '202ae3899a04d27d356d360f02ceb34ba231a8f4bb1d2907ba09553f3e8e4b56'],
  [12, 'a3b1d6507e46385da9e85fb4a2b7e0874e51f8c5ea5d85eda8a4b9a6df3a8263'],
  [13, '975c6de42068ce06d05228181be62f4edc021b09206bd2c6c1992104d883416a'],
  [14, 'ed80b83b4809983f5176cedca4fcfcb221a17f83cc23595f0e3df0e37b4b3a53'],
  [15, '4334507576d6263178944ba0d36a619b6df40f4cde5664c3bb6a09b95c97074e'],
  [16, 'de2d7281157acd9ff6ca0b33582a470d464dbd16a958c2a59908e887283a7740'],
  [17, '6eac1aa88633d652cedca5bad9872c43c262c08896ecd7b3928cdb5bed87892a'],
  [18, '62eade69e45ec798f3256b7ee7970eff1eafffa38cc2444bab6cdbed0c5f1739'],
  [19, 'f38a9e92dc4f159181099ffea456d2e8b54e0b9e583b2c3e646c0d9852a378e2'],
  [20, 'cfd43ea548e27a3e537d7db685894e095c1bdde8b011780cf9787342df4ffb04'],
  [21, 'ea61fc6e08331be179239f28faffd432bdc629db0bdea41e77e1e1e490d4e948'],
  [22, '6188504b39bc3135ebe1c1100132b7e5e9d110276811699d02ef7271696a3033'],
  [23, 'e9e66cefe709963411a23674f63acaa223580346e727ba11b4ed4bc53ecf71dc'],
  [24, '75f2e86bb69ac09568652e8c9d15149a06a09a3381822d9239b6e91e0674f94f'],
  [25, '95d2c512f93990b81af7ee3fa9fbfc9abe34cc07cccce8ee78e5a896e524ceea'],
  [26, '7528db371e66d9ad66158e001727c3cc3a6d55a81be7e8f403619b000e2dda19'],
  [27, '42a5b3aa3eadfa0b986914d155ed9253ca8c637e034468a3e287a6f020ce70a5'],
  [28, '7b500f198686df9781988e6bf6666719f986796e7035f0b4f1d58d637d007eed'],
  [29, 'ab5b96a7e10cc37674a4b3e465ed7d6779cb4de803a40ceb6463fd32105849bd'],
  [30, '210b0b04be8c9c936c932d937879d4853a58bdc5047de700ec4571aa8a6847f8'],
  [31, '841a12100b9ad92a696d69a7a7b88d6b3eabd04df8239028bb783cbfbcf3a25d'],
  [32, 'e51c0171768d34a54737df08eb2451ceccdd9089cda083b072aa2b8798c8b5fd'],
  [33, '558735e7bf5c587f2c33c1aba5d24c5639c64e1f063d10abccd865b2a3a14af7'],
  [34, '6d9cc7284338b8d391a67c6802d902b7bb833d73b28120b09431cb1644a7b56d'],
  [35, '1cb99332465de2c5d452c8815b2b1b25d954b64a48cb9c06e212f84ab7063b4f'],
  [36, 'edf97014c91adb9e0c2933a1d49044d9c187874c0e507b921eeb944bac46cb12'],
  [37, '8d3e5d2102dabb9273738f5c87b6e223e686d0863f19ebab6c327664b2b04d2d'],
  [38, '79140344af782c29abf2130e56752c8689b799da1cb8c77ef15c1240a93dd17b'],
  [39, 'be43ae31cc5d4815ceab4b41950af9bc7f109b299947ee4335d1f4567840d197'],
  [40, '92eb599edca0f24d809ca03a3a5405e929bc60ae779f06bd9f5fd973148d27f3'],
  [41, '80cfe01d0d3adc25664ab494d54ef10507fe5511029f8131e12552cd251b63e4'],
  [42, 'ef24e1344deb7e28d3a0c88580eb3dc877f780253c0273826fd407cd36196647'],
  [50, '9e47d94e801758e484c622074dfdb86af8ec9b2cad124e9393ec37a50f14bb2e'],
  [51, '35653212e1964b9b3378c9d728896452ee038ee265f8ca4de4014355a16c4659'],
  [52, 'a77cd18d8561399ee7c6a805911f1518b864d6386982615fbac86b6790b8553d'],
  [53, 'ca43fb68b2b44fd6b4c6e1127e25680eb6b81b5df43e1b277b28fdca10ed4c4c'],
  [54, 'b24e2afb6de5909ff5edffd030171c5ee3ec26d2c61d0c1f3382e5ea6445bf96'],
  [55, '071cad8734119181535b8b7caa70d84f33520f0e936df114d6e1f2f7a99b52fb'],
  [60, '716074033b835f5578c60a8f3e2e6612f1604d3ddf78b821185ccfc08ce37594'],
  [61, 'e13657ae37aeac6a12f8b1c7d3fe22bab07f808ba88b71d25bfd9a2ab431334d'],
  [62, '53ac559a9745bf375a86019d493b39abe8e642217df20e86515cb46028fb5df7'],
  [65, '47253865b852df1c6a50e9f21355cf4792c92d5868b32cccdda775c546a447f6'],
  [66, '80b512a339803d06d7acb4263bfa3c4bea1be9b4070aa101d84acbcbb65090eb'],
  [67, 'd6a9bf3b757bfc6a2e6632ccad02e1d932e5fe32fb993b013be0ac0a0bf7216f'],
  [68, 'b1c25927725d84bd16b2e86d7ba3829083b4ede8869ef6c558323f58302fa318'],
  [69, 'd99d2104dfb9c7298d817916bf3f0749868ac6e8051ae9a7e1ed3b4b4e59d26e'],
];
const LEGACY_LAST = 69;

/**
 * Migrations 15 and 26 of 0.x had two comments reworded before the repository went public (a project name and a person's
 * name). A 0.x database recorded the checksum of the old text, a fresh checkout of the 0.x fixtures hashes the new one: both
 * are accepted for exactly these two versions, so no database needs a hand edit.
 */
const LEGACY_0X_REWORDED: ReadonlyMap<number, string> = new Map([
  [15, '5e3709b440ccaa0898b90d6cc7a2dd200dc4a3f1a35070718d20090bf6331459'],
  [26, '73f51889c01ceb7ed7a158a45e10a935a292393f9a0dc1c31860ea7097e714fa'],
]);

/**
 * Bring the database to the current schema. An empty database gets the baseline; one with 100 recorded runs what is
 * pending (0101+); a 0.x database at 69 is recognised (see recognise). Anything else stops the hub with what to do,
 * and nothing is changed.
 */
export function migrate(db: Db, dir: string = migrationsDir()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`);
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const read = (f: string): string => normaliseEol(readFileSync(join(dir, f), 'utf8'));
  if (!files.includes(BASELINE_FILE)) throw new Error(`migration ${BASELINE_FILE} is missing from ${dir}`);
  const recorded = (): Map<number, string> => new Map((db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: number; checksum: string }[])
    .map((r) => [r.version, r.checksum]));
  let applied = recorded();
  if (!applied.has(BASELINE)) {
    if (applied.size === 0) {
      const objs = userObjects(db);
      if (objs.length) {
        throw new Error(`the database has ${objs.length} table(s), index(es) or trigger(s) but no recorded migrations, so Conclave 1.0 `
          + `does not know what it holds (${objs.slice(0, 5).join(', ')}${objs.length > 5 ? ', ...' : ''}). ${UNCHANGED}`);
      }
    } else if (applied.has(LEGACY_LAST)) {
      recognise(db, read(BASELINE_FILE));
      applied = recorded();
    } else {
      throw new Error(`the database is at migration ${Math.max(...applied.keys())} of 0.x, which `
        + `is too old to move to 1.0 directly: upgrade it to the last 0.x release (migration 69) first, then to 1.0. `
        + `That older release is not part of the public repository, so this upgrade path is not supported from it. ${UNCHANGED}`);
    }
  }
  const pending: { version: number; f: string; sql: string; checksum: string }[] = [];
  for (const f of files) {
    const version = Number(f.slice(0, 4));
    const sql = read(f);
    const checksum = migrationChecksum(sql);
    const prev = applied.get(version);
    if (prev === undefined) { pending.push({ version, f, sql, checksum }); continue; }
    if (prev !== checksum) throw new Error(`migration ${f} changed after it was applied`);
  }
  for (const m of pending) {
    // A migration that rebuilds a table other tables reference (SQLite cannot change a CHECK in place) has the line
    // "-- migrate: foreign_keys off": foreign keys are off while it runs (the pragma is a no-op inside a transaction),
    // and foreign_key_check must find no violation the migration made before it commits. Orphans that were there before
    // (in any table) are logged, not fatal: an old stray row elsewhere must not stop the hub from starting.
    const fkOff = /^-- migrate: foreign_keys off$/m.test(m.sql);
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

/** Objects other than schema_migrations and SQLite's own (sqlite_sequence, sqlite_autoindex_*), as "type name". */
function userObjects(db: Db): string[] {
  return (db.prepare(`SELECT type, name FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' AND tbl_name <> 'schema_migrations' ORDER BY rowid`)
    .all() as { type: string; name: string }[]).map((r) => `${r.type} ${r.name}`);
}

/**
 * sqlite_master as a set keyed by "type name", each with its tbl_name and its sql exactly (line endings normalised, no
 * whitespace collapsing, which could hide a change inside a DEFAULT). rootpage and row order are left out: tables
 * rebuilt by 0.x migrations sit at other rowids on a live hub. sqlite_autoindex_* rows (sql NULL) count by name;
 * schema_migrations, sqlite_sequence and the statistics tables (sqlite_stat1 to sqlite_stat4, made by ANALYZE or
 * PRAGMA optimize) are left out.
 */
export function schemaSet(db: Db): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as { type: string; name: string; tbl_name: string; sql: string | null }[]) {
    if (r.name === 'sqlite_sequence' || /^sqlite_stat\d$/.test(r.name) || r.tbl_name === 'schema_migrations') continue;
    m.set(`${r.type} ${r.name}`, `${r.tbl_name}\n${r.sql === null ? '' : normaliseEol(r.sql)}`);
  }
  return m;
}

/** What differs between two schema sets, one line per object: missing from, extra in, or differing in `have`. */
export function schemaDiff(want: Map<string, string>, have: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of want) if (!have.has(k)) out.push(`missing ${k}`); else if (have.get(k) !== v) out.push(`differs ${k}`);
  for (const k of have.keys()) if (!want.has(k)) out.push(`extra ${k}`);
  return out;
}

/**
 * A 0.x database at migration 69 (both hubs before 1.0) is adopted when its recorded migrations are exactly the 56 of
 * 0.x and its schema equals the baseline: 100 is recorded as applied without running it. Rows 1 to 69 stay, so the 0.x
 * image still starts on it (rollback). All in one BEGIN IMMEDIATE, with quick_check and foreign_key_check: a damaged
 * or different database is refused with what differs, and nothing is changed.
 */
function recognise(db: Db, baselineSql: string): void {
  tx(db, () => {
    // Read again inside the lock: another process may have recorded 100 since migrate() looked.
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(BASELINE)) return;
    const problems: string[] = [];
    const quick = (db.prepare('PRAGMA quick_check').all() as { quick_check: string }[]).map((r) => r.quick_check);
    if (quick.join() !== 'ok') problems.push(`quick_check: ${quick.slice(0, 5).join('; ')}`);
    const fk = db.prepare('PRAGMA foreign_key_check').all() as { table: string; parent: string }[];
    if (fk.length) problems.push(`foreign_key_check: ${fk.length} violation(s), the first in ${fk[0]!.table} (parent ${fk[0]!.parent})`);
    const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
    const legacy = new Map(LEGACY_0X);
    for (const r of rows) {
      const want = legacy.get(r.version);
      if (want === undefined) problems.push(`migration ${r.version} is recorded but is not one of 0.x`);
      else if (want !== r.checksum && LEGACY_0X_REWORDED.get(r.version) !== r.checksum) problems.push(`migration ${r.version} is recorded with another checksum than in 0.x`);
    }
    const have = new Set(rows.map((r) => r.version));
    for (const [v] of LEGACY_0X) if (!have.has(v)) problems.push(`migration ${v} of 0.x is not recorded`);
    const base = new DatabaseSync(':memory:');
    try { base.exec(baselineSql); problems.push(...schemaDiff(schemaSet(base), schemaSet(db))); } finally { base.close(); }
    if (problems.length) {
      throw new Error(`the database is at migration ${LEGACY_LAST} but is not the 0.x schema, so Conclave 1.0 does not adopt it. `
        + `${UNCHANGED}\n  ${problems.join('\n  ')}`);
    }
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES (?,?,?,?)')
      .run(BASELINE, BASELINE_FILE, Date.now(), migrationChecksum(baselineSql));
    console.warn(`[db] recognised a 0.x database at migration ${LEGACY_LAST}; recorded ${BASELINE_FILE} as applied`);
  });
}

/** Run fn in a transaction (BEGIN IMMEDIATE so writers serialize cleanly). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
