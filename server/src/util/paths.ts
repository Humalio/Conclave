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
