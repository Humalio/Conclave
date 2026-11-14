/**
 * Hardware (docs/hardware.md, SPEC-HARDWARE-01 to 03): a PC's optional compute role, the teams it serves, and one ordered
 * waiting list per machine whose first entry holds it. The hub coordinates only: it records what the holder reports and
 * never opens SSH, starts jobs or measures the machine. Every read and write sweeps the list first, so an entry whose
 * agent lost its task or access goes on the next operation, and a holder that goes raises a flag for the operator.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { LeakGuard } from '../guard/leakGuard.js';
import { randomToken } from '../util/crypto.js';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = typeof DAYS[number];
export interface HwWindow { days: Day[]; from: string; to: string }
export interface ComputeIn {
  access: string; timezone: string; windows: HwWindow[];
  memory_gb?: number | null; cpus?: number | null; gpu?: string | null; notes?: string | null; teams: string[];
}
interface ComputeRow { machine_id: string; access: string; timezone: string; windows: string; memory_gb: number | null; cpus: number | null; gpu: string | null; notes: string | null; created_at: number; updated_at: number }
export interface Compute extends Omit<ComputeIn, 'teams'> { teams: { id: string; name: string }[] }
interface EntryRow {
  seq: number; machine_id: string; agent_id: string; team_id: string; task_id: string; joined_at: number; estimate_minutes: number | null;
  held_since: number | null; estimate_until: number | null; report: string | null; reported_at: number | null;
  agent_label: string; agent_status: string; team_name: string; team_status: string; task_title: string | null; task_status: string | null;
  task_assignee: string | null; task_team: string | null; member: number | null; served: number | null;
}
export interface Entry {
  seq: number; position: number; holder: boolean; agent_id: string; label: string; team_id: string; team_name: string; task_id: string; task_title: string;
  joined_at: number; estimate_minutes: number | null; held_since: number | null; estimate_until: number | null; report: string | null; reported_at: number | null;
}
export interface Availability { any: boolean; now: boolean; until: string | null; next: string | null }

/** Task states an agent may join with, and the wider set it may stay with (a submitted or blocked task is still its own). */
const JOIN_STATES = ['assigned', 'in_progress', 'changes_requested'];
const GONE_STATES = ['done', 'cancelled', 'discarded', 'open', 'backlog'];
const TEAM_LIVE = ['running', 'paused'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DAY_NAME: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const NOT_OFFERED = 'No machine of that name is offered to your teams. Call hw_list for the machines you may use.';

const dayAt = (i: number): Day => DAYS[((i % 7) + 7) % 7]!;
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const bad = (msg: string) => new KeyError('invalid_argument', msg);

/** The weekday and minute of the day at `at` in time zone `tz`. */
function localNow(tz: string, at: number): { day: number; min: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { day: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3) as Day), min: Number(p.hour) * 60 + Number(p.minute) };
}
export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Whether the machine is in a scheduled window at `at`, until when, and when the next one opens, all in its own time zone.
 * A window whose end is before its start runs past midnight into the next day. No windows: any time.
 */
