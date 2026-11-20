/**
 * Paths and folder identity for the Conclave connector (docs/connector.md). Node 18 or later, no dependencies.
 *
 * The connector keeps everything in one folder, ~/.config/conclave (CONCLAVE_HOME overrides it, for tests and for a
 * second account). A registered agent folder is known by its canonical path AND its filesystem identity, so a copy or
 * a clone of a folder is never taken for the original.
 */
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync, statSync, lstatSync, writeFileSync, mkdirSync, renameSync, chmodSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, rmSync } from 'node:fs';
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

/**
 * Writes a file through a temporary file in the same folder and a rename, so a reader never sees half a file. The
 * temporary file is flushed to disk before the rename, and on macOS and Linux the folder is flushed after it, so a power
 * loss leaves the old file or the new one, never an empty one.
 */
export function atomicWrite(path, text, secret = false) {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, ...(secret && !WIN ? { mode: 0o700 } : {}) });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', secret ? 0o600 : 0o644);
  try { writeSync(fd, typeof text === 'string' ? Buffer.from(text, 'utf8') : text); fsyncSync(fd); } finally { closeSync(fd); }
  if (secret && !WIN) chmodSync(tmp, 0o600);
  try { renameSync(tmp, path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  if (!WIN) { try { const d = openSync(dir, 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* a folder that cannot be flushed: the rename still happened */ } }
}

/** True if a process with this id is alive (signal 0 only checks; EPERM means it exists under another user). */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * The connector's shared state files (the key file, the registry, the process list, the switches, the builds) are
 * written as two flushed copies: `<file>.bak` first, then `<file>`, both through `atomicWrite`. Whichever write a crash
 * or a power loss interrupts, the other copy is whole, and `readState` falls back to the `.bak` when the file itself
 * is not valid. The `.bak` always holds the newest content, so a key removed from the file is gone from the `.bak` too.
 */
export const bakPath = (path) => `${path}.bak`;
export function writeState(path, text, secret = false) {
  atomicWrite(bakPath(path), text, secret);
  atomicWrite(path, text, secret);
}

/** Like `readJson`, but a file that is not valid JSON is read from its `.bak` (written by `writeState`) when that one is. */
export function readState(path, fallback = undefined) {
  const v = readJson(path, fallback);
  if (v !== null) return v;
  const b = readJson(bakPath(path), null);
  return b ?? null;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** How long a state lock is waited for, and after how long a lock whose holder still runs is taken as stuck. */
export const LOCK_WAIT_MS = 10_000, LOCK_STALE_MS = 60_000;

/**
 * Runs `fn` (synchronous) while holding `<path>.lock`, so two processes never interleave a read-change-write of the
 * same state file. The lock file names its holder (`{pid, at}`); a lock whose process is gone, or older than a minute, is
 * taken over. Waits up to 10 seconds, then throws `state_locked`.
 */
export function withLock(path, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lock = `${path}.lock`;
  mkdirSync(join(path, '..'), { recursive: true });
  const until = Date.now() + waitMs;
  let fd = null;
  for (;;) {
    try { fd = openSync(lock, 'wx', 0o600); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const h = readJson(lock, null);
    if (!h || !alive(h.pid) || h.pid === process.pid || Date.now() - (Number(h.at) || 0) > staleMs) {
      // An unreadable lock may be one being written this instant: only a lock that stays unreadable is taken over.
      if (h || Date.now() + waitMs - until > 200) { rmSync(lock, { force: true }); continue; }
    }
    if (Date.now() > until) throw Object.assign(new Error(`a state file is locked by process ${h?.pid ?? 'unknown'}`), { reason: 'state_locked' });
    sleepSync(25);
  }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { closeSync(fd); }
  try { return fn(); } finally { const h = readJson(lock, null); if (!h || h.pid === process.pid) rmSync(lock, { force: true }); }
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
