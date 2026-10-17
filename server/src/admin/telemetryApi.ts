/**
 * Telemetry (Auditing → Telemetry): what using the hub costs, built only from what the hub already records.
 * Agents make no extra calls for it. Tokens inside an agent's own context are not visible to the hub; the hub's
 * share is estimated from the size of its answers (about 4 bytes per token). A baseline measured without the hub
 * can be stored once by the operator for a before/after comparison.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';

export interface TelemetryDeps { db: Db; audit: Audit }

const DAY = 86_400_000;
/** Coordination overhead: team, task, work-queue, notice, messaging and session tools. Everything else is the work itself. */
const BOOKKEEPING = /^(team_|task_|work_|session_|message_|room_|agent_list|access_)/;
const tokens = (bytes: number) => Math.round(bytes / 4);

type Inv = { agent_id: string | null; tool: string; result: string; result_bytes: number | null; created_at: number };

export function registerTelemetryApi(api: FastifyInstance, d: TelemetryDeps, actor: (req: FastifyRequest) => Actor): void {
  const { db } = d;

  api.get('/api/telemetry', async (req) => {
    const q = z.object({ team: z.string().max(100).optional(), days: z.coerce.number().int().min(1).max(90).optional() }).parse(req.query ?? {});
    const days = q.days ?? 7, since = Date.now() - days * DAY;
    const teamIds = q.team ? [q.team] : (db.prepare('SELECT id FROM teams').all() as { id: string }[]).map((t) => t.id);
    const memberIds = new Set((db.prepare(`SELECT DISTINCT agent_id FROM team_members WHERE team_id IN (${teamIds.map(() => '?').join(',') || "''"})`).all(...teamIds) as { agent_id: string }[]).map((r) => r.agent_id));
    const inv = (db.prepare('SELECT agent_id, tool, result, result_bytes, created_at FROM tool_invocations WHERE created_at>=? AND agent_id IS NOT NULL ORDER BY created_at').all(since) as unknown as Inv[])
      .filter((i) => !q.team || memberIds.has(i.agent_id!));
    const label = (id: string | null) => (id ? (db.prepare('SELECT label FROM agents WHERE id=?').get(id) as { label: string } | undefined)?.label ?? id : '—');

    // One row per finished task: everything its people did between assignment and close (an upper bound when they
    // also worked on other tasks at the same time).
    const tasks = db.prepare(`SELECT k.id, k.team_id, k.title, k.status, k.assignee_agent_id, k.reviewer_agent_id, k.review_rounds, k.created_by_agent
      FROM tasks k WHERE k.status IN ('done','cancelled') AND k.updated_at>=? AND k.team_id IN (${teamIds.map(() => '?').join(',') || "''"})`).all(since, ...teamIds) as {
        id: string; team_id: string; title: string; status: string; assignee_agent_id: string | null; reviewer_agent_id: string | null; review_rounds: number; created_by_agent: string | null }[];
    const cycles = tasks.map((k) => {
      const ev = db.prepare('SELECT to_status, tool, actor_id, created_at FROM task_events WHERE task_id=? ORDER BY id').all(k.id) as { to_status: string; tool: string | null; actor_id: string | null; created_at: number }[];
      const start = ev.find((e) => e.to_status === 'assigned')?.created_at ?? ev[0]?.created_at ?? 0;
      const end = [...ev].reverse().find((e) => e.to_status === 'done' || e.to_status === 'cancelled')?.created_at ?? Date.now();
      const submitted = ev.find((e) => e.to_status === 'in_review')?.created_at ?? null;
      const people = new Set([k.assignee_agent_id, k.reviewer_agent_id, k.created_by_agent, ...ev.map((e) => e.actor_id)].filter(Boolean) as string[]);
      const mine = inv.filter((i) => people.has(i.agent_id!) && i.created_at >= start && i.created_at <= end);
      const book = mine.filter((i) => BOOKKEEPING.test(i.tool));
      const overdue = (db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='task_overdue' AND subject=?").get(k.id) as { n: number }).n;
      return {
        task_id: k.id, team_id: k.team_id, title: k.title, status: k.status, assignee: label(k.assignee_agent_id), closed_at: end,
        elapsed_ms: end - start, review_wait_ms: submitted ? end - submitted : null, review_rounds: k.review_rounds, overdue,
        calls: mine.length, bookkeeping_calls: book.length, est_tokens: tokens(mine.reduce((n, i) => n + (i.result_bytes ?? 0), 0)),
        people: people.size,
      };
    }).sort((a, b) => b.closed_at - a.closed_at);

    // Per agent: volume, how much was coordination, and the context the hub's answers added.
    const byAgent = new Map<string, { calls: number; book: number; bytes: number; denied: number; errors: number; perDay: number[] }>();
    for (const i of inv) {
      const a = byAgent.get(i.agent_id!) ?? { calls: 0, book: 0, bytes: 0, denied: 0, errors: 0, perDay: Array(days).fill(0) };
      a.calls++; if (BOOKKEEPING.test(i.tool)) a.book++; a.bytes += i.result_bytes ?? 0;
      if (i.result === 'denied') a.denied++; else if (i.result !== 'ok') a.errors++;
      const di = Math.min(days - 1, Math.floor((i.created_at - since) / DAY)); a.perDay[di] = (a.perDay[di] ?? 0) + 1;
      byAgent.set(i.agent_id!, a);
    }
    const agents = [...byAgent].map(([id, a]) => ({ agent_id: id, label: label(id), calls: a.calls, bookkeeping_calls: a.book, est_tokens: tokens(a.bytes), denied: a.denied, errors: a.errors, per_day: a.perDay }))
      .sort((x, y) => y.calls - x.calls);

    // The operator's side: what replaced asking agents for progress.
    const inTeams = (sql: string) => (db.prepare(sql.replace('$T', teamIds.map(() => '?').join(',') || "''")).get(since, ...teamIds) as { n: number }).n;
    const operator = {
      status_requests: inTeams("SELECT COUNT(*) n FROM audit_events WHERE action='team.status_request' AND created_at>=? AND target_id IN ($T)"),
      status_reports: inTeams('SELECT COUNT(*) n FROM team_status_reports WHERE created_at>=? AND team_id IN ($T)'),
      directives: (db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE kind IN ('directive','message') AND created_at>=?").get(since) as { n: number }).n,
      approvals_waiting: (db.prepare(`SELECT COUNT(*) n FROM tasks WHERE approval_requested=1 AND status='approved' AND team_id IN (${teamIds.map(() => '?').join(',') || "''"})`).get(...teamIds) as { n: number }).n,
    };
    // When a team changed how it works, so cycles can be compared before and after.
    const switches = (db.prepare("SELECT target_id, details, created_at FROM audit_events WHERE action='team.update' AND details LIKE '%delivery_mode%' AND created_at>=? ORDER BY created_at").all(since) as { target_id: string; details: string; created_at: number }[])
      .filter((s) => !q.team || s.target_id === q.team)
      .map((s) => { let mode = null; try { mode = (JSON.parse(s.details) as { delivery_mode?: string }).delivery_mode ?? null; } catch { /* keep null */ } return { team_id: s.target_id, mode, at: s.created_at }; });
    const baseline = (db.prepare("SELECT value FROM system_settings WHERE key='telemetry.baseline'").get() as { value: string } | undefined)?.value;
    return {
      since, days, cycles, agents, operator, switches,
      totals: { calls: inv.length, bookkeeping_calls: inv.filter((i) => BOOKKEEPING.test(i.tool)).length, est_tokens: tokens(inv.reduce((n, i) => n + (i.result_bytes ?? 0), 0)), measured_calls: inv.filter((i) => i.result_bytes !== null).length },
      baseline: baseline ? JSON.parse(baseline) : null,
    };
  });

  /** A baseline measured without the hub, entered once by the operator (for example from the BIRAZ evaluation). */
  api.put('/api/telemetry/baseline', async (req) => {
    const b = z.object({
      label: z.string().trim().min(1).max(120), calls_per_cycle: z.number().min(0).max(1000), tokens_per_cycle: z.number().min(0).max(1e9),
      note: z.string().trim().max(500).optional(),
    }).parse(req.body ?? {});
    db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES ('telemetry.baseline',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(JSON.stringify(b), Date.now());
    d.audit.event(actor(req), 'telemetry.baseline', { kind: 'system', id: 'telemetry' }, b);
    return { baseline: b };
  });
}
