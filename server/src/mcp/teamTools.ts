/** MCP tools for teams, tasks and the work loop (design/08 "Tasks", "Teams and the work loop"). */
import { z } from 'zod';
import { KeyError } from '../keys/keys.js';
import type { Teams, Who, TaskRow } from '../teams/teams.js';

type Out = { text: string; data: Record<string, unknown> };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;
type ToolErrorCtor = new (code: string, message: string, extra?: Record<string, unknown>) => Error;

export function registerTeamTools(reg: Reg, teams: Teams, ToolError: ToolErrorCtor): void {
  const who = (ctx: any): Who => { const s = ctx.session; return { agentId: s.agent.id, credId: s.cred.id, tokenHash: s.tokenHash, rules: s.rules, cap: s.cap }; };
  /** Run a team operation, turning hub errors into tool errors. */
  const run = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { if (e instanceof KeyError) throw new ToolError(e.code, e.message); throw e; }
  };
  const taskLine = (t: { id: string; status: string; title: string; version: number; assignee?: string | null; reviewer?: string | null; assignee_agent_id?: string | null; reviewer_agent_id?: string | null }) => {
    const as = t.assignee ?? t.assignee_agent_id, rv = t.reviewer ?? t.reviewer_agent_id;
    return `${t.id} [${t.status}] "${t.title}" v${t.version}${as ? ` assignee=${as}` : ''}${rv ? ` reviewer=${rv}` : ''}`;
  };
  const one = (verb: string, t: TaskRow): Out => ({ text: `${verb}: ${taskLine(t)}`, data: { task: teams.taskView(t) } });
  const teamId = z.string().max(100);
  const taskId = z.string().max(100);

  reg('team_info', 'My teams: goal, my team role and playbook (L0, follow it), members with roles, status (draft / running / paused / done / stopped).', { team_id: teamId.optional() }, true, async (ctx, a) => {
    const w = who(ctx);
    const mine = teams.teamsOf(w.agentId).filter((t) => !a.team_id || t.id === a.team_id);
    if (a.team_id && mine.length === 0) throw new ToolError('denied', 'Not allowed, or does not exist.');
    const list = mine.map((t) => ({
      trust: 'L0', team_id: t.id, name: t.name, goal: t.goal, status: t.status, paused_reason: t.paused_reason, room_id: t.room_id, my_role: t.my_role,
      playbook: teams.playbook(t.id, t.my_role), lease_minutes: t.lease_minutes, max_review_rounds: t.max_review_rounds,
      members: teams.members(t.id).map((m) => ({ agent_id: m.agent_id, role: m.role, me: m.agent_id === w.agentId })),
    }));
    return { text: list.length ? list.map((t) => `${t.team_id} "${t.name}" [${t.status}] you are ${t.my_role}\nGoal: ${t.goal}\nPlaybook (L0): ${t.playbook}\nMembers: ${t.members.map((m) => `${m.agent_id}(${m.role})`).join(', ')}`).join('\n\n') : 'You are not in a team.', data: { teams: list } };
  });

  reg('team_report', 'Coordinator: post a report to the team room and tell the stakeholders.', { team_id: teamId, summary: z.string().min(1).max(8000) }, true, async (ctx, a) => {
    await run(() => teams.report(who(ctx), a));
    return { text: 'Report posted.', data: { ok: true } };
  });
  reg('team_complete', 'Coordinator: finish the team. Team permissions are removed and members are told to stop.', { team_id: teamId, summary: z.string().min(1).max(8000) }, true, async (ctx, a) => {
    const t = await run(() => teams.finishTeam(who(ctx), a));
    return { text: `Team ${t.id} is done.`, data: { team_id: t.id, status: t.status } };
  });

  reg('work_next', 'Get the next pending item for your team work, by priority: notice, review_requested / changes_requested, task_assigned, message, channel_offer. Returns idle, paused or team_done when there is none. The same item comes back until you confirm it with work_ack. wait_seconds (0-45) waits for new work. Items carry a trust level (L0 hub, L1 your tasks, L2 data) and their source.', {
    wait_seconds: z.number().min(0).max(45).optional(),
  }, true, async (ctx, a) => {
    const r = await run(() => teams.workNext(who(ctx), Number(a.wait_seconds ?? 0)));
    if (r.status !== 'item') return { text: `${r.status}${r.note ? `: ${r.note}` : ''}`, data: { ...r } };
    const it = r.item as any;
    const body = it.message ? `${it.message.from} (${it.message.kind}, L2 data): ${it.message.content}`
      : it.task ? `${taskLine(it.task)}${it.task.description ? `\n${it.task.description}` : ''}${it.review?.summary ? `\nSubmitted: ${it.review.summary}` : ''}${it.review?.comments ? `\nReview comments: ${it.review.comments}` : ''}` : it.content;
    return { text: `item ${it.item_id} (${it.kind}, ${it.trust}):\n${body}\nConfirm with work_ack {item_id: "${it.item_id}"} when handled.`, data: { status: 'item', item: it } };
  });
  reg('work_ack', 'Confirm a work item as handled. Until then the same item is returned again.', { item_id: z.string().max(100) }, true, async (ctx, a) => {
    const r = await run(() => teams.workAck(who(ctx), a.item_id));
    return { text: r.already ? 'Already confirmed.' : 'Confirmed.', data: r };
  });

  reg('task_create', 'Coordinator: create an open task in a team. claimable lets any worker take it; reviewer names the reviewer (never the assignee).', {
    team_id: teamId, title: z.string().min(1).max(200), description: z.string().max(20000).optional(), claimable: z.boolean().optional(), reviewer: z.string().max(100).optional(),
  }, true, async (ctx, a) => one('Created', await run(() => teams.create_task(who(ctx), a))));
  reg('task_update', 'Coordinator: edit title and description only. Fails with conflict if version is stale.', {
    task_id: taskId, version: z.number().int().min(1), title: z.string().min(1).max(200).optional(), description: z.string().max(20000).optional(),
  }, true, async (ctx, a) => one('Updated', await run(() => teams.update_task(who(ctx), a))));
  reg('task_list', 'Tasks of my team(s), optionally by status or assignee.', {
    team_id: teamId.optional(), room_id: z.string().max(100).optional(), status: z.string().max(30).optional(), assignee: z.string().max(100).optional(),
  }, true, async (ctx, a) => {
    const list = await run(() => teams.list_tasks(who(ctx), a));
    return { text: list.length ? list.map(taskLine).join('\n') : 'No tasks.', data: { tasks: list.map((t) => teams.taskView(t)) } };
  });
  reg('task_assign', 'Coordinator: open -> assigned to a worker; optionally name the reviewer (must not be the assignee).', {
    task_id: taskId, agent_id: z.string().max(100), reviewer: z.string().max(100).optional(),
  }, true, async (ctx, a) => one('Assigned', await run(() => teams.assign(who(ctx), a))));
  reg('task_claim', 'Worker: take a claimable open task. First caller wins; others get conflict. Pass the version you saw; start:true also starts it in this call. Example: {task_id:"task_...",version:1,start:true}.', {
    task_id: taskId, version: z.number().int().min(1), start: z.boolean().optional(),
  }, true, async (ctx, a) => one('Claimed', await run(() => teams.claim(who(ctx), a))));
  reg('task_start', 'Assignee: assigned or changes_requested -> in_progress.', { task_id: taskId }, true, async (ctx, a) => one('Started', await run(() => teams.start_task(who(ctx), a.task_id))));
  reg('task_progress', 'Assignee heartbeat: renews the lease; until (epoch ms, at most 24 h ahead) says you are busy until then.', {
    task_id: taskId, note: z.string().max(500).optional(), until: z.number().int().optional(),
  }, true, async (ctx, a) => one('Progress noted', await run(() => teams.progress(who(ctx), a))));
  reg('task_submit', 'Assignee: in_progress -> in_review with a summary (and optionally a share version). The reviewer is notified.', {
    task_id: taskId, summary: z.string().min(1).max(20000), share_id: z.string().max(100).optional(), share_version: z.number().int().min(1).optional(),
  }, true, async (ctx, a) => one('Submitted', await run(() => teams.submit(who(ctx), a))));
  reg('task_review', 'Assigned reviewer (never the submitter): approve, or request_changes with comments.', {
    task_id: taskId, decision: z.enum(['approve', 'request_changes']), comments: z.string().min(1).max(20000),
  }, true, async (ctx, a) => one('Reviewed', await run(() => teams.review(who(ctx), a))));
  reg('task_complete', 'Coordinator: approved -> done. If the team has a "done" checkpoint the administrator must approve first.', {
    task_id: taskId, summary: z.string().max(20000).optional(),
  }, true, async (ctx, a) => {
    const r = await run(() => teams.complete(who(ctx), a));
    return { text: r.awaiting_approval ? `Waiting for the administrator's approval: ${taskLine(r.task)}` : `Done: ${taskLine(r.task)}`, data: { task: teams.taskView(r.task), awaiting_approval: r.awaiting_approval } };
  });
  reg('task_block', 'Coordinator: any open task -> blocked with a reason. The administrator is alerted.', { task_id: taskId, reason: z.string().min(1).max(2000) },
    true, async (ctx, a) => one('Blocked', await run(() => teams.stopTask(who(ctx), a, 'blocked'))));
  reg('task_cancel', 'Coordinator: any open task -> cancelled with a reason.', { task_id: taskId, reason: z.string().min(1).max(2000) },
    true, async (ctx, a) => one('Cancelled', await run(() => teams.stopTask(who(ctx), a, 'cancelled'))));
}
