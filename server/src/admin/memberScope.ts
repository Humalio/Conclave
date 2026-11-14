/**
 * What a member may see (docs/multi-user.md §1.2, §2): the user's project grants turned into the sets every scoped
 * route filters with, before paging, limits and counts. Built once per request from the database (the grants, the teams
 * of granted projects and the restricted folders), so a grant revoked mid-session applies to the next call.
 */
import type { Db } from '../db/db.js';
import type { Component } from './users.js';
import { normFolder } from './users.js';

interface Grant { project_id: string; components: Set<Component>; folders: string[]; may_export: boolean }
/** A folder grant (docs/multi-user.md §1.2a): a vault folder without a project, Read or Contribute. */
export interface FolderGrant { path: string; mode: 'read' | 'contribute'; may_export: boolean; delegation: { folders?: { path: string; mode: 'read' | 'contribute' }[] } }
/** A hidden part of the vault: the restricted folder `r`, apart from the granted folders inside it (`except`). */
interface Hidden { r: string; except: string[] }
/**
 * Grants to read instead of the saved ones, for the grant editor's preview: the scope a save of them would give, so the
 * preview drops exactly what enforcement would drop.
 */
export interface ScopeOverride {
  grants?: { project_id: string; components: readonly string[]; vault_folders: string[]; may_export: boolean }[];
  folderGrants?: { path: string; mode: 'read' | 'contribute'; may_export: boolean; delegation: { folders?: { path: string; mode: 'read' | 'contribute' }[] } }[];
}

