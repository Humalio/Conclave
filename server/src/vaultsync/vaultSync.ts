/**
 * Vault sync, hub side (docs/vault-sync.md): the readers, the vault's change feed, the per-reader opaque cursor, the
 * scope decision (the same one file_read makes, plus the export right) and the coalesced hint.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import { authorize, type Rule } from '../policy/engine.js';
import type { OwnerScope } from '../policy/ownerScope.js';
import type { VaultStore, RevisionEvent } from '../vault/store.js';
import { hmacHex, randomToken, sha256Hex } from '../util/crypto.js';

/** The only actions a reader's rules may allow: it can never write. */
export const READER_ACTIONS = ['fs.list', 'fs.read', 'fs.search', 'fs.history', 'fs.download'] as const;
export const HINT_MS = 2000;
export const PAIR_ISSUES = 3;
const SCAN_ROWS = 5000;
const sys: Actor = { kind: 'system', id: null };

export class SyncError extends Error {
  constructor(public readonly code: 'invalid_argument' | 'unauthorized' | 'forbidden' | 'not_found' | 'invalid_state' | 'rate_limited' | 'unsupported', message: string) { super(message); }
}

export interface ReaderRow {
  id: string; agent_id: string; credential_id: string; machine_id: string; name: string; owner_user_id: string | null;
  state: 'pending' | 'active' | 'paused' | 'removed'; code_status: 'unused' | 'issued' | 'confirmed' | 'revoked'; code_issues: number;
  created_at: number; last_sync_at: number | null; files: number; bytes: number; removed_at: number | null;
}
export interface ScopeRule { effect: 'allow' | 'deny'; resource: string }
export type FeedEntry = { kind: 'put'; path: string; revision: string | null; size: number | null } | { kind: 'delete'; path: string } | { kind: 'rename'; path: string; from: string; revision: string | null };

interface ChangeRow { seq: number; file_id: string; kind: 'put' | 'delete' | 'rename'; path: string; old_path: string | null; revision: string | null }
const COLS = 'id,agent_id,credential_id,machine_id,name,owner_user_id,state,code_status,code_issues,created_at,last_sync_at,files,bytes,removed_at';

/** What a reader may mirror: the current decision for one reader, built once per request. */
export interface Scope { may(path: string): boolean; fingerprint: string }

export class VaultSync {
  /** Owner ceilings (docs/authorization.md#owner-enforcement); set by app.ts. */
  ownerScope: OwnerScope | null = null;
  /** The push stream: one `vault_changed` hint to the PC. Set by app.ts. */
  hintPc: ((pc: string, readerId: string) => void) | null = null;
  private readonly key: Buffer;
  private readonly lastHint = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly served = new Map<string, { files: number; bytes: number }>();

  constructor(private readonly db: Db, private readonly keys: Keys, private readonly audit: Audit, private readonly pepper: string, store: VaultStore, private readonly alias: string, private readonly now: () => number = Date.now) {
    this.key = createHash('sha256').update(`vault-sync-cursor:${pepper}`).digest();
    store.listeners.push((e) => this.onRevision(e));
    // Read-only in code: no other way to edit a reader's rules, and its key never logs in as a working agent.
    keys.ruleGuard = (policyId, rules) => this.guardRules(policyId, rules);
    keys.loginGuard = (credentialId) => { if (this.byCredential(credentialId)) throw new KeyError('forbidden', 'a vault reader key only syncs the vault; it cannot log in'); };
  }

