/**
 * Report requests (docs/blueprint.md §6-7, decision F-04 in §10): the operator asks a team for a status report or a plan
 * review, either for one team or for every running team of a project. Each notified team gets its own row and answers
 * for its own part: its bp_report answers its open status rows, its coordinator's plan write (bp_write) its plan rows.
 * These rows are the one record of open requests: the blueprint service opens and answers them (Blueprint.requestReport,
 * requestPlan), and the team views read them.
 */
import type { Db } from '../db/db.js';

/** The report format, in every status request notice (team or project scope) and the playbooks' wording. */
export const STATUS_FORMAT = 'Call bp_report: health (on_track, at_risk or off_track), then at most 3 bullets each for done, next and blockers (each at most 140 characters: a plain sentence the operator takes in at a glance, item keys in backticks where they help), refs to the items it is about, and escalate: true if you need the operator. The hub adds what moved since your last report.';

export type RequestKind = 'status' | 'plan';
export type RequestScope = 'project' | 'team';
export interface RequestRow {
  id: number; project_id: string | null; team_id: string; scope: RequestScope; kind: RequestKind; note: string | null;
  requested_by_kind: string; requested_by_id: string | null; requested_at: number; answered_at: number | null; answered_by: string | null;
}

export function openRequest(db: Db, a: { teamId: string; scope: RequestScope; kind: RequestKind; note: string | null; by: { kind: string; id: string | null }; at?: number }): void {
  const t = db.prepare('SELECT project_id FROM teams WHERE id=?').get(a.teamId) as { project_id: string | null } | undefined;
  db.prepare('INSERT INTO bp_report_requests(project_id,team_id,scope,kind,note,requested_by_kind,requested_by_id,requested_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(t?.project_id ?? null, a.teamId, a.scope, a.kind, a.note, a.by.kind, a.by.id, a.at ?? Date.now());
}

/** The team's open requests of one kind, newest first. */
export function openRequests(db: Db, teamId: string, kind: RequestKind): RequestRow[] {
  return db.prepare('SELECT * FROM bp_report_requests WHERE team_id=? AND kind=? AND answered_at IS NULL ORDER BY requested_at DESC, id DESC').all(teamId, kind) as unknown as RequestRow[];
}

/** Answer the team's open requests of one kind; the other teams' rows stay open. Returns how many were answered. */
export function answerRequests(db: Db, teamId: string, kind: RequestKind, by: string, at = Date.now()): number {
  return Number(db.prepare('UPDATE bp_report_requests SET answered_at=?, answered_by=? WHERE team_id=? AND kind=? AND answered_at IS NULL').run(at, by, teamId, kind).changes);
}

/** Open requests of a project (optionally of one team), oldest first: what the console shows as waiting. */
export function projectRequests(db: Db, projectId: string, teamId?: string): RequestRow[] {
  return db.prepare(`SELECT r.* FROM bp_report_requests r JOIN teams t ON t.id=r.team_id WHERE t.project_id=? AND r.answered_at IS NULL ${teamId ? 'AND r.team_id=?' : ''} ORDER BY r.requested_at, r.id`)
    .all(...(teamId ? [projectId, teamId] : [projectId])) as unknown as RequestRow[];
}
