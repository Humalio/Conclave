/**
 * People writing in the vault from the console (docs/vault.md "People writing in the vault"): create, upload, edit,
 * rename, remove and restore. The routes call the same store functions agents use; the person is the author.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Vault } from '../vault/vault.js';
import { VaultError } from '../vault/vault.js';
import type { VaultStore, Who, Person } from '../vault/store.js';
import { MAX_CONTENT } from '../vault/store.js';
import { MIRROR_FOLDER } from '../mirror/folder.js';
import { MemberScope } from './memberScope.js';

export const READ_ONLY = 'This folder is read only for you.';
export const RESERVED_FOLDER = `${MIRROR_FOLDER} is the hub's folder: nobody can write there.`;
/** Files the editor opens: plain text up to the vault's content limit. */
export const EDITABLE = /\.(md|txt)$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/**
 * Why a person may not write at this vault-relative path, or null. Checked before the store on create, upload, edit,
 * remove, restore and both ends of a rename. `hidden` is the vault's hidden-name test.
 */
export function refusedPath(rel: string[], hidden: (seg: string) => boolean): { reason: string; message: string } | null {
  if (rel.length === 0 || rel.some((s) => !s)) return { reason: 'invalid_path', message: 'A file name is required.' };
  if (rel[0]!.toLowerCase() === MIRROR_FOLDER.toLowerCase()) return { reason: 'reserved', message: RESERVED_FOLDER };
  for (const s of rel) {
    if (/[. ]$/.test(s)) return { reason: 'trailing', message: `"${s}" ends with a dot or a space, which Windows cannot store.` };
    if (hidden(s) || s === '.' || s === '..') return { reason: 'hidden', message: `"${s}" is a hidden name in the vault; choose another name.` };
    if (WINDOWS_RESERVED.test(s)) return { reason: 'windows_reserved', message: `"${s}" is a name Windows reserves; choose another name.` };
    if (BAD_CHARS.test(s)) return { reason: 'bad_char', message: `"${s}" has a character the vault cannot store (< > : " | ? * \\).` };
  }
  return null;
}

/** "Meeting notes" becomes "Meeting notes.md"; a name that has an extension keeps it. */
export const withNoteExtension = (rel: string[]): string[] => (/\.[^./]+$/.test(rel.at(-1) ?? '') ? rel : [...rel.slice(0, -1), `${rel.at(-1)}.md`]);

export interface VaultWriteDeps { db: Db; audit: Audit; vault: Vault; store: VaultStore }

