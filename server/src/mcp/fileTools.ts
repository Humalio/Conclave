/** Vault write tools (design/08 "Files (the vault)"): create, update, patch, rename, delete, history, diff, restore, conflicts. */
import { NOT_ALLOWED } from '../policy/engine.js';
import { z } from 'zod';
import type { OwnerScope } from '../policy/ownerScope.js';
import type { Keys } from '../keys/keys.js';
import type { Teams } from '../teams/teams.js';
import type { Vault } from '../vault/vault.js';
import { VaultError } from '../vault/vault.js';
import type { VaultStore, Who, RevisionRow } from '../vault/store.js';
import { MAX_CONTENT } from '../vault/store.js';
import { authorize } from '../policy/engine.js';

type Out = { text: string; data: Record<string, unknown> };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;
type ToolErrorCtor = new (code: string, message: string, extra?: Record<string, unknown>) => Error;
export interface FileToolDeps { store: VaultStore; vault: Vault; keys: Keys; teams: Teams; ToolError: ToolErrorCtor; hint?: (agentId: string, relPath: string) => string | null; ownerScope?: OwnerScope }

const BASE = z.string().max(100).describe('The revision (sha256:...) you last read; use "absent" for a file that does not exist');

export function registerFileWriteTools(reg: Reg, d: FileToolDeps): void {
  const { store, vault, keys, teams, ToolError, hint } = d;
  const withHint = (ctx: any, rel: string[], text: string, data: Record<string, unknown>): Out => {
    const h = hint?.(ctx.session.agent.id, rel.join('/')) ?? null;
    return { text: h ? `${text}\n${h}` : text, data: h ? { ...data, graph_hint: h } : data };
  };
  const DENIED = NOT_ALLOWED;

  /** Who is writing, plus a re-check run just before the commit point (the key may have been revoked meanwhile). */
  const who = (ctx: any, action: string, paths: string[]): Who => {
    const s = ctx.session;
    teams.guardWrite(s.agent.id);
    return {
      agentId: s.agent.id, credentialId: s.cred.id,
      recheck: () => {
        const c = keys.credential(s.cred.id);
        if (!c || keys.effectiveStatus(c) !== 'active') throw new VaultError('denied', DENIED);
        for (const p of paths) {
          // At commit: the key's current rules, the app key's cap and the owner ceilings as they are now.
          const appCap = keys.rulesFor(ctx.app.id), cap = d.ownerScope ? d.ownerScope.cap(s.agent.id, appCap) : appCap;
          const dec = authorize(keys.rulesFor(s.cred.id), cap, action, `path:${p}`, { isPaused: teams.isPaused });
          if (!dec.allowed) throw dec.source === 'paused' ? new ToolError('paused', 'The team is paused.') : new VaultError('denied', DENIED);
        }
      },
    };
  };
  const norm = (p: unknown) => vault.normalise(String(p));
  /**
   * Revisions recorded at a path this login may still see. A file renamed in from a folder the caller cannot read keeps its
   * earlier revisions for those who can, but they are not shown (or diffable) here: they are the old folder's history.
   */
  const mayAt = (ctx: any, relPath: string, actions: string[]) =>
    actions.every((act) => authorize(ctx.session.rules, ctx.session.cap, act, `path:${vault.virtual(relPath.split('/'))}`).allowed);
  const visible = (ctx: any, rows: RevisionRow[]) => {
    const ok = new Map<string, boolean>();
    return rows.filter((r) => ok.get(r.path_at_revision) ?? ok.set(r.path_at_revision, mayAt(ctx, r.path_at_revision, ['fs.history'])).get(r.path_at_revision)!);
  };
  /** A revision the caller may use: recorded (at least once) at a path where it holds every one of these actions. */
  const revisionVisible = (ctx: any, fileId: string, revision: string, actions: string[]) =>
    store.revisionPaths(fileId, revision).some((p) => mayAt(ctx, p, actions));
  const label = (id: string | null) => (id ? keys.agent(id)?.label ?? null : null);
  const content = z.string().max(MAX_CONTENT).describe('Full text content (UTF-8)');

  reg('file_create', 'Create a new text file in the vault (parent folders are created). Fails with conflict if the path exists.', {
    path: z.string(), content,
  }, true, async (ctx, a) => {
    const { path, rel } = norm(a.path);
    ctx.need('fs.create', path);
    const r = await store.write(rel, Buffer.from(a.content, 'utf8'), 'absent', 'create', who(ctx, 'fs.create', [path]));
    return { text: `Created ${path} (revision ${r.revision})`, data: { path, revision: r.revision } };
  });

  reg('file_update', 'Replace the full content of a vault file. base_revision must be the revision you read; otherwise you get a conflict with current_revision.', {
    path: z.string(), content, base_revision: BASE,
  }, true, async (ctx, a) => {
    const { path, rel } = norm(a.path);
    ctx.need('fs.update', path);
    const r = await store.write(rel, Buffer.from(a.content, 'utf8'), a.base_revision, 'update', who(ctx, 'fs.update', [path]));
    return withHint(ctx, rel, `Updated ${path} (revision ${r.revision})`, { path, revision: r.revision, previous_revision: r.previous_revision });
  });

  reg('file_patch', 'Edit a vault file with exact text replacements. Each edit\'s old text must occur exactly once (add context to make it unique). Edits apply in order.', {
    path: z.string(), base_revision: BASE,
    edits: z.array(z.object({ old: z.string().min(1).max(MAX_CONTENT), new: z.string().max(MAX_CONTENT) })).min(1).max(50),
  }, true, async (ctx, a) => {
    const { path, rel } = norm(a.path);
    ctx.need('fs.update', path);
    const cur = await store.current(rel);
    if (!cur) throw new ToolError('not_found', DENIED);
    const w = who(ctx, 'fs.update', [path]);
    if (cur.revision !== a.base_revision) await store.write(rel, cur.bytes, a.base_revision, 'patch', w); // records and throws the conflict
    let text = cur.bytes.toString('utf8');
    (a.edits as { old: string; new: string }[]).forEach((e, i) => {
      const n = text.split(e.old).length - 1;
      if (n === 0) throw new ToolError('no_match', `edit ${i}: the old text was not found. Nothing was changed.`, { edit_index: i, matches: 0 });
      if (n > 1) throw new ToolError('ambiguous_match', `edit ${i}: the old text occurs ${n} times; include more surrounding text so it matches once. Nothing was changed.`, { edit_index: i, matches: n });
      const at = text.indexOf(e.old);
      text = text.slice(0, at) + e.new + text.slice(at + e.old.length);
    });
    const r = await store.write(rel, Buffer.from(text, 'utf8'), a.base_revision, 'patch', w);
    return withHint(ctx, rel, `Patched ${path} (revision ${r.revision})`, { path, revision: r.revision, previous_revision: r.previous_revision, edits_applied: a.edits.length });
  });

  reg('file_rename', 'Rename or move a vault file. The destination must not exist. base_revision is the current revision of the source.', {
    from: z.string(), to: z.string(), base_revision: BASE,
  }, true, async (ctx, a) => {
    const f = norm(a.from), t = norm(a.to);
    ctx.need('fs.rename', f.path);
    ctx.need('fs.rename', t.path);
    const r = await store.rename(f.rel, t.rel, a.base_revision, who(ctx, 'fs.rename', [f.path, t.path]));
    const s = ctx.session;
    const linked = await vault.linkedFrom(f.rel, (p) => authorize(s.rules, s.cap, 'fs.read', `path:${p}`).allowed);
    return { text: `Renamed ${f.path} to ${t.path}${linked.length ? `; ${linked.length} note(s) still link to the old name` : ''}`, data: { from: f.path, path: t.path, revision: r.revision, still_linking_to_old_name: linked } };
  });

  reg('file_delete', 'Delete a vault file. Recoverable: the content is kept and can be brought back with file_restore.', {
    path: z.string(), base_revision: BASE,
  }, true, async (ctx, a) => {
    const { path, rel } = norm(a.path);
    ctx.need('fs.delete', path);
    const r = await store.delete(rel, a.base_revision, who(ctx, 'fs.delete', [path]));
    return { text: `Deleted ${path} (recoverable; last revision ${r.previous_revision})`, data: { path, deleted: true, last_revision: r.previous_revision } };
  });

  reg('file_history', 'Revisions of a vault file, newest first: who, when, origin (platform or external_observed).', {
    path: z.string(), limit: z.number().int().min(1).max(200).optional(),
  }, true, async (ctx, a) => {
    const { path, rel } = norm(a.path);
    ctx.need('fs.history', path);
    await store.observe(rel);
    const file = store.fileByPath(rel.join('/'), true);
    if (!file) throw new ToolError('not_found', DENIED);
    const revisions = visible(ctx, store.revisions(file.id, 1000)).slice(0, a.limit ?? 50).map((r) => ({
      revision: r.revision, parent_revision: r.parent_revision, op: r.op, origin: r.origin, recovered: !!r.recovered, path: r.path_at_revision, size: r.size, at: r.created_at,
      by: r.agent_id ? { agent_id: r.agent_id, label: label(r.agent_id) } : store.personLabel(r.author_kind, r.user_id) ?? (r.admin_id ? { kind: 'operator', label: 'Operator' } : null),
    }));
    return {
      text: `${path}: ${revisions.length} revision(s), current ${file.current_revision ?? 'deleted'}\n${revisions.map((r) => `${new Date(r.at).toISOString()} ${r.op} [${r.origin}] ${r.revision}${r.by && 'label' in r.by ? ` by ${r.by.label ?? ('agent_id' in r.by ? r.by.agent_id : '')}` : ''}`).join('\n')}`,
      data: { trust: 'L2', path, current_revision: file.current_revision, deleted: file.deleted_at !== null, revisions },
    };
  });

  reg('file_diff', 'Unified diff between two revisions of a vault file (to_revision defaults to the current one).', {
    path: z.string(), from_revision: z.string().max(100), to_revision: z.string().max(100).optional(),
  }, true, async (ctx, a) => {
    const { path, rel } = norm(a.path);
    ctx.need('fs.history', path);
    ctx.need('fs.read', path);
    await store.observe(rel);
    const file = store.fileByPath(rel.join('/'), true);
    if (!file) throw new ToolError('not_found', DENIED);
    for (const want of [a.from_revision, a.to_revision ?? file.current_revision]) {
      if (want && want !== 'tombstone' && want !== 'absent' && !revisionVisible(ctx, file.id, want, ['fs.history', 'fs.read'])) throw new ToolError('not_found', 'No such revision for this file.');
    }
    const r = await store.diff(file, a.from_revision, a.to_revision);
    const truncated = r.diff.length > 90_000;
    const diff = truncated ? r.diff.slice(0, 90_000) : r.diff;
    return { text: r.identical ? 'No differences.' : diff, data: { trust: 'L2', from: 'external', kind: 'diff', path, from_revision: r.from, to_revision: r.to, identical: r.identical, truncated, diff } };
  });

  reg('file_restore', 'Bring back an earlier revision of a vault file (also recreates a deleted file; use base_revision "absent" then). Creates a new revision.', {
    path: z.string(), revision: z.string().max(100), base_revision: BASE,
  }, true, async (ctx, a) => {
    const { path, rel } = norm(a.path);
    ctx.need('fs.restore', path);
    await store.observe(rel);
    const file = store.fileByPath(rel.join('/'), true);
    if (!file || a.revision === 'tombstone' || !revisionVisible(ctx, file.id, a.revision, ['fs.read'])) throw new ToolError('not_found', 'No such revision for this file.');
    const bytes = await store.getBlob(a.revision);
    if (!bytes) throw new ToolError('not_found', 'That revision was not kept (too large), so it cannot be restored.');
    const base = a.base_revision === 'tombstone' ? 'absent' : a.base_revision;
    const r = await store.write(rel, bytes, base, 'restore', who(ctx, 'fs.restore', [path]));
    return { text: `Restored ${path} to ${a.revision} (new revision ${r.revision})`, data: { path, revision: r.revision, restored_from: a.revision } };
  });

  reg('file_conflicts', 'Open conflicts (competing versions kept side by side) in a vault folder or the whole vault.', {
    path_prefix: z.string().optional(),
  }, true, async (ctx, a) => {
    const s = ctx.session;
    const { path: prefix } = norm(a.path_prefix ?? `/${vault.alias}`);
    ctx.need('fs.conflicts', prefix);
    const out = store.conflicts('open')
      .map((c) => ({ c, vp: vault.virtual(c.path.split('/')) }))
      .filter(({ vp }) => (vp === prefix || vp.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) && authorize(s.rules, s.cap, 'fs.conflicts', `path:${vp}`).allowed)
      .slice(0, 100)
      .map(({ c, vp }) => ({
        id: c.id, path: vp, source: c.source, base_revision: c.base_revision, revisions: JSON.parse(c.revisions) as unknown,
        current_revision: store.fileById(c.file_id)?.current_revision ?? null, conflict_path: c.conflict_path ? vault.virtual(c.conflict_path.split('/')) : null, created_at: c.created_at,
      }));
    return { text: out.length ? out.map((c) => `${c.id} ${c.path} [${c.source}]`).join('\n') : 'No open conflicts.', data: { trust: 'L2', conflicts: out } };
  });
}
