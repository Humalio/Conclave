/**
 * Migration 0165 on a hub that already ran 0164: task_turns keeps every row and both indexes and also takes the reason
 * connector_too_old (a reason outside the list is still refused); wake_runs keeps every row and gains run_id.
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

describe('migration 0165 (review fixes)', () => {
  it('keeps every turn and run, adds connector_too_old and run_id, and keeps the indexes', () => {
    const upTo = tmp('conclave-0165-upto-');
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 164) copyFileSync(join(MIGRATIONS, f), join(upTo, f));
    const db = new DatabaseSync(join(tmp('conclave-0165-db-'), 'hub.db'));
    migrate(db, upTo);
    db.exec('PRAGMA foreign_keys = OFF');
    const turn = db.prepare("INSERT INTO task_turns(id,task_id,team_id,phase,holder_agent_id,opened_at,opened_by_kind,delivered_at,delivery_reason,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    turn.run('tt1', 'task1', 'team1', 'queued', 'ag1', 1, 'system', null, 'wake_held', null);
    turn.run('tt2', 'task2', 'team1', 'work', 'ag1', 2, 'admin', 5, null, 9);
    expect(() => turn.run('tt3', 'task3', 'team1', 'queued', 'ag1', 3, 'system', null, 'connector_too_old', null)).toThrow();
    db.prepare("INSERT INTO wake_runs(agent_id,machine_id,state,task_id,started_at,updated_at) VALUES ('ag1','pc1','running','task1',10,11)").run();
    const turnsBefore = db.prepare('SELECT * FROM task_turns ORDER BY id').all().map((r) => ({ ...r }));
    const idx = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_turns' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
    const idxBefore = idx();
    db.exec('PRAGMA foreign_keys = ON');

    migrate(db, MIGRATIONS);

    expect(db.prepare('SELECT * FROM task_turns ORDER BY id').all().map((r) => ({ ...r }))).toEqual(turnsBefore);
    expect(idx()).toEqual(idxBefore);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("UPDATE task_turns SET delivery_reason='connector_too_old' WHERE id='tt1'").run();
    expect(() => db.prepare("UPDATE task_turns SET delivery_reason='bogus' WHERE id='tt1'").run()).toThrow();
    expect({ ...db.prepare("SELECT agent_id, state, task_id, started_at, run_id FROM wake_runs").get() }).toEqual({ agent_id: 'ag1', state: 'running', task_id: 'task1', started_at: 10, run_id: null });
    db.close();
  });
});
