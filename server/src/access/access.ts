/** Access requests and temporary grants (F7). Agents ask; only admins decide. */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import { actionMatches, parseResource, pathMatches } from '../policy/engine.js';
import { newId } from '../util/ids.js';

export const DEFAULT_GRANT_S = 3600;
export const MAX_GRANT_S = 7 * 24 * 3600;
export const REQUEST_TTL_MS = 24 * 3600_000;
const MAX_PENDING = 5;
const ACTION_RE = /^[a-z_]+(\.[a-z_*]+)*$|^\*$/;

export interface RequestRow {
  id: string; credential_id: string; agent_id: string; actions: string[]; resource: string; justification: string;
  requested_duration_s: number | null; status: string; decided_by: string | null; decision_note: string | null; decided_at: number | null; created_at: number;
}
type Raw = Omit<RequestRow, 'actions'> & { actions: string };

/** "90" (seconds), "30m", "2h", "1d" -> seconds. */
export function parseDuration(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  let s: number;
  if (typeof v === 'number') s = v;
  else {
    const m = /^(\d+)\s*([smhd]?)$/i.exec(String(v).trim());
    if (!m) throw new KeyError('invalid_argument', 'duration looks like "30m", "2h", "1d" or a number of seconds');
    s = Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]!.toLowerCase()]!;
  }
  if (!Number.isFinite(s) || s <= 0) throw new KeyError('invalid_argument', 'duration must be positive');
  return Math.min(Math.floor(s), MAX_GRANT_S);
}

