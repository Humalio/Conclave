import type { Db } from '../db/db.js';
import { newId } from '../util/ids.js';

/** `via`: a routed act (docs/multi-user.md §1.3), recorded in the event details as `via` and `via_team`. */
type Via = { via: 'decider' | 'admin_fallback' | 'admin_override'; team: string };
/**
 * Who did it. A console user is kind 'admin' with a role ('admin' or 'member', docs/multi-user.md §3): audit_events
 * keeps actor_kind 'admin' for every console user (the table is append-only) and records the role in actor_role. The
 * console always sets the role; a kind 'admin' actor without one is the admin. Service code tells the admin from a
 * member decider with isAdmin(), never with the kind alone.
 */
export type Actor = { kind: 'admin' | 'agent' | 'system'; id: string | null; role?: 'admin' | 'member'; via?: Via };

/** The admin: a console user who is not a member. A member (a team's decider) is kind 'admin' too, with role 'member'. */
export const isAdmin = (a: Actor): boolean => a.kind === 'admin' && a.role !== 'member';

/** Conclave key and token shapes (exported for the vault copy's page filter, mirror.ts). */
export const SECRET = /ah[_\W]{0,4}(?:app|ses|tok|brg|set)[_\W]{0,4}[a-z2-7_]{6,}/gi;
/** A fresh copy of SECRET for other modules (a shared /g regex keeps lastIndex between .test() calls). */
export const secretPattern = (): RegExp => new RegExp(SECRET.source, SECRET.flags);

/** Remove anything that looks like a key or token, and truncate long strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (typeof value === 'string') {
    const s = value.replace(SECRET, '[redacted]');
    return s.length > 300 ? `${s.slice(0, 300)}…(${s.length} chars)` : s;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /key|token|secret|password|totp/i.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const ALERT_DEDUPE_MS = 3600_000;
/** At most this many entries in a digest alert's list; the count keeps going. */
export const DIGEST_MAX = 200;

/**
 * Alerts that wait for a decision (docs/security.md, Alerts): each type names the row it waits on, as a condition on the
 * alert's subject that holds while that row still waits. Once it no longer holds (the proposal is decided, the task is
 * unblocked, the row is gone) the alert has nothing left to ask, and settle() closes it.
 */
export const SETTLES: Record<string, string> = {
  bp_proposal: "SELECT 1 FROM bp_proposals WHERE id=a.subject AND status='open'",
  bp_replan: "SELECT 1 FROM bp_replans WHERE id=a.subject AND status='open'",
  onboarding_request: "SELECT 1 FROM onboarding_requests WHERE id=a.subject AND state='submitted'",
  recruit_request: "SELECT 1 FROM recruit_requests WHERE team_id=a.subject AND status='pending'",
  checkpoint: "SELECT 1 FROM tasks WHERE id=a.subject AND status='approved' AND approval_requested=1",
  task_blocked: "SELECT 1 FROM tasks WHERE id=a.subject AND status='blocked'",
  // Overdue until the assignee gives news (progress, submit) or the task moves on; a later lapse raises a new one. Only a
  // started task can be overdue: a queued one (assigned, changes_requested) has no deadline (migration 0107).
  task_overdue: "SELECT 1 FROM tasks WHERE id=a.subject AND status='in_progress' AND overdue_at IS NOT NULL",
  // A restoring checkout past due, until the operator finishes or cancels it.
  checkout_overdue: "SELECT 1 FROM checkouts WHERE id=a.subject AND status='restoring' AND overdue_at IS NOT NULL",
  // A stalled member, only while one of its running teams has stall warnings on (off by default, migration 0123).
  stalled_member: "SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.agent_id=a.subject AND m.removed_at IS NULL AND t.status='running' AND t.stall_warnings=1",
};

export class Audit {
  /** Set by the alert engine: sees every authentication event. */
  onAuth?: (e: { subject: string; outcome: string; source: string | null; keyId: string | null }) => void;
  constructor(private readonly db: Db) {}

