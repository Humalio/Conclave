/** Phase 5 admin routes: access requests, temporary grants, lockdown scopes, alert actions, shares/channels admin, audit export. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import { redact } from '../audit/audit.js';
import type { Access } from '../access/access.js';
import type { Lockdown } from '../safety/lockdown.js';
import { LOCK_KINDS } from '../safety/lockdown.js';
import type { Alerts } from '../safety/alerts.js';
import type { Shares } from '../shares/shares.js';
import type { Channels } from '../channels/channels.js';
import type { Maintenance } from '../safety/retention.js';

export interface Phase5Deps { db: Db; keys: Keys; audit: Audit; access: Access; lockdown: Lockdown; alerts: Alerts; shares: Shares; channels: Channels; maintenance: Maintenance }

const dur = z.union([z.string().max(10), z.number()]).optional();
const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
const when = (v: string | undefined, name: string): number | null => {
  if (v === undefined || v === '') return null;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (Number.isNaN(n)) throw new KeyError('invalid_argument', `${name} must be a timestamp (ms) or an ISO date`);
  return n;
};
/** CSV cell; a leading = + - @ is neutralised so a spreadsheet never runs it as a formula. */
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function registerPhase5(api: FastifyInstance, d: Phase5Deps, actor: (req: FastifyRequest) => Actor): void {
  const { db, keys, audit, access, lockdown, alerts, shares, channels } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const label = (id: string | null) => (id ? keys.agent(id)?.label ?? id : null);

  // ───── access requests and temporary grants ─────
  const reqView = (r: ReturnType<Access['get']> & object) => ({ ...r, agent_label: label(r.agent_id), justification_untrusted: true });
  api.get('/api/requests', async (req) => ({ requests: access.list(q(req).status).map(reqView) }));
  api.post('/api/requests/:id/approve', async (req) => {
    const b = z.object({ duration: dur, narrowed_resource: z.string().max(1024).optional(), actions: z.array(z.string().max(60)).min(1).optional() }).parse(req.body ?? {});
    const r = access.approve(idOf(req), b, actor(req));
    return { request: reqView(r.request), grant_id: r.grant_id, not_after: r.not_after };
  });
  api.post('/api/requests/:id/deny', async (req) => {
    const b = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    return { request: reqView(access.deny(idOf(req), b.note ?? null, actor(req))) };
  });
  api.get('/api/grants', async (req) => ({ grants: access.grants(q(req).all === '1') }));
  api.delete('/api/grants/:id', async (req) => { access.revoke(idOf(req), actor(req)); return { ok: true }; });

  // ───── lockdown ─────
  api.get('/api/lockdown', async () => lockdown.list());
  api.post('/api/lockdown', async (req) => {
    const b = z.object({ writes_disabled: z.boolean().optional(), scope: z.enum(LOCK_KINDS as [string, ...string[]]).optional(), id: z.string().max(100).optional(), on: z.boolean().optional() }).parse(req.body ?? {});
    const scope = (b.scope ?? 'writes') as (typeof LOCK_KINDS)[number], on = b.on ?? b.writes_disabled;
    if (on === undefined) throw new KeyError('invalid_argument', 'on (or writes_disabled) is required');
    if (scope === 'agent' && b.id && !keys.agent(b.id)) throw new KeyError('not_found', 'agent not found');
    if (scope === 'pc' && b.id && !keys.machine(b.id)) throw new KeyError('not_found', 'PC not found');
    lockdown.set(scope, b.id, on, actor(req).id);
    audit.event(actor(req), on ? 'lockdown.on' : 'lockdown.off', { kind: 'system', id: scope === 'writes' ? 'emergency.writes_disabled' : `emergency.${scope}_disabled.${b.id}` }, { scope, id: b.id ?? null });
    return lockdown.list();
  });

  // ───── alerts ─────
  api.post('/api/alerts/:id/suspend-key', async (req) => ({ suspended: alerts.suspendKey(idOf(req), actor(req)) }));

  // ───── shares (metadata and feedback; never file bytes) ─────
  const shareView = (s: NonNullable<ReturnType<Shares['share']>>) => ({
    ...s, author_label: label(s.author_agent_id), recipients: shares.targets(s.id),
    versions: shares.versions(s.id, true).map((v) => ({ version: v.version, status: v.status, note: v.note, total_bytes: v.total_bytes, files: shares.manifestOf(v).length, upload_kind: v.upload_kind, created_at: v.created_at })),
  });
  const mustShare = (id: string) => { const s = shares.share(id); if (!s) throw new KeyError('not_found', 'share not found'); return s; };
  api.get('/api/shares', async (req) => {
    const st = q(req).status;
    const rows = (st ? db.prepare('SELECT id FROM shares WHERE status=? ORDER BY created_at DESC LIMIT 300').all(st) : db.prepare('SELECT id FROM shares ORDER BY created_at DESC LIMIT 300').all()) as { id: string }[];
    return { shares: rows.map((r) => shareView(shares.share(r.id)!)) };
  });
  api.get('/api/shares/:id', async (req) => ({ share: shareView(mustShare(idOf(req))) }));
  api.get('/api/shares/:id/versions', async (req) => ({
    versions: shares.versions(mustShare(idOf(req)).id, true).map((v) => ({ version: v.version, status: v.status, note: v.note, total_bytes: v.total_bytes, upload_kind: v.upload_kind, created_at: v.created_at, files: shares.manifestOf(v).map((e) => ({ path: e.path, size: e.size })) })),
  }));
  api.get('/api/shares/:id/feedback', async (req) => ({
    feedback: (db.prepare('SELECT * FROM share_feedback WHERE share_id=? ORDER BY created_at DESC LIMIT 500').all(mustShare(idOf(req)).id) as Record<string, unknown>[]).map((f) => ({ ...f, author_label: label(f.author_agent_id as string), body_untrusted: true })),
  }));
  api.post('/api/shares/:id/revoke', async (req) => {
    const s = mustShare(idOf(req));
    if (s.status === 'revoked') return { share: shareView(s) };
    shares.close(s.id, 'revoked');
    audit.event(actor(req), 'share.revoke', { kind: 'share', id: s.id }, { name: s.name });
    keys.notify(s.author_agent_id, 'share_revoked', `The administrator revoked your share ${s.id}. Recipients can no longer read it.`);
    return { share: shareView(shares.share(s.id)!) };
  });
  api.delete('/api/shares/:id', async (req) => {
    const s = mustShare(idOf(req));
    db.exec('BEGIN IMMEDIATE');
    try { d.maintenance.deleteShareRows([s.id]); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit.event(actor(req), 'share.delete', { kind: 'share', id: s.id }, { name: s.name });
    return { ok: true };
  });

  // ───── channels (metadata only) ─────
  api.get('/api/channels', async (req) => {
    const st = q(req).status;
    const rows = (st ? db.prepare('SELECT * FROM data_channels WHERE status=? ORDER BY created_at DESC LIMIT 300').all(st) : db.prepare('SELECT * FROM data_channels ORDER BY created_at DESC LIMIT 300').all()) as unknown as Parameters<Channels['view']>[0][];
    return { channels: rows.map((c) => ({ ...channels.view(c), from_label: label(c.from_agent_id), to_label: label(c.to_agent_id), bytes_moved: c.bytes_moved, created_at: c.created_at, finished_at: c.finished_at })) };
  });
  api.post('/api/channels/:id/close', async (req) => {
    const c = channels.adminClose(idOf(req));
    audit.event(actor(req), 'channel.admin_close', { kind: 'channel', id: c.id }, { status: c.status });
    return { channel: { ...channels.view(c) } };
  });

  // ───── audit export ─────
  api.get('/api/audit/export', async (req, reply) => {
    const { format = 'json' } = q(req);
    if (format !== 'json' && format !== 'csv') throw new KeyError('invalid_argument', 'format must be json or csv');
    const from = when(q(req).from, 'from'), to = when(q(req).to, 'to');
    const rows = db.prepare('SELECT * FROM audit_events WHERE (? IS NULL OR created_at>=?) AND (? IS NULL OR created_at<=?) ORDER BY id LIMIT 50000').all(from, from, to, to) as Record<string, unknown>[];
    // details were redacted when written; redact again so nothing slips through an older row.
    const out: Record<string, unknown>[] = rows.map((r) => ({ ...r, details: r.details ? JSON.stringify(redact(JSON.parse(r.details as string))) : null }));
    audit.event(actor(req), 'audit.export', null, { from, to, format, rows: out.length });
    if (format === 'json') return reply.header('content-disposition', 'attachment; filename="audit.json"').send({ events: out });
    const cols = ['id', 'created_at', 'actor_kind', 'actor_id', 'action', 'target_kind', 'target_id', 'details'];
    const csv = [cols.join(','), ...out.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="audit.csv"').send(csv);
  });
}