  // ───────────── The feed ─────────────
  /** A revision was committed: one feed entry, then the hint to every reader that can see it. Never throws into the writer. */
  private onRevision(e: RevisionEvent): void {
    try {
      let kind: ChangeRow['kind'] = e.revision === 'tombstone' ? 'delete' : 'put', old: string | null = null;
      if (e.op === 'rename') {
        const prev = this.db.prepare('SELECT path_at_revision p FROM file_revisions WHERE file_id=? ORDER BY created_at DESC, rowid DESC LIMIT 2').all(e.fileId) as { p: string }[];
        old = prev[1]?.p ?? null;
        if (old && old !== e.path) kind = 'rename';
      }
      const r = this.db.prepare('INSERT INTO vault_changes(file_id,kind,path,old_path,revision,origin,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(e.fileId, kind, e.path, old, e.revision === 'tombstone' ? null : e.revision, e.origin, this.now());
      const row: ChangeRow = { seq: Number(r.lastInsertRowid), file_id: e.fileId, kind, path: e.path, old_path: old, revision: e.revision === 'tombstone' ? null : e.revision };
      this.hint(row);
    } catch (err) { console.error('vault change feed failed', err); }
  }
  head(): number { return (this.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM vault_changes').get() as { s: number }).s; }

  /** What one change means to a reader whose scope this is: nothing, a put, a delete or a rename. A rename across the edge is a delete or a put. */
  classify(c: ChangeRow, scope: Scope): FeedEntry | null {
    if (c.kind === 'put') return scope.may(c.path) ? { kind: 'put', path: c.path, revision: c.revision, size: this.sizeOf(c.path) } : null;
    if (c.kind === 'delete') return scope.may(c.path) ? { kind: 'delete', path: c.path } : null;
    const from = scope.may(c.old_path!), to = scope.may(c.path);
    if (from && to) return { kind: 'rename', path: c.path, from: c.old_path!, revision: c.revision };
    if (from) return { kind: 'delete', path: c.old_path! };
    if (to) return { kind: 'put', path: c.path, revision: c.revision, size: this.sizeOf(c.path) };
    return null;
  }
  private sizeOf(path: string): number | null {
    return (this.db.prepare('SELECT size FROM files WHERE path=? AND deleted_at IS NULL').get(path) as { size: number | null } | undefined)?.size ?? null;
  }

  // ───────────── The hint ─────────────
  /** At most one hint per reader every HINT_MS, only when the change is in the reader's scope, and no paths. */
  private hint(c: ChangeRow): void {
    if (!this.hintPc) return;
    for (const r of this.active()) {
      if (this.timers.has(r.id)) continue; // a hint is already due for this reader
      if (!this.visible(r, c)) continue;
      const wait = Math.max(0, (this.lastHint.get(r.id) ?? 0) + HINT_MS - this.now());
      if (wait === 0) this.send(r);
      else {
        const t = setTimeout(() => { this.timers.delete(r.id); this.send(r); }, wait);
        t.unref?.(); this.timers.set(r.id, t);
      }
    }
  }
  private visible(r: ReaderRow, c: ChangeRow): boolean {
    try { return this.classify(c, this.scope(r)) !== null; } catch { return false; }
  }
  private send(r: ReaderRow): void {
    const cur = this.reader(r.id);
    if (!cur || cur.state !== 'active') return;
    this.lastHint.set(r.id, this.now());
    this.hintPc?.(cur.machine_id, cur.id);
  }
  stop(): void { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }

  // ───────────── The decision ─────────────
  /** The reader's current scope: its rules narrowed by its owner's ceilings, and a fingerprint of both. */
  scope(r: ReaderRow): Scope {
    const rules = this.keys.rulesFor(r.credential_id);
    const cap = this.ownerScope ? this.ownerScope.cap(r.agent_id, []) : [];
    const layers = (cap as { owners?: readonly { owner: string | null; basis: string; task?: string; rules: Rule[] }[] }).owners ?? [];
    const fingerprint = sha256Hex(JSON.stringify({ r: rules.map((x) => [x.effect, x.actions, x.resource, x.not_before ?? null, x.not_after ?? null]), o: layers.map((l) => [l.owner, l.basis, l.task ?? null, l.rules.map((x) => [x.effect, x.actions, x.resource])]) })).slice(0, 16);
    const may = (path: string): boolean => {
      const res = `path:/${this.alias}/${path}`; // the feed's paths are relative to the vault's root
      return authorize(rules, cap, 'fs.read', res).allowed && authorize(rules, cap, 'fs.download', res).allowed;
    };
    return { may, fingerprint };
  }

  // ───────────── Cursors ─────────────
  private seal(o: { r: string; s: number; f: string }): string {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(o), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  }
  private open(token: string, readerId: string): { s: number; f: string } | null {
    try {
      const b = Buffer.from(token, 'base64url');
      if (b.length < 29) return null;
      const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      const o = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) as { r: string; s: number; f: string };
      return o.r === readerId && Number.isInteger(o.s) ? { s: o.s, f: o.f } : null;
    } catch { return null; }
  }

  /** Changes after a cursor, in scope now. `reset`: the cursor is not usable (a scope edit, or not ours): list the scope again. */
  changes(r: ReaderRow, cursor: string | null, limit: number): { entries: FeedEntry[]; cursor: string; more: boolean; reset: boolean } {
    const scope = this.scope(r), head = this.head();
    const cur = cursor ? this.open(cursor, r.id) : null;
    if (!cur || cur.f !== scope.fingerprint || cur.s > head) return { entries: [], cursor: this.seal({ r: r.id, s: head, f: scope.fingerprint }), more: false, reset: true };
    const out: FeedEntry[] = [];
    let last = cur.s, examined = 0, more = false;
    for (;;) {
      const rows = this.db.prepare('SELECT seq,file_id,kind,path,old_path,revision FROM vault_changes WHERE seq>? ORDER BY seq LIMIT 500').all(last) as unknown as ChangeRow[];
      if (!rows.length) break;
      let stop = false;
      for (const c of rows) {
        const e = this.classify(c, scope);
        if (e) { if (out.length >= limit) { stop = true; more = true; break; } out.push(e); }
        last = c.seq; examined++;
      }
      if (stop) break;
      if (examined >= SCAN_ROWS) { more = true; break; } // a long run of changes outside the scope: carry on with the next request
    }
    return { entries: out, cursor: this.seal({ r: r.id, s: last, f: scope.fingerprint }), more, reset: false };
  }

  /** The files in scope, in path order, after `after`; with the cursor to follow changes from (first page only). */
  files(r: ReaderRow, after: string | null, limit: number): { files: { path: string; revision: string; size: number }[]; next: string | null; cursor?: string } {
    const scope = this.scope(r), start = after === null ? this.head() : null;
    const out: { path: string; revision: string; size: number }[] = [];
    let from = after ?? '', done = false;
    while (!done && out.length < limit) {
      const rows = this.db.prepare('SELECT path,current_revision rev,size FROM files WHERE deleted_at IS NULL AND current_revision IS NOT NULL AND path>? ORDER BY path LIMIT 500').all(from) as { path: string; rev: string; size: number | null }[];
      if (!rows.length) done = true;
      for (const f of rows) {
        from = f.path;
        if (scope.may(f.path)) { out.push({ path: f.path, revision: f.rev, size: f.size ?? 0 }); if (out.length >= limit) break; }
      }
    }
    const res: { files: typeof out; next: string | null; cursor?: string } = { files: out, next: done ? null : from };
    if (start !== null) res.cursor = this.seal({ r: r.id, s: start, f: scope.fingerprint });
    return res;
  }

  /** A download: the current rules decide again, at the moment of the request. */
  mayDownload(r: ReaderRow, path: string): boolean { return this.scope(r).may(path); }
  isExternalOwner(r: ReaderRow): boolean {
    return !!r.owner_user_id && !!(this.db.prepare('SELECT external FROM admin_users WHERE id=?').get(r.owner_user_id) as { external: number } | undefined)?.external;
  }
  /** Bytes served to a reader since its last run entry, kept for the run's audit entry. */
  served1(r: ReaderRow, bytes: number): void {
    const s = this.served.get(r.id) ?? { files: 0, bytes: 0 };
    s.files++; s.bytes += bytes; this.served.set(r.id, s);
  }
  /** One audit entry per sync run (files and bytes); the reader's mirror totals are kept for the console. */
  run(r: ReaderRow, totals: { files: number; bytes: number }): void {
    const s = this.served.get(r.id) ?? { files: 0, bytes: 0 };
    this.served.delete(r.id);
    this.db.prepare('UPDATE vault_readers SET last_sync_at=?, files=?, bytes=? WHERE id=?').run(this.now(), totals.files, totals.bytes, r.id);
    this.audit.event({ kind: 'agent', id: r.agent_id }, 'vault_sync.run', { kind: 'vault_reader', id: r.id }, { reader: r.name, files: s.files, bytes: s.bytes, mirror_files: totals.files, mirror_bytes: totals.bytes });
  }

  // ───────────── Rules stay read-only ─────────────
  private guardRules(policyId: string, rules: Omit<Rule, 'id'>[]): void {
    const own = this.db.prepare('SELECT 1 x FROM vault_readers v JOIN credentials c ON c.id=v.credential_id WHERE c.policy_id=? AND v.state<>\'removed\'').get(policyId);
    if (!own) return;
    for (const r of rules) {
      if (r.effect === 'allow' && r.actions.some((a) => !(READER_ACTIONS as readonly string[]).includes(a))) throw new KeyError('invalid_argument', `a vault reader is read-only: its rules may allow only ${READER_ACTIONS.join(', ')}`);
    }
  }

  // ───────────── Readers (the console) ─────────────
  reader(id: string): ReaderRow | null { return (this.db.prepare(`SELECT ${COLS} FROM vault_readers WHERE id=?`).get(id) as unknown as ReaderRow) ?? null; }
  byCredential(credentialId: string): ReaderRow | null { return (this.db.prepare(`SELECT ${COLS} FROM vault_readers WHERE credential_id=?`).get(credentialId) as unknown as ReaderRow) ?? null; }
  private active(): ReaderRow[] { return this.db.prepare(`SELECT ${COLS} FROM vault_readers WHERE state='active'`).all() as unknown as ReaderRow[]; }
  private rulesOf(scope: ScopeRule[]): Omit<Rule, 'id'>[] {
    if (!Array.isArray(scope) || scope.length === 0 || scope.length > 100) throw new SyncError('invalid_argument', 'scope: 1 to 100 rules');
    return scope.map((s) => {
      if ((s.effect !== 'allow' && s.effect !== 'deny') || typeof s.resource !== 'string' || !/^path:\/[^\s]+$/.test(s.resource)) throw new SyncError('invalid_argument', 'a scope rule is allow or deny on path:/vault/…');
      return { effect: s.effect, actions: [...READER_ACTIONS], resource: s.resource, note: 'vault sync scope' };
    });
  }
  view(r: ReaderRow) {
    const pc = this.keys.machine(r.machine_id);
    const rules = this.keys.rules(this.keys.credential(r.credential_id)!.policy_id).map((x) => ({ effect: x.effect, resource: x.resource }));
    return { id: r.id, name: r.name, agent_id: r.agent_id, owner_user_id: r.owner_user_id, machine_id: r.machine_id, pc: pc?.name ?? null, state: r.state, scope: rules,
      pairing: r.code_status, created_at: r.created_at, last_sync_at: r.last_sync_at, files: r.files, bytes: r.bytes };
  }
  list() { return (this.db.prepare(`SELECT ${COLS} FROM vault_readers WHERE state<>'removed' ORDER BY created_at DESC`).all() as unknown as ReaderRow[]).map((r) => this.view(r)); }
  get(id: string) { const r = this.reader(id); if (!r || r.state === 'removed') throw new SyncError('not_found', 'vault reader not found'); return this.view(r); }

  /** A reader: a teamless agent with one key bound to the PC, its scope as rules, and a single-use pairing code (shown only here). */
  create(i: { name: string; machineId: string; owner: string | null; scope: ScopeRule[] }, actor: Actor): { reader: ReturnType<VaultSync['view']>; code: string } {
    const name = String(i.name ?? '').trim();
    if (!name || name.length > 80) throw new SyncError('invalid_argument', 'name: 1 to 80 characters');
    if (!this.keys.machine(i.machineId)) throw new SyncError('not_found', 'PC not found');
    const rules = this.rulesOf(i.scope);
    return tx(this.db, () => {
      const agent = this.keys.createAgent(`Vault reader: ${name}`, null, actor, i.owner);
      const k = this.keys.createSessionKey({ agentId: agent.id, label: `Vault reader: ${name}`, machineId: i.machineId }, actor);
      this.keys.setRules(k.credential.policy_id, rules, 'vault sync scope', actor);
      const code = `cnv_vsync_${randomToken(17).slice(0, 26)}`, id = `vrd_${randomToken(8)}`;
      this.db.prepare("INSERT INTO vault_readers(id,agent_id,credential_id,machine_id,name,owner_user_id,state,code_verifier,created_at) VALUES (?,?,?,?,?,?,'pending',?,?)")
        .run(id, agent.id, k.credential.id, i.machineId, name, i.owner, hmacHex(this.pepper, code), this.now());
      this.audit.event(actor, 'vault_sync.create', { kind: 'vault_reader', id }, { name, pc: i.machineId, owner: i.owner, rules: rules.length });
      return { reader: this.view(this.reader(id)!), code };
    });
  }
  /** Edit the scope: the reader's rules are replaced; its cursors stop working and it lists its scope again. */
  editScope(id: string, scope: ScopeRule[], actor: Actor) {
    const r = this.live(id), rules = this.rulesOf(scope);
    this.keys.setRules(this.keys.credential(r.credential_id)!.policy_id, rules, 'vault sync scope edited', actor);
    this.audit.event(actor, 'vault_sync.scope', { kind: 'vault_reader', id }, { rules: rules.length });
    return this.view(r);
  }
  private live(id: string): ReaderRow { const r = this.reader(id); if (!r || r.state === 'removed') throw new SyncError('not_found', 'vault reader not found'); return r; }
  pause(id: string, actor: Actor) {
    const r = this.live(id);
    if (r.state !== 'active') throw new SyncError('invalid_state', 'Only a reader that is syncing can be paused.');
    this.db.prepare("UPDATE vault_readers SET state='paused' WHERE id=?").run(id);
    this.audit.event(actor, 'vault_sync.pause', { kind: 'vault_reader', id }, {});
    return this.view(this.reader(id)!);
  }
  resume(id: string, actor: Actor) {
    const r = this.live(id);
    if (r.state !== 'paused') throw new SyncError('invalid_state', 'This reader is not paused.');
    this.db.prepare("UPDATE vault_readers SET state='active' WHERE id=?").run(id);
    this.audit.event(actor, 'vault_sync.resume', { kind: 'vault_reader', id }, {});
    return this.view(this.reader(id)!);
  }
  /** Remove revokes the key: the reader's next request fails. Its mirror stays on its PC for the PC's user to delete. */
  remove(id: string, actor: Actor) {
    const r = this.live(id);
    tx(this.db, () => {
      const c = this.keys.credential(r.credential_id);
      if (c && c.status !== 'revoked') this.keys.setStatus(c.id, 'revoked', 'vault reader removed', actor);
      this.db.prepare("UPDATE vault_readers SET state='removed', removed_at=?, code_status=CASE WHEN code_status='confirmed' THEN code_status ELSE 'revoked' END WHERE id=?").run(this.now(), id);
      this.audit.event(actor, 'vault_sync.remove', { kind: 'vault_reader', id }, { name: r.name });
    });
    const t = this.timers.get(id); if (t) { clearTimeout(t); this.timers.delete(id); }
    return { ok: true as const };
  }

  // ───────────── Pairing (enrolment-code rules) ─────────────
  /** The code buys the reader's key, once; a lost response is retried with the same nonce. Returns the key and the reader. */
  redeem(code: string, nonce: string): { key: string; reader: ReaderRow } {
    const row = /^cnv_vsync_[a-z2-7]{26}$/.test(String(code).trim())
      ? this.db.prepare(`SELECT ${COLS}, code_nonce_hash FROM vault_readers WHERE code_verifier=?`).get(hmacHex(this.pepper, String(code).trim())) as unknown as (ReaderRow & { code_nonce_hash: string | null }) | undefined
      : undefined;
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new SyncError('invalid_argument', 'nonce: 16 to 128 characters of A-Z, a-z, 0-9, _ or -');
    if (!row || row.code_status === 'revoked' || row.state === 'removed') throw new SyncError('unauthorized', 'This pairing code is not valid. Ask the administrator for a new one.');
    if (row.code_status === 'confirmed' || (row.code_status === 'issued' && row.code_nonce_hash !== sha256Hex(nonce))) throw new SyncError('invalid_state', 'This pairing code was already used.');
    if (row.code_issues >= PAIR_ISSUES) throw new SyncError('invalid_state', `This pairing code was handed out ${row.code_issues} times without confirmation.`);
    const pc = this.keys.machine(row.machine_id);
    if (!pc || pc.status !== 'active') throw new SyncError('forbidden', 'The PC is suspended.');
    const issued = tx(this.db, () => {
      const r = this.keys.reissueSecret(row.credential_id, 'pairing');
      this.db.prepare("UPDATE vault_readers SET code_status='issued', code_nonce_hash=?, code_issues=code_issues+1 WHERE id=?").run(sha256Hex(nonce), row.id);
      return r;
    });
    this.audit.event(sys, 'vault_sync.pair', { kind: 'vault_reader', id: row.id }, { issue: row.code_issues + 1 });
    return { key: issued.secret, reader: this.reader(row.id)! };
  }
  /** Confirming ends the code and starts the reader. Repeating it is harmless. */
  confirm(nonce: string): void {
    const row = typeof nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(nonce)
      ? this.db.prepare("SELECT id, code_status, state FROM vault_readers WHERE code_nonce_hash=? AND code_status IN ('issued','confirmed')").get(sha256Hex(nonce)) as { id: string; code_status: string; state: string } | undefined : undefined;
    if (!row) throw new SyncError('unauthorized', 'Unknown pairing.');
    if (row.code_status === 'issued') {
      this.db.prepare("UPDATE vault_readers SET code_status='confirmed', state=CASE WHEN state='pending' THEN 'active' ELSE state END WHERE id=?").run(row.id);
      this.audit.event(sys, 'vault_sync.pair_confirm', { kind: 'vault_reader', id: row.id }, {});
    }
  }
}
