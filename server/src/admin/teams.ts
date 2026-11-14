/** Team builder and team page API (F4). Registered inside the authenticated /api scope. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import type { Actor } from '../audit/audit.js';
import type { Teams, TaskRow } from '../teams/teams.js';
import { tagFilter, normTaskTags, parseTags } from '../teams/teams.js';
import { wakeText } from '../teams/turns.js';
import { SHORT_SUMMARY_MAX } from '../teams/shortSummary.js';
import { KeyError } from '../keys/keys.js';
import type { Component } from './users.js';
import type { Routing } from './routing.js';
import { Keywords } from '../teams/keywords.js';
import { Audit } from '../audit/audit.js';
import { sniff, type TaskAttachments } from '../shares/taskAttachments.js';

export interface TeamsDeps {
  db: Db; keys: Keys; teams: Teams; routing?: Routing;
  /** Opens a new team's Blueprint part (ADR-001, docs/blueprint.md §4): the operator creating a team approves it. */
  openPart?: (teamId: string, actor: Actor, o: { moreTeams: boolean }) => void;
  /** The setup record of the onboarding request that created the team (docs/onboarding.md#setup-progress), for its page. */
  setupOf?: (teamId: string) => unknown;
  /** Task attachments (docs/specification.md, "Task attachments"): counts on the board, the sets on the operator's task screen, and Attach. */
  attachments?: TaskAttachments;
}

/** At most this many pinned teams per operator. */
export const MAX_PINS = 50;

const role = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/);
const limits = z.object({ tasks_per_hour: z.number().int().min(1).optional(), messages_per_hour: z.number().int().min(1).optional(), writes_per_hour: z.number().int().min(1).optional(), channel_bytes_per_hour: z.number().int().min(1).optional(), attachment_bytes: z.number().int().min(1).optional() }).strict();
const member = z.object({ agent_id: z.string(), role, credential_id: z.string().optional() });
const create = z.object({
  name: z.string().trim().min(1).max(80), goal: z.string().trim().min(1).max(4000), members: z.array(member).min(1).max(50), grant_messaging: z.boolean().optional(),
  limits: limits.optional(), checkpoints: z.array(z.enum(['done'])).optional(), lease_minutes: z.number().int().min(1).max(1440).optional(),
  max_review_rounds: z.number().int().min(1).max(20).optional(), stall_minutes: z.number().int().min(1).max(1440).optional(),
  keywords: z.array(z.string().max(100)).max(20).optional(),
  /** More teams will join the team's project: it gets its own Blueprint part even as the project's only team (FR-PLAN-12). */
  more_teams: z.boolean().optional(),
});
const patch = z.object({
  name: z.string().trim().min(1).max(80).optional(), goal: z.string().trim().min(1).max(4000).optional(), limits: limits.optional(), checkpoints: z.array(z.enum(['done'])).optional(),
  keywords: z.array(z.string().max(100)).max(20).optional(),
  lease_minutes: z.number().int().min(1).max(1440).optional(), max_review_rounds: z.number().int().min(1).max(20).optional(), stall_minutes: z.number().int().min(1).max(1440).optional(),
  close_on_approve: z.boolean().optional(), coordinator_reviews: z.boolean().optional(), delivery_mode: z.enum(['poll', 'on_demand']).optional(), feedback_nudge: z.boolean().optional(), coordinator_decides_blueprint: z.boolean().optional(),
  recruiting: z.enum(['off', 'propose', 'auto']).optional(), recruit_max: z.number().int().min(1).max(20).optional(), recruit_roles: z.array(z.enum(['worker', 'reviewer', 'stakeholder'])).min(1).optional(),
  recruit_template_id: z.string().max(100).nullable().optional(), recruit_days: z.number().int().min(1).max(90).optional(),
});

/** How long a task opened on a relayed request is listed with the backlog (it leaves sooner once someone holds it). */
const RELAYED_DAYS = 7;

