/**
 * Decider routing (docs/multi-user.md §1.3): who decides for a team, the per-team ceiling for access requests, the
 * actor a routed act is recorded with (`via`), escalation to the admin, and the Needs you lists.
 *
 * In a team with no deciders the admin decides and nothing extra is recorded. With deciders set, the
 * team's active deciders get its questions, task approvals, unblocks, dismissals, review switches (per_task projects
 * only), plan and status requests, and the access requests inside its ceiling; the admin can always act too.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import { resourceWithin } from '../access/access.js';
import type { RequestRow } from '../access/access.js';
import { parseResource } from '../policy/engine.js';
import { ALL_ACTIONS } from '../policy/catalogue.js';
import type { MemberScope } from './memberScope.js';
import type { Users, UserRow } from './users.js';
import { normFolder } from './users.js';

export type Via = 'decider' | 'admin_fallback' | 'admin_override';
/** Read and write, no rename, delete or anything outside the vault (D1's default). */
export const CEILING_DEFAULT_ACTIONS = ['fs.list', 'fs.read', 'fs.search', 'fs.history', 'fs.create', 'fs.update'];
/** Actions a ceiling may hold at all: vault actions only, never admin, keys, tools or agents. */
export const CEILING_ACTIONS: string[] = ALL_ACTIONS.filter((a) => a.startsWith('fs.'));
export const CEILING_MAX_S = 7 * 24 * 3600;
export const ESCALATE_MS = 24 * 3600_000;
export interface Ceiling { actions: string[]; folders: string[] | null; max_s: number }
export interface CeilingInput { actions?: string[]; folders?: string[] | null; max_hours?: number }
interface RequestLike { team_id?: string | null; actions: string[]; resource: string; requested_duration_s: number | null }

export class Routing {
  constructor(private readonly db: Db, private readonly users: Users, private readonly audit: Audit, private readonly alias: string) {}

  private team(id: string) {
    const t = this.db.prepare('SELECT id, name, project_id, request_ceiling FROM teams WHERE id=?').get(id) as { id: string; name: string; project_id: string | null; request_ceiling: string | null } | undefined;
    if (!t) throw new KeyError('not_found', 'team not found');
    return t;
  }
  /** Members named as deciders of a team, whether or not they can act now. */
  deciders(teamId: string): string[] {
    return (this.db.prepare("SELECT d.user_id FROM team_deciders d JOIN admin_users u ON u.id=d.user_id WHERE d.team_id=? AND u.role='member' ORDER BY d.added_at, d.user_id").all(teamId) as { user_id: string }[]).map((r) => r.user_id);
  }
  /**
   * Deciders who can act now: members (an admin acts as the admin), active, set up, 2FA enrolled when required, not
   * expired, and still granted the team's project.
   */
  activeDeciders(teamId: string): string[] {
    const rows = this.db.prepare(`SELECT u.* FROM team_deciders d JOIN admin_users u ON u.id=d.user_id JOIN teams t ON t.id=d.team_id
      JOIN user_project_grants g ON g.user_id=u.id AND g.project_id=t.project_id
      WHERE d.team_id=? AND u.role='member' AND u.status='active' AND u.password_set=1 ORDER BY d.added_at, u.id`).all(teamId) as unknown as UserRow[];
    return rows.filter((u) => this.users.ready(u) && !this.users.isExpired(u)).map((u) => u.id);
  }
  isDecider(userId: string, teamId: string): boolean { return this.activeDeciders(teamId).includes(userId); }
  /** Teams this user decides for right now. */
  decidesFor(userId: string): string[] { return this.users.deciderTeams(userId).filter((t) => this.isDecider(userId, t)); }

  /**
   * The actor for a routed act on a team's item. A member must be an active decider of that team: an item they can see
   * answers 403 not_decider, any other answers not_found like an unknown id. An admin's act is recorded as
   * `admin_override` when the team has an active decider, `admin_fallback` when it has deciders but none can act, and
   * plainly when it has none.
   */
  act(actor: Actor, member: MemberScope | undefined, teamId: string | null, notFound = 'not found'): Actor {
    if (member) {
      if (teamId && this.isDecider(member.userId, teamId)) return { ...actor, via: { via: 'decider', team: teamId } };
      if (teamId && member.team(teamId, 'tasks')) throw new KeyError('not_decider', 'Only a decider of this team can do this.');
      throw new KeyError('not_found', notFound);
    }
    if (!teamId || !this.deciders(teamId).length) return actor;
    return { ...actor, via: { via: this.activeDeciders(teamId).length ? 'admin_override' : 'admin_fallback', team: teamId } };
  }

