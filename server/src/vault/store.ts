/**
 * Vault writes and change tracking (Phase 4a; design/04 §1-5).
 * The folder on disk is the truth for current content; SQLite holds history. Every platform write is a
 * compare-and-swap on the sha256 revision, saves a pre-image blob, and replaces the file atomically
 * (temp file in the same folder, fsync, re-hash, rename). External changes are found by fs.watch and a
 * periodic scan and recorded as `external_observed` revisions.
 */
import { promises as fs, watch as fsWatch, existsSync, mkdirSync, readFileSync, rmSync, type FSWatcher, type Stats } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit } from '../audit/audit.js';
import { sha256Hex } from '../util/crypto.js';
import { newId } from '../util/ids.js';
import { Vault, VaultError, isText } from './vault.js';
import { unifiedDiff } from './diff.js';

export const MAX_BLOB = 16 * 1024 * 1024;         // platform pre-images / new content kept as blobs
export const MAX_EXTERNAL_BLOB = 2 * 1024 * 1024; // observed external text kept as blobs
export const MAX_TRACK = 64 * 1024 * 1024;        // larger files are not tracked
export const MAX_CONTENT = 2 * 1024 * 1024;       // content accepted in one write call

/** A person writing in the console (docs/vault.md "People writing in the vault"): the author kind and the console user id. */
export interface Person { kind: 'operator' | 'collaborator'; userId: string }
export interface Who { agentId?: string | null; credentialId?: string | null; adminId?: string | null; person?: Person | null; recheck?: () => void; allowLarge?: boolean }
export interface FileRow { id: string; path: string; current_revision: string | null; size: number | null; mtime: number | null; is_text: number; deleted_at: number | null; created_at: number; updated_at: number }
export interface RevisionRow { id: string; file_id: string; revision: string; parent_revision: string | null; path_at_revision: string; op: string; origin: string; recovered: number; agent_id: string | null; credential_id: string | null; admin_id: string | null; author_kind: 'operator' | 'collaborator' | null; user_id: string | null; size: number | null; created_at: number }
export interface ConflictRow { id: string; file_id: string; source: string; base_revision: string | null; revisions: string; conflict_path: string | null; status: string; resolution: string | null; agent_id: string | null; resolved_by_admin: string | null; created_at: number; resolved_at: number | null }
/** Fired after a revision is committed (graph indexing hooks in here). `bytes` is null for deletes and renames. */
export interface RevisionEvent { fileId: string; path: string; revision: string; op: string; origin: string; agentId: string | null; bytes: Buffer | null }
export interface ScanResult { checked: number; changed: number; renamed: number }
interface Intent { id: string; op: 'write' | 'delete' | 'rename'; path: string; new_path: string | null; base_revision: string | null; new_revision: string | null; tmp_name: string | null; agent_id: string | null; credential_id: string | null; author_kind: string | null; user_id: string | null; revision_op: string | null; origin: string | null }

type Origin = 'platform' | 'external_observed' | 'restore' | 'initial_scan';
type RevOp = 'create' | 'update' | 'patch' | 'rename' | 'delete' | 'restore' | 'observe';
type Stat = Stats | null;

const SYNC_CONFLICT = [
  { re: /^(.*)\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]+)?(\.[^.]*)?$/, orig: (m: RegExpExecArray) => `${m[1]}${m[2] ?? ''}` },
  { re: /^(.*) \((?:[^)]*conflicted copy[^)]*)\)(\.[^.]*)?$/i, orig: (m: RegExpExecArray) => `${m[1]}${m[2] ?? ''}` },
];
const sha = (b: Buffer) => `sha256:${sha256Hex(b)}`;

export class VaultStore {
  readonly blobsDir: string;
  /** Test seams around staging a write: just before the temporary file is opened, and just after it is written. */
  hooks: { beforeTmp?: (abs: string) => void | Promise<void>; afterTmp?: (abs: string) => void | Promise<void> } = {};
  /** Resolves when the startup recovery and first scan are done. */
  ready: Promise<void> = Promise.resolve();
  /** Listeners must not throw into the writer; errors are logged and swallowed. */
  readonly listeners: ((e: RevisionEvent) => void)[] = [];
  /** Tell every listener (the graph); false if one threw, so the caller keeps the write intent for a retry. */
  private emit(e: RevisionEvent): boolean {
    let ok = true;
    for (const l of this.listeners) { try { l(e); } catch (err) { ok = false; console.error('revision listener failed', err); } }
    return ok;
  }
  /** Intents whose change a listener failed to take: retried at the next scan, and at the next start if the hub stops. */
  private readonly unsent = new Set<string>();
  /** The intent is done once every listener has seen its change; otherwise it stays for retryUnsent() or recover(). */
  private settle(intent: string, told: boolean): void {
    if (told) { this.db.prepare('DELETE FROM write_intents WHERE id=?').run(intent); this.unsent.delete(intent); }
    else this.unsent.add(intent);
  }
  /** Tell the graph again about committed changes a listener failed to take, under the paths' locks. */
  async retryUnsent(): Promise<number> {
    let n = 0;
    for (const id of [...this.unsent]) {
      const it = this.db.prepare('SELECT * FROM write_intents WHERE id=?').get(id) as unknown as Intent | undefined;
      if (!it) { this.unsent.delete(id); continue; }
      await this.lockAll([it.path, ...(it.new_path ? [it.new_path] : [])], async () => {
        if (!this.db.prepare('SELECT 1 x FROM write_intents WHERE id=?').get(id)) { this.unsent.delete(id); return; }
        const told = await this.emitCommitted(it);
        this.settle(id, told);
        if (told) n++;
      });
    }
    return n;
  }
  private chains = new Map<string, Promise<unknown>>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending = new Set<string>();
  private debounce: NodeJS.Timeout | null = null;
  private scanning: Promise<ScanResult> | null = null;