export function registerVaultWriteApi(api: FastifyInstance, d: VaultWriteDeps, actor: (r: FastifyRequest) => Actor): void {
  const { db, audit, vault, store } = d;

  /** A raw console path to its parts, refused with a reason the console shows. Hidden names fail normalise as denied. */
  const target = (raw: string | undefined): { path: string; rel: string[]; relStr: string } => {
    let n: { path: string; rel: string[] };
    try { n = vault.normalise(raw ?? ''); } catch (e) {
      if (e instanceof VaultError && e.code === 'denied') {
        const segs = (raw ?? '').split('/').filter(Boolean);
        if (segs[0] === vault.alias) segs.shift();
        const why = refusedPath(segs, (x) => vault.isHidden(x)) ?? { reason: 'hidden', message: 'This path uses a hidden name in the vault; choose another name.' };
        throw new KeyError('invalid_path', why.message, { reason: why.reason });
      }
      throw e;
    }
    const refused = refusedPath(n.rel, (s) => vault.isHidden(s));
    if (refused) throw new KeyError('invalid_path', refused.message, { reason: refused.reason });
    return { ...n, relStr: n.rel.join('/') };
  };
  /**
   * A path that differs only in case from another file would be a second name for it on Windows and macOS. Run after
   * the member check, and a member is never told the name of a file they cannot see.
   */
  const refuseAlias = (req: FastifyRequest, relStr: string, except?: string) => {
    const other = store.aliasOf(relStr);
    if (!other || other === except) return;
    if (req.member && !req.member.canSee(other)) throw new KeyError('conflict', 'A file with this name in other capitals already exists; choose another name.', { reason: 'case_mismatch' });
    throw new KeyError('conflict', `${vault.virtual(other.split('/'))} already exists with different capitals; use that name or another one.`, { reason: 'case_mismatch', path: vault.virtual(other.split('/')) });
  };

  /**
   * The person writing, with a check run just before the commit point. A member must see the path (else it answers as
   * missing) and hold Contribute on it through a folder grant (MemberScope.canWrite, which keeps restricted folders
   * out; else read only), now and again at save. Agents write through their own tools, not here.
   */
  const person = (req: FastifyRequest, relStrs: string[]): Who => {
    const m = req.member;
    if (!m) { const id = actor(req).id!; return { adminId: id, person: { kind: 'operator', userId: id } satisfies Person }; }
    const check = (scope: MemberScope) => {
      for (const p of relStrs) {
        if (!scope.canSee(p)) throw new VaultError('not_found', 'no such file');
        if (!scope.canWrite(p)) throw new KeyError('read_only', READ_ONLY);
      }
    };
    check(m);
    return { person: { kind: 'collaborator', userId: m.userId }, recheck: () => check(new MemberScope(db, m.userId, m.external)) };
  };
  const kind = (who: Who) => who.person!.kind;
  /** Store refusals carry the revisions the console needs (the error handler sends KeyError details only). */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof VaultError) throw new KeyError(e.code, e.message, e.extra);
      throw e;
    }
  };
  const fileIdOf = (relStr: string) => store.fileByPath(relStr, true)?.id ?? null;
  const tooLarge = (n: number) => { if (n > MAX_CONTENT) throw new KeyError('too_large', `The file is larger than ${MAX_CONTENT / (1024 * 1024)} MB, the vault's limit for files written here.`); };

  // Uploads come as raw bytes (a 2 MB file would not fit the JSON body limit once encoded).
  // The bridge's parser (1 MB) is inherited here; this scope replaces it with one sized for the vault's limit.
  if (api.hasContentTypeParser('application/octet-stream')) api.removeContentTypeParser('application/octet-stream');
  api.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_CONTENT + 1 }, (_r, body, done) => done(null, body));

  /** New note (JSON { path, text }) or upload (raw bytes, ?path=). A taken name is refused; nothing is overwritten. */
  api.post('/api/vault/files', { bodyLimit: MAX_CONTENT + 64 * 1024 }, async (req) => {
    const upload = Buffer.isBuffer(req.body);
    if (upload && req.member) throw new KeyError('admin_only', 'Uploading is for the operator for now.');
    const b = upload ? { path: (req.query as { path?: string }).path ?? '', text: '' } : z.object({ path: z.string().min(1).max(1024), text: z.string().optional() }).parse(req.body ?? {});
    let t = target(b.path);
    if (!upload) {
      const rel = withNoteExtension(t.rel);
      t = { path: vault.virtual(rel), rel, relStr: rel.join('/') };
      if (!EDITABLE.test(t.relStr)) throw new KeyError('invalid_argument', 'A new note is a Markdown (.md) or text (.txt) file.');
    }
    const bytes = upload ? (req.body as Buffer) : Buffer.from(b.text ?? '', 'utf8');
    tooLarge(bytes.length);
    // The member check comes first: a refusal never names a file the member cannot see.
    const who = person(req, [t.relStr]);
    refuseAlias(req, t.relStr);
    const r = await run(() => store.write(t.rel, bytes, 'absent', 'create', who)).catch((e) => {
      if (e instanceof KeyError && e.code === 'conflict' && !e.extra?.reason) throw new KeyError('conflict', `${t.path} already exists; choose another name.`, { reason: 'exists' });
      throw e;
    });
    audit.event(actor(req), 'vault.file.create', { kind: 'vault_file', id: t.path }, { path: t.path, revision: r.revision, author_kind: kind(who), bytes: bytes.length, ...(upload ? { upload: true } : {}) });
    return { path: t.path, revision: r.revision, file_id: fileIdOf(t.relStr) };
  });

  /** Save edited text with the revision it was opened at. A stale base writes nothing and records no conflict. */
  api.put('/api/vault/files', { bodyLimit: MAX_CONTENT + 64 * 1024 }, async (req) => {
    const b = z.object({ path: z.string().min(1).max(1024), text: z.string(), base_revision: z.string().min(1).max(100) }).parse(req.body ?? {});
    const t = target(b.path);
    if (!EDITABLE.test(t.relStr)) throw new KeyError('invalid_argument', 'Only Markdown (.md) and text (.txt) files can be edited here.');
    const bytes = Buffer.from(b.text, 'utf8');
    tooLarge(bytes.length);
    const who = person(req, [t.relStr]);
    const r = await run(() => store.write(t.rel, bytes, b.base_revision, 'update', who)).catch((e) => {
      if (e instanceof KeyError && e.code === 'conflict') throw new KeyError('conflict', e.message, { ...e.extra, reason: e.extra?.conflict_id ? 'external_during_commit' : e.extra?.reason ?? 'changed', file_id: fileIdOf(t.relStr) });
      throw e;
    });
    if (r.revision !== r.previous_revision) audit.event(actor(req), 'vault.file.update', { kind: 'vault_file', id: t.path }, { path: t.path, revision: r.revision, previous_revision: r.previous_revision, author_kind: kind(who), bytes: bytes.length });
    return { path: t.path, revision: r.revision, previous_revision: r.previous_revision };
  });

  /** Rename or move a file. Both ends are checked; links are not rewritten. */
  api.post('/api/vault/files/rename', async (req) => {
    const b = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024), base_revision: z.string().min(1).max(100) }).parse(req.body ?? {});
    const from = target(b.from), to = target(b.to);
    const who = person(req, [from.relStr, to.relStr]);
    refuseAlias(req, to.relStr, from.relStr);
    const r = await run(() => store.rename(from.rel, to.rel, b.base_revision, who)).catch((e) => {
      if (e instanceof KeyError && e.code === 'conflict' && e.extra?.reason === 'destination_exists') throw new KeyError('conflict', `${to.path} already exists; choose another name.`, { reason: 'exists' });
      if (e instanceof KeyError && e.code === 'conflict') throw new KeyError('conflict', e.message, { ...e.extra, reason: e.extra?.reason ?? 'changed' });
      throw e;
    });
    audit.event(actor(req), 'vault.file.rename', { kind: 'vault_file', id: to.path }, { from: from.path, path: to.path, revision: r.revision, author_kind: kind(who) });
    return { path: to.path, revision: r.revision };
  });

  /** Remove: always a soft delete, restorable from History. */
  api.delete('/api/vault/files', async (req) => {
    const qy = req.query as { path?: string; base_revision?: string };
    if (!qy.base_revision) throw new KeyError('invalid_argument', 'base_revision is required');
    const t = target(qy.path);
    const who = person(req, [t.relStr]);
    const r = await run(() => store.delete(t.rel, qy.base_revision!, who)).catch((e) => {
      if (e instanceof KeyError && e.code === 'conflict') throw new KeyError('conflict', e.message, { ...e.extra, reason: e.extra?.reason ?? 'changed' });
      throw e;
    });
    audit.event(actor(req), 'vault.file.delete', { kind: 'vault_file', id: t.path }, { path: t.path, revision: 'tombstone', previous_revision: r.previous_revision, author_kind: kind(who) });
    return { path: t.path, previous_revision: r.previous_revision };
  });

  /**
   * Restore an earlier revision, or a removed file, as a new revision. `to` restores under another name (offered when
   * the path was taken since). The base is the target's current revision, or "absent".
   */
  api.post('/api/vault/files/restore', async (req) => {
    const b = z.object({ path: z.string().min(1).max(1024), revision: z.string().min(1).max(100), base_revision: z.string().min(1).max(100), to: z.string().min(1).max(1024).optional() }).parse(req.body ?? {});
    const src = target(b.path);
    const dst = b.to ? target(b.to) : src;
    const file = store.fileByPath(src.relStr, true);
    if (!file || !store.revisions(file.id, 1000).some((r) => r.revision === b.revision) || b.revision === 'tombstone') throw new KeyError('not_found', 'No such revision for this file.');
    const who = person(req, [dst.relStr]);
    if (dst !== src) refuseAlias(req, dst.relStr, src.relStr);
    const bytes = await store.getBlob(b.revision);
    if (!bytes) throw new KeyError('not_found', 'That version was not kept, so it cannot be restored.');
    const r = await run(() => store.write(dst.rel, bytes, b.base_revision, 'restore', who)).catch((e) => {
      if (e instanceof KeyError && e.code === 'conflict' && b.base_revision === 'absent') throw new KeyError('conflict', `${dst.path} is taken now. Restore it under another name.`, { reason: 'taken', current_revision: e.extra?.current_revision });
      if (e instanceof KeyError && e.code === 'conflict') throw new KeyError('conflict', e.message, { ...e.extra, reason: e.extra?.reason ?? 'changed' });
      throw e;
    });
    audit.event(actor(req), 'vault.file.restore', { kind: 'vault_file', id: dst.path }, { path: dst.path, revision: r.revision, restored_from: b.revision, author_kind: kind(who), ...(dst !== src ? { from: src.path } : {}) });
    return { path: dst.path, revision: r.revision };
  });

  /** How many notes the viewer can read link to (or embed) this file, with its current revision. Notes the viewer cannot read are never counted. */
  api.get('/api/vault/backlinks', async (req) => {
    const { rel } = vault.normalise((req.query as { path?: string }).path ?? '');
    const relStr = rel.join('/'), m = req.member;
    if (m && !m.canSee(relStr)) throw new VaultError('not_found', 'no such file');
    const f = store.fileByPath(relStr);
    if (!f) return { count: 0 };
    const srcs = db.prepare(`SELECT DISTINCT s.path FROM kg_signals k JOIN files s ON s.id=k.src_file
      WHERE k.dst_file=? AND k.kind IN ('link','embed') AND s.deleted_at IS NULL AND s.id<>?`).all(f.id, f.id) as { path: string }[];
    const visible = srcs.filter((s) => !s.path.split('/').some((x) => vault.isHidden(x)) && (!m || m.canSee(s.path)));
    // The revision and id let the console send the base of a rename or removal it opens from here.
    return { count: visible.length, revision: f.current_revision, file_id: f.id };
  });
}
