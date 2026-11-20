/**
 * Path safety for a vault mirror (docs/vault-sync.md, "The connector side"). Nothing here touches a file except to look
 * (lstat, realpath). A hub path is a claim by someone else: it is checked before any byte is written, and a refused path is
 * reported and never written. The rules are the same on every system, plus what Windows and macOS add.
 */
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';

export const NAME_MAX = 255;
/** Folders the mirror never writes into, at any depth (compared without case). */
export const FORBIDDEN_PARTS = ['.git', '.obsidian', '.conclave-trash', '.conclave-sync'];
const WIN_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const WIN_BAD_CHARS = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

const isWin = (os) => os === 'win32';
const caseless = (os) => os === 'win32' || os === 'darwin';

/** Why a hub path (relative to the vault's root, `/` separated) may not be mirrored, or null. */
export function relRefusal(rel, os = process.platform) {
  if (typeof rel !== 'string' || !rel) return 'empty path';
  if (CONTROL.test(rel)) return 'a control character in the path';
  if (rel.includes('\\')) return 'a backslash in the path';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'an absolute path';
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '') return 'an empty part in the path';
    if (p === '.' || p === '..') return 'a . or .. part in the path';
    if (Buffer.byteLength(p, 'utf8') > NAME_MAX || p.length > NAME_MAX) return 'a name longer than 255';
    if (FORBIDDEN_PARTS.includes(p.toLowerCase())) return `inside ${p.toLowerCase()}`;
    if (isWin(os)) {
      if (WIN_BAD_CHARS.test(p)) return 'a character Windows does not allow in a name';
      if (/^[^.]{1,6}~\d+(\.[^.]{0,3})?$/.test(p)) return 'a Windows short name (8.3), which can stand for another folder';
      if (/[. ]$/.test(p)) return 'a name ending in a dot or a space';
      if (WIN_RESERVED.test(p.split('.')[0].replace(/[ ]+$/, ''))) return 'a name Windows reserves';
    }
  }
  return null;
}

/** The key under which two names are the same file on this system (case on Windows and macOS, and Unicode form on both). */
export const collisionKey = (rel, os = process.platform) => {
  const n = rel.normalize('NFC');
  return caseless(os) ? n.toLowerCase() : n;
};

/**
 * Finds the paths that would land on the same file here. `paths` is a list of hub paths; the result maps a collision key to
 * every path of a group of more than one. Callers write none of them and report all.
 */
export function collisions(paths, os = process.platform) {
  const groups = new Map();
  for (const p of paths) { const k = collisionKey(p, os); const g = groups.get(k); if (g) g.push(p); else groups.set(k, [p]); }
  const out = new Map();
  for (const [k, g] of groups) if (g.length > 1) out.set(k, g);
  return out;
}

/** The name to hand to fs for an absolute path: on Windows a long path takes the `\\?\` form. */
export function fsPath(p, os = process.platform) {
  if (!isWin(os) || p.length < 240 || p.startsWith('\\\\?\\')) return p;
  return p.startsWith('\\\\') ? `\\\\?\\UNC\\${p.slice(2)}` : `\\\\?\\${p}`;
}

const sameOrInside = (child, root, os) => {
  const c = caseless(os) ? child.toLowerCase() : child, r = caseless(os) ? root.toLowerCase() : root;
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};
export { sameOrInside };

/**
 * The absolute target for a hub path under the mirror's folder, or why not. Every part of the path that exists is looked at
 * with lstat: a symlink, junction or other link is refused (never written through), and the real path of the deepest part
 * that exists must lie inside the folder's real path. The last part may be a file already (it is replaced), never a link.
 */
export async function safeTarget(root, rel, os = process.platform) {
  const why = relRefusal(rel, os);
  if (why) return { ok: false, reason: why };
  let realRoot;
  try { realRoot = await fs.realpath(root); } catch { return { ok: false, reason: 'the folder cannot be read' }; }
  const parts = rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = await fs.lstat(fsPath(cur, os)); } catch (e) { if (e.code === 'ENOENT') break; return { ok: false, reason: 'the path cannot be read' }; }
    if (st.isSymbolicLink()) return { ok: false, reason: 'a link in the path' };
    if (i < parts.length - 1 && !st.isDirectory()) return { ok: false, reason: 'a file where a folder is needed' };
    if (i === parts.length - 1 && st.isDirectory()) return { ok: false, reason: 'a folder where a file is needed' };
    if (i === parts.length - 1 && !st.isFile()) return { ok: false, reason: 'not a plain file' };
  }
  // The deepest existing part must resolve inside the folder (a case or 8.3 variant of a name resolves to the real one).
  let probe = path.join(root, ...parts), real = null;
  for (;;) {
    try { real = await fs.realpath(fsPath(probe, os)); break; } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return { ok: false, reason: 'the path cannot be read' }; }
    const up = path.dirname(probe);
    if (up === probe) return { ok: false, reason: 'the path cannot be read' };
    probe = up;
  }
  if (!sameOrInside(real, realRoot, os)) return { ok: false, reason: 'outside the folder' };
  return { ok: true, abs: path.join(realRoot, ...parts) };
}

/**
 * Why a folder may not be a sync's folder, or null. `others` are folders it must not overlap, each `{path, what}`: the
 * connector's own folder, each agent's folder, each other sync's folder. Overlap is either way (inside or holding), compared
 * on real paths.
 */
export function folderRefusal(folder, others, os = process.platform) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return 'the folder must be a full path';
  let real;
  try { real = realpathSync.native(folder); } catch { return 'the folder does not exist'; }
  if (path.dirname(real) === real) return 'a whole drive cannot be a sync folder';
  const parts = real.split(path.sep);
  if (parts.some((p) => FORBIDDEN_PARTS.includes(p.toLowerCase()))) return 'the folder is inside .git, .obsidian or a trash folder';
  for (const o of others) {
    let r;
    try { r = realpathSync.native(o.path); } catch { r = path.resolve(o.path); }
    if (sameOrInside(real, r, os) || sameOrInside(r, real, os)) return `the folder overlaps ${o.what}`;
  }
  return null;
}
