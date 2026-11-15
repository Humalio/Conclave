/**
 * Work in motion (docs/dashboard-ux.md, Home): the latest task changes and plan moves across every team, newest first,
 * for the Home card and its full view. Plan moves are blueprint events (bp_events, docs/blueprint.md §2.5): bp_write
 * and operator writes, applied proposals and report requests.
 * A project-level event (no team) carries the project's name in `team` with a null id. The admin sees every project; a
 * member sees the projects granted with `feed`, with no console user id (the operator's events carry a null actor id).
 * Bounded (at most 50 per page, at most 7 days back) and paged with a cursor. `total` counts the events in the window,
 * up to TOTAL_MAX. Task progress heartbeats are left out: a change is a status move, a replaced submission or a new task.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { delegateAt } from '../checkout/via.js';
import { KeyError } from '../keys/keys.js';

export const WORK_MAX = 50;
export const WORK_DAYS = 7;
/** `total` counts at most this many events of each kind. */
export const TOTAL_MAX = 10_000;
const DAY = 86_400_000;
/** The note teams.ts writes on a task event that waits for the operator's approval. */
const AWAITING_APPROVAL = 'awaiting administrator approval';

interface TaskEv { id: number; task_id: string; from_status: string | null; to_status: string; actor_kind: string; actor_id: string | null; tool: string | null; note: string | null; created_at: number;
  title: string; team_id: string; plan_refs: string | null; status: string; team_name: string; actor_label: string | null; round: number;
  project_id: string | null; project_key: string | null; project_name: string | null; relayed: number }
interface PlanEv { decided: string | null; id: number; team_id: string | null; project_id: string; project_key: string; project_name: string; proposal_id: string | null; kind: string; actor_kind: string; actor_id: string | null; version: number | null; added: string; removed: string; changed: string; moves: string | null; note: string | null; created_at: number;
  team_name: string | null; actor_label: string | null }
export interface WorkEvent {
  id: string; kind: 'task' | 'plan'; at: number; team: { id: string | null; name: string }; project: { id: string; key: string; name: string } | null; actor: { kind: string; id: string | null; label: string | null; via?: string };
  task: { id: string; title: string; status: string; refs: string[] } | null; from: string | null; to: string | null; tool: string | null; round: number | null;
  plan: { event: string; version: number | null; added: string[]; removed: string[]; changed: string[]; moves: { key: string; status: string | null; was: string | null }[]; proposal_id: string | null;
    /** Requirements the team's coordinator agreed under coordinator_decides_blueprint (docs/blueprint.md §4). */
    decided: string[] } | null;
  note: string | null;
  /** A fixed code for the two task events the console words in its own way; null for the rest. */
  flag: 'relayed' | 'awaiting_approval' | null;
}

