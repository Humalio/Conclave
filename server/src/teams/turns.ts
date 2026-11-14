/**
 * Task turns (docs/proposals/console-systems.md §8.2): every point where a task waits on one party is one task_turns row.
 * `queued` waits for task_start and has no deadline; `work` waits for task_submit; `review` waits for task_review.
 *
 * One function opens turns: handOff() closes the task's open turn, opens the next one, writes the holder's work item
 * and, on an on-demand team, the notice, the same way for every phase, and returns the hand-off (with the wake text for
 * an on-demand holder) to the actor who caused it. A new transition is one handOff() call. At most one turn per task is
 * open (unique index task_turns_open). The hub never wakes a session: the turn records whether the holder has seen it.
 *
 * Seen (docs/specification.md, Task turns): only the holder's successful full read of that task (task_list {task_id},
 * a work_next item that delivers it: read()) or a successful action on its open turn (the transition that closes it, or
 * task_progress: read() too) marks a turn seen. Both run inside the caller's work, so a refused call changes nothing. A
 * list fetch or any other call leaves it unseen. Seen (seen_at) is not started (tasks.started_at) nor reviewed (the event).
 *
 * A turn the actor opens for itself is seen at once. It still gets its work item when it was handed over (a coordinator
 * assigning a task to itself or naming itself reviewer); only the holder's own moves (claim, start, withdraw) pass
 * `item: false`. A notice goes only to a holder who is not the actor, and not when the caller sends its own
 * (`notify: false`).
 *
 * A replaced submission (task_submit while in_review) re-opens the review turn: the reviewer has not seen the new
 * submission, and its review deadline counts from the replacement.
 *
 * Clocks (§8.2): a task's clock starts at task_start, never at assignment. On a polling team liveness is per member:
 * its lease ends lease_minutes after MAX(last activity, busy_until), renew() shows it on the member's started tasks, and
 * sweep() finds members whose lease passed so the tick releases everything they hold at once. On an on-demand team
 * only started tasks can pass their check-in time.
 */
import type { Db } from '../db/db.js';
import type { Actor } from '../audit/audit.js';
import { newId } from '../util/ids.js';
import type { TeamRow, TurnCloseReason, TurnPhase, TurnRow } from './teams.js';

/** What a hand-off tells the actor (§8.4): who holds the task now, in which phase, and how to wake an on-demand holder. */
export interface Handoff {
  to: string; to_label: string; phase: TurnPhase; on_demand: boolean; seen: boolean;
  /** The command to pass to an on-demand holder's session ("review task_x", "start task_x"); absent for poll holders. */
  wake_text?: string;
  turn_id: string;
}
/** The task fields a hand-off needs: its new status says the phase. */
export interface TurnTask { id: string; title: string; team_id: string | null; status: string }
export interface HandOffOpts {
  reason?: TurnCloseReason; dueAt?: number | null; now?: number;
  /** Write the holder's work item (default true); false for the holder's own claim, start or withdraw. */
  item?: boolean;
  /** Send the on-demand notice (default true); false when the caller sends its own (a settled team_ask, a replaced submission). */
  notify?: boolean;
}
export interface TurnDeps {
  /** A work item for the holder (Teams.addItem): deduplicated per agent, kind and task. */
  enqueue: (agentId: string, teamId: string, kind: string, refId: string, priority: number, trust: 'L0' | 'L1' | 'L2') => void;
  /** An L0 notice for the holder (Keys.notify), tied to the task state it describes. */
  notify: (agentId: string, kind: string, body: string, ref: { task: string; state: string }) => void;
  label: (agentId: string) => string;
}

/** The phase a task status waits in; null for a status nobody holds (open, approved, blocked, done …). */
export function phaseOf(status: string): TurnPhase | null {
  if (status === 'assigned' || status === 'changes_requested') return 'queued';
  if (status === 'in_progress') return 'work';
  if (status === 'in_review') return 'review';
  return null;
}
/** The statuses an assignee holds a task in while it waits on them: released together when a poll member's lease passes. */
export const HELD_STATUSES = ['assigned', 'changes_requested', 'in_progress'] as const;
const HELD = HELD_STATUSES.map((x) => `'${x}'`).join(',');
const WAKE_VERB: Record<TurnPhase, string> = { queued: 'start', work: 'continue', review: 'review' };
/** The wake text a hand-off gives for an on-demand holder ("review task_x"): the same words for the console's waiting rows. */
export const wakeText = (phase: TurnPhase, taskId: string): string => `${WAKE_VERB[phase]} ${taskId}`;
/** The fixed L0 line for the actor (§8.4): it names the task id, never task content. Null for a poll holder. */
export function wakeLine(h: Handoff): string | null {
  if (!h.on_demand || !h.wake_text || h.seen) return null;
  return `${h.to_label} (on demand) only sees this when woken. Tell its session: ${h.wake_text}`;
}

