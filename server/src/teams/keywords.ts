/**
 * Keywords on projects and teams (docs/proposals/team-keywords.md, docs/specification.md): the console's Teams view filters
 * by them. A team matches a keyword when it or its project has it. Console only: no MCP tool reads or writes keywords.
 * The known keywords are one hub setting; new projects and teams get DEFAULT_KEYWORD from triggers (migration 0103).
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import { KeyError } from '../keys/keys.js';

export const KEYWORDS_SETTING = 'keywords.known';
export const DEFAULT_KEYWORD = 'Research & Development';
export const DEFAULT_KEYWORDS = [DEFAULT_KEYWORD, 'Applications'];
export const KEYWORD_MAX = 40;
export const KEYWORDS_MAX = 20;

type Usage = Record<string, { projects: number; teams: number }>;
const bad = (m: string) => new KeyError('invalid_argument', m);
const fold = (s: string) => s.toLocaleLowerCase('en');

export class Keywords {
  constructor(private db: Db) {}

  /** The known keywords, in the operator's order. An unreadable setting reads as the default. */
  known(): string[] {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(KEYWORDS_SETTING) as { value: string } | undefined;
    if (!r) return [...DEFAULT_KEYWORDS];
    try { const v = JSON.parse(r.value); if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v; } catch { /* default */ }
    return [...DEFAULT_KEYWORDS];
  }

  /** What a new project or team gets: Research & Development while it is known. */
  defaults(): string[] { return this.known().includes(DEFAULT_KEYWORD) ? [DEFAULT_KEYWORD] : []; }

  /** A clean keyword list: trimmed, inner spaces collapsed, 1–40 characters, not "All", unique ignoring case. */
  static clean(list: unknown, what = 'keywords'): string[] {
    if (!Array.isArray(list)) throw bad(`${what}: a list of keywords.`);
    const out: string[] = [], seen = new Set<string>();
    for (const x of list) {
      if (typeof x !== 'string') throw bad(`${what}: each keyword is text.`);
      const k = x.replace(/\s+/g, ' ').trim();
      if (!k || k.length > KEYWORD_MAX) throw bad(`${what}: a keyword is 1 to ${KEYWORD_MAX} characters.`);
      if (/[\u0000-\u001f\u007f]/.test(k)) throw bad(`${what}: a keyword has no control characters.`);
      if (fold(k) === 'all') throw bad(`${what}: "All" is the filter's own choice and cannot be a keyword.`);
      if (seen.has(fold(k))) throw bad(`${what}: "${k}" is listed twice.`);
      seen.add(fold(k)); out.push(k);
    }
    return out;
  }

  /** Keywords for a project or team: known ones only, in the known list's spelling; anything else is refused. */
  valid(list: unknown, what = 'keywords'): string[] {
    const known = this.known(), by = new Map(known.map((k) => [fold(k), k]));
    const L = Keywords.clean(list, what), unknown = L.filter((k) => !by.has(fold(k)));
    if (unknown.length) throw bad(`${what}: not a known keyword: ${unknown.join(', ')}. Add it to the keyword list first.`);
    return L.map((k) => by.get(fold(k))!);
  }

  usage(): Usage {
    const u: Usage = Object.fromEntries(this.known().map((k) => [k, { projects: 0, teams: 0 }]));
    for (const r of this.db.prepare('SELECT keyword, COUNT(*) n FROM project_keywords GROUP BY keyword').all() as { keyword: string; n: number }[]) if (u[r.keyword]) u[r.keyword]!.projects = r.n;
    for (const r of this.db.prepare('SELECT keyword, COUNT(*) n FROM team_keywords GROUP BY keyword').all() as { keyword: string; n: number }[]) if (u[r.keyword]) u[r.keyword]!.teams = r.n;
    return u;
  }

  /** Replace the known list. A keyword left out comes off every project and team that had it, in the same transaction. */
  setKnown(list: unknown): { keywords: string[]; removed: Usage } {
    const next = Keywords.clean(list);
    if (next.length > KEYWORDS_MAX) throw bad(`keywords: at most ${KEYWORDS_MAX}.`);
    const before = this.usage(), keep = new Set(next.map(fold));
    const gone = Object.keys(before).filter((k) => !keep.has(fold(k)));
    // A keyword kept with a new spelling ("applications" for "Applications") is renamed where it is used.
    const respell = next.map((k) => [Object.keys(before).find((b) => fold(b) === fold(k) && b !== k), k]).filter((x): x is [string, string] => !!x[0]);
    tx(this.db, () => {
      for (const k of gone) {
        this.db.prepare('DELETE FROM project_keywords WHERE keyword=?').run(k);
        this.db.prepare('DELETE FROM team_keywords WHERE keyword=?').run(k);
      }
      for (const [from, to] of respell) {
        this.db.prepare('UPDATE project_keywords SET keyword=? WHERE keyword=?').run(to, from);
        this.db.prepare('UPDATE team_keywords SET keyword=? WHERE keyword=?').run(to, from);
      }
      this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(KEYWORDS_SETTING, JSON.stringify(next), Date.now());
    });
    return { keywords: next, removed: Object.fromEntries(gone.map((k) => [k, before[k]!])) };
  }

  ofProject(id: string): string[] { return this.list('project_keywords', 'project_id', id); }
  ofTeam(id: string): string[] { return this.list('team_keywords', 'team_id', id); }
  private list(table: string, col: string, id: string): string[] {
    return (this.db.prepare(`SELECT keyword FROM ${table} WHERE ${col}=? ORDER BY position, keyword`).all(id) as { keyword: string }[]).map((r) => r.keyword);
  }
  /** Every project's and team's keywords at once, for lists. */
  allProjects(): Map<string, string[]> { return this.all('project_keywords', 'project_id'); }
  allTeams(): Map<string, string[]> { return this.all('team_keywords', 'team_id'); }
  private all(table: string, col: string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const r of this.db.prepare(`SELECT ${col} id, keyword FROM ${table} ORDER BY position, keyword`).all() as { id: string; keyword: string }[]) {
      if (!m.has(r.id)) m.set(r.id, []);
      m.get(r.id)!.push(r.keyword);
    }
    return m;
  }

  setProject(id: string, list: unknown): string[] { return this.set('project_keywords', 'project_id', id, this.valid(list)); }
  setTeam(id: string, list: unknown): string[] { return this.set('team_keywords', 'team_id', id, this.valid(list)); }
  private set(table: string, col: string, id: string, L: string[]): string[] {
    tx(this.db, () => {
      this.db.prepare(`DELETE FROM ${table} WHERE ${col}=?`).run(id);
      L.forEach((k, i) => this.db.prepare(`INSERT INTO ${table}(${col}, keyword, position) VALUES (?,?,?)`).run(id, k, i));
    });
    return L;
  }
}
