/**
 * Lightweight in-process alert rules (F7). Event driven from the MCP pipeline and the audit log;
 * counters live in usage_counters so they survive restarts. Raising goes through Audit.alert,
 * which dedupes. Stalled members, blocked tasks, quota trips and shared keys are raised where
 * they happen (teams, session_login).
 */
import type { Db } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Vault } from '../vault/vault.js';
import { WRITE_TOOLS } from './lockdown.js';

export interface AlertOpts {
  denialMax: number; denialWindowMs: number;
  loginMax: number; loginWindowMs: number;
  /** Hourly volume alert fires above max(floor, factor x the key's own average of busy hours). */
  volumeFloor: number; volumeFactor: number;
}
export const DEFAULT_ALERT_OPTS: AlertOpts = { denialMax: 10, denialWindowMs: 10 * 60_000, loginMax: 10, loginWindowMs: 10 * 60_000, volumeFloor: 100, volumeFactor: 5 };
const HOUR = 3600_000;

const volumeClass = (tool: string): 'write' | 'message' | 'channel' | null =>
  /^channel_(open|send)$/.test(tool) ? 'channel' : tool === 'message_send' ? 'message' : WRITE_TOOLS.has(tool) && /^(file_|share_|task_)/.test(tool) ? 'write' : null;

export class Alerts {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly keys: Keys, private readonly vault: Vault, readonly opts: AlertOpts = DEFAULT_ALERT_OPTS) {
    audit.onAuth = (e) => this.onAuth(e);
  }

  /** Add n to the counter of the current window; returns the count before and after. */
  private bump(scope: string, metric: string, windowMs: number, n = 1, now = Date.now()): { before: number; after: number } {
    const w = Math.floor(now / windowMs) * windowMs;
    const row = this.db.prepare('SELECT count FROM usage_counters WHERE scope=? AND metric=? AND window_start=?').get(scope, metric, w) as { count: number } | undefined;
    const before = row?.count ?? 0;
    this.db.prepare('INSERT INTO usage_counters(scope,metric,window_start,count) VALUES (?,?,?,?) ON CONFLICT(scope,metric,window_start) DO UPDATE SET count=count+excluded.count').run(scope, metric, w, n);
    return { before, after: before + n };
  }

  /** After every tool call. */
  onCall(c: { credentialId: string | null; agentId: string | null; tool: string; args: Record<string, unknown>; result: string; errorCode: string | null }, now = Date.now()): void {
    if (!c.credentialId) return;
    const cred = c.credentialId;
    if (c.result === 'denied') {
      const { before, after } = this.bump(cred, 'alert_denied', this.opts.denialWindowMs, 1, now);
      if (before < this.opts.denialMax && after >= this.opts.denialMax) {
        this.audit.alert('warning', 'repeated_denials', cred, { agent: c.agentId, count: after, window_minutes: this.opts.denialWindowMs / 60_000, last_tool: c.tool });
      }
    }
    if (c.result !== 'ok' && this.forbiddenPath(c.args)) {
      this.audit.alert('warning', 'forbidden_path', cred, { agent: c.agentId, tool: c.tool, error: c.errorCode });
    }
    const cls = c.result === 'ok' ? volumeClass(c.tool) : null;
    if (cls) this.volume(cred, c.agentId, cls, now);
  }

  /** A path argument that tries to leave the vault or reaches a hidden folder. */
  private forbiddenPath(args: Record<string, unknown>): boolean {
    const bad = (v: unknown, depth = 0): boolean => {
      if (typeof v === 'string') return v.includes('/') && v.length < 1100 && v.split(/[\\/]/).some((seg) => seg === '..' || (seg.length > 1 && this.vault.isHidden(seg)));
      if (depth < 3 && Array.isArray(v)) return v.slice(0, 20).some((x) => bad(x, depth + 1));
      if (depth < 3 && v && typeof v === 'object') return Object.values(v).slice(0, 20).some((x) => bad(x, depth + 1));
      return false;
    };
    return Object.entries(args).some(([k, v]) => k !== 'session_token' && k !== 'session_key' && bad(v));
  }

  private volume(cred: string, agentId: string | null, cls: string, now: number): void {
    const metric = `alert_vol_${cls}`;
    const { before, after } = this.bump(cred, metric, HOUR, 1, now);
    const w = Math.floor(now / HOUR) * HOUR;
    const prev = this.db.prepare('SELECT count FROM usage_counters WHERE scope=? AND metric=? AND window_start<? AND window_start>=? AND count>0').all(cred, metric, w, w - 24 * HOUR) as { count: number }[];
    const baseline = prev.length >= 3 ? prev.reduce((s, r) => s + r.count, 0) / prev.length : 0;
    const limit = Math.max(this.opts.volumeFloor, baseline * this.opts.volumeFactor);
    if (before <= limit && after > limit) {
      this.audit.alert('warning', 'unusual_volume', cred, { agent: agentId, kind: cls, count_this_hour: after, hourly_baseline: Math.round(baseline), limit: Math.round(limit) });
    }
  }

  /** Failed sign-ins (admin, app key, session key) per source. */
  private onAuth(e: { subject: string; outcome: string; source: string | null; keyId: string | null }): void {
    if (e.outcome === 'success' || e.outcome === 'rate_limited' || !e.source) return;
    const { before, after } = this.bump(`src:${e.source}`, 'alert_login_fail', this.opts.loginWindowMs);
    if (before < this.opts.loginMax && after >= this.opts.loginMax) {
      this.audit.alert('warning', 'login_burst', e.source, { count: after, window_minutes: this.opts.loginWindowMs / 60_000, last_outcome: e.outcome, last_subject: e.subject });
    }
  }

  /** Forget old counters (called by the scheduler). */
  cleanup(now = Date.now()): void {
    this.db.prepare("DELETE FROM usage_counters WHERE metric LIKE 'alert\\_%' ESCAPE '\\' AND window_start<?").run(now - 48 * HOUR);
  }

  /** The active session keys an alert points at (credential, agent or task subject). */
  relatedKeys(alertId: string): string[] {
    const a = this.db.prepare('SELECT subject, details FROM security_alerts WHERE id=?').get(alertId) as { subject: string | null; details: string | null } | undefined;
    if (!a) throw new KeyError('not_found', 'alert not found');
    const s = a.subject ?? '';
    let ids: string[] = [];
    if (s.startsWith('crd_')) ids = [s];
    else if (s.startsWith('agent-')) ids = (this.db.prepare("SELECT id FROM credentials WHERE agent_id=? AND kind='session_key'").all(s) as { id: string }[]).map((r) => r.id);
    else if (s.startsWith('task_')) ids = (this.db.prepare("SELECT c.id FROM tasks t JOIN credentials c ON c.agent_id=t.assignee_agent_id AND c.kind='session_key' WHERE t.id=?").all(s) as { id: string }[]).map((r) => r.id);
    return ids.filter((id) => { const c = this.keys.credential(id); return c && c.status === 'active'; });
  }

  /** One-click action: suspend the key behind an alert and close it. */
  suspendKey(alertId: string, actor: Actor): string[] {
    const ids = this.relatedKeys(alertId);
    if (ids.length === 0) throw new KeyError('invalid_state', 'this alert has no active session key to suspend');
    for (const id of ids) this.keys.setStatus(id, 'suspended', 'alert', actor);
    this.db.prepare("UPDATE security_alerts SET status='closed', updated_at=? WHERE id=?").run(Date.now(), alertId);
    this.audit.event(actor, 'alert.suspend_key', { kind: 'alert', id: alertId }, { keys: ids });
    return ids;
  }
}
