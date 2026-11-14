/**
 * The task board a member may read (docs/multi-user.md §1.2, §7): a project's teams with their tasks in board columns,
 * read only. The operator opens it per project ("Members can see the task board", projects.member_board, off by default).
 * A member reads it only when the switch is on and they hold a grant on the project; anything else (no grant, an unknown
 * project, the switch off, an external user) answers the same 403 board_denied, so the answer never tells whether a
 * project exists. The admin reads every board, to see what members would see. The detail route opens any task on the
 * board, done ones beyond the BOARD_DONE_MAX the board lists included. No write path: members act only through Needs you.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import type { Teams, TaskRow } from '../teams/teams.js';
import { KeyError } from '../keys/keys.js';
import type { MemberScope } from './memberScope.js';

export interface MemberBoardDeps { db: Db; keys: Keys; teams: Teams; attachments?: { count(taskId: string): number } }

/** Statuses on the board. The backlog and discarded tasks are the operator's queue, and cancelled ones are gone. */
export const BOARD_STATUSES: readonly string[] = ['open', 'assigned', 'in_progress', 'changes_requested', 'in_review', 'approved', 'blocked', 'done'];
/** Done tasks per team, newest first; the rest are counted, not listed. */
export const BOARD_DONE_MAX = 50;

interface ProjectRef { id: string; key: string; name: string; member_board: number }

/** Whether this reader may open the board of this project; the reason a member is refused is never told apart. */
export function boardAllowed(p: ProjectRef | undefined, member: MemberScope | undefined): boolean {
  if (!member) return !!p;
  // An external user (users.external = 1) never reads a task board, whatever the switch says (docs/multi-user.md §1.4).
  return !!p && !!p.member_board && !member.external && member.grants.has(p.id);
}

export function registerMemberBoard(api: FastifyInstance, d: MemberBoardDeps): void {
  const { db, keys, teams } = d;
  const denied = () => new KeyError('board_denied', 'The task board of this project is not shared with you.');
  const params = (req: FastifyRequest) => req.params as { id: string; taskId?: string };
  const project = (req: FastifyRequest): ProjectRef => {
    const p = db.prepare('SELECT id, key, name, member_board FROM projects WHERE id=?').get(params(req).id) as ProjectRef | undefined;
    if (boardAllowed(p, req.member)) return p!;
    if (req.member) throw denied();
    throw new KeyError('not_found', 'No such project.');
  };
  const label = (id: string | null) => (id ? keys.agent(id)?.label ?? 'An agent' : null);
  const projectTeams = (pid: string) => db.prepare('SELECT id, name, status FROM teams WHERE project_id=? ORDER BY created_at, rowid').all(pid) as { id: string; name: string; status: string }[];
  /** A board card: what the board shows and nothing else (no agent, key or console user ids). */
  const card = (k: TaskRow) => ({
    id: k.id, title: k.title, status: k.status, assignee: label(k.assignee_agent_id), review_rounds: k.review_rounds,
    awaiting_approval: !!k.approval_requested, overdue: k.overdue_at !== null && k.overdue_at !== undefined, blocked_reason: k.status === 'blocked' ? k.blocked_reason : null,
    refs: teams.refsOf(k), updated_at: k.updated_at,
    // Attachments: the count only ("4 attachments"), never a file or its name; there is no member route to the files.
    attachments: d.attachments?.count(k.id) ?? 0,
  });
  const onBoard = (k: TaskRow) => BOARD_STATUSES.includes(k.status) && !(k.status === 'done' && k.dismissed_at);

  api.get('/api/projects/:id/board', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    const p = project(req);
    return {
      project: { id: p.id, key: p.key, name: p.name }, member_board: !!p.member_board,
      teams: projectTeams(p.id).map((t) => {
        const L = teams.tasks(t.id).filter(onBoard);
        const done = L.filter((k) => k.status === 'done').sort((a, b) => b.updated_at - a.updated_at);
        const live = L.filter((k) => k.status !== 'done');
        return { id: t.id, name: t.name, status: t.status, tasks: [...live, ...done.slice(0, BOARD_DONE_MAX)].map(card), done_total: done.length };
      }),
    };
  });
  api.get('/api/projects/:id/board/:taskId', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    const p = project(req);
    const k = teams.task(params(req).taskId!);
    const t = k?.team_id ? projectTeams(p.id).find((x) => x.id === k.team_id) : undefined;
    // A task of another project, off the board or unknown reads the same.
    if (!k || !t || !onBoard(k)) throw new KeyError('not_found', 'No such task.');
    return { task: { ...card(k), team: { id: t.id, name: t.name }, description: k.description, summary: k.summary, reviewer: label(k.reviewer_agent_id), created_at: k.created_at } };
  });
}
