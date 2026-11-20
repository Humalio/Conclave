import path from 'node:path';

/** Lexical check that `target` is inside one of the `allowed` absolute folders (same rule as the bridge program). */
export function isPathAllowed(target: unknown, allowed: string[], os: 'win32' | 'posix'): boolean {
  if (typeof target !== 'string' || target === '' || target.includes('\0')) return false;
  const win = os === 'win32';
  const p = win ? path.win32 : path.posix;
  if (!p.isAbsolute(target)) return false;
  const norm = (s: string) => { const n = p.resolve(s); return win ? n.toLowerCase() : n; };
  const t = norm(target);
  return allowed.some((a) => {
    if (typeof a !== 'string' || !p.isAbsolute(a)) return false;
    const root = norm(a);
    if (t === root) return true;
    const rel = p.relative(root, t);
    return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
  });
}
export const osKind = (os: string | null | undefined): 'win32' | 'posix' => (os && /^(win|windows)/i.test(os) ? 'win32' : 'posix');
export const joinFor = (os: 'win32' | 'posix', ...parts: string[]) => (os === 'win32' ? path.win32 : path.posix).join(...parts);

/** Folders a local upload never reads from: git's own data, Codex's settings and the connector's folders (docs/transfers.md). */
const REFUSED_DIRS = new Set(['.git', '.codex', '.agent-hub']);
/** The role files the connector writes or reads in an agent's folder. */
export const ROLE_FILES = new Set(['claude.md', 'agents.md', 'agents.override.md']);
/**
 * Why a local path may not be uploaded through the connector, on its name alone (the PC checks the real path again,
 * links and junctions resolved): `null` when the name is fine. Refused: an absolute path is required; `.git`, `.codex`,
 * the connector's folders (`.agent-hub`, `.config/conclave`) anywhere on the way; a role file.
 */
export function refusedLocalName(target: string, os: 'win32' | 'posix'): string | null {
  const p = os === 'win32' ? path.win32 : path.posix;
  if (!target || target.includes('\0') || !p.isAbsolute(target)) return 'is not an absolute path.';
  const parts = p.normalize(target).split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  if (parts.some((s) => REFUSED_DIRS.has(s))) return 'is inside .git, .codex or the connector\'s own folder.';
  if (parts.some((s, i) => s === '.config' && parts[i + 1] === 'conclave')) return 'is inside the connector\'s own folder.';
  if (ROLE_FILES.has(parts.at(-1) ?? '')) return 'is a role file (CLAUDE.md, AGENTS.md or AGENTS.override.md).';
  return null;
}
