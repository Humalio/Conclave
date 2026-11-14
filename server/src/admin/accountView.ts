/**
 * A collaborator's own agents for Account (docs/multi-user.md §7, Account): each agent they own, by label, with its
 * effective scope. A delegated team counts only while the agent is a live member of it, and a delegated folder only
 * inside a folder the owner may see now: the same reading as the owner ceiling in policy/ownerScope.ts (rules()). A
 * project grant's vault is Read (it needs the vault component); Contribute comes only from a folder grant whose own mode
 * and the delegated mode are both Contribute, for folders inside that grant. Nothing an agent could use leaves here: no
 * key, credential, machine or host.
 */
import type { Db } from '../db/db.js';
import { MemberScope } from './memberScope.js';
import type { Component } from './users.js';
import type { Delegation } from '../policy/ownerScope.js';

export interface OwnedAgent {
  id: string;
  label: string;
  teams: { id: string; name: string; project_name: string | null }[];
  folders: { path: string; mode: 'read' | 'contribute' }[];
}

const delegated = (raw: string | null): Delegation => { try { return JSON.parse(raw || '{}') as Delegation; } catch { return {}; } };
/** "/A/B/" for a delegated folder path, or null for an empty or dotted one. */
const norm = (p: unknown): string | null => {
  const parts = String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  return !parts.length || parts.some((x) => x === '.' || x === '..') ? null : `/${parts.join('/')}/`;
};

/** The active agents a console user owns, label order, each with the teams and folders it may work in today. */
export function ownedAgents(db: Db, userId: string, external: boolean): OwnedAgent[] {
  const agents = db.prepare("SELECT id, label FROM agents WHERE owner_user_id=? AND status='active' ORDER BY label COLLATE NOCASE, id").all(userId) as { id: string; label: string }[];
  if (!agents.length) return [];
  const scope = new MemberScope(db, userId, external);
  const grants = db.prepare('SELECT project_id, components, delegation FROM user_project_grants WHERE user_id=?').all(userId) as { project_id: string; components: string; delegation: string | null }[];
  const fgrants = db.prepare('SELECT path, mode, delegation FROM user_folder_grants WHERE user_id=?').all(userId) as { path: string; mode: string; delegation: string | null }[];
  return agents.map((a) => {
    const teams = new Map<string, OwnedAgent['teams'][number]>();
    const folders = new Map<string, 'read' | 'contribute'>();
    for (const g of grants) {
      const comps = new Set(JSON.parse(g.components) as Component[]);
      const d = delegated(g.delegation);
      for (const teamId of d.teams ?? []) {
        const t = db.prepare(`SELECT t.id, t.name, p.name project_name FROM teams t LEFT JOIN projects p ON p.id=t.project_id
          JOIN team_members m ON m.team_id=t.id AND m.agent_id=? AND m.removed_at IS NULL WHERE t.id=? AND t.project_id=?`).get(a.id, teamId, g.project_id) as OwnedAgent['teams'][number] | undefined;
        if (t) teams.set(t.id, { id: t.id, name: t.name, project_name: t.project_name ?? null });
      }
      if (!comps.has('vault')) continue;
      for (const f of d.folders ?? []) {
        const folder = norm(f.path);
        if (folder && scope.canSee(folder, true) && !folders.has(folder)) folders.set(folder, 'read');
      }
    }
    for (const g of fgrants) {
      for (const f of delegated(g.delegation).folders ?? []) {
        const folder = norm(f.path);
        if (!folder || !folder.toLowerCase().startsWith(g.path.toLowerCase()) || !scope.canSee(folder, true)) continue;
        // Contribute anywhere wins over Read for the same folder.
        if (g.mode === 'contribute' && f.mode === 'contribute') folders.set(folder, 'contribute');
        else if (!folders.has(folder)) folders.set(folder, 'read');
      }
    }
    return {
      id: a.id, label: a.label,
      teams: [...teams.values()].sort((x, y) => x.name.localeCompare(y.name)),
      folders: [...folders].map(([path, mode]) => ({ path, mode })).sort((x, y) => x.path.localeCompare(y.path)),
    };
  });
}
