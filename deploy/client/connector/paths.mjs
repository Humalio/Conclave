/**
 * Paths and folder identity for the Conclave connector (docs/connector.md). Node 18 or later, no dependencies.
 *
 * The connector keeps everything in one folder, ~/.config/conclave (CONCLAVE_HOME overrides it, for tests and for a
 * second account). A registered agent folder is known by its canonical path AND its filesystem identity, so a copy or
 * a clone of a folder is never taken for the original.
 */
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync, statSync, lstatSync, writeFileSync, mkdirSync, renameSync, chmodSync, readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const WIN = platform() === 'win32';

/** The connector's own folder. */
export const confDir = (env = process.env) => (env.CONCLAVE_HOME ? resolve(env.CONCLAVE_HOME) : join(homedir(), '.config', 'conclave'));

/** The folder's real path (symlinks and junctions resolved, no trailing separator), or null if it does not exist or is not a folder. */
export function canonicalFolder(p) {
  let r;
  try { r = realpathSync.native(resolve(String(p))); } catch { return null; }
  try { if (!statSync(r).isDirectory()) return null; } catch { return null; }
  return r.length > 1 ? r.replace(/[\\/]+$/, '') : r;
}

/** The comparison key for a path: forward slashes, and lower case on Windows, where paths are case-insensitive. */
export const pathKey = (p, win = WIN) => (win ? String(p).replace(/\\/g, '/').toLowerCase() : String(p));

/** The folder's filesystem identity (device and inode), or null where the filesystem reports none. */
export function folderIdentity(p) {
  try {
    const s = statSync(p, { bigint: true });
    if (s.ino === 0n) return null;
    return `${s.dev}:${s.ino}`;
  } catch { return null; }
}

/** True if `p` itself is a symbolic link, junction or other reparse point. */
export function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The JSON file's value, or `fallback` if it is missing, and `null` if it exists but is not valid JSON. */
export function readJson(path, fallback = undefined) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; return null; }
  try { return JSON.parse(text); } catch { return null; }
}

/** Writes a file through a temporary file in the same folder and a rename, so a reader never sees half a file. */
export function atomicWrite(path, text, secret = false) {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, ...(secret && !WIN ? { mode: 0o700 } : {}) });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: secret ? 0o600 : 0o644 });
  if (secret && !WIN) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The keys Claude Code uses for a folder in ~/.claude.json: forward slashes, and on Windows also the native form (proof 9). */
export const trustKeys = (dir, win = WIN) => (win ? [...new Set([String(dir).replace(/\\/g, '/'), String(dir)])] : [String(dir)]);

/** One line, no control characters: for logs and for anything shown to a person. */
export const oneLine = (s) => String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').split(/\s+/).filter(Boolean).join(' ');

/**
 * Which of `paths` carry the Windows reparse-point attribute: any kind, not only symbolic links and junctions (mount
 * points, cloud-file placeholders, app execution aliases, deduplicated files). Node's lstat names only links, so the
 * attribute is read through PowerShell, once for the whole list; the paths go in through the environment, never a
 * command line (Windows PowerShell 5 emits a JSON array as one object, so it is enumerated as such). Returns a Set of the paths that are reparse points (missing paths are not), or null when the check
 * could not run: the caller then treats every path as unsafe. Elsewhere there are no reparse points: an empty Set.
 */
export function reparsePoints(paths) {
  if (!WIN || !paths.length) return new Set();
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop';"
    + " foreach ($x in ($env:CONCLAVE_REPARSE_PATHS | ConvertFrom-Json)) {"
    + " if (-not [IO.File]::Exists($x) -and -not [IO.Directory]::Exists($x)) { continue };"
    + " if ([IO.File]::GetAttributes($x) -band [IO.FileAttributes]::ReparsePoint) { 'R:' + $x } }; 'DONE'";
  let r;
  try {
    r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, CONCLAVE_REPARSE_PATHS: JSON.stringify(paths) }, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
  } catch { return null; }
  const lines = String(r.stdout || '').split(/\r?\n/);
  if (r.status !== 0 || !lines.includes('DONE')) return null;
  return new Set(lines.filter((l) => l.startsWith('R:')).map((l) => l.slice(2)));
}