  /** Replace a team's deciders and, when given, its request ceiling (admin, audited team.deciders_set). */
  setDeciders(teamId: string, userIds: string[], ceiling: CeilingInput | null | undefined, actor: Actor) {
    const t = this.team(teamId);
    const ids = [...new Set(userIds)];
    if (ids.length && !t.project_id) throw new KeyError('invalid_argument', 'The team has no project, so it cannot have deciders.');
    for (const id of ids) {
      const u = this.db.prepare('SELECT id, role, status FROM admin_users WHERE id=?').get(id) as { id: string; role: string; status: string } | undefined;
      if (!u) throw new KeyError('not_found', `user ${id} not found`);
      if (u.role !== 'member') throw new KeyError('invalid_argument', `${id} is an admin: admins decide for every team already.`);
      if (!this.db.prepare('SELECT 1 FROM user_project_grants WHERE user_id=? AND project_id=?').get(id, t.project_id)) throw new KeyError('invalid_argument', `${id} holds no grant on the team's project.`);
    }
    const next = ceiling === undefined ? t.request_ceiling : ceiling === null ? null : JSON.stringify(this.checkCeiling(t.project_id, ceiling));
    const before = { deciders: this.deciders(teamId), ceiling: t.request_ceiling ? JSON.parse(t.request_ceiling) : null };
    const now = Date.now();
    tx(this.db, () => {
      this.db.prepare('DELETE FROM team_deciders WHERE team_id=?').run(teamId);
      for (const id of ids) this.db.prepare('INSERT INTO team_deciders(team_id,user_id,added_by,added_at) VALUES (?,?,?,?)').run(teamId, id, actor.id, now);
      this.db.prepare('UPDATE teams SET request_ceiling=? WHERE id=?').run(next, teamId);
    });
    this.audit.event(actor, 'team.deciders_set', { kind: 'team', id: teamId }, { before, after: { deciders: ids, ceiling: next ? JSON.parse(next) : null } });
    return this.view(teamId);
  }
  view(teamId: string) {
    const t = this.team(teamId);
    return { deciders: this.deciders(teamId), active_deciders: this.activeDeciders(teamId), ceiling: this.ceiling(teamId), ceiling_is_default: !t.request_ceiling };
  }

  private checkCeiling(projectId: string | null, c: CeilingInput): Ceiling {
    const actions = c.actions ?? CEILING_DEFAULT_ACTIONS;
    const bad = actions.find((a) => !CEILING_ACTIONS.includes(a));
    if (bad) throw new KeyError('invalid_argument', `A ceiling holds vault actions only (${CEILING_ACTIONS.join(', ')}); not ${bad}.`);
    let folders: string[] | null = null;
    if (c.folders) {
      if (!projectId) throw new KeyError('invalid_argument', 'The team has no project.');
      const roots = this.users.vaultRoots(projectId);
      folders = [...new Set(c.folders.map(normFolder))];
      for (const f of folders) {
        if (!roots.some((r) => f.startsWith(r))) throw new KeyError('invalid_argument', `${f} is outside the project's vault roots (${roots.join(', ')}).`);
        const r = this.users.restrictedAt(f);
        if (r) throw new KeyError('invalid_argument', `${f} is in the restricted folder ${r}: a ceiling never covers one.`);
      }
    }
    const hours = c.max_hours ?? CEILING_MAX_S / 3600;
    if (!Number.isInteger(hours) || hours < 1 || hours > CEILING_MAX_S / 3600) throw new KeyError('invalid_argument', `max_hours is 1 to ${CEILING_MAX_S / 3600}.`);
    return { actions: [...new Set(actions)], folders, max_s: hours * 3600 };
  }
  ceiling(teamId: string): Ceiling {
    const t = this.team(teamId);
    return t.request_ceiling ? JSON.parse(t.request_ceiling) as Ceiling : { actions: CEILING_DEFAULT_ACTIONS, folders: null, max_s: CEILING_MAX_S };
  }

