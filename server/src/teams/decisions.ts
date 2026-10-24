/**
 * Decisions (docs/decisions.md): a team member asks the operator a question, with options and a recommendation,
 * optionally blocking a task until the answer. The operator answers in the console; the answer comes back to the
 * agent as a notice (L0, it is the operator's word), the task returns to its assignee, and the answered question
 * stays in the team's decision log. Optionally the answer is also appended to a vault note.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Teams, Who } from './teams.js';
import type { VaultStore } from '../vault/store.js';
import type { Vault } from '../vault/vault.js';
import { VaultError } from '../vault/vault.js';
import { randomToken, sha256Hex } from '../util/crypto.js';

export type DecisionStatus = 'open' | 'needs_info' | 'answered' | 'declined' | 'withdrawn';
export interface DecisionOption { key: string; label: string; effect?: string | null }
export interface DecisionRow {
  id: string; team_id: string; task_id: string | null; blocks_task: number; agent_id: string; credential_id: string | null;
  question: string; context: string | null; options: string; recommended: string | null; refs: string; needed_by: number | null;
  status: DecisionStatus; info_note: string | null; answer_option: string | null; answer_text: string | null;
  answered_by: string | null; answered_at: number | null; log_revision: string | null; created_at: number; updated_at: number;
}
export interface DecisionView extends Omit<DecisionRow, 'options' | 'refs' | 'blocks_task'> {
  options: DecisionOption[]; refs: string[]; blocks_task: boolean; answer_label: string | null;
  agent_label: string | null; team_name: string | null; task_title: string | null; answered_by_name: string | null;
}

/** An agent may have this many questions waiting for the operator at once: questions stay deliberate. */
export const MAX_OPEN_PER_AGENT = 5;
const OPEN: DecisionStatus[] = ['open', 'needs_info'];
const err = (code: string, msg: string) => new KeyError(code, msg);