export class MemberScope {
  readonly grants = new Map<string, Grant>();
  /** The person's folder grants: shown in Vault like a project's folders, written with Contribute. */
  readonly folderGrants: FolderGrant[];
  /** Teams of granted projects only: any other team does not exist for the member. */
  private readonly teamRows: { id: string; project_id: string | null; room_id: string | null }[];
  private readonly restricted: string[];
  private readonly vaultFolders: string[];
  private readonly hidden: Hidden[];
  constructor(private readonly db: Db, readonly userId: string, readonly external: boolean, over: ScopeOverride = {}) {
    const saved = () => (db.prepare('SELECT * FROM user_project_grants WHERE user_id=?').all(userId) as { project_id: string; components: string; vault_folders: string; may_export: number }[])
      .map((g) => ({ project_id: g.project_id, components: JSON.parse(g.components) as string[], vault_folders: JSON.parse(g.vault_folders) as string[], may_export: !!g.may_export }));
    for (const g of over.grants ?? saved()) {
      this.grants.set(g.project_id, { project_id: g.project_id, components: new Set(g.components as Component[]), folders: g.vault_folders.map(normFolder), may_export: g.may_export });
    }
    const ids = [...this.grants.keys()];
    this.teamRows = ids.length ? db.prepare(`SELECT id, project_id, room_id FROM teams WHERE project_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as typeof this.teamRows : [];
    this.restricted = (db.prepare('SELECT path FROM vault_folder_flags WHERE restricted=1').all() as { path: string }[]).map((r) => normFolder(r.path));
    this.folderGrants = over.folderGrants ? over.folderGrants.map((g) => ({ path: normFolder(g.path), mode: g.mode, may_export: g.may_export, delegation: g.delegation })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      : (db.prepare('SELECT path, mode, may_export, delegation FROM user_folder_grants WHERE user_id=? ORDER BY path').all(userId) as { path: string; mode: 'read' | 'contribute'; may_export: number; delegation: string }[])
        .map((g) => ({ path: normFolder(g.path), mode: g.mode, may_export: !!g.may_export, delegation: JSON.parse(g.delegation || '{}') }));
    this.vaultFolders = [...new Set([...[...this.grants.values()].filter((g) => g.components.has('vault')).flatMap((g) => g.folders), ...this.folderGrants.map((g) => g.path)])].sort();
    const fs = this.vaultFolders;
    // A restricted folder is hidden from an external user, and from anyone whose grant lies above it, apart from the
    // granted folders inside it: a grant on a subfolder of a restricted folder opens that subfolder, not its parent.
    this.hidden = this.external ? this.restricted.map((r) => ({ r, except: [] }))
      : this.restricted.filter((r) => fs.some((f) => r.startsWith(f) && r !== f)).map((r) => ({ r, except: fs.filter((f) => f.startsWith(r)) }));
  }

  /** Projects granted with this component. */
  projects(c: Component): string[] { return [...this.grants.values()].filter((g) => g.components.has(c)).map((g) => g.project_id); }
  has(projectId: string | null | undefined, c: Component): boolean { return !!projectId && !!this.grants.get(projectId)?.components.has(c); }
  mayExport(projectId: string | null | undefined): boolean { return !!projectId && !!this.grants.get(projectId)?.may_export; }

  /** Teams of projects granted with this component. */
  teams(c: Component): string[] { return this.teamRows.filter((t) => this.has(t.project_id, c)).map((t) => t.id); }
  team(teamId: string, c: Component): boolean { const t = this.teamRows.find((x) => x.id === teamId); return !!t && this.has(t.project_id, c); }
  teamProject(teamId: string): string | null { return this.teamRows.find((x) => x.id === teamId)?.project_id ?? null; }

  /** Agents that are current members of teams visible with this component (tasks, or topology). */
  agents(c: Component = 'tasks'): Set<string> {
    const ids = this.teams(c);
    if (!ids.length) return new Set();
    return new Set((this.db.prepare(`SELECT DISTINCT agent_id FROM team_members WHERE removed_at IS NULL AND team_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { agent_id: string }[]).map((r) => r.agent_id));
  }
  /** Team rooms of teams whose project is granted with this component (messages, or topology). Direct and ad-hoc rooms are never visible. */
  rooms(c: Component = 'messages'): string[] { return this.teamRows.filter((t) => t.room_id && this.has(t.project_id, c)).map((t) => t.room_id!); }
  room(roomId: string, c: Component = 'messages'): string | null {
    const t = this.teamRows.find((x) => x.room_id === roomId && this.has(x.project_id, c));
    return t ? t.project_id : null;
  }

  /**
   * Vault folders the member reads. A restricted folder inside a grant stays out unless it, or a folder inside it, is
   * granted by name (§1.2); an external user never gets one, which the grant check in users.ts also enforces.
   */
  folders(): string[] { return this.vaultFolders; }
  /** The restricted folder that hides this visible-looking folder from the member, or null when nothing hides it. */
  hiddenBy(relFolder: string): string | null {
    const key = `/${relFolder.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
    return this.hidden.find((h) => key.startsWith(h.r) && !h.except.some((e) => key.startsWith(e)))?.r ?? null;
  }
  /** A vault-relative path ("Projects/X/a.md" or "/Projects/X/"), folder or file. */
  canSee(relPath: string, folder = false): boolean {
    const key = `/${relPath.replace(/^\/+/, '').replace(/\/+$/, '')}${folder ? '/' : ''}`;
    if (!this.vaultFolders.some((f) => key.startsWith(f))) return false;
    return !this.hidden.some((h) => key.startsWith(h.r) && !h.except.some((e) => key.startsWith(e)));
  }
  /**
   * May the member take this visible file's original bytes (inline playback or an attachment)? Only through a grant that
   * opens the file and has may_export (a project grant, or the most specific folder grant covering it): a grant whose folder lies above a restricted folder does not open what is inside
   * it, so inside a restricted folder only the grant that names it (or a folder in it) counts.
   */
  mayExportFile(relPath: string): boolean {
    if (!this.canSee(relPath)) return false;
    const key = `/${relPath.replace(/^\/+/, '')}`;
    const opens = (f: string) => key.startsWith(f) && this.restricted.every((r) => !key.startsWith(r) || f.startsWith(r));
    if ([...this.grants.values()].some((g) => g.may_export && g.components.has('vault') && g.folders.some(opens))) return true;
    // A folder grant: the most specific one that covers the file decides, so an inner share without export wins over an
    // outer share with it.
    const fg = this.folderGrant(key);
    return !!fg && fg.may_export && opens(fg.path);
  }
  /**
   * The folder grant that decides for this path ("/A/b.md" or "/A/"): the most specific (deepest) one that covers it, so
   * Read on a parent and Contribute on an inner folder, or the other way round, each hold in their own folder.
   */
  folderGrant(key: string): FolderGrant | undefined {
    let best: FolderGrant | undefined;
    for (const g of this.folderGrants) if (key.startsWith(g.path) && (!best || g.path.length > best.path.length)) best = g;
    return best;
  }
  /**
   * A note the person may create or revise (§1.5): visible, and the most specific folder grant covering it has
   * Contribute. Checked against this target only, so one folder's Contribute never reaches another folder.
   */
  canWrite(relPath: string): boolean {
    const key = `/${relPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
    return this.canSee(relPath) && this.folderGrant(key)?.mode === 'contribute';
  }
  /** A folder that lies above granted folders (the tree may list down to them, showing only the way there). */
  isAncestor(relPath: string): string[] {
    const p = `/${relPath.replace(/^\/+/, '').replace(/\/+$/, '')}/`.replace(/^\/\/$/, '/');
    return this.folders().filter((f) => f.startsWith(p) && f !== p);
  }
  /** SQL for "this column holds a visible vault-relative path (no leading slash)". */
  pathSql(column: string): { sql: string; args: string[] } {
    const fs = this.vaultFolders;
    if (!fs.length) return { sql: '0', args: [] };
    const under = `substr('/' || ${column}, 1, length(?)) = ?`;
    const hidden = this.hidden.map((h) => (h.except.length ? `(${under} AND NOT (${h.except.map(() => under).join(' OR ')}))` : under));
    return {
      sql: `((${fs.map(() => under).join(' OR ')})${hidden.length ? ` AND NOT (${hidden.join(' OR ')})` : ''})`,
      args: [...fs.flatMap((f) => [f, f]), ...this.hidden.flatMap((h) => [h.r, h.r, ...h.except.flatMap((e) => [e, e])])],
    };
  }
}
