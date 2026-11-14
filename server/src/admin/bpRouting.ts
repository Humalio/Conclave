/**
 * Blueprint decider routing (docs/multi-user.md §1.3). A proposal goes to the deciders of the one team that owns
 * every item it touches; one that touches a project-level item or more than one part, opens or removes a track,
 * changes the owner of a track or paper, submits a re-plan or restores from an export goes to the admin (decision D2). A decider's own writes are
 * the operator's status moves (kinds.ts `isOperatorAct`) on items of their team's part that no open re-plan marks.
 * Routes are computed from the items as they are now.
 */
import type { Db } from '../db/db.js';
import type { Blueprint, Op, Proposal } from '../blueprint/blueprint.js';
import { isOperatorAct } from '../blueprint/kinds.js';
import type { Routing } from './routing.js';

/** Items with no team: summary, stakeholders, architecture, terms and references stay with the admin (D2). */
const PROJECT_KINDS = new Set(['summary', 'stakeholder', 'architecture', 'term', 'reference']);
const TRACKS = new Set(['module', 'line']);
/** Kinds whose owner (team) only the admin changes. */
const OWNED = new Set(['module', 'line', 'paper']);

type Place = { kind: string; team_id: string | null; parent_key: string | null; status: string | null; replan_id: string | null };

/** The team whose deciders decide one proposal, or null for the admin; `row` finds live items. */
function route(pr: Proposal, row: (k: string | null | undefined) => Place | undefined): string | null {
  if (pr.type !== 'ops') return null;
  // A restore from an export (blueprint.md §4.2) is the admin's, whatever it touches.
  if ((pr.ops as Op[]).some((o) => o.op === 'upsert' && !!o.restore)) return null;
  const teams = new Set<string | null>();
  for (const any of pr.ops as Op[]) {
    if (any.op === 'link' || any.op === 'unlink') { teams.add(row(any.from)?.team_id ?? null); teams.add(row(any.to)?.team_id ?? null); continue; }
    const op = any as Exclude<Op, { op: 'link' | 'unlink' }>;
    const cur = row(op.key);
    if (op.op === 'remove') { if (cur && TRACKS.has(cur.kind)) return null; teams.add(cur?.team_id ?? null); continue; }
    const kind = op.op === 'upsert' ? op.kind : cur?.kind;
    if (!kind || PROJECT_KINDS.has(kind)) return null;
    if (TRACKS.has(kind) && !cur) return null;
    const parentKey = op.parent_key === undefined ? (cur?.parent_key ?? null) : op.parent_key;
    const parent = row(parentKey);
    if (parentKey && !parent) return null;
    const to = parent ? parent.team_id : op.op === 'upsert' && op.team_id !== undefined ? op.team_id : (cur?.team_id ?? null);
    if (cur && OWNED.has(kind) && to !== cur.team_id) return null;
    if (cur) teams.add(cur.team_id);
    teams.add(to);
  }
  return teams.size === 1 ? [...teams][0]! : null;
}

export interface RoutedProposal { id: string; project_id: string; team_id: string | null; route: string | null; agent_id: string | null; ops: number; reason: string | null; created_at: number }

export class BpRouting {
  constructor(private readonly db: Db, private readonly bp: Blueprint, private readonly routing: Routing) {}

  /** The team whose deciders decide this proposal, or null for the admin. */
  proposalTeam(pr: Proposal): string | null { return this.routes(pr.project_id, [pr]).get(pr.id) ?? null; }

