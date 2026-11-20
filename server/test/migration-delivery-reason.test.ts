/**
 * Migration 0155 on a hub that already ran 0153 (three delivery reasons): task_turns is rebuilt, every row and both indexes
 * are kept, the old reasons still pass, agent_unknown can now be recorded, and anything else is still refused.
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

describe('migration 0155 (delivery reason agent_unknown)', () => {
  it('upgrades a 0153 database, keeps its turns and indexes, and records agent_unknown', () => {
    const upTo = tmp('conclave-0155-upto-');
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 153) copyFileSync(join(MIGRATIONS, f), join(upTo, f));
    const db = new DatabaseSync(join(tmp('conclave-0155-db-'), 'hub.db'));
    migrate(db, upTo);
    db.exec('PRAGMA foreign_keys = OFF');
    const ins = db.prepare("INSERT INTO task_turns (id,task_id,team_id,phase,holder_agent_id,opened_at,opened_by_kind,closed_at,delivered_at,delivery_reason) VALUES (?,?,?,?,?,1,'system',?,?,?)");
    ins.run('trn_a', 'task_a', 'team_a', 'queued', 'ag', null, null, 'pc_offline');
    ins.run('trn_b', 'task_b', 'team_a', 'work', 'ag', 5, 4, null);
    expect(() => db.prepare("UPDATE task_turns SET delivery_reason='agent_unknown' WHERE id='trn_a'").run()).toThrow(/CHECK/);
    const before = db.prepare('SELECT * FROM task_turns ORDER BY id').all().map((r) => ({ ...r }));
    db.exec('PRAGMA foreign_keys = ON');

    migrate(db, MIGRATIONS);

    expect(db.prepare('SELECT * FROM task_turns ORDER BY id').all().map((r) => ({ ...r }))).toEqual(before);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_turns' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(['task_turns_holder', 'task_turns_open']);
    db.prepare("UPDATE task_turns SET delivery_reason='agent_unknown' WHERE id='trn_a'").run();
    expect(db.prepare("SELECT delivery_reason r FROM task_turns WHERE id='trn_a'").get()).toEqual({ r: 'agent_unknown' });
    expect(() => db.prepare("UPDATE task_turns SET delivery_reason='nonsense' WHERE id='trn_a'").run()).toThrow(/CHECK/);
    db.close();
  });
});
