import type { Db } from '../db/db.js';
import { newId } from '../util/ids.js';

export type Actor = { kind: 'admin' | 'agent' | 'system'; id: string | null };

const SECRET = /ah[_\W]{0,4}(?:app|ses|tok|brg|set)[_\W]{0,4}[a-z2-7_]{6,}/gi;

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

export class Audit {
  /** Set by the alert engine: sees every authentication event. */
  onAuth?: (e: { subject: string; outcome: string; source: string | null; keyId: string | null }) => void;
  constructor(private readonly db: Db) {}

  event(actor: Actor, action: string, target: { kind: string; id: string } | null, details?: unknown): void {
    this.db.prepare('INSERT INTO audit_events(actor_kind,actor_id,action,target_kind,target_id,details,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(actor.kind, actor.id, action, target?.kind ?? null, target?.id ?? null, details === undefined ? null : JSON.stringify(redact(details)), Date.now());
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
}