export function availability(c: { timezone: string; windows: HwWindow[] }, at = Date.now()): Availability {
  if (!c.windows.length) return { any: true, now: true, until: null, next: null };
  const { day, min } = localNow(c.timezone, at);
  let until: number | null = null, next: { off: number; day: number; from: string } | null = null;
  for (const w of c.windows) {
    const f = mins(w.from), t = mins(w.to), on = (d: number) => w.days.includes(dayAt(d));
    // Minutes from now to the end of this window, when now is inside it.
    const end = f < t ? (on(day) && min >= f && min < t ? t - min : null)
      : on(day) && min >= f ? 1440 - min + t : on(day - 1) && min < t ? t - min : null;
    if (end !== null) until = Math.max(until ?? 0, end);
    for (let d = 0; d <= 7; d++) {
      if (!on(day + d)) continue;
      const off = d * 1440 + f - min;
      if (off > 0 && (!next || off < next.off)) next = { off, day: (day + d) % 7, from: w.from };
    }
  }
  const clock = (off: number) => { const m = (min + off) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  return { any: false, now: until !== null, until: until !== null ? clock(until) : null, next: next ? `${DAY_NAME[dayAt(next.day)]} ${next.from}` : null };
}

/** "Mon–Fri 09:00–18:00; Sat 10:00–14:00", or "Any time". */
export function windowsText(windows: HwWindow[]): string {
  if (!windows.length) return 'Any time';
  return windows.map((w) => {
    const idx = [...new Set(w.days)].map((d) => DAYS.indexOf(d)).sort((a, b) => a - b), runs: string[] = [];
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1] === idx[j]! + 1) j++;
      runs.push(j - i >= 2 ? `${DAY_NAME[dayAt(idx[i]!)]}–${DAY_NAME[dayAt(idx[j]!)]}` : idx.slice(i, j + 1).map((x) => DAY_NAME[dayAt(x)]).join(', '));
      i = j + 1;
    }
    return `${runs.join(', ')} ${w.from}–${w.to}`;
  }).join('; ');
}
export function limitsText(c: { memory_gb?: number | null; cpus?: number | null; gpu?: string | null }): string {
  const p = [c.memory_gb != null ? `memory ${c.memory_gb} GB` : '', c.cpus != null ? `${c.cpus} ${c.cpus === 1 ? 'CPU' : 'CPUs'}` : '', c.gpu ? `GPU ${c.gpu}` : ''].filter(Boolean);
  return p.length ? p.join(' · ') : 'none declared';
}
const localClock = (tz: string, at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

export class Hardware {
  constructor(private db: Db, private keys: Keys, private audit: Audit, private guard: LeakGuard) {}

  // ───── Reading ─────

  private computeRow(machineId: string): ComputeRow | null {
    return (this.db.prepare('SELECT * FROM hw_machines WHERE machine_id=?').get(machineId) as unknown as ComputeRow) ?? null;
  }
  private compute(r: ComputeRow): Compute {
    const teams = this.db.prepare('SELECT t.id, t.name FROM hw_machine_teams mt JOIN teams t ON t.id=mt.team_id WHERE mt.machine_id=? ORDER BY t.name').all(r.machine_id) as { id: string; name: string }[];
    return { access: r.access, timezone: r.timezone, windows: JSON.parse(r.windows) as HwWindow[], memory_gb: r.memory_gb, cpus: r.cpus, gpu: r.gpu, notes: r.notes, teams };
  }
  private rows(machineId: string): EntryRow[] {
    return this.db.prepare(`SELECT q.*, a.label agent_label, a.status agent_status, t.name team_name, t.status team_status,
        k.title task_title, k.status task_status, k.assignee_agent_id task_assignee, k.team_id task_team,
        (SELECT 1 FROM team_members m WHERE m.team_id=q.team_id AND m.agent_id=q.agent_id AND m.removed_at IS NULL) member,
        (SELECT 1 FROM hw_machine_teams s WHERE s.machine_id=q.machine_id AND s.team_id=q.team_id) served
      FROM hw_queue q JOIN agents a ON a.id=q.agent_id JOIN teams t ON t.id=q.team_id LEFT JOIN tasks k ON k.id=q.task_id
      WHERE q.machine_id=? ORDER BY q.seq`).all(machineId) as unknown as EntryRow[];
  }
  private entries(machineId: string): Entry[] {
    return this.rows(machineId).map((r, i) => ({
      seq: r.seq, position: i + 1, holder: r.held_since !== null, agent_id: r.agent_id, label: r.agent_label, team_id: r.team_id, team_name: r.team_name,
      task_id: r.task_id, task_title: r.task_title ?? '', joined_at: r.joined_at, estimate_minutes: r.estimate_minutes, held_since: r.held_since,
      estimate_until: r.estimate_until, report: r.report, reported_at: r.reported_at,
    }));
  }
  /** Why an entry may no longer stay: its access (agent, membership, team, machine's team list) first, then its task. */
  private lost(r: EntryRow): 'access' | 'task' | null {
    if (r.agent_status !== 'active' || !r.member || !r.served || !TEAM_LIVE.includes(r.team_status)) return 'access';
    if (!r.task_status || r.task_assignee !== r.agent_id || r.task_team !== r.team_id || GONE_STATES.includes(r.task_status)) return 'task';
    return null;
  }

  // ───── The list: sweep, promote, remove ─────

  private name(machineId: string): string { return this.keys.machine(machineId)?.name ?? machineId; }

  /** Remove entries that lost their task or access (a holder raises a flag), then promote the first entry if none holds. */
  sweep(machineId: string, skipNotice: string | null = null): void {
    tx(this.db, () => {
      const sys: Actor = { kind: 'system', id: null };
      for (const r of this.rows(machineId)) {
        const why = this.lost(r); if (!why) continue;
        this.db.prepare('DELETE FROM hw_queue WHERE seq=?').run(r.seq);
        const held = r.held_since !== null, m = this.name(machineId);
        this.audit.event(sys, 'hardware.remove', { kind: 'agent', id: r.agent_id }, { machine: machineId, task: r.task_id, reason: why, held });
        this.keys.notify(r.agent_id, 'hardware_removed', `You were taken off ${m}'s waiting list because you ${why === 'task' ? 'no longer have the task you joined with' : 'no longer have access to it'}.${held ? ' Stop using the machine now.' : ''}`);
        if (held) {
          const id = `hwf_${randomToken(8)}`;
          this.db.prepare('INSERT INTO hw_flags(id,machine_id,agent_id,task_id,reason,held_since,created_at) VALUES (?,?,?,?,?,?,?)').run(id, machineId, r.agent_id, r.task_id, why, r.held_since, Date.now());
          this.audit.event(sys, 'hardware.flag', { kind: 'agent', id: r.agent_id }, { machine: machineId, flag: id, reason: why });
        }
      }
      this.promote(machineId, skipNotice);
    });
  }
  /** The hub's 30 s upkeep (app.ts): every machine with a list is swept, so a lost entry goes and the next one moves up
     without waiting for someone to read the list. */
  sweepAll(): void {
    const ids = (this.db.prepare('SELECT DISTINCT machine_id FROM hw_queue').all() as { machine_id: string }[]).map((r) => r.machine_id);
    for (const id of ids) this.sweep(id);
  }
  private promote(machineId: string, skipNotice: string | null): void {
    if (this.db.prepare('SELECT 1 FROM hw_queue WHERE machine_id=? AND held_since IS NOT NULL').get(machineId)) return;
    const first = this.db.prepare('SELECT * FROM hw_queue WHERE machine_id=? ORDER BY seq LIMIT 1').get(machineId) as unknown as EntryRow | undefined;
    if (!first) return;
    const now = Date.now();
    this.db.prepare('UPDATE hw_queue SET held_since=?, estimate_until=? WHERE seq=?').run(now, first.estimate_minutes ? now + first.estimate_minutes * 60_000 : null, first.seq);
    this.audit.event({ kind: 'system', id: null }, 'hardware.hold', { kind: 'agent', id: first.agent_id }, { machine: machineId, task: first.task_id });
    if (first.agent_id !== skipNotice) this.keys.notify(first.agent_id, 'hardware_hold', `You now hold ${this.name(machineId)} for task ${first.task_id}. Use it within the limits hw_list shows, report progress with hw_report, and call hw_leave when you are done or stop.`);
  }

  // ───── Operator ─────

  overview(): { machines: Record<string, unknown>[]; pcs: { id: string; name: string; status: string }[] } {
    const ids = (this.db.prepare('SELECT machine_id FROM hw_machines').all() as { machine_id: string }[]).map((r) => r.machine_id);
    for (const id of ids) this.sweep(id);
    const machines = (this.db.prepare('SELECT h.*, m.name, m.status pc_status, m.os FROM hw_machines h JOIN machines m ON m.id=h.machine_id ORDER BY m.name').all() as unknown as (ComputeRow & { name: string; pc_status: string; os: string | null })[])
      .map((r) => {
        const c = this.compute(r), list = this.entries(r.machine_id);
        const flags = this.db.prepare(`SELECT f.id, f.agent_id, a.label, f.task_id, k.title task_title, k.team_id, f.reason, f.held_since, f.created_at FROM hw_flags f
          JOIN agents a ON a.id=f.agent_id LEFT JOIN tasks k ON k.id=f.task_id WHERE f.machine_id=? AND f.cleared_at IS NULL ORDER BY f.created_at`).all(r.machine_id);
        return { id: r.machine_id, name: r.name, pc_status: r.pc_status, os: r.os, ...c, availability: availability(c), holder: list.find((e) => e.holder) ?? null, waiting: list.filter((e) => !e.holder), flags, updated_at: r.updated_at };
      });
    const pcs = this.db.prepare("SELECT id, name, status FROM machines WHERE status<>'retired' AND id NOT IN (SELECT machine_id FROM hw_machines) ORDER BY name").all() as { id: string; name: string; status: string }[];
    return { machines, pcs };
  }

  private check(c: ComputeIn): ComputeIn {
    const access = c.access.trim();
    if (!access || access.length > 500) throw bad('Access: an SSH alias or instructions, 1 to 500 characters.');
    if (!validTimezone(c.timezone)) throw bad('Timezone: an IANA name such as Europe/Lisbon.');
    if (c.windows.length > 14) throw bad('Availability: at most 14 windows.');
    for (const w of c.windows) {
      if (!w.days.length || w.days.some((d) => !DAYS.includes(d))) throw bad('Availability: each window needs at least one weekday.');
      if (!HHMM.test(w.from) || !HHMM.test(w.to) || w.from === '24:00' || w.from === w.to) throw bad('Availability: times are HH:MM, and a window cannot start and end at the same time.');
    }
    if (c.memory_gb != null && !(c.memory_gb > 0 && c.memory_gb <= 100_000)) throw bad('Memory: a positive number of GB.');
    if (c.cpus != null && !(Number.isInteger(c.cpus) && c.cpus > 0 && c.cpus <= 100_000)) throw bad('CPUs: a whole number above 0.');
    if (c.gpu != null && c.gpu.length > 120) throw bad('GPU: at most 120 characters.');
    if (c.notes != null && c.notes.length > 1000) throw bad('Notes: at most 1000 characters.');
    const hit = this.guard.scan({ access, gpu: c.gpu ?? '', notes: c.notes ?? '' });
    if (hit) throw bad('Access, GPU and notes must not contain a key or credential. Keep credentials on the machine or in its SSH setup.');
    const teams = [...new Set(c.teams)];
    for (const t of teams) if (!this.db.prepare('SELECT 1 FROM teams WHERE id=?').get(t)) throw new KeyError('not_found', `No team ${t}.`);
    return { ...c, access, teams, gpu: c.gpu?.trim() || null, notes: c.notes?.trim() || null };
  }

  register(machineId: string, input: ComputeIn, actor: Actor): void {
    const pc = this.keys.machine(machineId);
    if (!pc || pc.status === 'retired') throw new KeyError('not_found', 'No such PC.');
    const c = this.check(input), now = Date.now(), had = !!this.computeRow(machineId);
    tx(this.db, () => {
      if (had) this.db.prepare('UPDATE hw_machines SET access=?, timezone=?, windows=?, memory_gb=?, cpus=?, gpu=?, notes=?, updated_at=? WHERE machine_id=?')
        .run(c.access, c.timezone, JSON.stringify(c.windows), c.memory_gb ?? null, c.cpus ?? null, c.gpu ?? null, c.notes ?? null, now, machineId);
      else this.db.prepare('INSERT INTO hw_machines(machine_id,access,timezone,windows,memory_gb,cpus,gpu,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(machineId, c.access, c.timezone, JSON.stringify(c.windows), c.memory_gb ?? null, c.cpus ?? null, c.gpu ?? null, c.notes ?? null, now, now);
      this.db.prepare('DELETE FROM hw_machine_teams WHERE machine_id=?').run(machineId);
      for (const t of c.teams) this.db.prepare('INSERT INTO hw_machine_teams(machine_id,team_id) VALUES (?,?)').run(machineId, t);
      this.audit.event(actor, had ? 'hardware.update' : 'hardware.register', { kind: 'pc', id: machineId }, { timezone: c.timezone, windows: c.windows.length, teams: c.teams });
    });
    // A team taken off the list loses its entries now, not at the next read.
    this.sweep(machineId);
  }

  unregister(machineId: string, actor: Actor): { ended: number } {
    if (!this.computeRow(machineId)) throw new KeyError('not_found', 'This PC does not offer compute.');
    const m = this.name(machineId);
    return tx(this.db, () => {
      const list = this.rows(machineId);
      for (const r of list) this.keys.notify(r.agent_id, 'hardware_removed', `${m} is no longer offered for compute, so you were taken off its waiting list.${r.held_since !== null ? ' Stop using the machine now.' : ''}`);
      this.db.prepare('DELETE FROM hw_queue WHERE machine_id=?').run(machineId);
      // Its open flags would no longer show on the Hardware screen, which lists only machines that offer compute: they close here.
      const flags = this.db.prepare('UPDATE hw_flags SET cleared_at=?, cleared_by=? WHERE machine_id=? AND cleared_at IS NULL').run(Date.now(), actor.id, machineId).changes;
      this.db.prepare('DELETE FROM hw_machine_teams WHERE machine_id=?').run(machineId);
      this.db.prepare('DELETE FROM hw_machines WHERE machine_id=?').run(machineId);
      this.audit.event(actor, 'hardware.unregister', { kind: 'pc', id: machineId }, { ended: list.length, flags_cleared: flags });
      return { ended: list.length };
    });
  }

  removeEntry(seq: number, actor: Actor): void {
    const r = this.db.prepare('SELECT * FROM hw_queue WHERE seq=?').get(seq) as unknown as EntryRow | undefined;
    if (!r) throw new KeyError('not_found', 'That entry is no longer on the list.');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM hw_queue WHERE seq=?').run(seq);
      this.audit.event(actor, 'hardware.remove', { kind: 'agent', id: r.agent_id }, { machine: r.machine_id, task: r.task_id, reason: 'operator', held: r.held_since !== null });
      this.keys.notify(r.agent_id, 'hardware_removed', `The operator took you off ${this.name(r.machine_id)}'s waiting list.${r.held_since !== null ? ' Stop using the machine now.' : ''} Join again with hw_join if you still need it.`);
      this.promote(r.machine_id, null);
    });
  }

  clearFlag(id: string, actor: Actor): void {
    const r = this.db.prepare('UPDATE hw_flags SET cleared_at=?, cleared_by=? WHERE id=? AND cleared_at IS NULL').run(Date.now(), actor.id, id);
    if (!r.changes) throw new KeyError('not_found', 'No open flag with that id.');
    this.audit.event(actor, 'hardware.flag_clear', { kind: 'hw_flag', id }, null);
  }

  /** What an eligible agent not yet on the list would get from hw_list, for a draft before it is saved. */
  preview(machineId: string | null, input: ComputeIn): string {
    const c = this.check(input);
    const name = machineId ? this.name(machineId) : '(new machine)';
    const list = machineId && this.computeRow(machineId) ? this.entries(machineId) : [];
    const { teams: _t, ...draft } = c;
    return this.render({ id: machineId ?? '', name, ...draft }, list, null, new Set());
  }

  // ───── Agents ─────

  /** The machines an agent may use: offered to a team it is a live member of, on an active PC. */
  private offered(agentId: string): { id: string; name: string }[] {
    return this.db.prepare(`SELECT DISTINCT m.id, m.name FROM hw_machines h JOIN machines m ON m.id=h.machine_id
      JOIN hw_machine_teams s ON s.machine_id=h.machine_id JOIN team_members tm ON tm.team_id=s.team_id AND tm.agent_id=? AND tm.removed_at IS NULL
      JOIN teams t ON t.id=s.team_id AND t.status IN ('running','paused') WHERE m.status='active' ORDER BY m.name`).all(agentId) as { id: string; name: string }[];
  }
  private teamsOf(agentId: string): Set<string> {
    return new Set((this.db.prepare('SELECT team_id FROM team_members WHERE agent_id=? AND removed_at IS NULL').all(agentId) as { team_id: string }[]).map((r) => r.team_id));
  }
  private resolve(agentId: string, ref: string): { id: string; name: string } {
    const m = this.offered(agentId).find((x) => x.id === ref || x.name === ref);
    if (!m) throw new KeyError('not_found', NOT_OFFERED);
    return m;
  }

  /** The agent's view of one machine: header lines, then the list as it may see it. */
  private render(m: { id: string; name: string } & Omit<ComputeIn, 'teams'>, list: Entry[], agentId: string | null, mine: Set<string>): string {
    const a = availability(m), tz = m.timezone;
    const when = a.any ? 'Any time' : a.now ? `Scheduled now, until ${a.until}` : `Outside its scheduled hours${a.next ? `; the next window opens ${a.next}` : ''}`;
    const who = (e: Entry) => (e.agent_id === agentId ? 'you' : mine.has(e.team_id) ? `${e.label} (task "${e.task_title}")` : 'an agent of another team');
    const holder = list.find((e) => e.holder), waiting = list.filter((e) => !e.holder), me = list.find((e) => e.agent_id === agentId);
    const lines = [
      `${m.name}${m.id ? ` (${m.id})` : ''}: ${when} (scheduled, ${tz})`,
      `  Access: ${m.access}`,
      `  Availability: ${windowsText(m.windows)}`,
      `  Limits, declared by the operator and not measured: ${limitsText(m)}`,
      ...(m.notes ? [`  Notes: ${m.notes}`] : []),
      `  Holder: ${holder ? `${who(holder)}, since ${localClock(tz, holder.held_since!)}${holder.estimate_until ? `, estimated finish ${localClock(tz, holder.estimate_until)}` : ''}${holder.reported_at && (holder.agent_id === agentId || mine.has(holder.team_id)) ? `, last report ${localClock(tz, holder.reported_at)}: "${holder.report}"` : ''}` : 'none'}`,
      `  Waiting: ${waiting.length ? waiting.map((e, i) => `${i + 1}. ${who(e)}${e.estimate_minutes ? `, about ${e.estimate_minutes} min` : ''}`).join('; ') : 'nobody'}`,
      `  You: ${me ? (me.holder ? 'you hold it. Report with hw_report; call hw_leave when done.' : `waiting, number ${me.position - 1} in line.`) : 'not on the list. Join with hw_join {machine, task_id} when a task needs it.'}`,
    ];
    return lines.join('\n');
  }
  private dataFor(m: { id: string; name: string }, c: Compute, list: Entry[], agentId: string, mine: Set<string>) {
    const vis = (e: Entry) => (e.agent_id === agentId || mine.has(e.team_id)
      ? { agent_id: e.agent_id, label: e.label, task_id: e.task_id, task_title: e.task_title, held_since: e.held_since, estimate_until: e.estimate_until, estimate_minutes: e.estimate_minutes, report: e.report, reported_at: e.reported_at }
      : { agent_id: null, label: 'an agent of another team', held_since: e.held_since, estimate_until: e.estimate_until, estimate_minutes: e.estimate_minutes });
    const holder = list.find((e) => e.holder), me = list.find((e) => e.agent_id === agentId);
    return { id: m.id, name: m.name, access: c.access, timezone: c.timezone, windows: c.windows, availability: availability(c), memory_gb: c.memory_gb, cpus: c.cpus, gpu: c.gpu, notes: c.notes,
      holder: holder ? vis(holder) : null, waiting: list.filter((e) => !e.holder).map(vis), you: me ? { holder: me.holder, position: me.position } : null };
  }

  list(agentId: string): { text: string; data: Record<string, unknown> } {
    const mine = this.teamsOf(agentId), out: string[] = [], data: Record<string, unknown>[] = [];
    for (const m of this.offered(agentId)) {
      this.sweep(m.id);
      const r = this.computeRow(m.id); if (!r) continue;
      const c = this.compute(r), list = this.entries(m.id);
      const { teams: _t, ...shown } = c;
      out.push(this.render({ ...m, ...shown }, list, agentId, mine));
      data.push(this.dataFor(m, c, list, agentId, mine));
    }
    const text = out.length ? `Machines your teams may use (the hub records what holders report; it does not measure the machine):\n\n${out.join('\n\n')}` : 'No machine is offered to your teams.';
    return { text, data: { machines: data } };
  }

  join(agentId: string, ref: string, taskId: string, estimateMinutes: number | null): { holder: boolean; position: number; machine: string } {
    const m = this.resolve(agentId, ref);
    this.sweep(m.id);
    return tx(this.db, () => {
      const mine = this.db.prepare('SELECT seq FROM hw_queue WHERE machine_id=? AND agent_id=?').get(m.id, agentId);
      if (mine) throw new KeyError('conflict', `You are already on ${m.name}'s list. Call hw_list to see your place, or hw_leave first.`);
      const t = this.db.prepare('SELECT id, team_id, status, assignee_agent_id FROM tasks WHERE id=?').get(taskId) as { id: string; team_id: string; status: string; assignee_agent_id: string | null } | undefined;
      if (!t || t.assignee_agent_id !== agentId || !t.team_id) throw new KeyError('denied', 'That task is not assigned to you.');
      if (!JOIN_STATES.includes(t.status)) throw new KeyError('invalid_state', `Join with a task you can work on (assigned, in progress or changes requested); this one is ${t.status.replace(/_/g, ' ')}.`);
      const ok = this.db.prepare(`SELECT 1 FROM hw_machine_teams s JOIN team_members tm ON tm.team_id=s.team_id AND tm.agent_id=? AND tm.removed_at IS NULL
        JOIN teams tt ON tt.id=s.team_id AND tt.status IN ('running','paused') JOIN agents a ON a.id=tm.agent_id AND a.status='active' WHERE s.machine_id=? AND s.team_id=?`).get(agentId, m.id, t.team_id);
      if (!ok) throw new KeyError('denied', `${m.name} is not offered to the team of that task.`);
      this.db.prepare('INSERT INTO hw_queue(machine_id,agent_id,team_id,task_id,joined_at,estimate_minutes) VALUES (?,?,?,?,?,?)').run(m.id, agentId, t.team_id, t.id, Date.now(), estimateMinutes);
      this.audit.event({ kind: 'agent', id: agentId }, 'hardware.join', { kind: 'pc', id: m.id }, { task: t.id, estimate_minutes: estimateMinutes });
      this.promote(m.id, agentId);
      const e = this.entries(m.id).find((x) => x.agent_id === agentId)!;
      return { holder: e.holder, position: e.position, machine: m.name };
    });
  }

  report(agentId: string, ref: string, progress: string, estimateMinutes: number | null): { estimate_until: number | null; machine: string } {
    const m = this.resolve(agentId, ref);
    this.sweep(m.id);
    const e = this.entries(m.id).find((x) => x.agent_id === agentId);
    if (!e) throw new KeyError('not_found', `You are not on ${m.name}'s list.`);
    if (this.guard.scan({ progress })) throw bad('Progress must not contain a key or credential.');
    if (!e.holder) throw new KeyError('invalid_state', `Only the holder reports. You are number ${e.position - 1} in line; you get a notice when you hold ${m.name}.`);
    const now = Date.now(), until = estimateMinutes != null ? now + estimateMinutes * 60_000 : e.estimate_until;
    this.db.prepare('UPDATE hw_queue SET report=?, reported_at=?, estimate_until=? WHERE seq=?').run(progress, now, until, e.seq);
    return { estimate_until: until, machine: m.name };
  }

  leave(agentId: string, ref: string, outcome: 'done' | 'cancelled', note: string | null): { machine: string; moved_up: boolean } {
    const m = this.resolve(agentId, ref);
    if (note && this.guard.scan({ note })) throw bad('The note must not contain a key or credential.');
    this.sweep(m.id);
    return tx(this.db, () => {
      const e = this.entries(m.id).find((x) => x.agent_id === agentId);
      if (!e) throw new KeyError('not_found', `You are not on ${m.name}'s list.`);
      this.db.prepare('DELETE FROM hw_queue WHERE seq=?').run(e.seq);
      this.audit.event({ kind: 'agent', id: agentId }, 'hardware.leave', { kind: 'pc', id: m.id }, { task: e.task_id, outcome, held: e.holder, note });
      this.promote(m.id, null);
      return { machine: m.name, moved_up: e.holder && this.entries(m.id).some((x) => x.holder) };
    });
  }
}
