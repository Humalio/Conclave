/**
 * Read-only vault provider for Phase 1 (SPECIFICATION F5). The vault is a folder on the
 * server (an Obsidian vault). Paths are "/<alias>/<relative path>". Every path is
 * normalised, confined to the vault root (no "..", no symlink escape) and checked for
 * hidden folders before anything touches the disk.
 */
import { promises as fs, realpathSync, existsSync } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { sha256Hex } from '../util/crypto.js';

export const DEFAULT_HIDDEN = ['.obsidian', '.trash', '.git', '.stfolder', '.stversions', '.sync', '.syncthing', '.DS_Store', '.hub-tmp', 'shares', '.conclave-demo'];
export const MAX_READ_BYTES = 90_000;

export class VaultError extends Error {
  constructor(public readonly code: 'invalid_path' | 'denied' | 'too_large' | 'invalid_argument' | 'conflict' | 'not_found' | 'lockdown' | 'patch_failed' | 'binary', message: string, public readonly extra?: Record<string, unknown>) { super(message); }
}

export interface Entry { name: string; path: string; type: 'file' | 'folder'; size: number | null; modified: number; }

export class Vault {
  readonly root: string;
  constructor(rootDir: string, readonly alias: string, private readonly hidden: string[] = DEFAULT_HIDDEN) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(alias) || alias === 'shares') throw new Error(`invalid vault alias "${alias}"`);
    this.root = realpathSync(rootDir);
    this.hiddenLower = new Set(hidden.map((h) => h.toLowerCase()));
  }

  /** Normalise a virtual path to "/<alias>/a/b" and its relative segments. Throws invalid_path. */
  normalise(virtualPath: string): { path: string; rel: string[] } {
    if (typeof virtualPath !== 'string' || virtualPath.length === 0 || virtualPath.length > 1024) throw new VaultError('invalid_path', 'path is required');
    if (/[\x00-\x1f]/.test(virtualPath)) throw new VaultError('invalid_path', 'control characters are not allowed');
    const p = virtualPath.normalize('NFC').replace(/\\/g, '/');
    const segs = p.split('/').filter((s) => s.length > 0 && s !== '.');
    if (segs[0] !== this.alias) throw new VaultError('invalid_path', `paths start with /${this.alias}/`);
    const rel = segs.slice(1);
    for (const s of rel) {
      if (s === '..') throw new VaultError('invalid_path', '".." is not allowed');
      if (/^[a-zA-Z]:$/.test(s) || s.includes(':')) throw new VaultError('invalid_path', 'drive letters and ":" are not allowed');
      // Windows drops trailing dots and spaces, so ".obsidian." or "secret.md " would reach ".obsidian" or "secret.md"
      // past the hidden-folder check and path rules. Refused on every platform so a path means the same everywhere.
      if (/[. ]$/.test(s)) throw new VaultError('invalid_path', 'a name cannot end with a dot or a space');
      if (this.isHidden(s)) throw new VaultError('denied', 'not allowed, or does not exist');
    }
    return { path: '/' + [this.alias, ...rel].join('/'), rel };
  }

  /** Hidden from agents: configured names, hub temp files, and names ending in a dot or space (unreachable by path, see normalise). */
  isHidden(segment: string): boolean { return this.hidden.includes(segment) || this.hiddenLower.has(segment.toLowerCase()) || segment.endsWith('.hub-tmp') || /[. ]$/.test(segment); }
  private readonly hiddenLower: Set<string>;

  /** Whether a normalised vault path exists on disk (no symlink checks; for warnings only, never for access). */
  exists(virtualPath: string): boolean { try { return existsSync(join(this.root, ...this.normalise(virtualPath).rel)); } catch { return false; } }

  /** Resolve to a real absolute path inside the root, following symlinks safely. */
  async resolve(rel: string[]): Promise<string> {
    const abs = join(this.root, ...rel);
    let real: string;
    try { real = await fs.realpath(abs); } catch { throw new VaultError('denied', 'not allowed, or does not exist'); }
    const r = relative(this.root, real);
    if (r !== '' && (r.startsWith('..') || isAbsolute(r) || r.split(sep).includes('..'))) throw new VaultError('denied', 'not allowed, or does not exist');
    for (const s of r.split(sep)) if (s && this.isHidden(s)) throw new VaultError('denied', 'not allowed, or does not exist');
    // On a case-insensitive file system "SECRET.md" opens "secret.md", but path rules compare names exactly. A path
    // that reaches a file only through a case difference is refused, so a rule on the real name cannot be sidestepped.
    if (real !== abs && real.toLowerCase() === abs.toLowerCase()) throw new VaultError('denied', 'not allowed, or does not exist');
    return real;
  }

  virtual(rel: string[]): string { return '/' + [this.alias, ...rel].join('/'); }

  async list(rel: string[]): Promise<Entry[]> {
    const dir = await this.resolve(rel);
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw new VaultError('invalid_argument', 'not a folder');
    const out: Entry[] = [];
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (this.isHidden(d.name)) continue;
      const childRel = [...rel, d.name];
      try {
        const real = await this.resolve(childRel);
        const s = await fs.stat(real);
        out.push({ name: d.name, path: this.virtual(childRel), type: s.isDirectory() ? 'folder' : 'file', size: s.isDirectory() ? null : s.size, modified: Math.round(s.mtimeMs) });
      } catch { /* escapes the root or vanished: skip */ }
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  }

  async stat(rel: string[]): Promise<{ path: string; type: 'file' | 'folder'; size: number | null; modified: number; revision: string | null; is_text: boolean | null }> {
    const real = await this.resolve(rel);
    const s = await fs.stat(real);
    if (s.isDirectory()) return { path: this.virtual(rel), type: 'folder', size: null, modified: Math.round(s.mtimeMs), revision: null, is_text: null };
    const buf = s.size <= 16 * 1024 * 1024 ? await fs.readFile(real) : null;
    return { path: this.virtual(rel), type: 'file', size: s.size, modified: Math.round(s.mtimeMs), revision: buf ? `sha256:${sha256Hex(buf)}` : null, is_text: buf ? isText(buf) : null };
  }

  /** sha256 revision of a file up to maxBytes (default 1 MB), else null. */
  async revisionOf(rel: string[], maxBytes = 1024 * 1024): Promise<string | null> {
    try {
      const real = await this.resolve(rel);
      const s = await fs.stat(real);
      if (!s.isFile() || s.size > maxBytes) return null;
      return `sha256:${sha256Hex(await fs.readFile(real))}`;
    } catch { return null; }
  }

  /** Notes (.md, <= 2 MB, at most 2000 scanned) whose text links to [[name]] or [[name|...]]. */
  async linkedFrom(rel: string[], canRead: (virtualPath: string) => boolean): Promise<string[]> {
    const name = (rel[rel.length - 1] ?? '').replace(/.md$/i, '');
    if (!name) return [];
    const needles = [`[[${name}]]`, `[[${name}|`];
    const out: string[] = [];
    let scanned = 0;
    for await (const f of this.walk([], 20000, { agent: true })) {
      if (!/.md$/i.test(f.rel[f.rel.length - 1]!) || f.size > 2 * 1024 * 1024) continue;
      if (++scanned > 2000) break;
      const vp = this.virtual(f.rel);
      if (!canRead(vp)) continue;
      try {
        const text = await fs.readFile(await this.resolve(f.rel), 'utf8');
        if (needles.some((n) => text.includes(n))) out.push(vp);
      } catch { /* vanished */ }
    }
    return out.sort();
  }

  /** The whole file as bytes (hub-internal use, such as appending to a log note); not_found when it does not exist. */
  async readBytes(rel: string[]): Promise<Buffer> {
    // resolve() refuses a missing file like a forbidden one; here the difference matters (a log note not created yet).
    try { await fs.lstat(join(this.root, ...rel)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new VaultError('not_found', 'no such file'); throw e; }
    return fs.readFile(await this.resolve(rel));
  }
  async read(rel: string[], offset = 0, length = MAX_READ_BYTES, inspect?: (text: string) => void): Promise<{ path: string; revision: string; size: number; offset: number; content: string; truncated: boolean }> {
    if (!Number.isInteger(offset) || offset < 0) throw new VaultError('invalid_argument', 'offset must be a non-negative integer');
    if (!Number.isInteger(length) || length <= 0) throw new VaultError('invalid_argument', 'length must be a positive integer');
    const real = await this.resolve(rel);
    const s = await fs.stat(real);
    if (s.isDirectory()) throw new VaultError('invalid_argument', 'this is a folder; use file_list');
    if (s.size > 64 * 1024 * 1024) throw new VaultError('too_large', 'file is larger than 64 MB; large files move through file_download (Phase 4)');
    const buf = await fs.readFile(real);
    if (!isText(buf)) throw new VaultError('invalid_argument', 'binary file; binary attachments move through file_download (Phase 4)');
    inspect?.(buf.toString('utf8'));
    const len = Math.min(length, MAX_READ_BYTES);
    const slice = buf.subarray(offset, offset + len);
    return { path: this.virtual(rel), revision: `sha256:${sha256Hex(buf)}`, size: buf.length, offset, content: slice.toString('utf8'), truncated: offset + slice.length < buf.length };
  }

  /**
   * Folders an agent's walk never enters (vault-relative segments, e.g. [["99 Conclave"]]): the hub's own folder, so
   * file_search and linkedFrom neither read it nor spend their file budget on it. Set once at boot (app.ts).
   */
  agentSkip: string[][] = [];
  private skipped(rel: string[]): boolean { return this.agentSkip.some((s) => s.length <= rel.length && s.every((x, i) => x === rel[i])); }

  /** Walk every visible file below rel (depth-first, bounded). An agent's walk (`o.agent`) skips the agentSkip folders. */
  async *walk(rel: string[], maxFiles = 20000, o: { agent?: boolean } = {}): AsyncGenerator<{ rel: string[]; size: number }> {
    let count = 0;
    if (o.agent && this.skipped(rel)) return;
    const stack: string[][] = [rel];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries;
      try { entries = await fs.readdir(await this.resolve(cur), { withFileTypes: true }); } catch { continue; }
      for (const d of entries) {
        if (this.isHidden(d.name)) continue;
        const child = [...cur, d.name];
        if (o.agent && this.skipped(child)) continue;
        let real: string;
        try { real = await this.resolve(child); } catch { continue; }
        const s = await fs.stat(real).catch(() => null);
        if (!s) continue;
        if (s.isDirectory()) stack.push(child);
        else { yield { rel: child, size: s.size }; if (++count >= maxFiles) return; }
      }
    }
  }
}

export function isText(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n)); return true; }
  catch { return n === 8192; /* a cut multi-byte char at the boundary is fine */ }
}