  /** The deciding team of each proposal of one project (null: the admin), from two item lookups for the whole list. */
  routes(projectId: string, prs: Proposal[]): Map<string, string | null> {
    const keys = new Set<string>();
    for (const pr of prs) {
      if (pr.type !== 'ops') continue;
      for (const any of pr.ops as Op[]) {
        if (any.op === 'link' || any.op === 'unlink') { keys.add(any.from); keys.add(any.to); continue; }
        const op = any as Exclude<Op, { op: 'link' | 'unlink' }>;
        keys.add(op.key);
        if (op.op !== 'remove' && op.parent_key) keys.add(op.parent_key);
      }
    }
    const live = [...keys].filter((k) => typeof k === 'string' && !k.endsWith('*'));
    const places: Map<string, Place> = live.length ? this.bp.places(projectId, live) : new Map();
    const parents = [...places.values()].map((x) => x.parent_key).filter((k): k is string => !!k && !places.has(k));
    if (parents.length) for (const [k, v] of this.bp.places(projectId, parents)) places.set(k, v);
    const row = (k: string | null | undefined) => (typeof k === 'string' && !k.endsWith('*') ? places.get(k) : undefined);
    return new Map(prs.map((pr) => [pr.id, route(pr, row)]));
  }

  /**
   * The team a batch of ops belongs to when every op is an operator act in that one team's part (a status move only,
   * on an existing item that no open re-plan marks), else null.
   */
  actTeam(projectId: string, ops: Op[], teamId?: string | null): string | null {
    const places = this.bp.places(projectId, ops.flatMap((o) => (o.op === 'upsert' && typeof o.key === 'string' ? [o.key] : [])));
    let team: string | null = null;
    for (const op of ops) {
      if (op.op !== 'upsert' || Object.keys(op).some((k) => !['op', 'kind', 'key', 'status'].includes(k))) return null;
      const cur = places.get(op.key);
      if (!cur || cur.kind !== op.kind || !cur.team_id || cur.replan_id || typeof op.status !== 'string') return null;
      if (!isOperatorAct(cur.kind, cur.status, op.status)) return null;
      if (team && team !== cur.team_id) return null;
      team = cur.team_id;
    }
    if (teamId && teamId !== team) return null;
    return team;
  }

  /** Proposals with their deciding team, routed one project at a time. */
  private routed(prs: Proposal[]): { p: Proposal; t: string | null }[] {
    const byProject = new Map<string, Proposal[]>();
    for (const p of prs) (byProject.get(p.project_id) ?? byProject.set(p.project_id, []).get(p.project_id)!).push(p);
    const team = new Map<string, string | null>();
    for (const [projectId, list] of byProject) for (const [id, t] of this.routes(projectId, list)) team.set(id, t);
    return prs.map((p) => ({ p, t: team.get(p.id) ?? null }));
  }
  /** Open proposals routed to teams this user decides for now: only the projects of those teams are read. */
  private routedFor(userId: string, projectId?: string): { p: Proposal; t: string | null }[] {
    const teams = this.routing.decidesFor(userId);
    if (!teams.length) return [];
    const projects = (this.db.prepare('SELECT DISTINCT project_id FROM teams WHERE project_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))').all(JSON.stringify(teams)) as { project_id: string }[])
      .map((r) => r.project_id).filter((id) => !projectId || id === projectId);
    const mine = new Set(teams);
    return this.routed(this.bp.openProposals(projects)).filter(({ t }) => !!t && mine.has(t));
  }
  /** Open proposals routed to teams this user decides for now. */
  routedTo(userId: string, projectId?: string): Proposal[] { return this.routedFor(userId, projectId).map(({ p }) => p); }
  private view(p: Proposal, route: string | null): RoutedProposal {
    return { id: p.id, project_id: p.project_id, team_id: p.team_id, route, agent_id: p.agent_id, ops: p.ops.length, reason: p.reason, created_at: p.created_at };
  }
  /** Needs you: a member's routed proposals; for the admin, those no decider may decide (no team, or no active decider). */
  needsYou(userId: string, isAdmin: boolean): RoutedProposal[] {
    if (!isAdmin) return this.routedFor(userId).map(({ p, t }) => this.view(p, t));
    const active = new Map<string, boolean>();
    const decided = (t: string) => active.get(t) ?? active.set(t, this.routing.activeDeciders(t).length > 0).get(t)!;
    return this.routed(this.bp.openProposals()).filter(({ t }) => !t || !decided(t)).map(({ p, t }) => this.view(p, t));
  }
}
