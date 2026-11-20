/**
 * Migration 0153 (one delivery model) on a hub at 0152 seeded with a polling team, an on-demand team and a team whose
 * playbook the operator edited, with tasks in every live state, members, events and queued work items: every team, task,
 * member and event is kept; every playbook still at the shipped default reads act when woken; an edited one is left alone;
 * the polling team's queued work loses its lease and its started work gets an on-demand deadline; queued room-message
 * items are retired while task items stay; and task_turns gains delivered_at and delivery_reason apart from seen_at.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { ON_DEMAND_PLAYBOOKS } from '../src/teams/teams.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
vi.spyOn(console, 'warn').mockImplementation(() => {});
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const upTo = (last: number): string => {
  const d = tmp(`conclave-0153-upto-${last}-`);
  for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= last) copyFileSync(join(MIGRATIONS, f), join(d, f));
  return d;
};

const MIN = 60_000, HOUR = 60 * MIN, NOW = Date.now(), T0 = NOW - 2 * 24 * HOUR;
const UNTIL = NOW + 2 * HOUR;
const ROLES = ['coordinator', 'worker', 'reviewer', 'stakeholder'] as const;

function seed(db: DatabaseSync) {
  const def = (role: string) => (db.prepare('SELECT playbook FROM team_role_defaults WHERE role=?').get(role) as { playbook: string } | undefined)?.playbook;
  const agent = db.prepare('INSERT INTO agents(id,label,created_at,last_seen_at) VALUES (?,?,?,?)');
  const policy = db.prepare("INSERT INTO permission_policies(id,kind,created_at,updated_at) VALUES (?,'credential',?,?)");
  const cred = db.prepare("INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,policy_id,created_at) VALUES (?,'session_key',?,?,?,'00','active',?,?)");
  for (const a of ['agent-c', 'agent-w', 'agent-w2', 'agent-r', 'agent-s']) {
    agent.run(a, a, T0, NOW - 3 * HOUR); policy.run(`pol_${a}`, T0, T0); cred.run(`crd_${a}`, a, a, `kid_${a}`, `pol_${a}`, T0);
  }
  const team = db.prepare("INSERT INTO teams(id,name,goal,status,lease_minutes,delivery_mode,created_at,updated_at) VALUES (?,?,?,?,30,?,?,?)");
  team.run('team_poll', 'Poll', 'g', 'running', 'poll', T0, T0);
  team.run('team_od', 'On demand', 'g', 'running', 'on_demand', T0, T0);
  team.run('team_edit', 'Edited', 'g', 'paused', 'poll', T0, T0);
  team.run('team_draft', 'Draft', 'g', 'draft', 'poll', T0, T0);
  const role = db.prepare('INSERT INTO team_roles(team_id,role,playbook) VALUES (?,?,?)');
  for (const t of ['team_poll', 'team_od', 'team_draft']) for (const r of ROLES) { const p = def(r); if (p) role.run(t, r, p); }
  role.run('team_edit', 'coordinator', `${def('coordinator')} Also water the plants.`);
  role.run('team_edit', 'worker', def('worker')!);
  const member = db.prepare('INSERT INTO team_members(team_id,agent_id,credential_id,role,joined_at,removed_at) VALUES (?,?,?,?,?,?)');
  for (const t of ['team_poll', 'team_od', 'team_edit', 'team_draft']) {
    member.run(t, 'agent-c', 'crd_agent-c', 'coordinator', T0, null);
    member.run(t, 'agent-w', 'crd_agent-w', 'worker', T0, null);
    member.run(t, 'agent-r', 'crd_agent-r', 'reviewer', T0, null);
  }
  member.run('team_poll', 'agent-w2', 'crd_agent-w2', 'worker', T0, T0 + HOUR); // removed earlier: kept as history
  member.run('team_poll', 'agent-s', 'crd_agent-s', 'stakeholder', T0, null);
  const task = db.prepare(`INSERT INTO tasks(id,team_id,title,status,assignee_agent_id,reviewer_agent_id,lease_expires_at,progress_until,overdue_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  task.run('task_p_queued', 'team_poll', 'Queued', 'assigned', 'agent-w', 'agent-r', NOW + 10 * MIN, null, null, T0, T0);
  task.run('task_p_changes', 'team_poll', 'Changes', 'changes_requested', 'agent-w', 'agent-r', NOW - 5 * MIN, null, NOW - MIN, T0, T0);
  task.run('task_p_run_until', 'team_poll', 'Running with until', 'in_progress', 'agent-w', 'agent-r', UNTIL, UNTIL, null, T0, T0);
  task.run('task_p_run', 'team_poll', 'Running', 'in_progress', 'agent-w', 'agent-r', NOW + 5 * MIN, null, null, T0, T0);
  task.run('task_p_review', 'team_poll', 'Review', 'in_review', 'agent-w', 'agent-r', null, null, null, T0, T0);
  task.run('task_p_open', 'team_poll', 'Open', 'open', null, null, null, null, null, T0, T0);
  task.run('task_p_done', 'team_poll', 'Done', 'done', 'agent-w', 'agent-r', null, null, null, T0, T0);
  task.run('task_od_run', 'team_od', 'OD running', 'in_progress', 'agent-w', 'agent-r', NOW - MIN, null, NOW - 30_000, T0, T0);
  task.run('task_od_queued', 'team_od', 'OD queued', 'assigned', 'agent-w', 'agent-r', null, null, null, T0, T0);
  task.run('task_e_queued', 'team_edit', 'Edited queued', 'assigned', 'agent-w', 'agent-r', NOW + 10 * MIN, null, null, T0, T0);
  const turn = db.prepare("INSERT INTO task_turns(id,task_id,team_id,phase,holder_agent_id,opened_at,opened_by_kind,seen_at,due_at,overdue_at) VALUES (?,?,?,?,?,?,'system',?,?,?)");
  turn.run('trn_1', 'task_p_queued', 'team_poll', 'queued', 'agent-w', T0, null, null, null);
  turn.run('trn_2', 'task_p_changes', 'team_poll', 'queued', 'agent-w', T0, T0 + MIN, null, null);
  turn.run('trn_3', 'task_p_run_until', 'team_poll', 'work', 'agent-w', T0, T0, UNTIL, null);
  turn.run('trn_4', 'task_p_run', 'team_poll', 'work', 'agent-w', T0, T0, NOW + 5 * MIN, null);
  turn.run('trn_5', 'task_p_review', 'team_poll', 'review', 'agent-r', T0, null, NOW + 20 * MIN, null);
  turn.run('trn_6', 'task_od_run', 'team_od', 'work', 'agent-w', T0, T0, NOW - MIN, NOW - 30_000);
  turn.run('trn_7', 'task_od_queued', 'team_od', 'queued', 'agent-w', T0, null, null, null);
  const ev = db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,created_at) VALUES (?,?,?,'agent','agent-c',?,?)");
  ev.run('task_p_queued', 'open', 'assigned', 'task_assign', T0);
  ev.run('task_p_run', 'assigned', 'in_progress', 'task_start', T0 + MIN);
  const item = db.prepare("INSERT INTO work_items(id,agent_id,team_id,kind,priority,ref_id,trust,created_at,acked_at) VALUES (?,?,?,?,3,?,?,?,?)");
  item.run('wi_msg', 'agent-w', 'team_poll', 'message', 'msg_1', 'L2', T0, null);
  item.run('wi_msg_draft', 'agent-w', 'team_draft', 'message', 'msg_2', 'L2', T0, null);
  item.run('wi_msg_acked', 'agent-w', 'team_poll', 'message', 'msg_3', 'L2', T0, T0 + MIN);
  item.run('wi_task', 'agent-w', 'team_poll', 'task_assigned', 'task_p_queued', 'L1', T0, null);
  item.run('wi_note', 'agent-w', null, 'notice', 'ntc_1', 'L0', T0, null);
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
const snap = (db: DatabaseSync) => ({
  teams: all(db, 'SELECT id, name, goal, status, lease_minutes FROM teams ORDER BY id'),
  members: all(db, 'SELECT team_id, agent_id, role, joined_at, removed_at FROM team_members ORDER BY team_id, agent_id, joined_at'),
  tasks: all(db, 'SELECT id, team_id, title, status, assignee_agent_id, reviewer_agent_id FROM tasks ORDER BY id'),
  events: all(db, 'SELECT task_id, from_status, to_status, tool, created_at FROM task_events ORDER BY id'),
  turns: all(db, 'SELECT id, task_id, phase, holder_agent_id, opened_at, seen_at, closed_at FROM task_turns ORDER BY id'),
  items: all(db, 'SELECT id FROM work_items ORDER BY id'),
});

describe('migration 0153: one delivery model', () => {
  let db: DatabaseSync, before: ReturnType<typeof snap>;
  beforeAll(() => {
    db = new DatabaseSync(join(tmp('conclave-0153-db-'), 'hub.db'));
    migrate(db, upTo(152));
    expect((db.prepare('SELECT max(version) v FROM schema_migrations').get() as { v: number }).v).toBe(152);
    seed(db);
    before = snap(db);
    migrate(db, MIGRATIONS);
  });
  afterAll(() => { db?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('runs as 0153 and keeps every team, member, task, event, turn and work item', () => {
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version=153').get()).toBeTruthy();
    expect(snap(db)).toEqual(before);
  });

  it('every playbook still at the shipped default reads act when woken; an edited one is left as written', () => {
    for (const t of ['team_poll', 'team_od', 'team_draft']) for (const r of ['coordinator', 'worker', 'reviewer']) {
      const pb = (db.prepare('SELECT playbook FROM team_roles WHERE team_id=? AND role=?').get(t, r) as { playbook: string }).playbook;
      expect(pb, `${t} ${r}`).toBe(ON_DEMAND_PLAYBOOKS[r]);
      expect(pb).not.toMatch(/work_next \(each call|polling team/);
    }
    const edited = (db.prepare("SELECT playbook FROM team_roles WHERE team_id='team_edit' AND role='coordinator'").get() as { playbook: string }).playbook;
    expect(edited).toMatch(/Also water the plants\.$/);
    expect(edited).not.toBe(ON_DEMAND_PLAYBOOKS.coordinator);
    expect((db.prepare("SELECT playbook FROM team_roles WHERE team_id='team_edit' AND role='worker'").get() as { playbook: string }).playbook).toBe(ON_DEMAND_PLAYBOOKS.worker);
    for (const r of ['coordinator', 'worker', 'reviewer']) expect((db.prepare('SELECT playbook FROM team_role_defaults WHERE role=?').get(r) as { playbook: string }).playbook).toBe(ON_DEMAND_PLAYBOOKS[r]);
  });

  it('every team is set to the one model, so a rollback reads the same rule', () => {
    expect(all(db, 'SELECT DISTINCT delivery_mode m FROM teams')).toEqual([{ m: 'on_demand' }]);
  });

  it('the polling team\'s queued work loses its lease; started work keeps the member\'s own until, else gets lease_minutes from now', () => {
    const k = (id: string) => db.prepare('SELECT status, lease_expires_at l, overdue_at o FROM tasks WHERE id=?').get(id) as { status: string; l: number | null; o: number | null };
    expect(k('task_p_queued')).toMatchObject({ status: 'assigned', l: null, o: null });
    expect(k('task_p_changes')).toMatchObject({ status: 'changes_requested', l: null, o: null });
    expect(k('task_p_run_until')).toMatchObject({ status: 'in_progress', l: UNTIL, o: null });
    const run = k('task_p_run');
    expect(run.l!).toBeGreaterThanOrEqual(NOW + 29 * MIN);
    expect(run.l!).toBeLessThan(Date.now() + 31 * MIN);
    // The open work turns follow their task.
    const due = (id: string) => (db.prepare('SELECT due_at FROM task_turns WHERE task_id=? AND closed_at IS NULL').get(id) as { due_at: number | null }).due_at;
    expect(due('task_p_run_until')).toBe(UNTIL);
    expect(due('task_p_run')).toBe(run.l);
    // On-demand work is untouched: the overdue task stays flagged with its holder.
    expect(k('task_od_run')).toMatchObject({ status: 'in_progress', o: NOW - 30_000 });
    // The edited team polled too: its queued task also loses the lease.
    expect(k('task_e_queued')).toMatchObject({ status: 'assigned', l: null });
  });

  it('queued room-message items are retired; task items and notices stay', () => {
    const acked = (id: string) => (db.prepare('SELECT acked_at FROM work_items WHERE id=?').get(id) as { acked_at: number | null }).acked_at;
    expect(acked('wi_msg')).not.toBeNull();
    expect(acked('wi_msg_draft')).not.toBeNull();
    expect(acked('wi_msg_acked')).toBe(T0 + MIN);
    expect(acked('wi_task')).toBeNull();
    expect(acked('wi_note')).toBeNull();
  });

  it('adds delivered_at and delivery_reason to task_turns, apart from seen_at, and delivered_at to decisions', () => {
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('task_turns')).toEqual(expect.arrayContaining(['seen_at', 'delivered_at', 'delivery_reason']));
    expect(cols('decisions')).toContain('delivered_at');
    expect(all(db, 'SELECT DISTINCT delivered_at d, delivery_reason r FROM task_turns')).toEqual([{ d: null, r: null }]);
    expect(() => db.prepare("UPDATE task_turns SET delivery_reason='bogus' WHERE id='trn_1'").run()).toThrow();
    db.prepare("UPDATE task_turns SET delivery_reason='pc_offline' WHERE id='trn_1'").run();
    expect(db.prepare("SELECT seen_at FROM task_turns WHERE id='trn_1'").get()).toEqual({ seen_at: null });
  });
});