export class Decisions {
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly teams: Teams, private readonly audit: Audit,
    private readonly store: VaultStore, private readonly vault: Vault) {}

  private row(id: string): DecisionRow | null { return (this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id) as unknown as DecisionRow) ?? null; }
  private must(id: string): DecisionRow { const d = this.row(id); if (!d) throw err('not_found', 'decision not found'); return d; }

  view(d: DecisionRow): DecisionView {
    const options = JSON.parse(d.options) as DecisionOption[];
    const admin = d.answered_by ? (this.db.prepare('SELECT username FROM admin_users WHERE id=?').get(d.answered_by) as { username: string } | undefined)?.username ?? null : null;
    return {
      ...d, options, refs: JSON.parse(d.refs) as string[], blocks_task: !!d.blocks_task,
      answer_label: d.answer_option ? options.find((o) => o.key === d.answer_option)?.label ?? d.answer_option : null,
      agent_label: this.keys.agent(d.agent_id)?.label ?? null, team_name: this.teams.team(d.team_id)?.name ?? null,
      task_title: d.task_id ? this.teams.task(d.task_id)?.title ?? null : null, answered_by_name: admin,
    };
  }

  /** The console's list: open questions first (oldest first), then the log (newest first). */
  list(f: { team?: string; status?: 'open' | 'closed' | 'all'; limit?: number } = {}): DecisionView[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (f.team) { where.push('team_id=?'); args.push(f.team); }
    if (f.status === 'open') where.push("status IN ('open','needs_info')");
    if (f.status === 'closed') where.push("status IN ('answered','declined','withdrawn')");
    const rows = this.db.prepare(`SELECT * FROM decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN status IN ('open','needs_info') THEN 0 ELSE 1 END, CASE WHEN status IN ('open','needs_info') THEN created_at ELSE -COALESCE(answered_at, updated_at) END LIMIT ?`)
      .all(...args, Math.min(500, Math.max(1, f.limit ?? 200))) as unknown as DecisionRow[];
    return rows.map((d) => this.view(d));
  }
  get(id: string): DecisionView { return this.view(this.must(id)); }
  /** Open questions per team, for the team list and the Work badge. */
  openCounts(): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT team_id, COUNT(*) n FROM decisions WHERE status IN ('open','needs_info') GROUP BY team_id").all() as { team_id: string; n: number }[]).map((r) => [r.team_id, r.n]));
  }
  /** The open question that blocks each task, for the board cards. */
  openByTask(teamId: string): Record<string, string> {
    return Object.fromEntries((this.db.prepare("SELECT task_id, id FROM decisions WHERE team_id=? AND task_id IS NOT NULL AND blocks_task=1 AND status IN ('open','needs_info')").all(teamId) as { task_id: string; id: string }[]).map((r) => [r.task_id, r.id]));
  }

  // ───── the agent side ─────
  ask(w: Who, a: { team_id: string; question: string; context?: string; options?: DecisionOption[]; recommended?: string; task_id?: string; refs?: string[]; needed_by?: number }): DecisionView {
    const team = this.teams.checkAsk(w, a.team_id);
    const question = a.question.trim();
    if (!question) throw err('invalid_argument', 'Ask a question.');
    const options = (a.options ?? []).map((o) => ({ key: o.key.trim(), label: o.label.trim(), effect: o.effect?.trim() || null }));
    const keys = options.map((o) => o.key);
    if (options.length === 1) throw err('invalid_argument', 'Give two or more options, or none for a free answer.');
    if (new Set(keys).size !== keys.length || options.some((o) => !o.key || !o.label)) throw err('invalid_argument', 'Each option needs a unique key and a label.');
    if (a.recommended !== undefined && !keys.includes(a.recommended)) throw err('invalid_argument', 'recommended must be one of the option keys.');
    if (a.needed_by !== undefined && a.needed_by < Date.now()) throw err('invalid_argument', 'needed_by is in the past.');
    const open = (this.db.prepare("SELECT COUNT(*) n FROM decisions WHERE agent_id=? AND status IN ('open','needs_info')").get(w.agentId) as { n: number }).n;
    if (open >= MAX_OPEN_PER_AGENT) throw err('rate_limited', `You already have ${open} questions waiting for the operator. Wait for answers, or withdraw one with team_ask_update.`);
    if (a.task_id && this.db.prepare("SELECT 1 FROM decisions WHERE task_id=? AND blocks_task=1 AND status IN ('open','needs_info')").get(a.task_id)) {
      throw err('invalid_state', 'This task already waits for an answer. Add to that question with team_ask_update instead.');
    }
    const refs = this.teams.checkRefsPublic(team.id, a.refs);
    const id = `dec_${randomToken(10)}`, now = Date.now();
    tx(this.db, () => {
      if (a.task_id) this.teams.blockForDecision(w, team.id, a.task_id, question);
      this.db.prepare(`INSERT INTO decisions(id,team_id,task_id,blocks_task,agent_id,credential_id,question,context,options,recommended,refs,needed_by,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`).run(id, team.id, a.task_id ?? null, a.task_id ? 1 : 0, w.agentId, w.credId, question, a.context?.trim() || null,
        JSON.stringify(options), a.recommended ?? null, JSON.stringify(refs), a.needed_by ?? null, now, now);
    });
    const who = this.keys.agent(w.agentId)?.label ?? w.agentId;
    this.teams.notifyCoordinators(team.id, 'decision_asked', `${who} asked the operator (${id}): ${question.slice(0, 300)}${a.task_id ? ` It blocks task ${a.task_id} until answered.` : ''}`, w.agentId);
    this.audit.event({ kind: 'agent', id: w.agentId }, 'decision.ask', { kind: 'decision', id }, { team: team.name, task: a.task_id ?? null });
    return this.get(id);
  }
  /** The asker adds information (also the reply to "needs info") or withdraws the question. */
  update(w: Who, a: { decision_id: string; context?: string; withdraw?: boolean }): DecisionView {
    const d = this.must(a.decision_id);
    if (d.agent_id !== w.agentId) throw err('denied', 'Not allowed, or does not exist.');
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is ${d.status}.`);
    const now = Date.now();
    if (a.withdraw) {
      tx(this.db, () => {
        this.db.prepare("UPDATE decisions SET status='withdrawn', blocks_task=0, updated_at=? WHERE id=?").run(now, d.id);
        if (d.task_id && d.blocks_task) this.teams.unblockAfterDecision(d.task_id, 'question withdrawn', { kind: 'agent', id: w.agentId });
      });
      return this.get(d.id);
    }
    const add = a.context?.trim();
    if (!add) throw err('invalid_argument', 'Give context to add, or withdraw: true.');
    const context = [d.context, `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}: ${add}`].filter(Boolean).join('\n\n').slice(0, 20_000);
    this.db.prepare("UPDATE decisions SET context=?, status='open', info_note=NULL, updated_at=? WHERE id=?").run(context, now, d.id);
    return this.get(d.id);
  }
  /** Decisions of the caller's team, for agents: the log, or only open ones. */
  forAgent(w: Who, teamId: string, status: 'open' | 'closed' | 'all' = 'all', limit = 50): DecisionView[] {
    if (!this.teams.roleOf(teamId, w.agentId)) throw err('denied', 'Not allowed, or does not exist.');
    return this.list({ team: teamId, status, limit });
  }

  // ───── the operator side ─────
  async answer(id: string, a: { option?: string | null; text?: string | null }, actor: Actor & { kind: 'admin' }): Promise<DecisionView> {
    const d = this.must(id);
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}.`);
    const options = JSON.parse(d.options) as DecisionOption[], text = a.text?.trim() || null, option = a.option || null;
    if (option && !options.some((o) => o.key === option)) throw err('invalid_argument', 'Unknown option.');
    if (!option && !text) throw err('invalid_argument', 'Choose an option or write an answer.');
    const now = Date.now(), label = option ? options.find((o) => o.key === option)!.label : null;
    const answerLine = [label, text].filter(Boolean).join(' — ');
    tx(this.db, () => {
      this.db.prepare("UPDATE decisions SET status='answered', answer_option=?, answer_text=?, answered_by=?, answered_at=?, blocks_task=0, updated_at=? WHERE id=?").run(option, text, actor.id, now, now, d.id);
      if (d.task_id && d.blocks_task) this.teams.unblockAfterDecision(d.task_id, `answered: ${answerLine}`, actor);
    });
    const task = d.task_id ? this.teams.task(d.task_id) : null;
    const mine = task?.assignee_agent_id === d.agent_id, holder = task?.assignee_agent_id ? this.keys.agent(task.assignee_agent_id)?.label ?? task.assignee_agent_id : null;
    const back = task && d.blocks_task ? ` Task "${task.title}" (${task.id}) is ${task.status === 'assigned' ? (mine ? 'assigned to you again: continue with task_start' : `assigned to ${holder} again`) : `now ${task.status}`}.` : '';
    this.keys.notify(d.agent_id, 'decision', `The operator answered your question ${d.id} ("${d.question.slice(0, 200)}"): ${answerLine}.${back}`);
    this.teams.notifyCoordinators(d.team_id, 'decision', `The operator answered ${d.id} ("${d.question.slice(0, 200)}"): ${answerLine}.`, d.agent_id);
    // The worker of the blocked task hears it too when someone else (usually the coordinator) asked for it.
    if (task && task.assignee_agent_id && task.assignee_agent_id !== d.agent_id && this.teams.roleOf(d.team_id, task.assignee_agent_id) !== 'coordinator') {
      this.keys.notify(task.assignee_agent_id, 'decision', `The operator answered ${d.id} about your task "${task.title}": ${answerLine}.${d.blocks_task ? ' The task is assigned to you again: continue with task_start.' : ''}`);
    }
    this.audit.event(actor, 'decision.answer', { kind: 'decision', id: d.id }, { option, text: text?.slice(0, 500) ?? null });
    await this.mirror(d.id);
    return this.get(d.id);
  }
  /** Ask the agent for more information; the question stays open and its task stays blocked. */
  needInfo(id: string, note: string, actor: Actor): DecisionView {
    const d = this.must(id);
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}.`);
    if (!note.trim()) throw err('invalid_argument', 'Say what you need to know.');
    this.db.prepare("UPDATE decisions SET status='needs_info', info_note=?, updated_at=? WHERE id=?").run(note.trim(), Date.now(), d.id);
    this.keys.notify(d.agent_id, 'decision_needs_info', `The operator needs more information on your question ${d.id} ("${d.question.slice(0, 200)}"): ${note.trim()} Reply with team_ask_update {decision_id: "${d.id}", context}.`);
    this.audit.event(actor, 'decision.needs_info', { kind: 'decision', id: d.id }, { note: note.slice(0, 500) });
    return this.get(d.id);
  }
  /** The operator will not decide this: the question closes and its task goes back to the assignee. */
  async decline(id: string, note: string | null, actor: Actor): Promise<DecisionView> {
    const d = this.must(id);
    if (!OPEN.includes(d.status)) throw err('invalid_state', `The question is already ${d.status}.`);
    const now = Date.now();
    tx(this.db, () => {
      this.db.prepare("UPDATE decisions SET status='declined', answer_text=?, answered_by=?, answered_at=?, blocks_task=0, updated_at=? WHERE id=?").run(note?.trim() || null, actor.id, now, now, d.id);
      if (d.task_id && d.blocks_task) this.teams.unblockAfterDecision(d.task_id, 'question declined', actor);
    });
    this.keys.notify(d.agent_id, 'decision', `The operator declined to decide your question ${d.id} ("${d.question.slice(0, 200)}")${note?.trim() ? `: ${note.trim()}` : '.'} Decide within your role, or ask the coordinator.`);
    this.audit.event(actor, 'decision.decline', { kind: 'decision', id: d.id }, { note: note?.slice(0, 500) ?? null });
    await this.mirror(d.id);
    return this.get(d.id);
  }

  /**
   * Append the settled question to the team's decision note in the vault, when the team names one. Best effort: the
   * hub's log is the record, so a failed vault write (a conflict, lockdown) never undoes the answer.
   */
  private async mirror(id: string): Promise<void> {
    const d = this.get(id), team = this.teams.team(d.team_id);
    if (!team?.decision_log_path) return;
    try {
      const { rel } = this.vault.normalise(team.decision_log_path);
      for (let attempt = 0; attempt < 3; attempt++) {
        let cur: Buffer | null = null;
        try { cur = await this.vault.readBytes(rel); } catch (e) { if (!(e instanceof VaultError && e.code === 'not_found')) throw e; }
        const base = cur ? `sha256:${sha256Hex(cur)}` : 'absent';
        const entry = decisionMarkdown(d);
        const next = Buffer.from(`${cur ? cur.toString('utf8').replace(/\s*$/, '\n\n') : '# Decisions\n\n'}${entry}`, 'utf8');
        try {
          const r = await this.store.write(rel, next, base, cur ? 'update' : 'create', { adminId: d.answered_by });
          this.db.prepare('UPDATE decisions SET log_revision=? WHERE id=?').run(r.revision, d.id);
          return;
        } catch (e) { if (!(e instanceof VaultError && e.code === 'conflict')) throw e; }
      }
    } catch (e) { console.error('decision log mirror failed', d.id, e); }
  }
}

/** One settled decision as a Markdown section, for the vault note. */
export function decisionMarkdown(d: DecisionView): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [`## ${day(d.answered_at ?? d.updated_at)} · ${d.question}`, '',
    `- Asked by ${d.agent_label ?? d.agent_id}${d.task_title ? ` for task "${d.task_title}"` : ''}, ${day(d.created_at)}${d.refs.length ? ` (${d.refs.join(', ')})` : ''}`];
  if (d.options.length) lines.push(`- Options: ${d.options.map((o) => `${o.key}) ${o.label}${o.key === d.recommended ? ' (recommended)' : ''}`).join(' · ')}`);
  if (d.status === 'answered') lines.push(`- **Decision:** ${[d.answer_label, d.answer_text].filter(Boolean).join(' — ')}`);
  else lines.push(`- **Declined**${d.answer_text ? `: ${d.answer_text}` : ''}`);
  lines.push(`- ${d.status === 'answered' ? 'Answered' : 'Declined'} by ${d.answered_by_name ?? 'the operator'} · ${d.id}`, '');
  return lines.join('\n');
}