export function registerTeams(api: FastifyInstance, d: TeamsDeps, actor: (r: FastifyRequest) => Actor): void {
  const { teams } = d;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  const p = (req: FastifyRequest) => req.params as { id: string; taskId?: string; agentId?: string; role?: string };

  /**
   * A member's view of a team (docs/multi-user.md §2): with the tasks component, the summary, members (agent labels and
   * roles), the board and the latest status report; never keys, credentials, playbooks, limits, recruits, usage or vault paths.
   * With Blueprint only, the name, project and status.
   */
  // Stall warnings are off unless the team switched them on (migration 0123): every attention surface, the team badges included, reads this.
  const stallWarnings = (id: string) => !!(d.db.prepare('SELECT stall_warnings FROM teams WHERE id=?').get(id) as { stall_warnings: number } | undefined)?.stall_warnings;
  const memberSummary = (t: ReturnType<typeof teams.mustTeam>) => {
    const s = teams.summary(t);
    // A checkout pause names the checkout (docs/checkout.md §3); members never see checkouts, so the reason is withheld.
    return { id: s.id, name: s.name, goal: s.goal, status: s.status, paused_reason: s.paused_reason?.startsWith('checkout:') ? null : s.paused_reason, paused_until: s.paused_until, paused_note: s.paused_note, room_id: s.room_id, members: s.members, agent_ids: s.agent_ids, lead_id: s.lead_id,
      last_activity_at: s.last_activity_at, approvals: s.approvals, counts: s.counts, progress: s.progress, stalled: s.stalled, created_at: s.created_at, updated_at: s.updated_at,
      project_id: s.project_id, review_policy: s.review_policy, stall_warnings: stallWarnings(s.id) };
  };
  // The board's paperclip: how many files a task carries, for the operator and members alike (never a name or a file).
  const withCounts = <T extends { id: string }>(L: T[]) => { const c = d.attachments?.counts(L.map((k) => k.id)); return L.map((k) => ({ ...k, attachments: c?.get(k.id) ?? 0 })); };
  const memberBrief = (t: ReturnType<typeof teams.mustTeam>) => ({ id: t.id, name: t.name, status: t.status, project_id: t.project_id ?? null, tasks: false });
  const memberView = (t: ReturnType<typeof teams.mustTeam>) => {
    const v = teams.view(t);
    return { ...memberSummary(t), delivery_mode: v.delivery_mode, checkpoints: v.checkpoints, close_on_approve: v.close_on_approve,
      members: v.members.map((m) => ({ agent_id: m.agent_id, label: m.label, role: m.role, joined_at: m.joined_at, last_activity_at: m.last_activity_at, stalled: m.stalled })),
      board: withCounts(v.board), status_report: v.status_report, status_requested_at: v.status_requested_at, plan: v.plan };
  };
  /** A team the member may not see answers exactly like an unknown team. */
  const visibleTeam = (req: FastifyRequest, id: string, ...cs: Component[]) => {
    const t = teams.mustTeam(id);
    if (req.member && !cs.some((c) => req.member!.team(t.id, c))) throw new KeyError('not_found', 'team not found');
    return t;
  };

  // Keywords (docs/proposals/team-keywords.md): admins' answers only, never members' or agents' (no MCP tool carries them).
  const K = new Keywords(d.db), audit = new Audit(d.db);
  const withKw = <T extends { id: string; project_id: string | null }>(s: T, tk = K.ofTeam(s.id), pk = s.project_id ? K.ofProject(s.project_id) : []) => ({ ...s, keywords: tk, project_keywords: pk });
  /**
   * The operator's view of a task's open turn (docs/dashboard-ux.md, waiting review): who holds it, since when, whether
   * they have seen it, its due time, for a review the submission it waits on (round: the nth task_submit, as the task
   * screen numbers its rounds) and, for an on-demand holder who has not seen it, the hand-off's wake text. Null when
   * nobody holds the task.
   */
  const turnsOf = (ids: string[], onDemand: boolean) => {
    const v = teams.turns.views(ids), rounds = new Map<string, number>();
    const reviews = ids.filter((id) => v.get(id)?.turn.phase === 'review');
    if (reviews.length) for (const r of d.db.prepare(`SELECT task_id, COUNT(*) n FROM task_events WHERE tool='task_submit' AND task_id IN (${reviews.map(() => '?').join(',')}) GROUP BY task_id`).all(...reviews) as { task_id: string; n: number }[]) rounds.set(r.task_id, r.n);
    return (id: string) => {
      const x = v.get(id)?.turn;
      return x ? { phase: x.phase, holder: x.holder, holder_label: d.keys.agent(x.holder)?.label ?? x.holder, since: x.since, seen_at: x.seen_at, due_at: x.due_at,
        round: x.phase === 'review' ? rounds.get(id) ?? null : null, wake_text: onDemand && x.seen_at === null ? wakeText(x.phase, id) : null } : null;
    };
  };
  const adminView = (t: ReturnType<typeof teams.mustTeam>) => {
    const v = teams.view(t), turn = turnsOf(v.board.map((k) => k.id), t.delivery_mode === 'on_demand');
    return withKw({ ...v, stall_warnings: stallWarnings(t.id), board: withCounts(v.board).map((k) => ({ ...k, turn: turn(k.id) })) });
  };
  const setKw = (req: FastifyRequest, id: string, list: string[]) => {
    const before = K.ofTeam(id), after = K.setTeam(id, list);
    if (before.join('\n') !== after.join('\n')) audit.event(actor(req), 'team.keywords', { kind: 'team', id }, { keywords: after });
  };

  api.get('/api/teams', async (req) => {
    const m = req.member;
    if (!m) {
      const tk = K.allTeams(), pk = K.allProjects();
      return { teams: teams.teams().map((t) => { const s = { ...teams.summary(t), stall_warnings: stallWarnings(t.id) }; return withKw(s, tk.get(s.id) ?? [], s.project_id ? pk.get(s.project_id) ?? [] : []); }) };
    }
    return { teams: teams.teams().filter((t) => m.team(t.id, 'blueprint')).map((t) => (m.team(t.id, 'tasks') ? { ...memberSummary(t), tasks: true } : memberBrief(t))) };
  });
  // Home Teams card pins: per operator, in pin order, kept in system_settings so they follow the operator across browsers.
  const pinKey = (req: FastifyRequest) => `home.pinned_teams:${req.admin!.id}`;
  const readPins = (req: FastifyRequest): string[] => {
    const row = d.db.prepare('SELECT value FROM system_settings WHERE key=?').get(pinKey(req)) as { value: string } | undefined;
    let ids: unknown = [];
    try { ids = row ? JSON.parse(row.value) : []; } catch { /* unreadable: no pins */ }
    // A deleted team drops out; for a member, so does a team they no longer see.
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && !!teams.team(x) && (!req.member || req.member.team(x, 'blueprint'))) : [];
  };
  api.get('/api/teams/pins', async (req) => ({ team_ids: readPins(req) }));
  api.put('/api/teams/pins', async (req) => {
    const ids = [...new Set(body(z.object({ team_ids: z.array(z.string().min(1).max(100)).max(MAX_PINS) }).strict(), req).team_ids)];
    const unknown = ids.filter((id) => !teams.team(id) || (req.member && !req.member.team(id, 'blueprint')));
    if (unknown.length) throw new KeyError('invalid_argument', `team_ids: no such team ${unknown.join(', ')}`);
    d.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(pinKey(req), JSON.stringify(ids), Date.now());
    return { team_ids: ids };
  });
  // Teams Organize choice: per operator, stored like the pins. A missing or unknown stored value reads as '' (Attention).
  const ORGANIZE = ['', 'status', 'project', 'name'] as const;
  const organizeKey = (req: FastifyRequest) => `teams.organize:${req.admin!.id}`;
  // Stored as JSON (system_settings.value must be valid JSON).
  api.get('/api/teams/organize', async (req) => {
    const row = d.db.prepare('SELECT value FROM system_settings WHERE key=?').get(organizeKey(req)) as { value: string } | undefined;
    let v: unknown = '';
    try { v = row ? JSON.parse(row.value) : ''; } catch { /* unreadable: Attention */ }
    return { organize: ORGANIZE.find((o) => o === v) ?? '' };
  });
  api.put('/api/teams/organize', async (req) => {
    const { organize } = body(z.object({ organize: z.enum(ORGANIZE) }).strict(), req);
    d.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(organizeKey(req), JSON.stringify(organize), Date.now());
    return { organize };
  });
  // The Teams keyword filter: per operator, stored like Organize. '' is All; a keyword no longer known reads as All.
  const keywordKey = (req: FastifyRequest) => `teams.keyword:${req.admin!.id}`;
  api.get('/api/teams/keyword', async (req) => {
    const row = d.db.prepare('SELECT value FROM system_settings WHERE key=?').get(keywordKey(req)) as { value: string } | undefined;
    let v: unknown = '';
    try { v = row ? JSON.parse(row.value) : ''; } catch { /* unreadable: All */ }
    return { keyword: typeof v === 'string' && K.known().includes(v) ? v : '' };
  });
  api.put('/api/teams/keyword', async (req) => {
    const { keyword } = body(z.object({ keyword: z.string().max(100) }).strict(), req);
    const v = keyword ? K.valid([keyword])[0]! : '';
    d.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(keywordKey(req), JSON.stringify(v), Date.now());
    return { keyword: v };
  });
  api.post('/api/teams', async (req, reply) => {
    const { keywords, more_teams, ...b } = body(create, req);
    if (keywords) K.valid(keywords); // refused before the team exists
    const t = teams.create(b, actor(req));
    if (keywords) setKw(req, t.id, keywords);
    d.openPart?.(t.id, actor(req), { moreTeams: more_teams === true });
    reply.code(201);
    return { team: adminView(teams.mustTeam(t.id)), warnings: teams.chatWarnings(t.id) };
  });
  /** The actor for a decider act on this team : an active decider, or the admin (with via when the team has deciders). */
  const routed = (req: FastifyRequest, teamId: string) => (d.routing ? d.routing.act(actor(req), req.member, teamId, 'team not found') : actor(req));
  const teamOut = (req: FastifyRequest, t: ReturnType<typeof teams.mustTeam>) => (req.member ? memberView(t) : { ...teams.view(t), stall_warnings: stallWarnings(t.id) });
  api.get('/api/teams/:id', async (req) => {
    if (req.member) return { team: memberView(visibleTeam(req, p(req).id, 'tasks')) };
    const t = teams.mustTeam(p(req).id), setup = d.setupOf?.(t.id) ?? null;
    return { team: adminView(t), ...(setup ? { setup } : {}) };
  });
  api.patch('/api/teams/:id', async (req) => {
    const { keywords, ...b } = body(patch, req), id = p(req).id;
    teams.mustTeam(id);
    if (keywords) K.valid(keywords); // refused before anything changes
    if (Object.keys(b).length || !keywords) teams.update(id, b, actor(req));
    if (keywords) setKw(req, id, keywords);
    return { team: adminView(teams.mustTeam(id)) };
  });
  api.post('/api/teams/:id/start', async (req) => ({ team: teams.view(teams.start(p(req).id, actor(req))) }));
  // An optional end time (any length: the operator's) and reason (docs/multi-user.md); on a paused team it changes that pause.
  api.post('/api/teams/:id/pause', async (req) => {
    const b = body(z.object({ reason: z.string().max(200).optional(), until: z.number().int().positive().nullable().optional() }).strict(), req);
    return { team: teams.view(teams.pause(p(req).id, 'admin', actor(req), { until: b.until ?? null, note: b.reason ?? null })) };
  });
  api.post('/api/teams/:id/resume', async (req) => ({ team: teams.view(teams.resume(p(req).id, actor(req))) }));
  api.post('/api/teams/:id/stop', async (req) => ({ team: teams.view(teams.stop(p(req).id, actor(req))) }));
  api.post('/api/teams/:id/members', async (req) => {
    teams.addMember(p(req).id, body(member, req), actor(req));
    return { team: teams.view(teams.mustTeam(p(req).id)), warnings: teams.chatWarnings(p(req).id) };
  });
  api.delete('/api/teams/:id/members/:agentId', async (req) => {
    teams.removeMember(p(req).id, p(req).agentId!, actor(req));
    return { team: teams.view(teams.mustTeam(p(req).id)) };
  });
  api.put('/api/teams/:id/roles/:role', async (req) => {
    teams.setPlaybook(p(req).id, p(req).role!, body(z.object({ playbook: z.string().min(1).max(8000) }), req).playbook, actor(req));
    return { team: teams.view(teams.mustTeam(p(req).id)) };
  });
  api.get('/api/teams/:id/handoff', async (req) => teams.handoff(teams.mustTeam(p(req).id)));
  api.get('/api/teams/:id/tasks/:taskId', async (req) => {
    const t = teams.task(p(req).taskId!);
    // Out of a member's grant reads like a task that does not exist.
    if (!t || t.team_id !== p(req).id || (req.member && !req.member.team(t.team_id, 'tasks'))) return { task: null, events: [] };
    const events = teams.taskEvents(t.id) as { actor_kind: string; actor_id: string | null }[];
    // A member sees no console user id: the operator's events carry a null actor id.
    // A member gets the count only; the files, their names and the byte route are the operator's.
    const count = d.attachments?.count(t.id) ?? 0;
    if (req.member) return { task: { ...teams.taskView(t), attachments_count: count }, events: events.map((e) => (e.actor_kind === 'admin' ? { ...e, actor_id: null } : e)) };
    return { task: { ...teams.taskView(t), attachments_count: count, attachments: d.attachments?.consoleView(t.id) ?? { brief: null, rounds: [] }, turn: turnsOf([t.id], teams.team(t.team_id!)?.delivery_mode === 'on_demand')(t.id) }, events };
  });
  // The operator's Attach: images and HTML mockups added to the brief as its next version (a path given again replaces
  // that file). At most 1 MB of files a call, the task's version guards a stale screen, and every limit is the hub's.
  const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/html'];
  const attachBody = z.object({ files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(1_500_000), encoding: z.literal('base64') }).strict()).min(1).max(20), version: z.number().int().min(1) }).strict();
  api.post('/api/teams/:id/tasks/:taskId/attachments', async (req) => {
    if (req.member || !d.attachments) throw new KeyError('denied', 'Only the operator attaches files to a brief.');
    const t = teams.task(p(req).taskId!);
    if (!t || t.team_id !== p(req).id) throw new KeyError('not_found', 'task not found');
    const b = body(attachBody, req);
    if (b.version !== t.version) throw new KeyError('conflict', 'The task changed since you opened it. Reopen it and attach again.');
    for (const f of b.files) {
      const type = sniff(Buffer.from(f.content, 'base64'));
      if (!ATTACH_TYPES.includes(type)) throw new KeyError('invalid_argument', `"${f.path}" is not a PNG, JPEG, GIF, WebP or HTML file.`);
    }
    const A = d.attachments, w = { agentId: null, credId: null, actor: actor(req) };
    const staged = (await A.stage(w, b.files, undefined))!;
    try { A.inTx(() => { A.touchTask(t.id, t.version); A.commit(t, 'brief', staged, w); }); } catch (e) { staged.refund(); throw e; }
    const k = teams.task(t.id)!;
    return { task: { ...teams.taskView(k), attachments_count: A.count(k.id), attachments: A.consoleView(k.id) } };
  });
  api.post('/api/teams/:id/tasks/:taskId/approve', async (req) => ({ task: teams.taskView(teams.approve(p(req).id, p(req).taskId!, routed(req, p(req).id))) }));
  // Whether a task needs review (review policy): required or none, with the reason, audited. In review → none approves it.
  api.post('/api/teams/:id/tasks/:taskId/review', async (req) => {
    const b = z.object({ review: z.enum(['required', 'none']), reason: z.string().trim().min(1).max(400) }).strict().parse(req.body ?? {});
    const who = routed(req, p(req).id);
    // A decider switches a task's review only where the project lets the task decide (per_task); the policy stays admin-only.
    if (req.member && teams.reviewPolicy(p(req).id) !== 'per_task') throw new KeyError('not_decider', "Only an admin can change a task's review under this project's review policy.");
    return { task: teams.taskView(teams.adminSetReview(p(req).id, p(req).taskId!, b.review, b.reason, who)) };
  });
  // The operator's backlog: accept (backlog → open), discard (backlog → discarded, kept for history), demote (open → backlog).
  // Audited; the creator and the coordinators get a notice.
  const backlogNote = z.object({ note: z.string().max(1000).nullable().optional() }).strict();
  api.post('/api/teams/:id/tasks/:taskId/accept', async (req) => ({ task: teams.taskView(teams.adminAccept(p(req).id, p(req).taskId!, body(backlogNote, req).note?.trim() || null, actor(req))) }));
  api.post('/api/teams/:id/tasks/:taskId/discard', async (req) => ({ task: teams.taskView(teams.adminDiscard(p(req).id, p(req).taskId!, body(backlogNote, req).note?.trim() || null, actor(req))) }));
  api.post('/api/teams/:id/tasks/:taskId/demote', async (req) => ({ task: teams.taskView(teams.adminDemote(p(req).id, p(req).taskId!, body(backlogNote, req).note?.trim() || null, actor(req))) }));
  // Postpone a backlog task and return it to active: it stays backlog (postponed_at), versioned and audited, no notice.
  const postponeBody = z.object({ note: z.string().max(1000).nullable().optional(), version: z.number().int().min(1).optional() }).strict();
  api.post('/api/teams/:id/tasks/:taskId/postpone', async (req) => {
    const b = body(postponeBody, req);
    return { task: teams.taskView(teams.adminPostpone(p(req).id, p(req).taskId!, b.note?.trim() || null, b.version, actor(req))) };
  });
  api.post('/api/teams/:id/tasks/:taskId/restore', async (req) => {
    const b = body(postponeBody, req);
    return { task: teams.taskView(teams.adminRestore(p(req).id, p(req).taskId!, b.note?.trim() || null, b.version, actor(req))) };
  });
  // The backlog across every team (Home's Backlog card, Work → Backlog): oldest first, with the team's name.
  // ?list=active (default) or postponed, ?project=, ?team= and ?tag= combine before paging and counting: total counts the matching
  // tasks of the list, active_total and postponed_total the matching tasks of each list, all_total the whole active
  // backlog; tags and projects count the chosen list (with the other filter), for the console's filters. ?limit (1-200,
  // default 50) and ?cursor page it. The relayed tasks are open, never postponed: their own group, by project and tag.
  const hasTag = "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(k.tags) THEN k.tags ELSE '[]' END) j WHERE j.value=?)";
  const blQuery = z.object({
    list: z.enum(['active', 'postponed']).optional(), project: z.string().max(100).optional(), team: z.string().max(100).optional(), tag: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().max(100).optional(),
  });
  // The cursor is the last row's (created_at, rowid), opaque to the console, and names its list.
  const blCursor = (list: string, at: number, rowid: number) => Buffer.from(`${list}:${at}:${rowid}`).toString('base64url');
  const blCursorIn = (list: string, c: string | undefined): [number, number] | null => {
    if (!c) return null;
    const m = /^(active|postponed):(\d{1,16}):(\d{1,16})$/.exec(Buffer.from(c, 'base64url').toString());
    if (!m || m[1] !== list) throw new KeyError('invalid_argument', 'cursor is a next_cursor from this list');
    return [Number(m[2]), Number(m[3])];
  };
  api.get('/api/tasks/backlog', async (req) => {
    const q = blQuery.parse(req.query ?? {}), list = q.list ?? 'active', tag = tagFilter(q.tag) ?? null, project = q.project || null, team = q.team || null, limit = q.limit ?? 50;
    const after = blCursorIn(list, q.cursor);
    // One WHERE for the filters, so each list, count and page names the same tasks. k is the task, t its team.
    const filt = (o: { tag?: boolean; project?: boolean } = {}) => {
      const w: string[] = [], a: (string | number)[] = [];
      if (o.project !== false && project) { w.push('t.project_id=?'); a.push(project); }
      if (team) { w.push('k.team_id=?'); a.push(team); }
      if (o.tag !== false && tag) { w.push(hasTag); a.push(tag); }
      return { w: w.map((x) => ` AND ${x}`).join(''), a };
    };
    const inList = (l: string) => (l === 'postponed' ? "k.status='backlog' AND k.postponed_at IS NOT NULL" : "k.status='backlog' AND k.postponed_at IS NULL");
    const F = filt(), page = after ? ' AND (k.created_at>? OR (k.created_at=? AND k.rowid>?))' : '', pa = after ? [after[0], after[0], after[1]] : [];
    const rows = d.db.prepare(`SELECT k.*, k.rowid AS rid, t.name AS team_name FROM tasks k JOIN teams t ON t.id=k.team_id WHERE ${inList(list)}${F.w}${page} ORDER BY k.created_at, k.rowid LIMIT ?`)
      .all(...F.a, ...pa, limit + 1) as unknown as (TaskRow & { team_name: string; rid: number })[];
    const more = rows.length > limit, shown = rows.slice(0, limit), last = shown.at(-1);
    const count = (l: string) => (d.db.prepare(`SELECT COUNT(*) AS n FROM tasks k JOIN teams t ON t.id=k.team_id WHERE ${inList(l)}${F.w}`).get(...F.a) as { n: number }).n;
    const activeTotal = count('active'), postponedTotal = count('postponed');
    const allTotal = (d.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='backlog' AND postponed_at IS NULL").get() as { n: number }).n;
    // Opened at once on a coordinator's relayed request in the last 7 days and still held by nobody, newest first: the
    // operator can send each back to the backlog (demote) in one click, so a relay never skips the backlog unseen.
    const since = Date.now() - RELAYED_DAYS * 86_400_000;
    const relayedWhere = "k.status='open' AND k.assignee_agent_id IS NULL AND k.operator_request_source IS NOT NULL AND k.operator_request_at>=?";
    const relayed = d.db.prepare(`SELECT k.*, t.name AS team_name FROM tasks k JOIN teams t ON t.id=k.team_id WHERE ${relayedWhere}${F.w} ORDER BY k.operator_request_at DESC, k.rowid DESC LIMIT 50`)
      .all(since, ...F.a) as unknown as (TaskRow & { team_name: string })[];
    const view = (r: TaskRow & { team_name: string; rid?: number }) => { const { rid: _r, ...k } = r; return { ...teams.taskView(k as TaskRow), team_name: r.team_name }; };
    // Tag chips: the chosen list and the relayed group, within the project filter. Project choices: the chosen list and the
    // relayed group, within the tag filter, with the project's name.
    const T = filt({ tag: false }), P = filt({ project: false });
    const tagRows = d.db.prepare(`SELECT j.value AS tag, COUNT(*) AS n FROM tasks k JOIN teams t ON t.id=k.team_id, json_each(CASE WHEN json_valid(k.tags) THEN k.tags ELSE '[]' END) j
      WHERE ((${inList(list)}) OR (${relayedWhere}))${T.w} GROUP BY j.value ORDER BY n DESC, j.value`).all(since, ...T.a) as { tag: string; n: number }[];
    const projectRows = d.db.prepare(`SELECT p.id, p.name, COUNT(*) AS n FROM tasks k JOIN teams t ON t.id=k.team_id JOIN projects p ON p.id=t.project_id
      WHERE ((${inList(list)}) OR (${relayedWhere}))${P.w} GROUP BY p.id ORDER BY p.name, p.id`).all(since, ...P.a) as { id: string; name: string; n: number }[];
    return {
      list, tasks: shown.map(view), total: list === 'postponed' ? postponedTotal : activeTotal, active_total: activeTotal, postponed_total: postponedTotal, all_total: allTotal,
      next_cursor: more && last ? blCursor(list, last.created_at, last.rid) : null,
      relayed: relayed.map(view), relayed_days: RELAYED_DAYS, tag, project, tags: tagRows, projects: projectRows,
      team_name: team ? (d.db.prepare('SELECT name FROM teams WHERE id=?').get(team) as { name: string } | undefined)?.name ?? null : null,
      project_name: project ? (d.db.prepare('SELECT name FROM projects WHERE id=?').get(project) as { name: string } | undefined)?.name ?? null : null,
    };
  });
  // A team's tasks, filtered (members: teams granted their tasks). ?status= one status, "all", or (default) every status
  // but done, cancelled and discarded; ?tag= only tasks carrying it. tags counts the tags over the status filter.
  api.get('/api/teams/:id/tasks', async (req) => {
    const t = visibleTeam(req, p(req).id, 'tasks');
    const q = z.object({ status: z.string().max(30).optional(), tag: z.string().max(64).optional() }).parse(req.query ?? {}), tag = tagFilter(q.tag);
    const ended = ['done', 'cancelled', 'discarded'];
    const L = teams.tasks(t.id).filter((k) => (q.status === 'all' ? true : q.status ? k.status === q.status : !ended.includes(k.status)));
    const counts = new Map<string, number>();
    for (const k of L) for (const g of parseTags(k.tags)) counts.set(g, (counts.get(g) ?? 0) + 1);
    const out = tag ? L.filter((k) => parseTags(k.tags).includes(tag)) : L;
    return { tasks: out.map((k) => teams.taskView(k)), total: out.length, tag: tag ?? null,
      tags: [...counts].map(([g, n]) => ({ tag: g, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)) };
  });
  // The operator files a task: replace its tags (at most 8; [] clears them), on a task in any status. Audited.
  api.put('/api/teams/:id/tasks/:taskId/tags', async (req) => {
    const b = body(z.object({ tags: z.array(z.string().max(64)).max(8), version: z.number().int().min(1).optional() }).strict(), req);
    return { task: teams.taskView(teams.adminSetTags(p(req).id, p(req).taskId!, normTaskTags(b.tags), b.version, actor(req))) };
  });
  // The operator sets a task's "In short" (at most 280 characters of plain text; null or "" clears it), any status. Audited.
  api.put('/api/teams/:id/tasks/:taskId/short-summary', async (req) => {
    const b = body(z.object({ short_summary: z.string().max(SHORT_SUMMARY_MAX).nullable(), version: z.number().int().min(1).optional() }).strict(), req);
    return { task: teams.taskView(teams.adminSetShortSummary(p(req).id, p(req).taskId!, b.short_summary, b.version, actor(req))) };
  });
  // Lift a block (F-34): the task returns to the status it was blocked from.
  api.post('/api/teams/:id/tasks/:taskId/unblock', async (req) => {
    const b = z.object({ note: z.string().max(2000).nullable().optional() }).parse(req.body ?? {});
    return { task: teams.taskView(teams.adminUnblock(p(req).id, p(req).taskId!, b.note?.trim() || null, routed(req, p(req).id))) };
  });
  // Recruit requests from coordinators in teams set to 'propose'. Approving creates the agent; its key waits for pickup on the coordinator's PC and is never returned.
  api.get('/api/recruits', async (req) => ({ requests: teams.recruitRequests(undefined, (req.query as { status?: string }).status) }));
  api.post('/api/recruits/:id/approve', async (req) => {
    const r = teams.approveRecruit(p(req).id, actor(req));
    return { agent: r.agent, pickup: r.pickup };
  });
  api.post('/api/recruits/:id/deny', async (req) => {
    teams.denyRecruit(p(req).id, body(z.object({ note: z.string().trim().max(500).optional() }), req).note || null, actor(req));
    return { denied: true };
  });
  api.post('/api/teams/:id/plan-request', async (req) => {
    const b = body(z.object({ note: z.string().trim().max(500).optional() }), req);
    return { team: teamOut(req, teams.requestPlan(p(req).id, b.note || null, routed(req, p(req).id))) };
  });
  api.get('/api/teams/:id/status', async (req) => {
    const t = visibleTeam(req, p(req).id, 'tasks', 'blueprint');
    // The newest open request, asked of this team or of its whole project.
    const rq = teams.statusRequest(t.id);
    return { reports: teams.statusReports(t.id, 20), requested_at: rq?.requested_at ?? null, request_note: rq?.note ?? null, request_scope: rq?.scope ?? null };
  });
  api.post('/api/teams/:id/status-request', async (req) => {
    const b = body(z.object({ note: z.string().trim().max(500).optional() }), req);
    return { team: teamOut(req, teams.requestStatus(p(req).id, b.note || null, routed(req, p(req).id))) };
  });
  // Many at once: the board's "Hide all" in the Done column, and its undo. Same rules as one task; all or nothing.
  api.post('/api/teams/:id/tasks/dismiss', async (req) => {
    const b = body(z.object({ task_ids: z.array(z.string().max(100)).min(1).max(500), dismissed: z.boolean() }), req);
    return { tasks: teams.dismissMany(p(req).id, b.task_ids, b.dismissed, routed(req, p(req).id)).map((t) => teams.taskView(t)) };
  });
  api.post('/api/teams/:id/tasks/:taskId/dismiss', async (req) => {
    const b = body(z.object({ dismissed: z.boolean() }), req);
    return { task: teams.taskView(teams.dismiss(p(req).id, p(req).taskId!, b.dismissed, routed(req, p(req).id))) };
  });
}
