/** MCP tools for teams, tasks and the work loop (design/08 "Tasks", "Teams and the work loop"). */
import { z } from 'zod';
import { KeyError } from '../keys/keys.js';
import type { Teams, Who, TaskRow, TeamPlan } from '../teams/teams.js';
import type { Decisions, DecisionView } from '../teams/decisions.js';

type Out = { text: string; data: Record<string, unknown>; authorizedSecrets?: string[] };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;
type ToolErrorCtor = new (code: string, message: string, extra?: Record<string, unknown>) => Error;

/** messageBudget: charges one message to the sender's hourly limit and throws when it is spent (team_report and team_complete post into the team room). */
export function registerTeamTools(reg: Reg, teams: Teams, ToolError: ToolErrorCtor, opts: { messageBudget?: (credId: string) => void; decisions?: Decisions } = {}): void {
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
      playbook: teams.playbook(t.id, t.my_role), mode: t.delivery_mode, close_on_approve: !!t.close_on_approve, coordinator_reviews: !!t.coordinator_reviews,
      lease_minutes: t.lease_minutes, max_review_rounds: t.max_review_rounds,
      members: teams.members(t.id).map((m) => ({ agent_id: m.agent_id, role: m.role, me: m.agent_id === w.agentId })),
    }));
    return { text: list.length ? list.map((t) => `${t.team_id} "${t.name}" [${t.status}, ${t.mode === 'on_demand' ? 'on demand: act when woken, never poll' : 'polling: loop on work_next'}] you are ${t.my_role}\nGoal: ${t.goal}\nPlaybook (L0): ${t.playbook}\nMembers: ${t.members.map((m) => `${m.agent_id}(${m.role})`).join(', ')}`).join('\n\n') : 'You are not in a team.', data: { teams: list } };
  });

  reg('team_recruit', 'Coordinator: add an agent to your team, within the limits the administrator set (recruiting must be on). In automatic mode the agent is created now and you get its one-time handoff to start it (for example as a subagent); in ask mode the administrator approves it and starts it.', {
    team_id: teamId, label: z.string().min(1).max(80).describe('Name of the new agent'), role: z.string().max(30).describe('worker, reviewer or stakeholder (as allowed by the team)'),
    purpose: z.string().min(1).max(500).describe('What the agent is for; it becomes its role description'),
  }, true, async (ctx, a) => run(() => {
    const r = teams.recruit(who(ctx), a);
    if (r.status === 'pending') return { text: `Request ${r.request_id} is waiting for the administrator. You get a recruit_decision notice when it is decided.`, data: { status: 'pending', request_id: r.request_id } };
    return { text: `Recruited ${r.agent_id} as ${a.role}. Give this handoff to the agent once; it is not shown again:
${r.handoff}`, data: { status: 'created', agent_id: r.agent_id, handoff: r.handoff }, authorizedSecrets: [r.secret!] };
  }));

  const planText = (p: TeamPlan) => [`Plan v${p.version}${p.updated_at ? '' : ' (empty)'}`,
    ...p.requirements.map((x) => `${x.key} [${x.status}${x.priority ? ', ' + x.priority : ''}] ${x.title}${x.links.length ? ' -> ' + x.links.join(',') : ''}${x.tasks.total ? ` (tasks ${x.tasks.done}/${x.tasks.total})` : ''}`),
    ...p.milestones.map((x) => `${x.key} [${x.status}]${x.due_at ? ' due ' + new Date(x.due_at).toISOString().slice(0, 10) : ''} ${x.title}`)].join('\n');
  reg('team_plan', 'The team plan: requirements the goal implies (with status, priority and linked milestones) and milestones. Any member may read it.', { team_id: teamId }, true, async (ctx, a) => {
    const p = await run(() => teams.readPlan(who(ctx), a.team_id));
    return { text: planText(p), data: { plan: p } };
  });
  reg('team_plan_set', 'Coordinator: replace the whole team plan. Requirements first (most important): key (R1…), title, priority must/should/could, status open/met/unclear/dropped, criteria, evidence, milestones (keys it is delivered by). Milestones: key (M1…), title, due_at (ms), status planned/in_progress/reached/missed/dropped. Pass version from team_plan to avoid overwriting a newer plan.', {
    team_id: teamId, version: z.number().int().min(0).optional(), requirements: z.array(z.object({ key: z.string().min(1).max(16), title: z.string().min(1).max(200), detail: z.string().max(2000).optional(), priority: z.enum(['must', 'should', 'could']).optional(), status: z.string().max(20).optional(), criteria: z.string().max(1000).optional(), evidence: z.string().max(500).optional(), due_at: z.number().int().optional(), milestones: z.array(z.string().max(16)).max(20).optional() })).max(100), milestones: z.array(z.object({ key: z.string().min(1).max(16), title: z.string().min(1).max(200), detail: z.string().max(2000).optional(), priority: z.enum(['must', 'should', 'could']).optional(), status: z.string().max(20).optional(), criteria: z.string().max(1000).optional(), evidence: z.string().max(500).optional(), due_at: z.number().int().optional(), milestones: z.array(z.string().max(16)).max(20).optional() })).max(100).optional(),
  }, true, async (ctx, a) => { const p = await run(() => teams.setPlan(who(ctx), a)); return { text: planText(p), data: { plan: p } }; });
  reg('team_plan_update', 'Coordinator: change single plan items by key (only the fields you give change; new keys are added), or remove keys. Use it for status changes.', {
    team_id: teamId, requirements: z.array(z.object({ key: z.string().min(1).max(16), title: z.string().min(1).max(200).optional(), detail: z.string().max(2000).optional(), priority: z.enum(['must', 'should', 'could']).optional(), status: z.string().max(20).optional(), criteria: z.string().max(1000).optional(), evidence: z.string().max(500).optional(), due_at: z.number().int().optional(), milestones: z.array(z.string().max(16)).max(20).optional() })).max(50).optional(), milestones: z.array(z.object({ key: z.string().min(1).max(16), title: z.string().min(1).max(200).optional(), detail: z.string().max(2000).optional(), priority: z.enum(['must', 'should', 'could']).optional(), status: z.string().max(20).optional(), criteria: z.string().max(1000).optional(), evidence: z.string().max(500).optional(), due_at: z.number().int().optional(), milestones: z.array(z.string().max(16)).max(20).optional() })).max(50).optional(), remove: z.array(z.string().max(16)).max(50).optional(),
  }, true, async (ctx, a) => { const p = await run(() => teams.updatePlan(who(ctx), a as never)); return { text: planText(p), data: { plan: p } }; });

  reg('team_report', 'Coordinator: post a report to the team room and tell the stakeholders.', { team_id: teamId, summary: z.string().min(1).max(8000) }, true, async (ctx, a) => {
    opts.messageBudget?.(ctx.session.cred.id);
    await run(() => teams.report(who(ctx), a));
    return { text: 'Report posted.', data: { ok: true } };
  });
  reg('team_complete', 'Coordinator: finish the team. Team permissions are removed and members are told to stop.', { team_id: teamId, summary: z.string().min(1).max(8000) }, true, async (ctx, a) => {
    opts.messageBudget?.(ctx.session.cred.id);
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
    refs: z.array(z.string().max(16)).max(20).optional().describe('Requirement or milestone keys from the team plan this task serves'),
  }, true, async (ctx, a) => one('Created', await run(() => teams.create_task(who(ctx), a))));
  reg('task_update', 'Coordinator: edit title and description only. Fails with conflict if version is stale.', {
    task_id: taskId, version: z.number().int().min(1), title: z.string().min(1).max(200).optional(), description: z.string().max(20000).optional(),
    refs: z.array(z.string().max(16)).max(20).optional().describe('Requirement or milestone keys from the team plan'),
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

  // ───── decisions: ask the operator (docs/decisions.md) ─────
  const dec = opts.decisions;
  if (dec) {
    const decLine = (d: DecisionView) => `${d.id} [${d.status}] ${d.question}${d.status === 'answered' ? ` -> ${[d.answer_label, d.answer_text].filter(Boolean).join(' — ')}` : ''}${d.status === 'needs_info' && d.info_note ? ` (operator asks: ${d.info_note})` : ''}`;
    const decData = (d: DecisionView) => ({ trust: 'L0', decision_id: d.id, team_id: d.team_id, task_id: d.task_id, status: d.status, question: d.question, options: d.options, recommended: d.recommended,
      refs: d.refs, asked_by: d.agent_id, asked_at: d.created_at, info_note: d.info_note, answer_option: d.answer_option, answer: d.answer_label, answer_text: d.answer_text, answered_at: d.answered_at });
    const option = z.object({ key: z.string().min(1).max(8), label: z.string().min(1).max(160), effect: z.string().max(400).optional().describe('What choosing it means: cost, risk, what happens next') });
    reg('team_ask', 'Ask the operator for a decision you cannot make yourself. Give the question, short context, two or more options with their effect, and your recommendation. With task_id the task waits (blocked) until the answer, which comes back as a notice. Ask once per decision; never only write a question into a block reason or a note.', {
      team_id: teamId, question: z.string().min(1).max(300), context: z.string().max(4000).optional().describe('Why it matters and what you know; plain text, links to vault notes or shares welcome'),
      options: z.array(option).max(6).optional().describe('0 for a free answer, else 2 to 6'), recommended: z.string().max(8).optional().describe('The key of the option you recommend'),
      task_id: taskId.optional().describe('A task of yours (or any, for a coordinator) that waits for this answer'), refs: z.array(z.string().max(16)).max(10).optional().describe('Team plan keys (R1, M2)'),
      needed_by: z.number().int().optional().describe('When you need the answer (ms)'),
    }, true, async (ctx, a) => {
      const d = await run(() => dec.ask(who(ctx), a));
      return { text: `Asked (${d.id}). The operator answers in the console; the answer comes back as a notice.${d.task_id ? ` Task ${d.task_id} waits until then.` : ''}`, data: decData(d) };
    });
    reg('team_ask_update', 'Your own open question: add information (also the reply when the operator needs more) or withdraw it. Withdrawing gives a blocked task back to its assignee.', {
      decision_id: z.string().max(100), context: z.string().max(4000).optional(), withdraw: z.boolean().optional(),
    }, true, async (ctx, a) => { const d = await run(() => dec.update(who(ctx), a)); return { text: decLine(d), data: decData(d) }; });
    reg('team_decisions', 'The team\'s decision log: questions asked to the operator and the answers (L0: the operator\'s decisions). status open, closed or all (default).', {
      team_id: teamId, status: z.enum(['open', 'closed', 'all']).optional(), limit: z.number().int().min(1).max(100).optional(),
    }, true, async (ctx, a) => {
      const L = await run(() => dec.forAgent(who(ctx), a.team_id, a.status ?? 'all', a.limit ?? 30));
      return { text: L.length ? L.map(decLine).join('\n') : 'No decisions yet.', data: { decisions: L.map(decData) } };
    });
  }
}
