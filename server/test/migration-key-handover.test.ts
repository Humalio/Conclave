/**
 * Migration 0167 on a hub that already ran 0166: onboarding_requests is rebuilt the 0127 way (foreign keys off, then the
 * runner's foreign_key_check), every row is kept with no handover, the indexes come back with the handover one, the kind
 * 'rotate' and the handover marker pass, and anything else is still refused.
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

describe('migration 0167 (key handover)', () => {
  it('upgrades a 0166 database, keeps its requests and indexes, and accepts a handover', () => {
    const upTo = tmp('conclave-0167-upto-');
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 166) copyFileSync(join(MIGRATIONS, f), join(upTo, f));
    const db = new DatabaseSync(join(tmp('conclave-0167-db-'), 'hub.db'));
    migrate(db, upTo);
    db.exec('PRAGMA foreign_keys = OFF');
    const ins = db.prepare("INSERT INTO onboarding_requests (id,app_credential_id,machine_id,kind,state,body,filed_at,updated_at,waiting_since) VALUES (?,?,?,?,?,'{}',1,2,3)");
    ins.run('obr_a', 'crd_a', 'mch_a', 'new_team', 'submitted');
    ins.run('obr_b', 'crd_a', 'mch_a', 'add_agents', 'collected');
    expect(() => ins.run('obr_c', 'crd_a', 'mch_a', 'rotate', 'approved')).toThrow(/CHECK/);
    const before = db.prepare('SELECT * FROM onboarding_requests ORDER BY id').all().map((r) => ({ ...r }));
    db.exec('PRAGMA foreign_keys = ON');

    migrate(db, MIGRATIONS);

    expect(db.prepare('SELECT * FROM onboarding_requests ORDER BY id').all().map((r) => ({ ...r }))).toEqual(before.map((r) => ({ ...r, handover: null, expires_at: null })));
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='onboarding_requests' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['onboarding_requests_handover', 'onboarding_requests_key', 'onboarding_requests_state']));
    db.exec('PRAGMA foreign_keys = OFF');
    const add = db.prepare("INSERT INTO onboarding_requests (id,app_credential_id,machine_id,kind,state,body,filed_at,updated_at,waiting_since,handover,expires_at) VALUES (?,'crd_a','mch_a',?,'approved','{}',1,1,1,?,9)");
    add.run('obr_r', 'rotate', 'rotate');
    expect(() => add.run('obr_x', 'rotate', 'gift')).toThrow(/CHECK/);
    expect(() => add.run('obr_y', 'renew', null)).toThrow(/CHECK/);
    for (const [t, c] of [['onboarding_slots', 'staged_key_id'], ['onboarding_slots', 'staged_verifier'], ['connector_reports', 'app_credential_id']]) {
      expect((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name), `${t}.${c}`).toContain(c);
    }
    db.close();
  });
});
