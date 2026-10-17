/** Phase 4a admin routes: vault explorer, activity, change inspector, conflicts, lockdown, alert triage. Registered inside the authenticated /api scope. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Vault } from '../vault/vault.js';
import type { VaultStore } from '../vault/store.js';
import { authorize, canReach } from '../policy/engine.js';

export interface VaultApiDeps { db: Db; keys: Keys; audit: Audit; vault: Vault; store: VaultStore }

export function registerVaultApi(api: FastifyInstance, d: VaultApiDeps, actor: (r: FastifyRequest) => Actor): void {
  const { db, keys, audit, vault, store } = d;
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const int = (v: string | undefined, def: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : def; };
  const label = (id: string | null) => (id ? keys.agent(id)?.label ?? null : null);
  const revView = (r: { id: string; revision: string; parent_revision: string | null; path_at_revision: string; op: string; origin: string; recovered: number; agent_id: string | null; credential_id: string | null; admin_id: string | null; size: number | null; created_at: number }) => ({
    id: r.id, revision: r.revision, parent_revision: r.parent_revision, path: vault.virtual(r.path_at_revision.split('/')), op: r.op, origin: r.origin, recovered: !!r.recovered,
    agent_id: r.agent_id, agent_label: label(r.agent_id), credential_id: r.credential_id, admin_id: r.admin_id, size: r.size, created_at: r.created_at,
  });
  const fileOr404 = (id: string) => { const f = store.fileById(id); if (!f) throw new KeyError('not_found', 'file not found'); return f; };

  /** Active session keys and their rules, for exposure counts. */
  const activeKeys = () => keys.credentials({ kind: 'session_key' }).filter((c) => keys.effectiveStatus(c) === 'active')
    .map((c) => ({ id: c.id, agent_id: c.agent_id!, label: c.label, rules: keys.rules(c.policy_id) }));

  api.get('/api/vault/tree', async (req) => {
    const { path, rel } = vault.normalise(q(req).path ?? `/${vault.alias}`);
    const ks = activeKeys();
    const exposure = (p: string, folder = true) => {
      const reaches = (k: (typeof ks)[number], action: string) => folder
        ? canReach(k.rules, [], action, p)
        : authorize(k.rules, [], action, `path:${p}`).allowed;
      const read = ks.filter((k) => reaches(k, 'fs.read')), update = ks.filter((k) => reaches(k, 'fs.update'));
      return { read: read.length, update: update.length, read_agents: [...new Set(read.map((k) => k.agent_id))], update_agents: [...new Set(update.map((k) => k.agent_id))] };
    };
    const agg = new Map<string, { files: number; bytes: number }>();
    let total = 0, truncated = false;
    for await (const f of vault.walk(rel)) {
      const first = f.rel[rel.length];
      if (f.rel.length > rel.length + 1 && first) {
        const a = agg.get(first) ?? { files: 0, bytes: 0 };
        a.files++; a.bytes += f.size; agg.set(first, a);
      }
      if (++total >= 20000) { truncated = true; break; }
    }
    const entries = await vault.list(rel);
    return {
      path, active_keys: ks.length, truncated, exposure: exposure(path),
      folders: entries.filter((e) => e.type === 'folder').map((e) => ({ name: e.name, path: e.path, ...(agg.get(e.name) ?? { files: 0, bytes: 0 }), exposure: exposure(e.path) })),
      files: entries.filter((e) => e.type === 'file').map((e) => ({ name: e.name, path: e.path, size: e.size, modified: e.modified, exposure: exposure(e.path, false) })),
    };
  });

  api.get('/api/vault/activity', async (req) => {
    const query = q(req);
    const limit = int(query.limit, 50, 1, 200);
    const scope = query.path === undefined ? null : vault.normalise(query.path);
    const filter = (column: string, path: string | null) => {
      if (path === null) return { sql: '', args: [] };
      if (query.exact === '1') return { sql: `AND ${column} = ?`, args: [path] };
      const prefix = path ? path + '/' : '';
      return { sql: `AND (${column} = ? OR substr(${column}, 1, length(?)) = ?)`, args: [path, prefix, prefix] };
    };
    const revisionScope = filter('r.path_at_revision', scope?.rel.join('/') ?? null);
    const accessScope = filter('path', scope?.path ?? null);
    const agentArgs = query.agent ? [query.agent] : [];
    // writes=1: only changes, for the audit trail; the index's first sighting of each file is not one.
    const revs = db.prepare(`SELECT r.*, f.id fid FROM file_revisions r JOIN files f ON f.id=r.file_id
      WHERE 1=1 ${revisionScope.sql} ${query.agent ? 'AND r.agent_id = ?' : ''} ${query.writes === '1' ? "AND r.origin <> 'initial_scan'" : ''}
      ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(...revisionScope.args, ...agentArgs, limit) as never[];
    const access = db.prepare(`SELECT * FROM resource_access_events WHERE action LIKE 'fs.%'
      ${accessScope.sql} ${query.agent ? 'AND agent_id = ?' : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...accessScope.args, ...agentArgs, limit) as { agent_id: string }[];
    return {
      revisions: (revs as { fid: string }[]).map((r) => ({ file_id: r.fid, ...revView(r as never) })),
      access: access.map((a) => ({ ...a, agent_label: label(a.agent_id) })),
      last_scan: store.lastScan(), writes_disabled: store.writesDisabled(),
    };
  });

  api.get('/api/vault/preview', async (req, reply) => {
    const { rel } = vault.normalise(q(req).path ?? '');
    const file = await vault.stat(rel);
    const preview = file.is_text && file.size !== null && file.size <= 1024 * 1024 ? await vault.read(rel, 0, 24000) : null;
    return reply.header('Cache-Control', 'no-store').send({ ...file, preview });
  });

  api.get('/api/vault/revisions/:fileId', async (req) => {
    const f = fileOr404((req.params as { fileId: string }).fileId);
    return { file: { id: f.id, path: vault.virtual(f.path.split('/')), current_revision: f.current_revision, deleted: f.deleted_at !== null }, revisions: store.revisions(f.id, int(q(req).limit, 100, 1, 500)).map(revView) };
  });

  api.get('/api/vault/diff', async (req) => {
    const { file, from, to } = q(req);
    if (!file || !from) throw new KeyError('invalid_argument', 'file and from are required');
    const f = fileOr404(file);
    const r = await store.diff(f, from, to || undefined);
    return { file: { id: f.id, path: vault.virtual(f.path.split('/')) }, ...r };
  });

  api.get('/api/vault/conflicts', async (req) => ({
    conflicts: store.conflicts(q(req).status === 'all' ? 'all' : 'open').map((c) => ({
      id: c.id, file_id: c.file_id, path: vault.virtual(c.path.split('/')), source: c.source, base_revision: c.base_revision, revisions: JSON.parse(c.revisions) as unknown,
      conflict_path: c.conflict_path, status: c.status, resolution: c.resolution ? JSON.parse(c.resolution) as unknown : null, agent_id: c.agent_id, agent_label: label(c.agent_id), created_at: c.created_at, resolved_at: c.resolved_at,
    })),
  }));

  api.post('/api/vault/conflicts/:id/resolve', async (req) => {
    const b = z.object({ keep: z.string().min(1).max(100) }).parse(req.body ?? {});
    const id = (req.params as { id: string }).id;
    const r = await store.resolveConflict(id, b.keep, actor(req).id!);
    audit.event(actor(req), 'vault.conflict.resolve', { kind: 'file_conflict', id }, { keep: b.keep, revision: r.revision });
    return { ok: true, revision: r.revision };
  });

  const setAlert = (status: 'acknowledged' | 'closed') => async (req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    const r = db.prepare('UPDATE security_alerts SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), id);
    if (Number(r.changes) === 0) throw new KeyError('not_found', 'alert not found');
    audit.event(actor(req), `alert.${status}`, { kind: 'alert', id });
    return { alert: db.prepare('SELECT * FROM security_alerts WHERE id=?').get(id) };
  };
  api.post('/api/alerts/:id/ack', setAlert('acknowledged'));
  api.post('/api/alerts/:id/close', setAlert('closed'));
}