  constructor(private readonly db: Db, readonly vault: Vault, private readonly audit: Audit, dataDir: string) {
    this.blobsDir = join(dataDir, 'blobs');
    mkdirSync(this.blobsDir, { recursive: true });
  }

  // ───────────── lifecycle ─────────────
  start(o: { scanSeconds: number; watch: boolean }): void {
    this.ready = (async () => { await this.recover(); await this.scan(); })().catch((e) => console.error('vault startup scan failed', e));
    if (o.scanSeconds > 0) {
      this.timer = setInterval(() => { void this.scan().catch((e) => console.error('vault scan failed', e)); }, o.scanSeconds * 1000);
      this.timer.unref();
    }
    if (o.watch) this.startWatch();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.timer = this.debounce = null; this.watcher = null;
    await this.ready;
  }

  private startWatch(): void {
    try {
      this.watcher = fsWatch(this.vault.root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const segs = String(name).replace(/\\/g, '/').split('/').filter(Boolean);
        if (segs.length === 0 || segs.some((s) => this.vault.isHidden(s))) return;
        this.pending.add(segs.join('/'));
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          const paths = [...this.pending]; this.pending.clear();
          void this.reconcile(paths).catch((e) => console.error('vault watch reconcile failed', e));
        }, 500);
        this.debounce.unref();
      });
      this.watcher.on('error', () => { /* the periodic scan still covers us */ });
    } catch { this.watcher = null; }
  }

  // ───────────── settings ─────────────
  private setting(key: string): unknown {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : undefined;
  }
  private setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), Date.now());
  }
  writesDisabled(): boolean { return this.setting('emergency.writes_disabled') === true; }
  setWritesDisabled(on: boolean): void { this.setSetting('emergency.writes_disabled', on); }
  lastScan(): unknown { return this.setting('vault.last_scan') ?? null; }
  /** Lockdown of this vault only (all writes use writesDisabled). */
  vaultDisabled(): boolean { return this.setting(`emergency.vault_disabled.${this.vault.alias}`) === true; }
  /** Remove a blob's bytes (retention GC, after it removed the row in the same synchronous step). */
  deleteBlobSync(hash: string): void { rmSync(this.blobPath(hash), { force: true }); }
  private assertWritable(): void {
    if (this.writesDisabled() || this.vaultDisabled()) throw new VaultError('lockdown', 'Vault writes are disabled by the administrator (lockdown).', { reason: this.writesDisabled() ? 'writes_paused' : 'vault_lockdown' });
  }

  // ───────────── blobs ─────────────
  private blobPath(hash: string): string { const h = hash.replace(/^sha256:/, ''); return join(this.blobsDir, h.slice(0, 2), h); }

  /** Store bytes content-addressed. `stored` is false when over the size limit (metadata only). */
  async putBlob(buf: Buffer, limit = MAX_BLOB): Promise<{ hash: string; stored: boolean }> {
    const hash = sha(buf);
    const row = this.db.prepare('SELECT stored FROM blobs WHERE hash=?').get(hash) as { stored: number } | undefined;
    if (row && (buf.length > limit || (row.stored === 1 && existsSync(this.blobPath(hash))))) {
      // Reuse restarts the clean-up grace period (created_at doubles as "last stored"), so the GC cannot delete a
      // blob between this answer and the caller recording the revision that refers to it.
      this.db.prepare('UPDATE blobs SET created_at=? WHERE hash=?').run(Date.now(), hash);
      return { hash, stored: row.stored === 1 };
    }
    const stored = buf.length <= limit;
    if (stored) {
      const p = this.blobPath(hash);
      if (!existsSync(p)) {
        await fs.mkdir(dirname(p), { recursive: true });
        const tmp = `${p}.${newId.intent()}.tmp`;
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, p);
      }
    }
    this.db.prepare('INSERT INTO blobs(hash,size,stored,created_at) VALUES (?,?,?,?) ON CONFLICT(hash) DO UPDATE SET stored=MAX(stored, excluded.stored), created_at=excluded.created_at').run(hash, buf.length, stored ? 1 : 0, Date.now());
    return { hash, stored };
  }

  /** Synchronous read of a stored blob (small text notes for graph jobs). */
  getBlobSync(hash: string): Buffer | null {
    const row = this.db.prepare('SELECT stored FROM blobs WHERE hash=?').get(hash) as { stored: number } | undefined;
    if (!row || row.stored !== 1) return null;
    try { return readFileSync(this.blobPath(hash)); } catch { return null; }
  }

  async getBlob(hash: string): Promise<Buffer | null> {
    const row = this.db.prepare('SELECT stored FROM blobs WHERE hash=?').get(hash) as { stored: number } | undefined;
    if (!row || row.stored !== 1) return null;
    try { return await fs.readFile(this.blobPath(hash)); } catch { return null; }
  }

  // ───────────── locking and paths ─────────────
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(key, next);
    void next.catch(() => undefined).finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
    return next;
  }
  private lockAll<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const go = (i: number): Promise<T> => (i >= sorted.length ? fn() : this.lock(sorted[i]!, () => go(i + 1)));
    return go(0);
  }

  /** Absolute path for a relative path; refuses hidden names and any symlink component. */
  private async safeAbs(rel: string[]): Promise<{ abs: string; st: Stat }> {
    let cur = this.vault.root;
    let st: Stat = null;
    for (let i = 0; i < rel.length; i++) {
      const seg = rel[i]!;
      if (this.vault.isHidden(seg) || seg === '..' || seg === '.') throw new VaultError('denied', 'not allowed, or does not exist');
      cur = join(cur, seg);
      try { st = await fs.lstat(cur); } catch { return { abs: join(cur, ...rel.slice(i + 1)), st: null }; }
      if (st.isSymbolicLink()) throw new VaultError('denied', 'not allowed, or does not exist');
      if (i < rel.length - 1 && !st.isDirectory()) throw new VaultError('invalid_argument', `"${seg}" is not a folder`);
    }
    return { abs: cur, st };
  }
  private async safeStat(rel: string[]): Promise<Stat> { try { return (await this.safeAbs(rel)).st; } catch { return null; } }
  /**
   * On a case-insensitive file system, an existing file can be reached under a name that differs only by case
   * ("NOTE.md" for "Note.md"). Returns the names on disk when rel is such an alias, else null. Call only when rel exists.
   */
  private async caseAlias(rel: string[]): Promise<string[] | null> {
    let cur = this.vault.root, differs = false;
    const real: string[] = [];
    for (const seg of rel) {
      let names: string[];
      try { names = await fs.readdir(cur); } catch { return null; }
      const name = names.includes(seg) ? seg : names.find((n) => n.toLowerCase() === seg.toLowerCase());
      if (name === undefined) return null;
      if (name !== seg) differs = true;
      real.push(name);
      cur = join(cur, name);
    }
    return differs ? real : null;
  }
  private async refuseCaseAlias(rel: string[]): Promise<void> {
    const real = await this.caseAlias(rel);
    if (real) throw new VaultError('conflict', `The file exists as ${this.vault.virtual(real)}; use that name.`, { reason: 'case_mismatch', path: this.vault.virtual(real) });
  }
  /**
   * Just before touching the disk: the parent folders of rel are still real folders, not a symlink or junction swapped in
   * since safeAbs. This narrows the window to the operation itself; Node has no openat/O_NOFOLLOW to close it entirely.
   */
  private async assertConfined(rel: string[]): Promise<void> {
    let cur = this.vault.root;
    for (const seg of rel.slice(0, -1)) {
      cur = join(cur, seg);
      const st = await fs.lstat(cur).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new VaultError('denied', 'not allowed, or does not exist');
    }
  }

  /** Is there a sibling whose name differs only by case (case-insensitive file systems)? */
  private async clash(abs: string, exceptName?: string): Promise<boolean> {
    const name = basename(abs).toLowerCase();
    try { for (const n of await fs.readdir(dirname(abs))) if (n.toLowerCase() === name && n !== exceptName) return true; } catch { /* parent missing */ }
    return false;
  }

  private static key(rel: string[]): string { return rel.join('/'); }

  /** How agents see a person author: the kind and a label ("Operator", or the collaborator's display name), never the user id. */
  personLabel(kind: string | null, userId: string | null): { kind: 'operator' | 'collaborator'; label: string } | null {
    if (kind === 'operator') return { kind, label: 'Operator' };
    if (kind !== 'collaborator') return null;
    const u = userId ? this.db.prepare('SELECT display_name FROM admin_users WHERE id=?').get(userId) as { display_name: string | null } | undefined : undefined;
    return { kind, label: `${u?.display_name || 'A collaborator'} (collaborator)` };
  }

  /** The tracked live file whose path differs from this one only by letter case, if any (any file system). */
  aliasOf(path: string): string | null {
    const r = this.db.prepare('SELECT path FROM files WHERE lower(path)=lower(?) AND path<>? AND deleted_at IS NULL AND current_revision IS NOT NULL LIMIT 1').get(path, path) as { path: string } | undefined;
    return r?.path ?? null;
  }

  // ───────────── DB helpers ─────────────
  fileByPath(path: string, includeDeleted = false): FileRow | undefined {
    return (includeDeleted
      ? this.db.prepare('SELECT * FROM files WHERE path=? ORDER BY (deleted_at IS NULL) DESC, updated_at DESC LIMIT 1').get(path)
      : this.db.prepare('SELECT * FROM files WHERE path=? AND deleted_at IS NULL').get(path)) as FileRow | undefined;
  }
  fileById(id: string): FileRow | undefined { return this.db.prepare('SELECT * FROM files WHERE id=?').get(id) as FileRow | undefined; }
  revisions(fileId: string, limit = 200): RevisionRow[] {
    return this.db.prepare('SELECT * FROM file_revisions WHERE file_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(fileId, limit) as unknown as RevisionRow[];
  }
  /** Paths a file had at the revisions with this content hash (one hash can recur, A->B->A). */
  revisionPaths(fileId: string, revision: string): string[] {
    return (this.db.prepare('SELECT DISTINCT path_at_revision p FROM file_revisions WHERE file_id=? AND revision=?').all(fileId, revision) as { p: string }[]).map((r) => r.p);
  }
  hasRevision(fileId: string, revision: string): boolean {
    return !!this.db.prepare('SELECT 1 x FROM file_revisions WHERE file_id=? AND revision=? LIMIT 1').get(fileId, revision);
  }

  private insertRevision(f: { fileId: string; revision: string; parent: string | null; path: string; op: RevOp; origin: Origin; recovered?: boolean; who?: Who; size: number | null }): string {
    const id = newId.revision();
    this.db.prepare('INSERT INTO file_revisions(id,file_id,revision,parent_revision,path_at_revision,op,origin,recovered,agent_id,credential_id,admin_id,author_kind,user_id,size,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, f.fileId, f.revision, f.parent, f.path, f.op, f.origin, f.recovered ? 1 : 0, f.who?.agentId ?? null, f.who?.credentialId ?? null, f.who?.adminId ?? null, f.who?.person?.kind ?? null, f.who?.person?.userId ?? null, f.size, Date.now());
    // A write that lands closes the stale-base records this same agent left on the file: it lost a race, re-read and wrote, so
    // nothing is waiting on anyone. One it never recovered from stays open.
    if (f.who?.agentId) this.db.prepare("UPDATE file_conflicts SET status='resolved', resolution=?, resolved_at=? WHERE file_id=? AND source='platform_cas' AND status='open' AND agent_id=?")
      .run(JSON.stringify({ auto: 'superseded', by_revision: f.revision }), Date.now(), f.fileId, f.who.agentId);
    return id;
  }

  /** Insert or reactivate the files row for a path with new current state. */
  private upsertFile(path: string, revision: string | null, size: number | null, mtime: number | null, isTextFile: boolean): FileRow {
    const now = Date.now();
    const row = this.fileByPath(path, true);
    if (row) {
      this.db.prepare('UPDATE files SET current_revision=?, size=?, mtime=?, is_text=?, deleted_at=?, updated_at=? WHERE id=?')
        .run(revision, size, mtime, isTextFile ? 1 : 0, revision === null ? now : null, now, row.id);
      return this.fileById(row.id)!;
    }
    const id = newId.file();
    this.db.prepare('INSERT INTO files(id,path,current_revision,size,mtime,is_text,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, path, revision, size, mtime, isTextFile ? 1 : 0, revision === null ? now : null, now, now);
    return this.fileById(id)!;
  }

  private recordConflict(fileId: string, source: 'platform_cas' | 'external_during_commit' | 'sync_tool', base: string | null, revisions: { revision: string; role: string }[], who?: Who, conflictPath?: string): string {
    const json = JSON.stringify(revisions);
    const dup = this.db.prepare("SELECT id FROM file_conflicts WHERE file_id=? AND source=? AND status='open' AND base_revision IS ? AND revisions=? AND conflict_path IS ?").get(fileId, source, base, json, conflictPath ?? null) as { id: string } | undefined;
    if (dup) return dup.id;
    const id = newId.conflict();
    this.db.prepare('INSERT INTO file_conflicts(id,file_id,source,base_revision,revisions,conflict_path,agent_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, fileId, source, base, json, conflictPath ?? null, who?.agentId ?? null, Date.now());
    return id;
  }

  // ───────────── observing the disk ─────────────
  /** Bring the DB in line with the disk for one path. Caller holds the path lock. Returns the current revision or 'absent'. */
  private async observeLocked(rel: string[], known?: { bytes: Buffer; st: Stats }, forceOrigin?: Origin): Promise<string> {
    const path = VaultStore.key(rel);
    const row = this.fileByPath(path);
    let abs: string, st: Stat;
    try { ({ abs, st } = await this.safeAbs(rel)); } catch { return 'absent'; }
    if (!st || !st.isFile()) {
      if (!st && row?.current_revision) {
        tx(this.db, () => {
          this.insertRevision({ fileId: row.id, revision: 'tombstone', parent: row.current_revision, path, op: 'delete', origin: 'external_observed', size: null });
          this.upsertFile(path, null, null, null, false);
        });
        this.emit({ fileId: row.id, path, revision: 'tombstone', op: 'delete', origin: 'external_observed', agentId: null, bytes: null });
      }
      return 'absent';
    }
    if (st.size > MAX_TRACK) return 'absent';
    if (!row && await this.caseAlias(rel)) return 'absent'; // the file is tracked under its own name, not this alias
    const mtime = Math.round(st.mtimeMs);
    if (!known && row?.current_revision && row.size === st.size && row.mtime === mtime) return row.current_revision;
    const bytes = known?.bytes ?? await fs.readFile(abs);
    const hash = sha(bytes);
    const txt = isText(bytes);
    if (row?.current_revision === hash) {
      this.db.prepare('UPDATE files SET size=?, mtime=?, is_text=? WHERE id=?').run(bytes.length, mtime, txt ? 1 : 0, row.id);
      return hash;
    }
    await this.putBlob(bytes, txt ? MAX_EXTERNAL_BLOB : 0);
    const origin: Origin = forceOrigin ?? (this.setting('vault.initial_scan_done') === true ? 'external_observed' : 'initial_scan');
    const fid = tx(this.db, () => {
      const f = this.upsertFile(path, hash, bytes.length, mtime, txt);
      this.insertRevision({ fileId: f.id, revision: hash, parent: row?.current_revision ?? null, path, op: 'observe', origin, size: bytes.length });
      return f.id;
    });
    this.emit({ fileId: fid, path, revision: hash, op: 'observe', origin, agentId: null, bytes: txt ? bytes : null });
    return hash;
  }

  /** Current bytes and revision of a text file, or null if it does not exist. */
  async current(rel: string[]): Promise<{ bytes: Buffer; revision: string } | null> {
    const { abs, st } = await this.safeAbs(rel);
    if (!st) return null;
    if (!st.isFile()) throw new VaultError('invalid_argument', 'this is a folder');
    if (st.size > MAX_BLOB) throw new VaultError('too_large', 'the file is too large to edit through the hub');
    const bytes = await fs.readFile(abs);
    if (!isText(bytes)) throw new VaultError('binary', 'binary file; it cannot be patched as text');
    return { bytes, revision: sha(bytes) };
  }

  observe(rel: string[]): Promise<string> { return this.lock(VaultStore.key(rel), () => this.observeLocked(rel)); }

  /** Reconcile relative paths ("a/b.md") with the disk, detecting renames by content hash. */
  async reconcile(paths: string[]): Promise<ScanResult> {
    const count = () => (this.db.prepare('SELECT COUNT(*) n FROM file_revisions').get() as { n: number }).n;
    const before = count();
    const result: ScanResult = { checked: paths.length, changed: 0, renamed: 0 };
    const disappeared: FileRow[] = [], appeared: { path: string; hash: string }[] = [];
    const usable = paths.filter((p) => { const s = p.split('/').filter(Boolean); return s.length > 0 && !s.some((x) => this.vault.isHidden(x)); });
    for (const p of usable) {
      const rel = p.split('/');
      const row = this.fileByPath(p);
      const st = await this.safeStat(rel);
      if (row?.current_revision && !st) disappeared.push(row);
      else if (!row && st?.isFile() && st.size <= MAX_TRACK) {
        try { appeared.push({ path: p, hash: sha(await fs.readFile(join(this.vault.root, ...rel))) }); } catch { /* gone */ }
      }
    }
    const done = new Set<string>();
    for (const g of disappeared) {
      const m = appeared.find((a) => a.hash === g.current_revision && !done.has(a.path));
      if (!m) continue;
      await this.lockAll([g.path, m.path], async () => {
        const cur = this.fileByPath(g.path);
        if (!cur || cur.current_revision !== m.hash || this.fileByPath(m.path)) return;
        tx(this.db, () => {
          this.db.prepare('UPDATE files SET path=?, updated_at=? WHERE id=?').run(m.path, Date.now(), cur.id);
          this.insertRevision({ fileId: cur.id, revision: m.hash, parent: m.hash, path: m.path, op: 'rename', origin: 'external_observed', size: cur.size });
        });
        const b = cur.is_text ? await this.getBlob(m.hash) : null;
        this.emit({ fileId: cur.id, path: m.path, revision: m.hash, op: 'rename', origin: 'external_observed', agentId: null, bytes: b && isText(b) ? b : null });
        done.add(m.path); done.add(g.path); result.renamed++;
      });
    }
    for (const p of usable) {
      if (done.has(p)) continue;
      const hadRow = !!this.fileByPath(p);
      await this.observe(p.split('/'));
      if (!hadRow) this.linkSyncConflict(p);
    }
    result.changed = count() - before;
    return result;
  }

  /** A new file named like a sync tool's conflict copy is linked to its original. */
  private linkSyncConflict(path: string): void {
    const name = path.split('/').pop()!;
    for (const pat of SYNC_CONFLICT) {
      const m = pat.re.exec(name);
      if (!m) continue;
      const origPath = [...path.split('/').slice(0, -1), pat.orig(m)].join('/');
      const orig = this.fileByPath(origPath), copy = this.fileByPath(path);
      if (orig?.current_revision && copy?.current_revision) {
        this.recordConflict(orig.id, 'sync_tool', null, [{ revision: orig.current_revision, role: 'original' }, { revision: copy.current_revision, role: 'sync_conflict_copy' }], undefined, path);
      }
      return;
    }
  }

  /** Full reconciliation: every file on disk plus every file the DB believes exists. */
  scan(): Promise<ScanResult> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      // First the committed changes the graph failed to take: a listener error must not lose a change.
      await this.retryUnsent().catch((e) => console.error('graph retry failed', e));
      const paths = new Set<string>();
      for await (const f of this.vault.walk([])) paths.add(f.rel.join('/'));
      for (const r of this.db.prepare('SELECT path FROM files WHERE deleted_at IS NULL').all() as { path: string }[]) paths.add(r.path);
      const res = await this.reconcile([...paths]);
      this.setSetting('vault.initial_scan_done', true);
      this.setSetting('vault.last_scan', { at: Date.now(), checked: res.checked, changed: res.changed });
      return res;
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  // ───────────── crash recovery ─────────────
  /**
   * Roll forward or clean up write intents left by a crash (design/04 §3 "Crash safety"), then tell the graph each touched
   * file's committed state (docs/vault.md): an intent stays until the graph has seen its change, so a crash between the
   * metadata and the graph update is finished here. Both steps are idempotent: running recovery again changes nothing.
   */
  async recover(): Promise<{ recovered: number; cleaned: number }> {
    const out = { recovered: 0, cleaned: 0 };
    const intents = this.db.prepare('SELECT * FROM write_intents ORDER BY created_at').all() as unknown as Intent[];
    for (const it of intents) {
      const rel = it.path.split('/');
      const who: Who = { agentId: it.agent_id, credentialId: it.credential_id, person: it.author_kind && it.user_id ? { kind: it.author_kind as Person['kind'], userId: it.user_id } : null };
      await this.lockAll([it.path, ...(it.new_path ? [it.new_path] : [])], async () => {
        if (it.tmp_name) {
          try { await fs.unlink(join(this.vault.root, ...rel.slice(0, -1), it.tmp_name)); out.cleaned++; } catch { /* already gone */ }
        }
        const row = this.fileByPath(it.path);
        const st = await this.safeStat(rel);
        if (it.op === 'write') {
          if (st?.isFile()) {
            const bytes = await fs.readFile(join(this.vault.root, ...rel));
            const hash = sha(bytes);
            if (hash === it.new_revision && row?.current_revision !== hash) {
              await this.putBlob(bytes);
              tx(this.db, () => {
                const f = this.upsertFile(it.path, hash, bytes.length, Math.round(st.mtimeMs), isText(bytes));
                this.insertRevision({ fileId: f.id, revision: hash, parent: it.base_revision && it.base_revision !== 'absent' ? it.base_revision : null, path: it.path, op: (it.revision_op as RevOp) ?? 'update', origin: (it.origin as Origin) ?? 'platform', recovered: true, who, size: bytes.length });
              });
              out.recovered++;
            }
          }
        } else if (it.op === 'delete') {
          if (!st && row?.current_revision) {
            tx(this.db, () => {
              this.insertRevision({ fileId: row.id, revision: 'tombstone', parent: row.current_revision, path: it.path, op: 'delete', origin: 'platform', recovered: true, who, size: null });
              this.upsertFile(it.path, null, null, null, false);
            });
            out.recovered++;
          }
        } else if (it.op === 'rename' && it.new_path) {
          const dst = await this.safeStat(it.new_path.split('/'));
          if (!st && dst?.isFile() && row && row.current_revision === it.base_revision) {
            tx(this.db, () => {
              this.db.prepare('UPDATE files SET path=?, updated_at=? WHERE id=?').run(it.new_path, Date.now(), row.id);
              this.insertRevision({ fileId: row.id, revision: row.current_revision ?? 'tombstone', parent: row.current_revision, path: it.new_path!, op: 'rename', origin: 'platform', recovered: true, who, size: row.size });
            });
            out.recovered++;
          }
        }
        // Kept when the graph failed to take it again: the next start (or scan) tries once more.
        this.settle(it.id, await this.emitCommitted(it));
      });
    }
    return out;
  }

  /**
   * The committed state of an intent's file, as the graph must see it: its current revision and path, or a tombstone.
   * For a rename the renamed file is looked for where it went first, and at its old path only while it still holds the
   * content that was renamed: a new file made at the old path since is not the renamed one. Returns whether the graph
   * took it (true when there is no file to report).
   */
  private async emitCommitted(it: Intent): Promise<boolean> {
    const at = (p: string | null, dead = false) => (p ? this.fileByPath(p, dead) : undefined);
    const same = (f: ReturnType<VaultStore['fileByPath']>) => (f && f.current_revision === it.base_revision ? f : undefined);
    const f = it.op === 'rename'
      ? same(at(it.new_path)) ?? same(at(it.path)) ?? at(it.new_path) ?? at(it.new_path, true) ?? same(at(it.path, true))
      : at(it.path) ?? at(it.new_path) ?? at(it.path, true) ?? at(it.new_path, true);
    if (!f) return true;
    const live = f.deleted_at === null && !!f.current_revision;
    const bytes = live && f.is_text ? await this.getBlob(f.current_revision!) : null;
    return this.emit({ fileId: f.id, path: f.path, revision: live ? f.current_revision! : 'tombstone', op: 'recover', origin: it.origin ?? 'platform', agentId: it.agent_id, bytes: bytes && isText(bytes) ? bytes : null });
  }

  // ───────────── platform writes ─────────────
  /** A stale base. Recorded as a platform_cas conflict for agents; a person's console save records none, because the
   *  editor itself shows the change and asks (docs/filesystem-consistency.md). */
  private conflict(fileId: string | null, current: string, base: string, extra?: { revision: string; role: string }[], exists = false, who?: Who): VaultError {
    const id = fileId && !exists && !who?.person ? this.recordConflict(fileId, 'platform_cas', base, [{ revision: current, role: 'current' }, { revision: base, role: 'base' }, ...(extra ?? [])], who) : null;
    return new VaultError('conflict', exists ? 'The file already exists.' : 'The file changed since base_revision. Re-read it and apply your change to current_revision.',
      { current_revision: current, base_revision: base, ...(id ? { conflict_id: id } : {}) });
  }

  /** Create, update, patch or restore a file with new bytes. `base` is "absent" for create. */
  write(rel: string[], bytes: Buffer, base: string, op: 'create' | 'update' | 'patch' | 'restore', who: Who): Promise<{ revision: string; previous_revision: string | null; path: string }> {
    const path = VaultStore.key(rel);
    return this.lock(path, async () => {
      this.assertWritable();
      if (rel.length === 0) throw new VaultError('invalid_path', 'a file path is required');
      if (bytes.length > MAX_CONTENT && op !== 'restore' && !(who.allowLarge && bytes.length <= MAX_BLOB)) throw new VaultError('too_large', `content is larger than ${MAX_CONTENT} bytes`);
      const { abs, st } = await this.safeAbs(rel);
      if (st && !st.isFile()) throw new VaultError('invalid_argument', 'this is a folder');
      if (!st) this.vault.assertNewName(rel);
      if (st) await this.refuseCaseAlias(rel);
      let curBytes: Buffer | null = null;
      if (st) {
        if (st.size > MAX_BLOB) throw new VaultError('too_large', 'the existing file is too large to replace through the hub');
        curBytes = await fs.readFile(abs);
      }
      const cur = curBytes ? sha(curBytes) : 'absent';
      await this.observeLocked(rel, curBytes ? { bytes: curBytes, st: st! } : undefined);
      const file = this.fileByPath(path, true);
      if (op === 'create') {
        if (cur !== 'absent' || await this.clash(abs)) throw this.conflict(file?.id ?? null, cur, base, undefined, true);
      } else if (cur !== base) throw this.conflict(sha(bytes) === cur ? null : file?.id ?? null, cur, base, undefined, false, who); // a write of what is already there loses nothing: no record
      const newHash = sha(bytes);
      if (curBytes && op !== 'create' && op !== 'restore' && !isText(curBytes)) throw new VaultError('binary', 'the existing file is binary; it cannot be replaced with text');
      if (curBytes && newHash === cur && op !== 'create') return { revision: cur, previous_revision: cur, path };
      if (curBytes) await this.putBlob(curBytes);             // pre-image: never lose it
      await this.putBlob(bytes);
      await fs.mkdir(dirname(abs), { recursive: true });
      const tmpName = `.${newId.intent()}.hub-tmp`; // no part of the file's name: a name of 255 bytes must still fit
      const tmp = join(dirname(abs), tmpName);
      const intent = newId.intent();
      this.db.prepare('INSERT INTO write_intents(id,op,path,base_revision,new_revision,tmp_name,agent_id,credential_id,author_kind,user_id,revision_op,origin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(intent, 'write', path, cur, newHash, tmpName, who.agentId ?? null, who.credentialId ?? null, who.person?.kind ?? null, who.person?.userId ?? null, op, op === 'restore' ? 'restore' : 'platform', Date.now());
      const abort = async () => { await fs.unlink(tmp).catch(() => undefined); this.db.prepare('DELETE FROM write_intents WHERE id=?').run(intent); };
      try {
        await this.hooks.beforeTmp?.(abs);
        try { await this.assertConfined(rel); } catch (e) { await abort(); throw e; }
        const fh = await fs.open(tmp, 'wx');
        try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
        await this.hooks.afterTmp?.(abs);
        // re-hash: did an external writer touch the file since we checked?
        const again = await fs.readFile(abs).catch(() => null);
        const cur2 = again ? sha(again) : 'absent';
        if (cur2 !== cur) {
          await abort();
          await this.observeLocked(rel, again ? { bytes: again, st: await fs.stat(abs) } : undefined, 'external_observed');
          const f = this.fileByPath(path, true);
          if (!f) throw this.conflict(null, cur2, base);
          const id = this.recordConflict(f.id, 'external_during_commit', base, [{ revision: cur2, role: 'external' }, { revision: cur, role: 'previous' }, { revision: newHash, role: 'attempted' }], who);
          this.audit.alert('warning', 'vault_conflict', f.id, { path, source: 'external_during_commit', conflict: id });
          throw new VaultError('conflict', 'The file was changed by someone else while writing. Nothing was overwritten; both versions are kept.', { current_revision: cur2, base_revision: base, conflict_id: id });
        }
        try { this.assertWritable(); who.recheck?.(); await this.assertConfined(rel); } catch (e) { await abort(); throw e; }
        await fs.rename(tmp, abs);                              // commit point
        try { const dh = await fs.open(dirname(abs), 'r'); try { await dh.sync(); } finally { await dh.close(); } } catch { /* not supported (Windows) */ }
      } catch (e) {
        if (!(e instanceof VaultError)) await abort();
        throw e;
      }
      const nst = await fs.stat(abs);
      const fid = tx(this.db, () => {
        const f = this.upsertFile(path, newHash, bytes.length, Math.round(nst.mtimeMs), isText(bytes));
        this.insertRevision({ fileId: f.id, revision: newHash, parent: cur === 'absent' ? null : cur, path, op, origin: op === 'restore' ? 'restore' : 'platform', who, size: bytes.length });
        return f.id;
      });
      // The intent goes only once the graph has seen the change: a crash in between is finished by recovery.
      this.settle(intent, this.emit({ fileId: fid, path, revision: newHash, op, origin: op === 'restore' ? 'restore' : 'platform', agentId: who.agentId ?? null, bytes: isText(bytes) ? bytes : null }));
      return { revision: newHash, previous_revision: cur === 'absent' ? null : cur, path };
    });
  }

  /** Soft delete: the content stays in the blob store, the file is removed and a tombstone revision recorded. */
  delete(rel: string[], base: string, who: Who): Promise<{ previous_revision: string }> {
    const path = VaultStore.key(rel);
    return this.lock(path, async () => {
      this.assertWritable();
      const { abs, st } = await this.safeAbs(rel);
      if (!st) throw new VaultError('not_found', 'not allowed, or does not exist');
      if (!st.isFile()) throw new VaultError('invalid_argument', 'this is a folder; only files can be deleted');
      await this.refuseCaseAlias(rel);
      if (st.size > MAX_BLOB) throw new VaultError('too_large', 'the file is too large to delete through the hub (it could not be kept for recovery)');
      const bytes = await fs.readFile(abs);
      const cur = sha(bytes);
      await this.observeLocked(rel, { bytes, st });
      const file = this.fileByPath(path)!;
      if (cur !== base) throw this.conflict(file.id, cur, base, undefined, false, who);
      await this.putBlob(bytes);
      const intent = newId.intent();
      this.db.prepare('INSERT INTO write_intents(id,op,path,base_revision,agent_id,credential_id,author_kind,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(intent, 'delete', path, cur, who.agentId ?? null, who.credentialId ?? null, who.person?.kind ?? null, who.person?.userId ?? null, Date.now());
      try {
        const again = await fs.readFile(abs).catch(() => null);
        if (!again || sha(again) !== cur) {
          await this.observeLocked(rel, again ? { bytes: again, st: await fs.stat(abs) } : undefined, 'external_observed');
          throw new VaultError('conflict', 'The file was changed by someone else while deleting. Nothing was deleted.', { current_revision: again ? sha(again) : 'absent', base_revision: base });
        }
        who.recheck?.(); this.assertWritable(); await this.assertConfined(rel);
        await fs.unlink(abs);
      } catch (e) { this.db.prepare('DELETE FROM write_intents WHERE id=?').run(intent); throw e; }
      tx(this.db, () => {
        this.insertRevision({ fileId: file.id, revision: 'tombstone', parent: cur, path, op: 'delete', origin: 'platform', who, size: null });
        this.upsertFile(path, null, null, null, false);
      });
      this.settle(intent, this.emit({ fileId: file.id, path, revision: 'tombstone', op: 'delete', origin: 'platform', agentId: who.agentId ?? null, bytes: null }));
      return { previous_revision: cur };
    });
  }

  /** `base` null: move the file whatever its content is now (a rename does not change content; editors cannot starve it). */
  rename(from: string[], to: string[], base: string | null, who: Who): Promise<{ revision: string; path: string }> {
    const a = VaultStore.key(from), b = VaultStore.key(to);
    if (a === b) return Promise.reject(new VaultError('invalid_argument', 'from and to are the same path'));
    return this.lockAll([a, b], async () => {
      this.assertWritable();
      if (to.length === 0) throw new VaultError('invalid_path', 'a destination path is required');
      const src = await this.safeAbs(from);
      if (!src.st) throw new VaultError('not_found', 'not allowed, or does not exist');
      if (!src.st.isFile()) throw new VaultError('invalid_argument', 'only files can be renamed');
      await this.refuseCaseAlias(from);
      const bytes = await fs.readFile(src.abs);
      const cur = sha(bytes);
      await this.observeLocked(from, { bytes, st: src.st });
      const file = this.fileByPath(a)!;
      if (base !== null && cur !== base) throw this.conflict(file.id, cur, base, undefined, false, who);
      const dst = await this.safeAbs(to);
      const caseOnly = dirname(src.abs) === dirname(dst.abs) && basename(src.abs).toLowerCase() === basename(dst.abs).toLowerCase();
      // On a case-insensitive file system the destination of a case-only rename is the source itself; observing it
      // under the new name would record a second active row for the same file.
      if (!dst.st && !caseOnly) this.vault.assertNewName(to);
      if (!caseOnly) await this.observeLocked(to);
      if ((dst.st && !caseOnly) || await this.clash(dst.abs, caseOnly ? basename(src.abs) : undefined)) {
        throw new VaultError('conflict', 'The destination already exists.', { reason: 'destination_exists' });
      }
      await this.putBlob(bytes);
      await fs.mkdir(dirname(dst.abs), { recursive: true });
      const intent = newId.intent();
      this.db.prepare('INSERT INTO write_intents(id,op,path,new_path,base_revision,agent_id,credential_id,author_kind,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(intent, 'rename', a, b, cur, who.agentId ?? null, who.credentialId ?? null, who.person?.kind ?? null, who.person?.userId ?? null, Date.now());
      try {
        const again = await fs.readFile(src.abs).catch(() => null);
        if (!again || sha(again) !== cur) {
          await this.observeLocked(from, again ? { bytes: again, st: await fs.stat(src.abs) } : undefined, 'external_observed');
          throw new VaultError('conflict', 'The file was changed by someone else while renaming. Nothing was renamed.', { current_revision: again ? sha(again) : 'absent', base_revision: base ?? cur });
        }
        who.recheck?.(); this.assertWritable(); await this.assertConfined(from); await this.assertConfined(to);
        await fs.rename(src.abs, dst.abs);
      } catch (e) { this.db.prepare('DELETE FROM write_intents WHERE id=?').run(intent); throw e; }
      const nst = await fs.stat(dst.abs);
      tx(this.db, () => {
        const stale = this.fileByPath(b, true);
        if (stale && stale.id !== file.id && stale.deleted_at !== null) this.db.prepare("UPDATE files SET path=path || '#' || id WHERE id=?").run(stale.id); // keep tombstoned history, free the path
        this.db.prepare('UPDATE files SET path=?, mtime=?, updated_at=? WHERE id=?').run(b, Math.round(nst.mtimeMs), Date.now(), file.id);
        this.insertRevision({ fileId: file.id, revision: cur, parent: cur, path: b, op: 'rename', origin: 'platform', who, size: bytes.length });
      });
      this.settle(intent, this.emit({ fileId: file.id, path: b, revision: cur, op: 'rename', origin: 'platform', agentId: who.agentId ?? null, bytes: isText(bytes) ? bytes : null }));
      return { revision: cur, path: b };
    });
  }

  // ───────────── reading history ─────────────
  /** Text of a revision from the blob store. */
  async revisionText(file: FileRow, revision: string): Promise<string> {
    if (revision === 'tombstone' || revision === 'absent') return '';
    if (!this.hasRevision(file.id, revision)) throw new VaultError('not_found', 'no such revision for this file');
    const buf = await this.getBlob(revision);
    if (!buf) throw new VaultError('not_found', 'that revision was not kept (file too large or not text)');
    if (!isText(buf)) throw new VaultError('binary', 'binary content cannot be shown as a diff');
    return buf.toString('utf8');
  }

  async diff(file: FileRow, from: string, to?: string): Promise<{ from: string; to: string; diff: string; identical: boolean }> {
    const target = to ?? file.current_revision ?? 'tombstone';
    const [a, b] = [await this.revisionText(file, from), await this.revisionText(file, target)];
    const d = unifiedDiff(a, b, `${file.path}@${from.slice(0, 15)}`, `${file.path}@${target.slice(0, 15)}`);
    return { from, to: target, diff: d, identical: d === '' };
  }

  // ───────────── conflicts ─────────────
  conflicts(status: 'open' | 'all' = 'open'): (ConflictRow & { path: string })[] {
    return this.db.prepare(`SELECT c.*, f.path path FROM file_conflicts c JOIN files f ON f.id=c.file_id ${status === 'open' ? "WHERE c.status='open'" : ''} ORDER BY c.created_at DESC LIMIT 500`).all() as never;
  }

  /** Keep one of the competing versions; it becomes the file's content (a restore revision) unless it is already current. */
  async resolveConflict(id: string, keep: string, adminId: string): Promise<{ revision: string }> {
    const c = this.db.prepare('SELECT * FROM file_conflicts WHERE id=?').get(id) as ConflictRow | undefined;
    if (!c) throw new VaultError('not_found', 'conflict not found');
    if (c.status !== 'open') throw new VaultError('invalid_argument', 'conflict is already closed');
    const revs = JSON.parse(c.revisions) as { revision: string; role: string }[];
    if (!revs.some((r) => r.revision === keep)) throw new VaultError('invalid_argument', 'keep must be one of the conflict revisions');
    const file = this.fileById(c.file_id)!;
    let revision = file.current_revision ?? 'absent';
    if (revision !== keep) {
      const bytes = await this.getBlob(keep);
      if (!bytes) throw new VaultError('not_found', 'that version was not kept, so it cannot be restored');
      revision = (await this.write(file.path.split('/'), bytes, revision, 'restore', { adminId })).revision;
    }
    this.db.prepare("UPDATE file_conflicts SET status='resolved', resolution=?, resolved_by_admin=?, resolved_at=? WHERE id=?").run(JSON.stringify({ keep, revision }), adminId, Date.now(), id);
    return { revision };
  }
}
