/**
 * Vault links in rendered Markdown (docs/vault.md, Links in notes): one resolver for the operator and console members.
 * The console sends each link's target as written (md.js) and asks here which file it opens for this viewer, with the
 * shared rules of vault/links.ts. A link to a folder (`[x](Drafts/Paper)`) opens that folder: its answer ends with `/`. A target that is missing, hidden, refused by the path rules or outside a member's
 * grant gets the same answer (no match), so the answer never tells a member that a hidden file exists.
 */
import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Vault } from '../vault/vault.js';
import { hasExt, nearest, resolveLinks, tailMatch, type LinkLookup } from '../vault/links.js';
import type { MemberScope } from './memberScope.js';

export interface VaultLinksDeps { vault: Vault }

/** At most this many targets per request; a name search reads at most WALK_MAX visible files, like the tree. */
export const LINKS_MAX = 200;
const WALK_MAX = 20000;
/** Matches listed for one ambiguous name. */
const MATCH_MAX = 20;

const Body = z.object({
  from: z.string().max(1024).optional(),
  /** Link targets as written in the note (md.js), resolved with the shared rules. */
  links: z.array(z.string().max(1024)).max(LINKS_MAX).default([]),
  /** Before links: a path md.js worked out, and a wiki name. Kept for a console page loaded before the update. */
  paths: z.array(z.string().max(1024)).max(LINKS_MAX).default([]),
  names: z.array(z.string().max(512)).max(LINKS_MAX).default([]),
});

export function registerVaultLinksApi(api: FastifyInstance, d: VaultLinksDeps): void {
  const { vault } = d;

  /** The canonical vault-relative path of a file the viewer may open at exactly this path, or null for every other case. */
  const visible = async (rel: string[], m?: MemberScope): Promise<string[] | null> => {
    let n: string[];
    try { n = vault.normalise(vault.virtual(rel)).rel; } catch { return null; }
    if (!n.length || (m && !m.canSee(n.join('/')))) return null;
    try { return (await fs.stat(await vault.resolve(n))).isFile() ? n : null; } catch { return null; }
  };

  /** The same for a folder: a member sees a folder their grant opens, as the vault tree shows it. */
  const visibleDir = async (rel: string[], m?: MemberScope): Promise<string[] | null> => {
    let n: string[];
    try { n = vault.normalise(vault.virtual(rel)).rel; } catch { return null; }
    if (!n.length || (m && !m.canSee(n.join('/'), true))) return null;
    try { return (await fs.stat(await vault.resolve(n))).isDirectory() ? n : null; } catch { return null; }
  };

  /** Where to look for a shortest-path link: the whole vault for the operator, each granted folder once for a member. */
  const roots = (m?: MemberScope): string[][] => {
    if (!m) return [[]];
    const out: string[] = [];
    for (const f of m.folders()) if (!out.some((o) => f.startsWith(o))) out.push(f);
    return out.map((f) => f.split('/').filter(Boolean));
  };

  /** One walk for every wanted tail, visible files only. */
  const tails = async (wanted: string[][], m?: MemberScope): Promise<string[][][]> => {
    const found: string[][][] = wanted.map(() => []);
    let seen = 0;
    walk: for (const root of roots(m)) {
      for await (const f of vault.walk(root, WALK_MAX)) {
        if (++seen > WALK_MAX) break walk;
        if (m && !m.canSee(f.rel.join('/'))) continue;
        wanted.forEach((w, i) => { if (tailMatch(f.rel, w)) found[i]!.push(f.rel); });
      }
    }
    return found;
  };

  /** A virtual path or null, as the vault API names files. */
  const fromRel = (from?: string): string[] | null => { try { return from ? vault.normalise(from).rel : null; } catch { return null; } };

  api.post('/api/vault/links', async (req) => {
    const b = Body.parse(req.body ?? {});
    const m = req.member;
    const from = fromRel(b.from);
    const look: LinkLookup = { file: (rel) => visible(rel, m), tails: (w) => tails(w, m), folder: (rel) => visibleDir(rel, m) };

    const links: Record<string, string[]> = {};
    if (b.links.length) {
      const r = await resolveLinks(b.links, { alias: vault.alias, from, look });
      // A folder comes back with an empty last segment (links.ts) and goes out as its virtual path with a trailing slash.
      for (const [t, L] of r) links[t] = L.slice(0, MATCH_MAX).map((rel) => (rel.at(-1) === '' ? vault.virtual(rel.slice(0, -1)) + '/' : vault.virtual(rel)));
    }

    // The earlier protocol: a path md.js worked out (exact, with or without .md), and a wiki name matched anywhere.
    const paths: Record<string, string | null> = {};
    for (const p of new Set(b.paths)) {
      let rel: string[] | null = null;
      try { rel = vault.normalise(p).rel; } catch { /* refused: unavailable */ }
      let hit: string[] | null = null;
      if (rel?.length) for (const c of hasExt(rel.at(-1)!) ? [rel] : [rel, [...rel.slice(0, -1), rel.at(-1)! + '.md']]) { hit = await visible(c, m); if (hit) break; }
      paths[p] = hit ? vault.virtual(hit) : null;
    }
    const names: Record<string, string[]> = {};
    const wanted = [...new Set(b.names.map((n) => n.trim()).filter(Boolean))];
    if (wanted.length) {
      const found = await tails(wanted.map((n) => n.replace(/\\/g, '/').split('/').filter(Boolean)), m);
      const order = nearest(from);
      wanted.forEach((n, i) => { names[n] = found[i]!.sort(order).slice(0, MATCH_MAX).map((rel) => vault.virtual(rel)); });
    }
    return { links, paths, names };
  });
}