/** A task's open turn as agents see it (task_list, session_whoami). queue_position is null unless the turn is queued. */
export interface TurnView {
  turn: { phase: TurnPhase; holder: string; since: number; seen_at: number | null; due_at: number | null };
  queue_position: number | null;
}
interface TurnViewRow { id: string; task_id: string; team_id: string; title: string; phase: TurnPhase; holder_agent_id: string; opened_at: number; seen_at: number | null; due_at: number | null; queue_position: number | null }
/** Open turns with their queue place: one queue per holder across all its teams (spec §8.4, matching my_turns), oldest hand-off first. */
const VIEW_SQL = `SELECT u.id, u.task_id, u.team_id, k.title, u.phase, u.holder_agent_id, u.opened_at, u.seen_at, u.due_at,
    CASE WHEN u.phase='queued' THEN (SELECT COUNT(*) FROM task_turns q WHERE q.closed_at IS NULL AND q.phase='queued'
      AND q.holder_agent_id=u.holder_agent_id AND (q.opened_at<u.opened_at OR (q.opened_at=u.opened_at AND q.rowid<=u.rowid))) END AS queue_position
  FROM task_turns u JOIN tasks k ON k.id=u.task_id`;
const toView = (r: TurnViewRow): TurnView => ({
  turn: { phase: r.phase, holder: r.holder_agent_id, since: r.opened_at, seen_at: r.seen_at, due_at: r.due_at },
  queue_position: r.queue_position === null || r.queue_position === undefined ? null : Number(r.queue_position),
});

export class TurnService {
  constructor(private readonly db: Db, private readonly deps: TurnDeps) {}
  /** The hand-offs made inside the running capture() call; null outside one. */
  private captured: Handoff[] | null = null;

  /**
   * Run a synchronous task operation and collect the hand-offs it made, in order, so the MCP result can name them (§8.4).
   * Database work is synchronous, so no other call can interleave; nested captures each see their own.
   */
  capture<T>(fn: () => T): { result: T; handoffs: Handoff[] } {
    const prev = this.captured, mine: Handoff[] = [];
    this.captured = mine;
    try { return { result: fn(), handoffs: mine }; } finally { this.captured = prev; }
  }

