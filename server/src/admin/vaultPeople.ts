/**
 * Who reaches a vault folder (docs/multi-user.md §1.2a), and the marks the folder picker draws. Both read the same
 * MemberScope that enforces every member read and write, so the answer is the rule's own, not a copy of it: a person is
 * listed when their scope can see the folder (or something inside it), and Read or Contribute is what the deepest folder
 * grant decides, exactly as a save of that grant would give them.
 */
import type { Db } from '../db/db.js';
import { MemberScope } from './memberScope.js';
import { normFolder } from './users.js';
import { reservedPrefixes } from '../policy/engine.js';

export type Reach = {
  /** A folder grant on this folder or above it, a folder grant on a folder inside it, or a project's folder. */
  how: 'folder' | 'inner' | 'project';
  path: string;
  project: { id: string; name: string; key: string | null } | null;
  access: 'read' | 'contribute';
  may_export: boolean;
};
export type PersonReach = { user_id: string; username: string; display_name: string | null; external: boolean; reach: Reach[] };

/** Every active member who reaches `folder` or something inside it, with how. Admins reach everything and are not listed. */
export function peopleAt(db: Db, folder: string): PersonReach[] {
  const F = normFolder(folder);
  const users = db.prepare(`SELECT id, username, display_name, external FROM admin_users WHERE role='member' AND status='active' ORDER BY lower(COALESCE(display_name, username))`).all() as
    { id: string; username: string; display_name: string | null; external: number }[];
  const out: PersonReach[] = [];
  for (const u of users) {
    const scope = new MemberScope(db, u.id, !!u.external);
    const reach: Reach[] = [];
    const sees = (p: string) => scope.canSee(p, true);
    // The deepest folder grant covering the folder decides its access; inner grants are their own rows.
    const covering = scope.folderGrant(F);
    if (covering && sees(F)) reach.push({ how: 'folder', path: covering.path, project: null, access: covering.mode, may_export: covering.may_export });
    for (const g of scope.folderGrants) if (g.path !== F && g.path.startsWith(F) && sees(g.path)) reach.push({ how: 'inner', path: g.path, project: null, access: g.mode, may_export: g.may_export });
    const projects = db.prepare(`SELECT g.project_id, g.components, g.vault_folders, g.may_export, p.name, p.key FROM user_project_grants g JOIN projects p ON p.id=g.project_id WHERE g.user_id=?`).all(u.id) as
      { project_id: string; components: string; vault_folders: string; may_export: number; name: string; key: string | null }[];
    for (const g of projects) {
      if (!(JSON.parse(g.components) as string[]).includes('vault')) continue;
      const roots = (JSON.parse(g.vault_folders) as string[]).map(normFolder);
      for (const r of roots) {
        const inside = r.startsWith(F);
        if ((F.startsWith(r) || inside) && sees(inside ? r : F)) { reach.push({ how: 'project', path: r, project: { id: g.project_id, name: g.name, key: g.key }, access: 'read', may_export: !!g.may_export }); break; }
      }
    }
    if (reach.length) out.push({ user_id: u.id, username: u.username, display_name: u.display_name, external: !!u.external, reach });
  }
  return out;
}

/** What the folder picker marks for one person: restricted folders, the hub's own folder, what is already shared. */
export function folderMarks(db: Db, userId: string) {
  const restricted = (db.prepare('SELECT path FROM vault_folder_flags WHERE restricted=1').all() as { path: string }[]).map((r) => normFolder(r.path));
  const hub = reservedPrefixes().map((r) => r.split('/').filter(Boolean).slice(1)).filter((s) => s.length).map((s) => `/${s.join('/')}/`);
  const shared = (db.prepare('SELECT path, mode FROM user_folder_grants WHERE user_id=? ORDER BY path').all(userId) as { path: string; mode: 'read' | 'contribute' }[]).map((g) => ({ path: normFolder(g.path), mode: g.mode }));
  const projects = (db.prepare(`SELECT g.project_id id, g.components, g.vault_folders, p.name FROM user_project_grants g JOIN projects p ON p.id=g.project_id WHERE g.user_id=?`).all(userId) as
    { id: string; components: string; vault_folders: string; name: string }[])
    .filter((g) => (JSON.parse(g.components) as string[]).includes('vault')).map((g) => ({ id: g.id, name: g.name, folders: (JSON.parse(g.vault_folders) as string[]).map(normFolder) }));
  return { restricted, hub, shared, projects };
}
