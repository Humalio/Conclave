/**
 * The sources a blueprint item cites, resolved per viewer (docs/blueprint.md §2.7, proposal addendum E4), with the vault's
 * one link resolver (vault/links.ts, docs/vault.md Links in notes): a source is a vault file when the vault has it at the
 * cited path from the root, at that path under one of the team's granted folders, or as the only file in those folders
 * whose path ends with it (a shortest-path link) or, for a path cited from another checkout, by its file name; else it
 * is missing. Commits, URLs and drive paths are outside the vault.
 *
 * Security: every candidate goes through Vault.normalise (hidden names) and Vault.resolve (the realpath check), never
 * Vault.exists. A viewer gets a path only where its canSee allows it (a member's MemberScope, an agent's own fs.read
 * rules); anything else answers `missing`, as the vault API does, so nothing tells a viewer that a file outside their
 * grant exists. Only the operator (no viewer) resolves across the whole vault.
 */
import { stat } from 'node:fs/promises';
import type { Db } from '../db/db.js';
import type { Vault } from '../vault/vault.js';
import { authorize, type Rule } from '../policy/engine.js';
import { classifySource } from './plain.js';
import { hasExt, resolveLinks, tailMatch, type LinkLookup } from '../vault/links.js';

export interface Source { text: string; where: 'vault' | 'missing' | 'outside'; path?: string; cited?: string }

const READS = new Set(['fs.read', 'fs.*', '*']);

/** Who a source is resolved for: a console member (MemberScope) or an agent (Sources.agent). */
export interface Viewer { canSee(relPath: string): boolean }

export class Sources {
  constructor(private readonly db: Db, private readonly vault: Vault) {}

  /**
   * The vault folders (vault-relative, '' for the whole vault) the team's current members may read: allow rules on
   * `path:` resources with fs.read in their credentials' policies. A project-level item (no team) gets the union of the
   * project's teams.
   */
  folders(projectId: string, teamId: string | null): string[] {
    const teams = teamId ? [teamId] : (this.db.prepare('SELECT id FROM teams WHERE project_id=?').all(projectId) as { id: string }[]).map((t) => t.id);
    if (!teams.length) return [];
    const rows = this.db.prepare(`SELECT DISTINCT r.resource, r.actions FROM team_members m JOIN credentials c ON c.id=m.credential_id JOIN permission_rules r ON r.policy_id=c.policy_id
      WHERE m.removed_at IS NULL AND m.team_id IN (${teams.map(() => '?').join(',')}) AND r.effect='allow' AND r.resource LIKE 'path:%'`).all(...teams) as { resource: string; actions: string }[];
    const out = new Set<string>();
    for (const r of rows) {
      let acts: unknown;
      try { acts = JSON.parse(r.actions); } catch { continue; }
      if (!Array.isArray(acts) || !acts.some((a) => READS.has(String(a)))) continue;
      const segs = r.resource.slice('path:'.length).replace(/\\/g, '/').split('/').filter(Boolean);
      if (segs[0] !== this.vault.alias) continue;
      const rel: string[] = [];
      for (const s of segs.slice(1)) { if (s.includes('*')) break; rel.push(s); }
      out.add(rel.join('/'));
    }
    return [...out].sort();
  }

  /** An agent as a viewer: a vault-relative path it may fs.read under its session and credential rules. */
  agent(rules: Rule[], cap: Rule[]): Viewer {
    return { canSee: (rel) => authorize(rules, cap, 'fs.read', `path:/${this.vault.alias}/${rel.replace(/^\/+/, '')}`).allowed };
  }

  /** The vault-relative path when it names a file this viewer may open, else null. */
  private async file(rel: string, member?: Viewer): Promise<string | null> {
    try {
      const n = this.vault.normalise(`/${this.vault.alias}/${rel}`);
      if (!n.rel.length) return null;
      const r = n.rel.join('/');
      if (member && !member.canSee(r)) return null;
      const s = await stat(await this.vault.resolve(n.rel));
      return s.isFile() ? r : null;
    } catch { return null; }
  }

