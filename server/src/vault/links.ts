/**
 * The one resolver for links to vault notes (docs/vault.md, Links in notes). The vault viewer (POST /api/vault/links),
 * Blueprint Sources, an item's From line and Meetings all resolve a link through resolveLinks, with Obsidian's rules:
 *
 * - a target that starts with `/` is a path from the vault root (with or without the vault's alias), and only that;
 * - a target that starts with `./` or `../` is a path from the folder that holds the note, and only that;
 * - any other target, a bare name or a path with folders (`Plan`, `Projects/Plan.md`, `[[Projects/Plan]]`), is tried
 *   from the vault root, then from the note's folder, then under each extra base folder, and finally as the end of a
 *   path anywhere the viewer may look (shortest-path links), nearest to the note first.
 *
 * A target without an extension also matches the same path with `.md`. The resolver only names candidates; the lookup
 * a caller passes decides which files exist and which the viewer may see, so every access check stays with the caller.
 */

/** What a caller lets the resolver see. Both answer only for files the viewer may open. */
export interface LinkLookup {
  /** The canonical vault-relative path of a visible file at exactly this path, or null. */
  file(rel: string[]): Promise<string[] | null>;
  /** For each wanted tail, the visible files whose path ends with it (case and Unicode form ignored; see tailMatch). */
  tails(wanted: string[][]): Promise<string[][][]>;
}

export const hasExt = (name: string) => /\.[^./]{1,10}$/.test(name);
const fold = (s: string) => s.normalize('NFC').toLowerCase();

/** Whether a vault-relative path ends with the tail; the tail's last name also matches that name plus `.md`. */
export function tailMatch(rel: string[], tail: string[]): boolean {
  if (!tail.length || tail.length > rel.length) return false;
  const end = rel.slice(-tail.length).map(fold), want = tail.map(fold), last = want.length - 1, ext = hasExt(tail[last]!);
  return end.every((s, i) => s === want[i] || (i === last && !ext && s === want[i] + '.md'));
}

/** Closeness to the note: more shared leading folders first, then the shorter path, then by name. */
export function nearest(from: string[] | null) {
  const base = (from ?? []).slice(0, -1);
  const shared = (rel: string[]) => { let i = 0; while (i < base.length && i < rel.length - 1 && base[i] === rel[i]) i++; return i; };
  return (a: string[], b: string[]) => shared(b) - shared(a) || a.length - b.length || a.join('/').localeCompare(b.join('/'));
}

/**
 * A link target as vault-relative segments, and how it may be read: `root` (starts with `/`), `relative` (starts with
 * `.`) or `any`. `..` is applied here; null when it climbs above the root, or when a relative link has no note to start from.
 */
export function linkSegments(target: string, alias: string, from: string[] | null): { segs: string[]; mode: 'root' | 'relative' | 'any' } | null {
  const t = String(target ?? '').trim().replace(/\\/g, '/');
  if (!t) return null;
  const mode = t.startsWith('/') ? 'root' : t.startsWith('.') ? 'relative' : 'any';
  let raw = t.split('/');
  if (mode === 'root') { raw = raw.filter(Boolean); if (raw[0] === alias) raw = raw.slice(1); }
  if (mode === 'relative') { if (!from) return null; raw = [...from.slice(0, -1), ...raw]; }
  const segs: string[] = [];
  for (const s of raw) {
    if (!s || s === '.') continue;
    if (s === '..') { if (!segs.length) return null; segs.pop(); } else segs.push(s);
  }
  return segs.length ? { segs, mode } : null;
}

/**
 * Resolve each target for one viewer. `from` is the note that holds the links (vault-relative), or null outside a note;
 * `bases` are extra folders a cited path may sit under (Blueprint Sources: the team's granted folders). Each answer is
 * the list of matches: one for an exact path, the visible tail matches nearest first for a shortest-path link, none
 * when nothing matches.
 */
export async function resolveLinks(targets: string[], o: { alias: string; from: string[] | null; look: LinkLookup; bases?: string[][] }): Promise<Map<string, string[][]>> {
  const out = new Map<string, string[][]>();
  const later: { t: string; segs: string[] }[] = [];
  for (const t of new Set(targets)) {
    const s = linkSegments(t, o.alias, o.from);
    if (!s) { out.set(t, []); continue; }
    const tries: string[][] = [s.segs];
    if (s.mode === 'any') {
      if (o.from) tries.push([...o.from.slice(0, -1), ...s.segs]);
      for (const b of o.bases ?? []) if (b.length) tries.push([...b, ...s.segs]);
    }
    let hit: string[] | null = null;
    for (const r of tries) {
      for (const c of hasExt(r.at(-1)!) ? [r] : [r, [...r.slice(0, -1), r.at(-1)! + '.md']]) { hit = await o.look.file(c); if (hit) break; }
      if (hit) break;
    }
    if (hit) out.set(t, [hit]);
    else if (s.mode === 'any') later.push({ t, segs: s.segs });
    else out.set(t, []);
  }
  if (later.length) {
    const found = await o.look.tails(later.map((l) => l.segs));
    const order = nearest(o.from);
    later.forEach((l, i) => out.set(l.t, [...(found[i] ?? [])].sort(order)));
  }
  return out;
}
