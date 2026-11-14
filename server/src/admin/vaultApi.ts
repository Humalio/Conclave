/** Admin routes for the vault explorer, activity, change inspector, conflicts, lockdown and alert triage. Registered inside the authenticated /api scope. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Vault } from '../vault/vault.js';
import type { VaultStore } from '../vault/store.js';
import { authorize, canReach } from '../policy/engine.js';
import { VaultError } from '../vault/vault.js';
import type { MemberScope } from './memberScope.js';
import { EDITABLE, READ_ONLY } from './vaultWrite.js';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { MAX_TRACK, MAX_CONTENT } from '../vault/store.js';
import { SNIFF_BYTES, sniffInline, parseRange, disposition } from '../vault/media.js';

/** Why a member's player is unavailable without the folder's export permission (shown beside it). */
export const MEDIA_EXPORT_DENIED = 'Playing or downloading the original needs export permission on this folder.';
/** Seeks and resumes within this window after an audited media read add no further row (docs/vault.md). */
export const MEDIA_AUDIT_WINDOW_MS = 10 * 60 * 1000;

export interface VaultApiDeps { db: Db; keys: Keys; audit: Audit; vault: Vault; store: VaultStore }

export function registerVaultApi(api: FastifyInstance, d: VaultApiDeps, actor: (r: FastifyRequest) => Actor): void {
  const { db, keys, audit, vault, store } = d;
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const int = (v: string | undefined, def: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : def; };
  const label = (id: string | null) => (id ? keys.agent(id)?.label ?? null : null);
  const revView = (r: { id: string; revision: string; parent_revision: string | null; path_at_revision: string; op: string; origin: string; recovered: number; agent_id: string | null; credential_id: string | null; admin_id: string | null; author_kind?: string | null; user_id?: string | null; size: number | null; created_at: number }) => ({
    id: r.id, revision: r.revision, parent_revision: r.parent_revision, path: vault.virtual(r.path_at_revision.split('/')), op: r.op, origin: r.origin, recovered: !!r.recovered,
    agent_id: r.agent_id, agent_label: label(r.agent_id), credential_id: r.credential_id, admin_id: r.admin_id, author: store.personLabel(r.author_kind ?? null, r.user_id ?? null), size: r.size, created_at: r.created_at,
  });
  /** For a member, a file outside the grant answers exactly like a missing one (§2). */
  const fileOr404 = (id: string, m?: MemberScope) => { const f = store.fileById(id); if (!f || (m && !m.canSee(f.path))) throw new KeyError('not_found', 'file not found'); return f; };
  const noPath = () => new VaultError('not_found', 'no such file');
  /** A member's view of a path: missing and not granted look the same. */
  const memberPath = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e instanceof VaultError && e.code === 'not_found')) throw noPath(); throw e; }
  };
  /** Revisions as a member sees them: no credential or admin ids, and no path outside the grant. */
  const memberRev = (r: ReturnType<typeof revView>) => ({ ...r, credential_id: null, admin_id: null });
  /** A member's folder listing: only what the grant shows, counts from visible files only, no exposure (keys are admin data). */
  const memberTree = async (m: MemberScope, raw: string | undefined) => {
    const { path, rel } = vault.normalise(raw ?? `/${vault.alias}`);
    const relStr = rel.join('/');
    // Visible files and bytes per child folder, walked once (at most 20,000 files per listing, like the admin tree).
    const agg = new Map<string, { files: number; bytes: number }>();
    let n = 0, truncated = false;
    const tally = async (from: string[]) => {
      for await (const f of vault.walk(from)) {
        if (++n >= 20000) { truncated = true; return; }
        const first = f.rel[rel.length];
        if (first && f.rel.length > rel.length + 1 && m.canSee(f.rel.join('/'))) { const a = agg.get(first) ?? { files: 0, bytes: 0 }; a.files++; a.bytes += f.size; agg.set(first, a); }
      }
    };
    const sum = (name: string) => agg.get(name) ?? { files: 0, bytes: 0 };
    // Above the granted folders: only the way down to them, folder names that are part of the granted paths.
    if (!m.canSee(relStr, true)) {
      const below = m.isAncestor(relStr);
      if (!below.length) throw noPath();
      const next = [...new Set(below.map((f) => f.slice(relStr ? relStr.length + 2 : 1).split('/')[0]!))].sort();
      const folders = [];
      for (const name of next) {
        const childRel = [...rel, name];
        try { await vault.stat(childRel); } catch { continue; }
        if (m.canSee(childRel.join('/'), true) && !truncated) await tally(childRel);
        folders.push({ name, path: vault.virtual(childRel), ...sum(name) });
      }
      return { path, truncated, folders, files: [] };
    }
    const entries = await memberPath(() => vault.list(rel));
    await tally(rel);
    const folders = [], files = [];
    for (const e of entries) {
      const childRel = [...rel, e.name], folder = e.type === 'folder';
      if (!m.canSee(childRel.join('/'), folder)) {
        // A hidden restricted folder with a granted folder inside: shown as the way down to it.
        if (folder && m.isAncestor(childRel.join('/')).length) folders.push({ name: e.name, path: e.path, ...sum(e.name) });
        continue;
      }
      if (folder) folders.push({ name: e.name, path: e.path, ...sum(e.name) });
      else files.push({ name: e.name, path: e.path, size: e.size, modified: e.modified });
    }
    return { path, truncated, folders, files };
  };

  /** Active session keys and their rules, for exposure counts. */
  const activeKeys = () => keys.credentials({ kind: 'session_key' }).filter((c) => keys.effectiveStatus(c) === 'active')
    .map((c) => ({ id: c.id, agent_id: c.agent_id!, label: c.label, rules: keys.rules(c.policy_id) }));

  api.get('/api/vault/tree', async (req) => {
    if (req.member) return memberTree(req.member, q(req).path);
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
    // A member sees revisions under the granted folders only, filtered before the limit; access events are admin data.
    const mine = req.member ? req.member.pathSql('r.path_at_revision') : { sql: '1', args: [] as string[] };
    const revs = db.prepare(`SELECT r.*, f.id fid FROM file_revisions r JOIN files f ON f.id=r.file_id
      WHERE ${mine.sql} ${revisionScope.sql} ${query.agent ? 'AND r.agent_id = ?' : ''} ${query.writes === '1' ? "AND r.origin <> 'initial_scan'" : ''}
      ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(...mine.args, ...revisionScope.args, ...agentArgs, limit) as never[];
    if (req.member) return { revisions: (revs as { fid: string }[]).map((r) => ({ file_id: r.fid, ...memberRev(revView(r as never)) })), access: [], last_scan: store.lastScan(), writes_disabled: store.writesDisabled() };
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
    if (req.member && !req.member.canSee(rel.join('/'))) throw noPath();
    const file = req.member ? await memberPath(() => vault.stat(rel)) : await vault.stat(rel);
    const preview = file.is_text && file.size !== null && file.size <= 1024 * 1024 ? await vault.read(rel, 0, 24000) : null;
    // An external user's preview is audited (docs/multi-user.md §3); other member reads are not.
    if (req.member?.external) audit.event(actor(req), 'vault.preview', { kind: 'vault_file', id: file.path }, { path: file.path, bytes: preview ? Buffer.byteLength(preview.content) : 0 });
    return reply.header('Cache-Control', 'no-store').send({ ...file, preview });
  });

  /**
   * The one byte path for originals (docs/vault.md, "Media and attachments"), for the operator and members. Every
   * request, each range and HEAD included, is authorized from scratch before any size or byte leaves: path containment,
   * the member's grant and restricted folders, and may_export. Reads are bound to the revision the store records.
   */
  // One audit row per member, file revision and representation per window: the last time each key was recorded.
  const mediaAudited = new Map<string, number>();
  const mediaAuditDue = (key: string): boolean => {
    const now = Date.now(), last = mediaAudited.get(key);
    if (last !== undefined && now - last < MEDIA_AUDIT_WINDOW_MS) return false;
    if (mediaAudited.size >= 10_000) for (const [k, t] of mediaAudited) if (now - t >= MEDIA_AUDIT_WINDOW_MS) mediaAudited.delete(k);
    mediaAudited.set(key, now);
    return true;
  };
  api.get('/api/vault/media', async (req, reply) => {
    const query = q(req), m = req.member;
    const { path, rel } = vault.normalise(query.path ?? '');
    const relStr = rel.join('/');
    if (m && !m.canSee(relStr)) throw noPath();
    // as=text is the editor's read (docs/vault.md "People writing in the vault"): Contribute on the folder, not export.
    const asText = query.as === 'text';
    if (asText && !EDITABLE.test(relStr)) throw new KeyError('invalid_argument', 'Only Markdown (.md) and text (.txt) files open in the editor.');
    if (m && asText && !m.canWrite(relStr)) throw new KeyError('read_only', READ_ONLY);
    if (m && !asText && !m.mayExportFile(relStr)) throw new KeyError('export_denied', MEDIA_EXPORT_DENIED);
    const open = async () => {
      const real = await vault.resolve(rel);
      if (!(await fs.stat(real)).isFile()) throw new VaultError('invalid_argument', 'this is a folder');
      const fh = await fs.open(real, 'r');
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new VaultError('invalid_argument', 'this is a folder');
        if (st.size > MAX_TRACK) throw new VaultError('too_large', 'The file is larger than 64 MB, so the vault does not track it.');
        const revision = await store.observe(rel);
        const row = store.fileByPath(relStr);
        if (!revision.startsWith('sha256:')) throw noPath();
        // The open file is the one the store recorded: same revision, size and modification time.
        if (!row || row.current_revision !== revision || row.size !== st.size || row.mtime !== Math.round(st.mtimeMs)) throw new KeyError('conflict', 'The file changed while it was being read. Try again.', { reason: 'changed' });
        const head = Buffer.alloc(Math.min(SNIFF_BYTES, st.size));
        if (head.length) await fh.read(head, 0, head.length, 0);
        return { fh, size: st.size, revision, type: sniffInline(head) };
      } catch (e) { await fh.close(); throw e; }
    };
    // A member's missing, hidden or escaping path all answer the same not_found: nothing tells them apart.
    const f = m ? await memberPath(() => open().catch((e) => { throw e instanceof VaultError && e.code === 'denied' ? noPath() : e; })) : await open();
    let handed = false;
    try {
      if (query.rev && query.rev !== f.revision) throw new KeyError('conflict', 'The file has changed since it was opened. Reload to see the current version.', { reason: 'changed' });
      if (asText) {
        if (f.size > MAX_CONTENT) throw new KeyError('too_large', 'The file is larger than 2 MB, so it cannot be edited here.');
        const text = Buffer.alloc(f.size);
        if (f.size) await f.fh.read(text, 0, f.size, 0);
        if (text.includes(0)) throw new KeyError('binary', 'This file is not plain text, so it cannot be edited here.');
        // An external member's edit read is audited like a preview, once per revision in the window.
        if (m?.external && req.method !== 'HEAD' && mediaAuditDue(`${m.userId}|${f.revision}|text`)) audit.event(actor(req), 'vault.preview', { kind: 'vault_file', id: path }, { path, bytes: f.size, edit: true });
        reply.code(200).type('text/plain; charset=utf-8').header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').header('ETag', `"${f.revision}"`).header('X-Revision', f.revision);
        return reply.send(req.method === 'HEAD' ? '' : text);
      }
      const etag = `"${f.revision}"`, inline = query.as !== 'attachment' && f.type !== null;
      reply.header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff').header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Content-Security-Policy', "sandbox; default-src 'none'").header('Accept-Ranges', 'bytes').header('ETag', etag)
        .header('Content-Disposition', disposition(inline ? 'inline' : 'attachment', rel.at(-1) ?? 'file'));
      const inm = req.headers['if-none-match'];
      if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*')) return reply.code(304).send();
      const ifRange = [req.headers['if-range']].flat()[0];
      const r = ifRange && ifRange.trim() !== etag ? { kind: 'none' as const } : parseRange(req.headers.range, f.size);
      if (r.kind === 'unsatisfiable') return reply.code(416).header('Content-Range', `bytes */${f.size}`).send();
      const start = r.kind === 'range' ? r.start : 0, end = r.kind === 'range' ? r.end : f.size - 1, length = Math.max(0, end - start + 1);
      // Audited as today (docs/multi-user.md §3): a member's download and an external user's playback, whenever a
      // response sends bytes (not HEAD; 304 and 416 returned above), whatever range it starts from. Seeking and resuming
      // fold into one row per member, revision and representation within MEDIA_AUDIT_WINDOW_MS.
      if (m && req.method !== 'HEAD' && length > 0 && (!inline || m.external) && mediaAuditDue(`${m.userId}|${f.revision}|${inline ? 'inline' : 'attachment'}`)) {
        if (!inline) audit.event(actor(req), 'export.read', { kind: 'vault_file', id: path }, { what: 'vault_file', path, bytes: f.size });
        else audit.event(actor(req), 'vault.preview', { kind: 'vault_file', id: path }, { path, bytes: f.size, media: true });
      }
      reply.code(r.kind === 'range' ? 206 : 200).type(inline ? f.type!.mime : 'application/octet-stream').header('Content-Length', String(length));
      if (r.kind === 'range') reply.header('Content-Range', `bytes ${start}-${end}/${f.size}`);
      if (req.method === 'HEAD' || length === 0) return reply.send(Readable.from([]));
      handed = true;
      return reply.send(f.fh.createReadStream({ start, end, autoClose: true }));
    } finally { if (!handed) await f.fh.close(); }
  });

  api.get('/api/vault/revisions/:fileId', async (req) => {
    const m = req.member, f = fileOr404((req.params as { fileId: string }).fileId, m);
    const revs = store.revisions(f.id, int(q(req).limit, 100, 1, 500)).map(revView);
    // A member never sees a path the file had outside the grant (moved in from elsewhere).
    return { file: { id: f.id, path: vault.virtual(f.path.split('/')), current_revision: f.current_revision, deleted: f.deleted_at !== null },
      revisions: m ? revs.filter((r) => m.canSee(r.path.split('/').slice(2).join('/'))).map(memberRev) : revs };
  });

  api.get('/api/vault/diff', async (req) => {
    const { file, from, to } = q(req);
    if (!file || !from) throw new KeyError('invalid_argument', 'file and from are required');
    const f = fileOr404(file, req.member);
    // A member diffs only revisions the file had inside the grant: one made while it sat elsewhere (a restricted folder,
    // another project) answers like an unknown revision. The same content at a visible path is visible.
    if (req.member) {
      const m = req.member;
      for (const rev of [from, to || f.current_revision].filter((x): x is string => !!x && x !== 'tombstone' && x !== 'absent')) {
        const paths = db.prepare('SELECT path_at_revision p FROM file_revisions WHERE file_id=? AND revision=?').all(f.id, rev) as { p: string }[];
        if (!paths.some((r) => m.canSee(r.p))) throw new VaultError('not_found', 'no such revision for this file');
      }
    }
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