  /**
   * The files in the folders whose path ends with the tail (the store's index of tracked files, not a walk of the vault).
   * The folders are filtered in SQL, so a name common elsewhere in the vault cannot crowd out the one match in the team's
   * folders. LIKE ignores ASCII case, as tailMatch does.
   */
  private named(tail: string[], folders: string[]): string[][] {
    if (!folders.length || !tail.length) return [];
    const esc = (t: string) => t.replace(/[%_\\]/g, (c) => `\\${c}`);
    const last = tail.at(-1)!, names = hasExt(last) ? [last] : [last, `${last}.md`];
    const whole = folders.includes('');
    const inFolders = whole ? '' : ` AND (${folders.map(() => "path LIKE ? ESCAPE '\\'").join(' OR ')})`;
    const byName = names.map(() => "path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'").join(' OR ');
    const rows = this.db.prepare(`SELECT path FROM files WHERE deleted_at IS NULL AND current_revision IS NOT NULL AND (${byName})${inFolders} LIMIT 50`)
      .all(...names.flatMap((n) => [esc(n), `%/${esc(n)}`]), ...(whole ? [] : folders.map((f) => `${esc(f)}/%`))) as { path: string }[];
    return rows.map((r) => r.path.split('/')).filter((rel) => tailMatch(rel, tail));
  }

  /** A cited text as a link target: a [[wikilink]] without its brackets, label and heading, %-escapes decoded. */
  static target(text: string): string {
    let t = text.trim().replace(/^\[\[|\]\]$/g, '').split('|')[0]!.split('#')[0]!.trim();
    if (/%[0-9A-Fa-f]{2}/.test(t)) { try { t = decodeURIComponent(t); } catch { /* keep it as written */ } }
    return t;
  }

  /** Resolve each cited text for one viewer: the operator (no viewer), a member or an agent. */
  async resolve(projectId: string, teamId: string | null, texts: string[], member?: Viewer): Promise<Source[]> {
    if (!texts.length) return [];
    const folders = this.folders(projectId, teamId);
    const look: LinkLookup = {
      file: async (rel) => { const f = await this.file(rel.join('/'), member); return f ? f.split('/') : null; },
      // An agent often cites a path from its own checkout (Develop/projects/…/ledger.md); when no file ends with the
      // whole path, the file name alone is tried, and resolves when it is the only visible match.
      tails: async (wanted) => Promise.all(wanted.map(async (tail) => {
        const visible = async (hits: string[][]) => { const out: string[][] = []; for (const h of hits) { const ok = await this.file(h.join('/'), member); if (ok) out.push(ok.split('/')); } return out; };
        const out = await visible(this.named(tail, folders));
        return out.length || tail.length < 2 ? out : visible(this.named(tail.slice(-1), folders));
      })),
    };
    const want = texts.filter((t) => classifySource(t) !== 'outside').map((t) => Sources.target(t));
    const found = await resolveLinks(want, { alias: this.vault.alias, from: null, look, bases: folders.filter(Boolean).map((f) => f.split('/')) });
    return texts.map((text): Source => {
      if (classifySource(text) === 'outside') return { text, where: 'outside' };
      const t = Sources.target(text), hits = found.get(t) ?? [];
      // One match only: a source with several equally good matches is ambiguous, so it is missing.
      if (hits.length !== 1) return { text, where: 'missing' };
      const rel = hits[0]!.join('/');
      // Found somewhere other than the cited path (under a granted folder, or by the end of its path): say what was cited.
      let cited = t.replace(/\\/g, '/').replace(/^\/+/, '');
      if (cited.startsWith(`${this.vault.alias}/`)) cited = cited.slice(this.vault.alias.length + 1);
      return { text, where: 'vault', path: `/${this.vault.alias}/${rel}`, ...(rel !== cited && rel !== `${cited}.md` ? { cited: text } : {}) };
    });
  }
}