/** Is `narrow` (a resource) inside `wide`? Same kind, and the narrow pattern matches under the wide one. */
export function resourceWithin(narrow: string, wide: string): boolean {
  const a = parseResource(narrow), b = parseResource(wide);
  if (a.kind !== b.kind) return false;
  if (a.kind === 'path') return pathMatches(b.pattern, a.pattern);
  if (b.pattern === '*') return true;
  return new RegExp('^' + b.pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(a.pattern);
}

export class Access {
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly audit: Audit) {}

  private view(r: Raw): RequestRow { return { ...r, actions: JSON.parse(r.actions) as string[] }; }
  get(id: string): RequestRow | null { const r = this.db.prepare('SELECT * FROM access_requests WHERE id=?').get(id) as Raw | undefined; return r ? this.view(r) : null; }

  request(cred: { id: string }, agentId: string, i: { actions: string[]; resource: string; reason: string; duration?: unknown }): RequestRow {
    if (!i.actions.length || !i.actions.every((a) => ACTION_RE.test(a))) throw new KeyError('invalid_argument', 'actions must look like ["fs.update"]');
    const resource = i.resource.startsWith('/') ? `path:${i.resource}` : i.resource;
    try { parseResource(resource); } catch (e) { throw new KeyError('invalid_argument', (e as Error).message); }
    this.expirePending();
    const n = (this.db.prepare("SELECT COUNT(*) n FROM access_requests WHERE credential_id=? AND status='pending'").get(cred.id) as { n: number }).n;
    if (n >= MAX_PENDING) throw new KeyError('rate_limited', `You already have ${MAX_PENDING} pending requests. Wait for a decision.`);
    const id = newId.request();
    this.db.prepare('INSERT INTO access_requests(id,credential_id,agent_id,actions,resource,justification,requested_duration_s,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, cred.id, agentId, JSON.stringify(i.actions), resource, i.reason, parseDuration(i.duration), Date.now());
    this.audit.event({ kind: 'agent', id: agentId }, 'access.request', { kind: 'access_request', id }, { actions: i.actions, resource });
    return this.get(id)!;
  }

  forCredential(credId: string, id?: string): RequestRow[] {
    this.expirePending();
    const rows = id ? this.db.prepare('SELECT * FROM access_requests WHERE credential_id=? AND id=?').all(credId, id) : this.db.prepare('SELECT * FROM access_requests WHERE credential_id=? ORDER BY created_at DESC LIMIT 50').all(credId);
    return (rows as Raw[]).map((r) => this.view(r));
  }
  list(status?: string, limit = 200): RequestRow[] {
    this.expirePending();
    const rows = status ? this.db.prepare('SELECT * FROM access_requests WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit) : this.db.prepare('SELECT * FROM access_requests ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Raw[]).map((r) => this.view(r));
  }

  /** Pending requests nobody decided within 24 h expire. */
  expirePending(now = Date.now()): number {
    return Number(this.db.prepare("UPDATE access_requests SET status='expired', decided_at=? WHERE status='pending' AND created_at<?").run(now, now - REQUEST_TTL_MS).changes);
  }

  approve(id: string, o: { duration?: unknown; narrowed_resource?: string; actions?: string[] }, actor: Actor): { request: RequestRow; grant_id: string; not_after: number } {
    const r = this.mustPending(id);
    const resource = o.narrowed_resource ? (o.narrowed_resource.startsWith('/') ? `path:${o.narrowed_resource}` : o.narrowed_resource) : r.resource;
    try { parseResource(resource); } catch (e) { throw new KeyError('invalid_argument', (e as Error).message); }
    if (!resourceWithin(resource, r.resource)) throw new KeyError('invalid_argument', 'narrowed_resource must lie inside the requested resource');
    const actions = o.actions ?? r.actions;
    if (!actions.length || !actions.every((a) => ACTION_RE.test(a) && r.actions.some((q) => actionMatches(q, a)))) throw new KeyError('invalid_argument', 'actions must be a subset of the requested actions');
    const dur = parseDuration(o.duration) ?? Math.min(r.requested_duration_s ?? DEFAULT_GRANT_S, MAX_GRANT_S);
    const partial = resource !== r.resource || actions.length < r.actions.length || (r.requested_duration_s !== null && dur < r.requested_duration_s);
    const now = Date.now(), gid = newId.grant();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO temporary_grants(id,credential_id,actions,resource,resource_kind,not_before,not_after,access_request_id,granted_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(gid, r.credential_id, JSON.stringify(actions), resource, parseResource(resource).kind, now, now + dur * 1000, id, actor.id, now);
      this.db.prepare('UPDATE access_requests SET status=?, decided_by=?, decided_at=? WHERE id=?').run(partial ? 'partially_approved' : 'approved', actor.id, now, id);
    });
    this.audit.event(actor, 'access.approve', { kind: 'access_request', id }, { grant: gid, resource, actions, seconds: dur, partial });
    this.keys.notify(r.agent_id, 'access_decision', `Your access request ${id} was ${partial ? 'partially approved' : 'approved'}: ${actions.join(', ')} on ${resource} until ${new Date(now + dur * 1000).toISOString()}.`);
    return { request: this.get(id)!, grant_id: gid, not_after: now + dur * 1000 };
  }

  deny(id: string, note: string | null, actor: Actor): RequestRow {
    const r = this.mustPending(id);
    this.db.prepare("UPDATE access_requests SET status='denied', decided_by=?, decision_note=?, decided_at=? WHERE id=?").run(actor.id, note, Date.now(), id);
    this.audit.event(actor, 'access.deny', { kind: 'access_request', id }, { note });
    this.keys.notify(r.agent_id, 'access_decision', `Your access request ${id} was denied${note ? `: ${note}` : '.'}`);
    return this.get(id)!;
  }
  private mustPending(id: string): RequestRow {
    this.expirePending();
    const r = this.get(id);
    if (!r) throw new KeyError('not_found', 'request not found');
    if (r.status !== 'pending') throw new KeyError('invalid_state', `the request is already ${r.status}`);
    return r;
  }

  grants(all = false) {
    const rows = (all ? this.db.prepare('SELECT * FROM temporary_grants ORDER BY created_at DESC LIMIT 500').all()
      : this.db.prepare('SELECT * FROM temporary_grants WHERE revoked_at IS NULL AND not_after>? ORDER BY created_at DESC LIMIT 500').all(Date.now())) as { id: string; credential_id: string; actions: string; resource: string; not_before: number; not_after: number; access_request_id: string | null; granted_by: string; revoked_at: number | null; created_at: number }[];
    return rows.map((g) => ({ ...g, actions: JSON.parse(g.actions) as string[] }));
  }
  revoke(id: string, actor: Actor): void {
    const g = this.db.prepare('SELECT credential_id FROM temporary_grants WHERE id=? AND revoked_at IS NULL').get(id) as { credential_id: string } | undefined;
    if (!g) throw new KeyError('not_found', 'grant not found');
    this.db.prepare('UPDATE temporary_grants SET revoked_at=? WHERE id=?').run(Date.now(), id);
    this.audit.event(actor, 'access.grant_revoke', { kind: 'temporary_grant', id }, { credential: g.credential_id });
    const agent = this.keys.credential(g.credential_id)?.agent_id;
    if (agent) this.keys.notify(agent, 'permissions_changed', 'A temporary grant was revoked. Call access_list to see your grants.');
  }
}