  /** The task's open turn, if any. */
  current(taskId: string): TurnRow | null {
    return (this.db.prepare('SELECT * FROM task_turns WHERE task_id=? AND closed_at IS NULL').get(taskId) as unknown as TurnRow) ?? null;
  }
  /**
   * What task_list shows per task (§8.4): the open turn {phase, holder, since, seen_at, due_at} and, for a queued turn,
   * its place in the holder's queue in that team (1 = handed over first). One query for the whole page.
   */
  views(taskIds: readonly string[]): Map<string, TurnView> {
    const out = new Map<string, TurnView>();
    if (!taskIds.length) return out;
    const rows = this.db.prepare(`${VIEW_SQL} WHERE u.closed_at IS NULL AND u.task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds) as unknown as TurnViewRow[];
    for (const r of rows) out.set(r.task_id, toView(r));
    return out;
  }
  /** session_whoami's my_turns (§8.4): every open turn the agent holds, oldest first, with the task's title and team. */
  held(agentId: string): (TurnView & { task_id: string; team_id: string; title: string; turn_id: string })[] {
    const rows = this.db.prepare(`${VIEW_SQL} WHERE u.closed_at IS NULL AND u.holder_agent_id=? ORDER BY u.opened_at, u.rowid`).all(agentId) as unknown as TurnViewRow[];
    return rows.map((r) => ({ turn_id: r.id, task_id: r.task_id, team_id: r.team_id, title: r.title, ...toView(r) }));
  }
  /**
   * Close the task's open turn; returns whether one was open. `by`, when it is the holder acting on its turn, marks the
   * turn seen first (a successful action is a sign it was seen).
   */
  close(taskId: string, reason: TurnCloseReason, now = Date.now(), by?: Actor): boolean {
    if (by?.kind === 'agent' && by.id) this.read(taskId, by.id, now);
    return this.db.prepare('UPDATE task_turns SET closed_at=?, close_reason=? WHERE task_id=? AND closed_at IS NULL').run(now, reason, taskId).changes > 0;
  }
  /** Close every open turn of a team (the team ended). */
  closeTeam(teamId: string, reason: TurnCloseReason, now = Date.now()): number {
    return Number(this.db.prepare('UPDATE task_turns SET closed_at=?, close_reason=? WHERE team_id=? AND closed_at IS NULL').run(now, reason, teamId).changes);
  }
  /**
   * Open a turn on the task, closing any open one first (`reason`, default acted), so a task never has two. A turn the
   * holder opens for itself (start, claim, withdraw) is seen at once. Queued turns have no deadline; a work turn is due
   * at `dueAt`; a review turn lease_minutes after it opened (D-20).
   */
  open(task: { id: string; team_id: string }, team: TeamRow, phase: TurnPhase, holder: string, by: Actor, opts: { reason?: TurnCloseReason; dueAt?: number | null; now?: number } = {}): TurnRow {
    const now = opts.now ?? Date.now();
    this.close(task.id, opts.reason ?? 'acted', now, by);
    const due = phase === 'queued' ? null : phase === 'review' ? now + team.lease_minutes * 60_000 : opts.dueAt ?? null;
    const seen = by.kind === 'agent' && by.id === holder ? now : null;
    const id = newId.turn();
    this.db.prepare('INSERT INTO task_turns(id,task_id,team_id,phase,holder_agent_id,opened_at,opened_by_kind,opened_by_id,seen_at,due_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, task.id, task.team_id, phase, holder, now, by.kind, by.id, seen, due);
    return this.db.prepare('SELECT * FROM task_turns WHERE id=?').get(id) as unknown as TurnRow;
  }
  /**
   * The one hand-off: the task (already moved to its new status in the caller's transaction) now waits on `to`. Closes
   * the previous turn with `reason`, opens the turn of the new status' phase, and, when someone else caused it, gives
   * the holder its work item (unless `item: false`) and, on an on-demand team (no work_next polling), a notice when the
   * holder is not the actor (unless `notify: false`). A work turn takes the task's current deadline
   * (tasks.lease_expires_at) unless `dueAt` says otherwise.
   */
  handOff(task: TurnTask, team: TeamRow, to: string, by: Actor, opts: HandOffOpts = {}): Handoff {
    const phase = phaseOf(task.status);
    if (!phase) throw new Error(`handOff: status ${task.status} has no holder`);
    const dueAt = opts.dueAt !== undefined ? opts.dueAt
      : phase === 'work' ? ((this.db.prepare('SELECT lease_expires_at d FROM tasks WHERE id=?').get(task.id) as { d: number | null } | undefined)?.d ?? null) : null;
    const turn = this.open({ id: task.id, team_id: team.id }, team, phase, to, by, { reason: opts.reason, dueAt, now: opts.now });
    const self = turn.seen_at !== null, onDemand = team.delivery_mode === 'on_demand';
    const item = opts.item !== false, tell = onDemand && !self && opts.notify !== false;
    const ref = { task: task.id, state: task.status };
    if (phase === 'review') {
      if (item) this.deps.enqueue(to, team.id, 'review_requested', task.id, 2, 'L1');
      if (tell) this.deps.notify(to, 'review_requested', `Review requested for "${task.title}" (${task.id}): read the submission with task_list and give your verdict with task_review.`, ref);
    } else if (phase === 'queued' && task.status === 'changes_requested') {
      if (item) this.deps.enqueue(to, team.id, 'changes_requested', task.id, 2, 'L1');
      if (tell) this.deps.notify(to, 'changes_requested', `Changes were requested on "${task.title}" (${task.id}): read the comments with task_list, then task_start and resubmit.`, ref);
    } else if (phase === 'queued') {
      if (item) this.deps.enqueue(to, team.id, 'task_assigned', task.id, 3, 'L1');
      if (tell) this.deps.notify(to, 'task_assigned', `Task "${task.title}" (${task.id}) is assigned to you: read it with task_list, then task_start when you take it up.`, ref);
    }
    // A work turn (start, withdraw, an unblock back to in_progress) writes no item; the caller sends any notice.
    const h: Handoff = { to, to_label: this.deps.label(to), phase, on_demand: onDemand, seen: self, turn_id: turn.id };
    if (onDemand) h.wake_text = wakeText(phase, task.id);
    this.captured?.push(h);
    return h;
  }
  /**
   * `agentId` read this task in full or acted on it: the task's open turn is seen now if that agent holds it and has not
   * seen it yet. Anyone else's read, a closed turn, and a turn already seen are left alone. Returns whether it changed.
   */
  read(taskId: string, agentId: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE task_turns SET seen_at=? WHERE task_id=? AND holder_agent_id=? AND closed_at IS NULL AND seen_at IS NULL').run(now, taskId, agentId).changes > 0;
  }
  /**
   * Renew a poll member's lease (§8.2, §8.6, liveness per member): every task it has in progress is due lease_minutes
   * after MAX(now, busy_until, the task's own progress_until). Queued tasks have no deadline, so nothing else moves.
   */
  renew(team: TeamRow, agentId: string, now = Date.now()): number {
    const n = Number(this.db.prepare(`UPDATE tasks SET lease_expires_at=MAX(?, COALESCE(progress_until,0),
        COALESCE((SELECT m.busy_until FROM team_members m WHERE m.team_id=tasks.team_id AND m.agent_id=tasks.assignee_agent_id AND m.removed_at IS NULL),0)) + ?
      WHERE team_id=? AND assignee_agent_id=? AND status='in_progress'`).run(now, team.lease_minutes * 60_000, team.id, agentId).changes);
    if (n) this.mirrorWork({ teamId: team.id, holder: agentId });
    return n;
  }
  /**
   * What the upkeep tick acts on (one query each, §8.4): poll members whose lease has passed (MAX(last activity,
   * busy_until) + lease_minutes < now, §8.6 and 8.A2) and who still hold a queued or started task; and on-demand work turns past their
   * check-in time and not yet flagged overdue. A queued task never lapses on its own: only its holder's silence releases it.
   */
  sweep(now = Date.now()): { lapsed: { team_id: string; agent_id: string }[]; overdue: { id: string }[] } {
    const lapsed = this.db.prepare(`SELECT m.team_id, m.agent_id FROM team_members m
        JOIN teams t ON t.id=m.team_id AND t.status='running' AND t.delivery_mode='poll'
        LEFT JOIN agents a ON a.id=m.agent_id
      WHERE m.removed_at IS NULL
        AND MAX(m.joined_at, COALESCE(m.last_work_next_at,0), COALESCE(a.last_seen_at,0), COALESCE(m.busy_until,0)) + t.lease_minutes*60000 < ?
        AND EXISTS (SELECT 1 FROM tasks k WHERE k.team_id=m.team_id AND k.assignee_agent_id=m.agent_id AND k.status IN (${HELD}))`)
      .all(now) as unknown as { team_id: string; agent_id: string }[];
    const overdue = this.db.prepare(`SELECT k.id FROM tasks k JOIN teams t ON t.id=k.team_id AND t.status='running'
      WHERE t.delivery_mode='on_demand' AND k.status='in_progress' AND k.overdue_at IS NULL AND k.lease_expires_at IS NOT NULL AND k.lease_expires_at<?`)
      .all(now) as unknown as { id: string }[];
    return { lapsed, overdue };
  }
  /**
   * Pause and resume: a team's open review turns move by `ms`. Its work turns move with the tasks' cached deadlines
   * (mirrorWork); queued turns stay without a deadline.
   */
  shiftReviews(teamId: string, ms: number): void {
    if (ms <= 0) return;
    this.db.prepare("UPDATE task_turns SET due_at=due_at+? WHERE team_id=? AND closed_at IS NULL AND phase='review' AND due_at IS NOT NULL").run(ms, teamId);
  }
  /** A lease change restarts a team's open review turns from now; its work turns follow the tasks' cached deadlines. */
  restartReviews(teamId: string, dueAt: number): void {
    this.db.prepare("UPDATE task_turns SET due_at=? WHERE team_id=? AND closed_at IS NULL AND phase='review'").run(dueAt, teamId);
  }
  /** Keep the open work turns' deadlines equal to the tasks' cached ones (tasks.lease_expires_at, overdue_at) after a lease change. */
  mirrorWork(where: { teamId?: string; taskId?: string; holder?: string }): void {
    const cond: string[] = ["phase='work'", 'closed_at IS NULL'], args: string[] = [];
    if (where.teamId) { cond.push('team_id=?'); args.push(where.teamId); }
    if (where.taskId) { cond.push('task_id=?'); args.push(where.taskId); }
    if (where.holder) { cond.push('holder_agent_id=?'); args.push(where.holder); }
    this.db.prepare(`UPDATE task_turns SET due_at=(SELECT k.lease_expires_at FROM tasks k WHERE k.id=task_turns.task_id), overdue_at=(SELECT k.overdue_at FROM tasks k WHERE k.id=task_turns.task_id) WHERE ${cond.join(' AND ')}`).run(...args);
  }
}
