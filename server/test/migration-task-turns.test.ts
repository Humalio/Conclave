/**
 * Migration 0107 (docs/proposals/console-systems.md §8.3, TASKFLOW-1): task turns. A hub at 0106 starts on 0107 with one
 * open turn per live team task, queued tasks lose their lease and their overdue alert, busy_until and pickup_minutes
 * exist, and the hand-off line joins the coordinator and worker playbooks only where a copy is still the shipped text.
 * Covers 8.A13 and 8.A14, an idempotent rerun, and a checksum that is the same for CRLF and LF checkouts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, migrationChecksum } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
import { ON_DEMAND_PLAYBOOKS, HANDOFF_LINE, type TurnRow } from '../src/teams/teams.js';
import { testConfig } from './hub.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const FILE = '0107_task_turns.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
vi.spyOn(console, 'warn').mockImplementation(() => {});

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
/** The migrations up to `last`: the schema a hub had before this change. */
const upTo = (last: number, eol: 'lf' | 'crlf' = 'lf'): string => {
  const d = tmp(`conclave-0107-upto-${last}-`);
  for (const f of readdirSync(MIGRATIONS)) {
    if (!/^\d{4}_.+\.sql$/.test(f) || Number(f.slice(0, 4)) > last) continue;
    if (eol === 'lf') copyFileSync(join(MIGRATIONS, f), join(d, f));
    else writeFileSync(join(d, f), readFileSync(join(MIGRATIONS, f), 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  return d;
};

/** The on-demand text shipped before 0107: the constant without the hand-off line. */
const OLD_OD = { coordinator: ON_DEMAND_PLAYBOOKS.coordinator!.replace(' ' + HANDOFF_LINE, ''), worker: ON_DEMAND_PLAYBOOKS.worker!.replace(' ' + HANDOFF_LINE, '') };
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.now();
const T0 = NOW - 3 * 24 * HOUR;              // A was assigned three days ago
const T_START = NOW - 20 * MIN;              // B was started
const T_REVIEW = NOW - 2 * HOUR;             // C and D went into review
const UNTIL = NOW + 3 * HOUR;                // W's task_progress until on B

const ids = {
  team: 'team_poll0106', od: 'team_od0106', edited: 'team_edit0106',
  w: 'agent-w', r: 'agent-r', r2: 'agent-r2', c: 'agent-c',
  assigned: 'task_assigned', started: 'task_started', review: 'task_review', stuck: 'task_stuck', changes: 'task_changes', done: 'task_done', open: 'task_open',
  alert: 'alr_overdue_assigned',
};

/** A hub at 0106: a running poll team with tasks in every live state, an on-demand team, a team with an edited playbook. */
function seed(db: DatabaseSync): { oldPoll: Record<'coordinator' | 'worker', string> } {
  const defaults = (role: string) => (db.prepare('SELECT playbook FROM team_role_defaults WHERE role=?').get(role) as { playbook: string }).playbook;
  const oldPoll = { coordinator: defaults('coordinator'), worker: defaults('worker') };
  const agent = db.prepare('INSERT INTO agents(id,label,created_at,last_seen_at) VALUES (?,?,?,?)');
  agent.run(ids.w, 'Ana', T0, NOW - 5 * MIN);
  agent.run(ids.r, 'Bea', T0, T_REVIEW + 10 * MIN);   // called the hub after C went into review
  agent.run(ids.r2, 'Cy', T0, T_REVIEW - 10 * MIN);   // has not called since
  agent.run(ids.c, 'Coord', T0, NOW);
  const policy = db.prepare("INSERT INTO permission_policies(id,kind,created_at,updated_at) VALUES (?,'credential',?,?)");
  const cred = db.prepare("INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,policy_id,created_at) VALUES (?,'session_key',?,?,?,'00','active',?,?)");
  for (const a of [ids.w, ids.r, ids.r2, ids.c]) { policy.run(`pol_${a}`, T0, T0); cred.run(`crd_${a}`, a, a, `kid_${a}`, `pol_${a}`, T0); }
  const team = db.prepare("INSERT INTO teams(id,name,goal,status,lease_minutes,delivery_mode,created_at,updated_at) VALUES (?,?,?,'running',30,?,?,?)");
  team.run(ids.team, 'Poll', 'g', 'poll', T0, T0); team.run(ids.od, 'On demand', 'g', 'on_demand', T0, T0); team.run(ids.edited, 'Edited', 'g', 'poll', T0, T0);
  const role = db.prepare('INSERT INTO team_roles(team_id,role,playbook) VALUES (?,?,?)');
  for (const r of ['coordinator', 'worker'] as const) {
    role.run(ids.team, r, oldPoll[r]);
    role.run(ids.od, r, OLD_OD[r]);
  }
  role.run(ids.team, 'reviewer', defaults('reviewer'));
  role.run(ids.edited, 'coordinator', oldPoll.coordinator + ' Also water the plants.');
  role.run(ids.edited, 'worker', oldPoll.worker);
  const member = db.prepare('INSERT INTO team_members(team_id,agent_id,credential_id,role,joined_at,removed_at) VALUES (?,?,?,?,?,?)');
  member.run(ids.team, ids.w, `crd_${ids.w}`, 'worker', T0 - HOUR, T0 - 30 * MIN); // an earlier, removed membership
  member.run(ids.team, ids.w, `crd_${ids.w}`, 'worker', T0, null);
  member.run(ids.team, ids.r, `crd_${ids.r}`, 'reviewer', T0, null);
  member.run(ids.team, ids.r2, `crd_${ids.r2}`, 'reviewer', T0, null);
  member.run(ids.team, ids.c, `crd_${ids.c}`, 'coordinator', T0, null);
  const task = db.prepare(`INSERT INTO tasks(id,team_id,title,status,assignee_agent_id,reviewer_agent_id,lease_expires_at,progress_until,overdue_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  // Assigned three days ago and never started: the old image set a lease at assignment, it lapsed and raised an alert.
  task.run(ids.assigned, ids.team, 'Queued', 'assigned', ids.w, ids.r, T0 + 30 * MIN, null, T0 + 31 * MIN, T0, T0);
  task.run(ids.started, ids.team, 'Running', 'in_progress', ids.w, ids.r, UNTIL, UNTIL, null, T0, T_START + MIN);
  task.run(ids.review, ids.team, 'In review', 'in_review', ids.w, ids.r, null, null, null, T0, T_REVIEW + MIN);
  task.run(ids.stuck, ids.team, 'Stuck review', 'in_review', ids.w, ids.r2, null, null, null, T0, T_REVIEW + MIN);
  task.run(ids.changes, ids.team, 'Changes', 'changes_requested', ids.w, ids.r, T0 + 30 * MIN, null, null, T0, T0 + HOUR);
  task.run(ids.done, ids.team, 'Done', 'done', ids.w, ids.r, null, null, null, T0, T0);
  task.run(ids.open, ids.team, 'Open', 'open', null, null, null, null, null, T0, T0);
  const ev = db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,created_at) VALUES (?,?,?,'agent',?,?,?)");
  ev.run(ids.assigned, 'open', 'assigned', ids.c, 'task_assign', T0);
  ev.run(ids.started, 'assigned', 'in_progress', ids.w, 'task_start', T_START - HOUR); // an earlier start
  ev.run(ids.started, 'changes_requested', 'in_progress', ids.w, 'task_start', T_START);
  ev.run(ids.review, 'in_progress', 'in_review', ids.w, 'task_submit', T_REVIEW);
  ev.run(ids.stuck, 'in_progress', 'in_review', ids.w, 'task_submit', T_REVIEW);
  db.prepare("INSERT INTO security_alerts(id,severity,type,subject,details,status,created_at,updated_at) VALUES (?,'warning','task_overdue',?,'{}','open',?,?)")
    .run(ids.alert, ids.assigned, T0 + 31 * MIN, T0 + 31 * MIN);
  return { oldPoll };
}

const turns = (db: { prepare: DatabaseSync['prepare'] }) => db.prepare('SELECT * FROM task_turns ORDER BY task_id').all() as unknown as TurnRow[];
const open = (db: { prepare: DatabaseSync['prepare'] }, taskId: string) => db.prepare('SELECT * FROM task_turns WHERE task_id=? AND closed_at IS NULL').all(taskId) as unknown as TurnRow[];
/** Everything 0107 writes, to compare a database before and after a step. */
const snapshot = (db: { prepare: DatabaseSync['prepare'] }) => ({
  turns: turns(db),
  tasks: db.prepare('SELECT id, status, lease_expires_at, overdue_at, started_at FROM tasks ORDER BY id').all(),
  members: db.prepare('SELECT team_id, agent_id, removed_at, busy_until FROM team_members ORDER BY team_id, agent_id, joined_at').all(),
  teams: db.prepare('SELECT id, pickup_minutes FROM teams ORDER BY id').all(),
  roles: db.prepare('SELECT team_id, role, playbook FROM team_roles ORDER BY team_id, role').all(),
  defaults: db.prepare('SELECT role, playbook FROM team_role_defaults ORDER BY role').all(),
  alerts: db.prepare('SELECT id, status FROM security_alerts ORDER BY id').all(),
});

describe('migration 0107', () => {
  let root = '', app: App | undefined, oldPoll: Record<'coordinator' | 'worker', string>;
  beforeAll(async () => {
    root = tmp('conclave-0107-hub-');
    mkdirSync(join(root, 'data')); mkdirSync(join(root, 'vault'));
    const db = new DatabaseSync(testConfig(root).dbFile);
    migrate(db, upTo(106));
    expect((db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(106);
    ({ oldPoll } = seed(db));
    db.close();
    app = await buildApp(testConfig(root));
    await app.store.ready;
  });
  afterAll(async () => { await app?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('adds task_turns, tasks.started_at, team_members.busy_until and teams.pickup_minutes (default 15)', () => {
    const db = app!.db;
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version=107').get()).toBeTruthy();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number; dflt_value: string | null }[]);
    expect(cols('task_turns').map((c) => c.name)).toEqual(['id', 'task_id', 'team_id', 'phase', 'holder_agent_id', 'opened_at', 'opened_by_kind', 'opened_by_id',
      'seen_at', 'due_at', 'overdue_at', 'wake_noted_at', 'closed_at', 'close_reason']);
    expect(cols('tasks').find((c) => c.name === 'started_at')).toMatchObject({ notnull: 0 });
    expect(cols('team_members').find((c) => c.name === 'busy_until')).toMatchObject({ notnull: 0 });
    expect(cols('teams').find((c) => c.name === 'pickup_minutes')).toMatchObject({ notnull: 1, dflt_value: '15' });
    expect(db.prepare('SELECT DISTINCT pickup_minutes p FROM teams').all()).toEqual([{ p: 15 }]);
    const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='task_turns' AND sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[];
    expect(idx.map((i) => i.name)).toEqual(['task_turns_holder', 'task_turns_open']);
    expect(idx[1]!.sql).toMatch(/UNIQUE INDEX task_turns_open ON task_turns\(task_id\) WHERE closed_at IS NULL/);
  });

  it('8.A13: each live task has one open turn of the matching phase; done and open tasks have none', () => {
    const db = app!.db;
    const one = (taskId: string) => { const l = open(db, taskId); expect(l).toHaveLength(1); return l[0]!; };
    expect(one(ids.assigned)).toMatchObject({ phase: 'queued', team_id: ids.team, holder_agent_id: ids.w, opened_at: T0, opened_by_kind: 'system', seen_at: T0, due_at: null, overdue_at: null, closed_at: null, wake_noted_at: null });
    expect(one(ids.changes)).toMatchObject({ phase: 'queued', holder_agent_id: ids.w, opened_at: T0 + HOUR, seen_at: T0 + HOUR, due_at: null });
    // The work turn counts from the latest start, and keeps the deadline the task had.
    expect(one(ids.started)).toMatchObject({ phase: 'work', holder_agent_id: ids.w, opened_at: T_START, seen_at: T_START, due_at: UNTIL, overdue_at: null });
    // A review turn is due lease_minutes after it opened; it is seen only when the reviewer called the hub since.
    expect(one(ids.review)).toMatchObject({ phase: 'review', holder_agent_id: ids.r, opened_at: T_REVIEW, seen_at: T_REVIEW, due_at: T_REVIEW + 30 * MIN });
    expect(one(ids.stuck)).toMatchObject({ phase: 'review', holder_agent_id: ids.r2, opened_at: T_REVIEW, seen_at: null, due_at: T_REVIEW + 30 * MIN });
    expect(open(db, ids.done)).toEqual([]);
    expect(open(db, ids.open)).toEqual([]);
    expect(turns(db)).toHaveLength(5);
    for (const t of turns(db)) expect(t.id).toMatch(/^trn_[0-9a-f]{16}$/);
  });

  it('8.A13: a queued task has no lease and its overdue alert is settled at start; started_at is the latest start', () => {
    const db = app!.db;
    const task = (id: string) => db.prepare('SELECT status, lease_expires_at, overdue_at, started_at FROM tasks WHERE id=?').get(id);
    expect(task(ids.assigned)).toEqual({ status: 'assigned', lease_expires_at: null, overdue_at: null, started_at: null });
    expect(task(ids.changes)).toEqual({ status: 'changes_requested', lease_expires_at: null, overdue_at: null, started_at: null });
    expect(task(ids.started)).toEqual({ status: 'in_progress', lease_expires_at: UNTIL, overdue_at: null, started_at: T_START });
    expect(db.prepare('SELECT status FROM security_alerts WHERE id=?').get(ids.alert)).toEqual({ status: 'closed' });
  });

  it('busy_until is the member\'s latest future until, on the live membership row only', () => {
    const rows = app!.db.prepare('SELECT agent_id, removed_at, busy_until FROM team_members WHERE team_id=? ORDER BY agent_id, joined_at').all(ids.team) as { agent_id: string; removed_at: number | null; busy_until: number | null }[];
    expect(rows.filter((m) => m.agent_id === ids.w)).toEqual([{ agent_id: ids.w, removed_at: T0 - 30 * MIN, busy_until: null }, { agent_id: ids.w, removed_at: null, busy_until: UNTIL }]);
    for (const m of rows.filter((x) => x.agent_id !== ids.w)) expect(m.busy_until).toBeNull();
  });

  it('8.A14: shipped copies gain the hand-off line once, edited copies are kept, the defaults gain it', () => {
    const db = app!.db;
    const copy = (team: string, role: string) => (db.prepare('SELECT playbook FROM team_roles WHERE team_id=? AND role=?').get(team, role) as { playbook: string }).playbook;
    const defaults = (role: string) => (db.prepare('SELECT playbook FROM team_role_defaults WHERE role=?').get(role) as { playbook: string }).playbook;
    for (const r of ['coordinator', 'worker'] as const) {
      expect(defaults(r)).toBe(`${oldPoll[r]} ${HANDOFF_LINE}`);
      expect(copy(ids.team, r)).toBe(defaults(r));
      // The on-demand copy now equals the shipped constant, so switchMode() still swaps it.
      expect(copy(ids.od, r)).toBe(ON_DEMAND_PLAYBOOKS[r]);
      expect(count(copy(ids.od, r), HANDOFF_LINE)).toBe(1);
    }
    expect(copy(ids.edited, 'coordinator')).toBe(oldPoll.coordinator + ' Also water the plants.');
    expect(copy(ids.edited, 'worker')).toBe(defaults('worker'));
    expect(copy(ids.team, 'reviewer')).not.toContain(HANDOFF_LINE);
    expect(defaults('reviewer')).not.toContain(HANDOFF_LINE);
  });

  it('quotes the hand-off line and the old on-demand text verbatim', () => {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    expect(SQL).toContain(q(HANDOFF_LINE));
    expect(SQL).toContain(`playbook = ${q(OLD_OD.coordinator)}`);
    expect(SQL).toContain(`playbook = ${q(OLD_OD.worker)}`);
    expect(OLD_OD.coordinator).not.toBe(ON_DEMAND_PLAYBOOKS.coordinator);
    expect(OLD_OD.worker).not.toBe(ON_DEMAND_PLAYBOOKS.worker);
  });

  it('8.A13: a second start changes nothing', async () => {
    const before = snapshot(app!.db);
    await app!.close();
    app = await buildApp(testConfig(root));
    await app.store.ready;
    expect(snapshot(app.db)).toEqual(before);
    expect(app.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=107').get()).toEqual({ n: 1 });
  });

  it('running its data steps again adds no turn and no second hand-off line', () => {
    const db = app!.db;
    const before = snapshot(db);
    const dml = SQL.split(/;\n/).map((s) => s.replace(/^(\s*--[^\n]*\n)*/, '').trim()).filter((s) => /^(INSERT|UPDATE)\b/.test(s));
    expect(dml.length).toBe(9);
    for (const s of dml) db.exec(s);
    expect(snapshot(db)).toEqual(before);
  });
});

describe('migration 0107 on a fresh database', () => {
  it('runs after 0106, and the defaults hold the hand-off line once', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, upTo(107));
    const v = (db.prepare('SELECT version FROM schema_migrations WHERE version >= 106 ORDER BY version').all() as { version: number }[]).map((r) => r.version);
    expect(v).toEqual([106, 107]);
    for (const r of ['coordinator', 'worker']) {
      expect(count((db.prepare('SELECT playbook FROM team_role_defaults WHERE role=?').get(r) as { playbook: string }).playbook, HANDOFF_LINE)).toBe(1);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM task_turns').get()).toEqual({ n: 0 });
  });

  it('has one checksum for CRLF and LF checkouts, so a hub applied from either starts on the other', () => {
    expect(SQL).not.toContain('\r');
    expect(migrationChecksum(SQL.replace(/\n/g, '\r\n'))).toBe(migrationChecksum(SQL));
    const db = new DatabaseSync(':memory:');
    migrate(db, upTo(107, 'crlf'));
    expect(db.prepare('SELECT checksum FROM schema_migrations WHERE version=107').get()).toEqual({ checksum: migrationChecksum(SQL) });
    expect(() => migrate(db, upTo(107))).not.toThrow();
    expect(() => migrate(db, MIGRATIONS)).not.toThrow();
  });
});
