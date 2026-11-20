/**
 * Migration 0164 on a hub that already ran 0163: pc_actions keeps every row, gains the agent, reason, release and hand-out columns
 * (the agent and reason filled from each delivery order's payload) and the (kind, state) index; nothing else about the table changes.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
vi.spyOn(console, 'warn').mockImplementation(() => {});
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('migration 0164 (delivery reliability)', () => {
  it('keeps every order, adds only the new columns and indexes, and fills the agent and reason of delivery orders', () => {
    const upTo = tmp('conclave-0164-upto-');
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 163) copyFileSync(join(MIGRATIONS, f), join(upTo, f));
    const db = new DatabaseSync(join(tmp('conclave-0164-db-'), 'hub.db'));
    migrate(db, upTo);
    db.exec('PRAGMA foreign_keys = OFF');
    const ins = db.prepare('INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('pca_a', 'pc1', 'deliver', 'queued', JSON.stringify({ agent_id: 'ag1', items: [{ notice: 'message' }] }), 1, 'hub', 9);
    ins.run('pca_b', 'pc1', 'deliver', 'done', JSON.stringify({ agent_id: 'ag2', reason: 'reset', items: [] }), 2, 'hub', 9);
    ins.run('pca_c', 'pc1', 'check', 'done', '{}', 3, 'x', 9);
    const colsBefore = (db.prepare("SELECT name FROM pragma_table_info('pc_actions')").all() as { name: string }[]).map((r) => r.name);
    const idxBefore = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pc_actions' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
    const before = db.prepare('SELECT * FROM pc_actions ORDER BY id').all().map((r) => ({ ...r }));
    db.exec('PRAGMA foreign_keys = ON');

    migrate(db, MIGRATIONS);

    const colsAfter = (db.prepare("SELECT name FROM pragma_table_info('pc_actions')").all() as { name: string }[]).map((r) => r.name);
    expect(colsAfter.filter((c) => !colsBefore.includes(c)).sort()).toEqual(['agent_id', 'handed_at', 'order_reason', 'release_at']);
    expect(colsBefore.every((c) => colsAfter.includes(c))).toBe(true);
    const idxAfter = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pc_actions' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
    expect(idxAfter.filter((n) => !idxBefore.includes(n))).toEqual(['pc_actions_agent', 'pc_actions_kind_state']);
    // Every old column keeps its value; the new ones are filled for delivery orders only.
    const after = db.prepare('SELECT * FROM pc_actions ORDER BY id').all().map((r) => ({ ...r })) as Record<string, unknown>[];
    expect(after.map((r) => Object.fromEntries(colsBefore.map((c) => [c, r[c]])))).toEqual(before);
    expect(after.map((r) => [r.id, r.agent_id, r.order_reason, r.release_at, r.handed_at])).toEqual([
      ['pca_a', 'ag1', null, null, null], ['pca_b', 'ag2', 'reset', null, null], ['pca_c', null, null, null, null],
    ]);
    db.close();
  });
});