  /** Told after each event is recorded (the vault copy schedules a team's pages). Must not throw or write. */
  onEvent?: (action: string, target: { kind: string; id: string } | null, details: unknown) => void;
  event(actor: Actor, action: string, target: { kind: string; id: string } | null, details?: unknown): void {
    try { this.onEvent?.(action, target, details); } catch { /* the vault copy must never break an action */ }
    if (actor.via) details = { ...(details && typeof details === 'object' && !Array.isArray(details) ? details : details === undefined ? {} : { details }), via: actor.via.via, via_team: actor.via.team };
    this.db.prepare('INSERT INTO audit_events(actor_kind,actor_id,actor_role,action,target_kind,target_id,details,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(actor.kind, actor.id, actor.kind === 'admin' ? (actor.role ?? 'admin') : null, action, target?.kind ?? null, target?.id ?? null, details === undefined ? null : JSON.stringify(redact(details)), Date.now());
  }

  auth(e: { subject: 'app_key' | 'session_key' | 'admin'; credentialId?: string | null; adminId?: string | null; keyId?: string | null; outcome: string; source?: string | null }): void {
    this.db.prepare('INSERT INTO authentication_events(id,subject_kind,credential_id,admin_id,key_id_presented,outcome,source,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId.event(), e.subject, e.credentialId ?? null, e.adminId ?? null, e.keyId ?? null, e.outcome, e.source ?? null, Date.now());
    try { this.onAuth?.({ subject: e.subject, outcome: e.outcome, source: e.source ?? null, keyId: e.keyId ?? null }); } catch { /* alerting must never break a login */ }
  }

  invocation(i: { credentialId: string | null; appCredentialId: string | null; agentId: string | null; machineId: string | null; tool: string; args: unknown; result: string; errorCode: string | null; durationMs: number; resultBytes?: number }): void {
    this.db.prepare('INSERT INTO tool_invocations(id,credential_id,app_credential_id,agent_id,machine_id,tool,args_summary,result,error_code,duration_ms,result_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(newId.invocation(), i.credentialId, i.appCredentialId, i.agentId, i.machineId, i.tool, JSON.stringify(redact(i.args)), i.result, i.errorCode, Math.round(i.durationMs), i.resultBytes ?? null, Date.now());
  }

  access(a: { credentialId: string; agentId: string; path: string; action: string; allowed: boolean; ruleId: string | null; revision?: string | null }): void {
    this.db.prepare('INSERT INTO resource_access_events(id,credential_id,agent_id,path,action,decision,rule_id,revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId.event(), a.credentialId, a.agentId, a.path, a.action, a.allowed ? 'allow' : 'deny', a.ruleId, a.revision ?? null, Date.now());
  }

  /**
   * Raise an alert. A repeat of the same type and subject while one is still open or acknowledged
   * (and last seen within an hour) bumps that alert's repeat count instead of adding a row.
   */
  alert(severity: 'info' | 'warning' | 'critical', type: string, subject: string | null, details?: unknown): { id: string; repeated: boolean } {
    const now = Date.now();
    const prev = this.db.prepare("SELECT id, details FROM security_alerts WHERE type=? AND subject IS ? AND status IN ('open','acknowledged') AND updated_at>? ORDER BY updated_at DESC LIMIT 1")
      .get(type, subject, now - ALERT_DEDUPE_MS) as { id: string; details: string | null } | undefined;
    if (prev) {
      const d = prev.details ? JSON.parse(prev.details) as Record<string, unknown> : {};
      d.repeats = (typeof d.repeats === 'number' ? d.repeats : 1) + 1;
      d.last_seen_at = now;
      this.db.prepare('UPDATE security_alerts SET details=?, updated_at=? WHERE id=?').run(JSON.stringify(d), now, prev.id);
      return { id: prev.id, repeated: true };
    }
    const id = newId.alert();
    this.db.prepare('INSERT INTO security_alerts(id,severity,type,subject,details,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, severity, type, subject, details === undefined ? null : JSON.stringify(redact(details)), 'open', now, now);
    return { id, repeated: false };
  }

  /**
   * A digest: one alert per type and subject (for example a team and a day) whose `details[field]` list grows. New entries
   * join the open or acknowledged one, without repeats; a closed one starts a new alert.
   */
  digest(severity: 'info' | 'warning' | 'critical', type: string, subject: string, details: Record<string, unknown>, field: string, add: string[]): string {
    const prev = this.db.prepare("SELECT id, details FROM security_alerts WHERE type=? AND subject=? AND status IN ('open','acknowledged') ORDER BY created_at DESC LIMIT 1").get(type, subject) as { id: string; details: string | null } | undefined;
    if (!prev) {
      const id = newId.alert(), now = Date.now();
      this.db.prepare('INSERT INTO security_alerts(id,severity,type,subject,details,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, severity, type, subject, JSON.stringify(redact({ ...details, [field]: [...new Set(add)].slice(0, DIGEST_MAX), count: new Set(add).size })), 'open', now, now);
      return id;
    }
    const d = prev.details ? JSON.parse(prev.details) as Record<string, unknown> : {};
    const had = Array.isArray(d[field]) ? (d[field] as string[]) : [];
    const fresh = add.filter((x) => !had.includes(x));
    const list = [...had, ...fresh];
    this.db.prepare('UPDATE security_alerts SET details=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(redact({ ...d, ...details, [field]: list.slice(0, DIGEST_MAX), count: (typeof d.count === 'number' ? d.count : had.length) + fresh.length })), Date.now(), prev.id);
    return prev.id;
  }

  /**
   * Close the open or acknowledged alerts of `type` (every type in SETTLES when left out), for `subject` only when given,
   * whose row no longer waits for a decision. Called where a decision is made, and once at start (the sweep). Returns
   * how many it closed.
   */
  settle(type?: string, subject?: string | null): number {
    let n = 0;
    for (const [t, waits] of Object.entries(SETTLES)) {
      if (type !== undefined && t !== type) continue;
      n += Number(this.db.prepare(`UPDATE security_alerts AS a SET status='closed', updated_at=? WHERE a.type=? AND a.status IN ('open','acknowledged') ${subject === undefined ? '' : 'AND a.subject IS ?'} AND NOT EXISTS (${waits})`)
        .run(Date.now(), t, ...(subject === undefined ? [] : [subject])).changes);
    }
    return n;
  }
}