  /**
   * The team an agent's access request goes to: the agent's only running team. An agent in several running teams (or in
   * none) gets the admin: nothing the agent sends, such as a task_ref, picks whose deciders and ceiling apply.
   */
  requestTeam(agentId: string): string | null {
    const teams = this.db.prepare(`SELECT DISTINCT m.team_id FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.agent_id=? AND m.removed_at IS NULL AND t.status='running'`).all(agentId) as { team_id: string }[];
    return teams.length === 1 ? teams[0]!.team_id : null;
  }
  /**
   * Whether a request (and the grant an approval would create, `seconds` long) lies inside its team's ceiling: every
   * action allowed by the ceiling, a vault path inside the ceiling's folders (default: the project's vault roots), no
   * overlap with any restricted folder, and no longer than the ceiling allows. A ceiling never overrides a deny: the
   * grant it creates is checked by the policy engine like any other.
   */
  withinCeiling(r: RequestLike, seconds?: number): boolean { return this.ceilingTest()(r, seconds); }
  /** The ceiling check for many requests at once: each team's ceiling and folders, and the restricted folders, are read once. */
  private ceilingTest(): (r: RequestLike, seconds?: number) => boolean {
    let restricted: string[] | null = null;
    const teams = new Map<string, { c: Ceiling; folders: string[] } | null>();
    const of = (teamId: string) => {
      if (!teams.has(teamId)) {
        const t = this.db.prepare('SELECT project_id, request_ceiling FROM teams WHERE id=?').get(teamId) as { project_id: string | null; request_ceiling: string | null } | undefined;
        const c: Ceiling | null = t?.project_id ? (t.request_ceiling ? JSON.parse(t.request_ceiling) as Ceiling : { actions: CEILING_DEFAULT_ACTIONS, folders: null, max_s: CEILING_MAX_S }) : null;
        teams.set(teamId, c ? { c, folders: c.folders ?? this.users.vaultRoots(t!.project_id!) } : null);
      }
      return teams.get(teamId)!;
    };
    return (r, seconds) => {
      const t = r.team_id ? of(r.team_id) : null;
      if (!t) return false;
      if (!r.actions.every((a) => t.c.actions.includes(a))) return false;
      let res: { kind: string; pattern: string };
      try { res = parseResource(r.resource); } catch { return false; }
      if (res.kind !== 'path') return false;
      if (!t.folders.some((f) => resourceWithin(r.resource, `path:/${this.alias}${f}**`))) return false;
      // The pattern's fixed part (the folders before any glob): a restricted folder above or below it overlaps.
      const segs = res.pattern.split('/').filter(Boolean), glob = segs.findIndex((x) => /[*?[\]{}]/.test(x));
      const prefix = `/${(glob < 0 ? segs : segs.slice(0, glob)).join('/')}/`;
      restricted ??= (this.db.prepare('SELECT path FROM vault_folder_flags WHERE restricted=1').all() as { path: string }[]).map((x) => `/${this.alias}${normFolder(x.path)}`);
      if (restricted.some((x) => x.startsWith(prefix) || prefix.startsWith(x))) return false;
      return (seconds ?? r.requested_duration_s ?? 0) <= t.c.max_s;
    };
  }
  /** Whether this member may decide this request: an active decider of its team, and the request inside the team's ceiling. */
  mayDecideRequest(userId: string, r: RequestLike, seconds?: number): boolean {
    return !!r.team_id && this.isDecider(userId, r.team_id) && this.withinCeiling(r, seconds);
  }
  /**
   * The requests a member may decide, newest first, at most `limit`: rows of the teams they decide for, read in SQL, then
   * the ceiling check, stopping at the limit.
   */
  requestsFor(userId: string, status: string | undefined, limit = 200): RequestRow[] {
    const teams = this.decidesFor(userId);
    if (!teams.length) return [];
    const ph = teams.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM access_requests WHERE team_id IN (${ph})${status ? ' AND status=?' : ''} ORDER BY created_at DESC`).iterate(...teams, ...(status ? [status] : [])) as Iterable<Omit<RequestRow, 'actions'> & { actions: string }>;
    const ok = this.ceilingTest(), out: RequestRow[] = [];
    for (const raw of rows) {
      const r = { ...raw, actions: JSON.parse(raw.actions) as string[] };
      if (ok(r)) out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Audit where a new question went (only for teams with deciders). */
  routed(decisionId: string, teamId: string): void {
    if (!this.deciders(teamId).length) return;
    const to = this.activeDeciders(teamId);
    this.audit.event({ kind: 'system', id: null }, 'decision.routed', { kind: 'decision', id: decisionId }, to.length ? { team: teamId, to } : { team: teamId, to: 'admin', reason: 'no_active_decider' });
  }
  /**
   * Open questions routed to deciders that passed needed_by, or 24 h with no answer, become admin attention items, once
   * each (audited decision.escalated).
   */
  escalate(now = Date.now()): number {
    const rows = this.db.prepare(`SELECT id, team_id, needed_by FROM decisions WHERE status IN ('open','needs_info') AND escalated_at IS NULL
      AND ((needed_by IS NOT NULL AND needed_by<=?) OR created_at<=?) AND team_id IN (SELECT team_id FROM team_deciders)`).all(now, now - ESCALATE_MS) as { id: string; team_id: string; needed_by: number | null }[];
    for (const d of rows) {
      this.db.prepare('UPDATE decisions SET escalated_at=? WHERE id=? AND escalated_at IS NULL').run(now, d.id);
      this.audit.event({ kind: 'system', id: null }, 'decision.escalated', { kind: 'decision', id: d.id }, { team: d.team_id, reason: d.needed_by !== null && d.needed_by <= now ? 'needed_by' : 'no_answer_24h' });
    }
    return rows.length;
  }

  /**
   * Needs you (§1.3). For a member: open questions, pending access requests inside the ceiling, and tasks waiting for a
   * checkpoint approval or an unblock, in the teams they decide for. For an admin: what routing sent to them, that is
   * escalated questions, questions of teams whose deciders cannot act, and pending requests no decider may approve.
   */
  needsYou(userId: string, isAdmin: boolean) {
    type D = { id: string; team_id: string; question: string; needed_by: number | null; created_at: number; escalated_at: number | null };
    type R = { id: string; agent_id: string; team_id: string | null; actions: string; resource: string; requested_duration_s: number | null; created_at: number };
    const pendingReqs = (this.db.prepare("SELECT id, agent_id, team_id, actions, resource, requested_duration_s, created_at FROM access_requests WHERE status='pending' ORDER BY created_at").all() as R[])
      .map((r) => ({ ...r, actions: JSON.parse(r.actions) as string[] }));
    const open = this.db.prepare("SELECT id, team_id, question, needed_by, created_at, escalated_at FROM decisions WHERE status IN ('open','needs_info') ORDER BY created_at");
    const within = this.ceilingTest();
    if (!isAdmin) {
      const teams = new Set(this.decidesFor(userId));
      if (!teams.size) return { decisions: [], requests: [], tasks: [] };
      const ph = [...teams].map(() => '?').join(',');
      return {
        decisions: (open.all() as D[]).filter((d) => teams.has(d.team_id)),
        requests: pendingReqs.filter((r) => r.team_id && teams.has(r.team_id) && within(r)),
        tasks: this.db.prepare(`SELECT id, team_id, title, status, updated_at FROM tasks WHERE team_id IN (${ph}) AND status IN ('approved','blocked') ORDER BY updated_at`).all(...teams),
      };
    }
    // Per team, read once: whether it has deciders, and whether any of them can act now.
    const named = new Map<string, boolean>(), active = new Map<string, boolean>();
    const hasDeciders = (t: string) => { if (!named.has(t)) named.set(t, this.deciders(t).length > 0); return named.get(t)!; };
    const canAct = (t: string) => { if (!active.has(t)) active.set(t, this.activeDeciders(t).length > 0); return active.get(t)!; };
    return {
      decisions: (open.all() as D[]).filter((d) => d.escalated_at !== null || (hasDeciders(d.team_id) && !canAct(d.team_id))),
      requests: pendingReqs.filter((r) => !r.team_id || !canAct(r.team_id) || !within(r)),
      tasks: [],
    };
  }
}