const refs = (s: string | null): string[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const excerpt = (s: string | null): string | null => (s ? (s.length > 160 ? `${s.slice(0, 157).trimEnd()}…` : s) : null);
/** Total order: newest first; at the same millisecond plan events before task events, then the higher id first. */
const order = (a: WorkEvent, b: WorkEvent) => b.at - a.at || (a.kind === b.kind ? Number(b.id.slice(1)) - Number(a.id.slice(1)) : a.kind === 'plan' ? -1 : 1);

/**
 * `projects`: only events of these projects (a member's feed grant); an empty list shows nothing. Undefined shows all.
 * `member`: the reader is a member, so console user ids are left out.
 */
export function workFeed(db: Db, o: { limit: number; before?: string; since?: number; now?: number; projects?: string[]; member?: boolean }): { events: WorkEvent[]; next: string | null; total: number } {
  const now = o.now ?? Date.now();
  const floor = Math.max(o.since ?? now - DAY, now - WORK_DAYS * DAY);
  const cur = o.before ? /^(\d+)\.([tp])(\d+)$/.exec(o.before) : null;
  if (o.before && !cur) throw new KeyError('invalid_argument', 'before is a cursor from a previous page.');
  const top = cur ? Number(cur[1]) : now + 1;
  const take = o.limit + 1;
  const inP = (col: string) => (o.projects === undefined ? { sql: '', args: [] as string[] } : o.projects.length ? { sql: ` AND ${col} IN (${o.projects.map(() => '?').join(',')})`, args: o.projects } : { sql: ' AND 0', args: [] as string[] });
  // A task event belongs to the project it was written in (migration 0119); older events, without one, to the team's current project.
  const tp = inP('COALESCE(e.project_id, t.project_id)'), pp = inP('p.project_id');
  // Keyset paging in SQL, exact at ties: rows strictly older than the cursor in the total order. At the cursor's millisecond a
  // plan cursor admits every task event and plan events with a lower id; a task cursor admits task events with a lower id only.
  const MAXID = Number.MAX_SAFE_INTEGER, curPlan = cur?.[2] === 'p', cid = cur ? Number(cur[3]) : MAXID;
  const taskBelow = !cur || curPlan ? MAXID : cid, planBelow = !cur ? MAXID : curPlan ? cid : 0;
  const tasks = db.prepare(`SELECT e.id, e.task_id, e.from_status, e.to_status, e.actor_kind, e.actor_id, e.tool, e.note, e.created_at, k.title, k.team_id, k.plan_refs, k.status, t.name AS team_name, a.label AS actor_label,
      p.id AS project_id, p.key AS project_key, p.name AS project_name, (k.operator_request_source IS NOT NULL) AS relayed,
      (SELECT COUNT(*) FROM task_events x WHERE x.task_id=e.task_id AND x.to_status='changes_requested' AND x.id<=e.id) AS round
    FROM task_events e JOIN tasks k ON k.id=e.task_id JOIN teams t ON t.id=k.team_id LEFT JOIN projects p ON p.id=COALESCE(e.project_id, t.project_id) LEFT JOIN agents a ON a.id=e.actor_id
    WHERE (e.created_at<? OR (e.created_at=? AND e.id<?)) AND e.created_at>=? AND (e.from_status IS NULL OR e.from_status<>e.to_status OR e.tool='task_submit')${tp.sql}
    ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(top, top, taskBelow, floor, ...tp.args, take) as unknown as TaskEv[];
  const plans = db.prepare(`SELECT p.id, p.team_id, p.project_id, j.key AS project_key, j.name AS project_name, p.proposal_id, p.kind, p.actor_kind, p.actor_id, p.version, p.added, p.removed, p.changed, p.moves, p.note, p.decided, p.created_at,
      t.name AS team_name, a.label AS actor_label
    FROM bp_events p JOIN projects j ON j.id=p.project_id LEFT JOIN teams t ON t.id=p.team_id LEFT JOIN agents a ON a.id=p.actor_id
    WHERE (p.created_at<? OR (p.created_at=? AND p.id<?)) AND p.created_at>=?${pp.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(top, top, planBelow, floor, ...pp.args, take) as unknown as PlanEv[];
  const arr = (s: string | null) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  /** A console user's id (the admin's or a decider's) is not shown to a member. */
  const who = (kind: string, id: string | null) => (o.member && (kind === 'admin' || kind === 'operator') ? null : id);
  /** An agent's event while it ran for a collaborator carries their name ("via Lena", docs/checkout.md §9.1). */
  const via = (kind: string, id: string | null, at: number) => { const v = kind === 'agent' ? delegateAt(db, id, at) : null; return v ? { via: v } : {}; };
  const all: WorkEvent[] = [
    ...tasks.map((e): WorkEvent => ({
      id: `t${e.id}`, kind: 'task', at: e.created_at, team: { id: e.team_id, name: e.team_name }, project: e.project_id ? { id: e.project_id, key: e.project_key!, name: e.project_name! } : null, actor: { kind: e.actor_kind, id: who(e.actor_kind, e.actor_id), label: e.actor_kind === 'admin' ? 'Operator' : e.actor_kind === 'system' ? 'Hub' : e.actor_label ?? e.actor_id, ...via(e.actor_kind, e.actor_id, e.created_at) },
      task: { id: e.task_id, title: e.title, status: e.status, refs: refs(e.plan_refs) }, from: e.from_status, to: e.to_status, tool: e.tool, round: e.to_status === 'changes_requested' ? e.round : null, plan: null, note: excerpt(e.note),
      flag: e.tool === 'task_create' && e.relayed ? 'relayed' : e.note === AWAITING_APPROVAL ? 'awaiting_approval' : null,
    })),
    ...plans.map((p): WorkEvent => ({
      id: `p${p.id}`, kind: 'plan', at: p.created_at, team: { id: p.team_name === null ? null : p.team_id, name: p.team_name ?? p.project_name }, project: { id: p.project_id, key: p.project_key, name: p.project_name }, actor: { kind: p.actor_kind, id: who(p.actor_kind, p.actor_id), label: p.actor_kind === 'admin' || p.actor_kind === 'operator' ? 'Operator' : p.actor_kind === 'system' ? 'Hub' : p.actor_label ?? p.actor_id, ...via(p.actor_kind, p.actor_id, p.created_at) },
      task: null, from: null, to: null, tool: null, round: null, plan: { event: p.kind, version: p.version, added: arr(p.added), removed: arr(p.removed), changed: arr(p.changed), moves: arr(p.moves), proposal_id: p.proposal_id, decided: arr(p.decided) }, note: excerpt(p.note), flag: null,
    })),
  ].sort(order);
  const page = all.slice(0, o.limit);
  const more = all.length > o.limit;
  const last = page.at(-1);
  // The first page that holds every event in the window is its own count; otherwise count, bounded, in the index on created_at.
  const count = (sql: string, args: string[]) => (db.prepare(`SELECT COUNT(*) AS n FROM (${sql} LIMIT ${TOTAL_MAX})`).get(floor, ...args) as { n: number }).n;
  const total = !cur && !more ? all.length
    : count(`SELECT 1 FROM task_events e JOIN tasks k ON k.id=e.task_id JOIN teams t ON t.id=k.team_id WHERE e.created_at>=? AND (e.from_status IS NULL OR e.from_status<>e.to_status OR e.tool='task_submit')${tp.sql}`, tp.args)
      + count(`SELECT 1 FROM bp_events p WHERE p.created_at>=?${pp.sql}`, pp.args);
  return { events: page, next: more && last ? `${last.at}.${last.id}` : null, total };
}

export function registerWorkFeed(api: FastifyInstance, d: { db: Db }): void {
  const q = z.object({
    limit: z.coerce.number().int().min(1).max(WORK_MAX).default(20),
    before: z.string().max(40).optional(),
    since: z.coerce.number().int().min(0).optional(),
  }).strict();
  api.get('/api/work/recent', async (req) => workFeed(d.db, { ...q.parse(req.query ?? {}), ...(req.member ? { projects: req.member.projects('feed'), member: true } : {}) }));
}
