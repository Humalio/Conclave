/**
 * Owner enforcement (docs/authorization.md#owner-enforcement; next release §2, enforcement contract points 2 to 4): the
 * grant-to-operation mapping. An agent acts only within its owner's delegated grant, and work handed over by another
 * owner's agent is trusted only up to that owner's grant. Both are owner ceilings (engine.ts OwnerLayer) on the cap of
 * every decision, built again from the database on every call, so a narrowed grant, a disabled or expired owner, a
 * removed delegation or a lost team membership applies to the next operation, queued work included.
 *
 * Only while owner enforcement is on (keys.ts, after the admin's claim step): otherwise there is no ceiling and every
 * agent keeps the rules it has.
 */
import type { Db } from '../db/db.js';
import { MemberScope, type ScopeOverride } from '../admin/memberScope.js';
import type { Component } from '../admin/users.js';
import { ownerAllows, withOwners, type Cap, type OwnerLayer, type Rule } from './engine.js';

/** A grant's agent delegation (user_project_grants.delegation). A new grant delegates nothing. */
export interface Delegation {
  /** Teams of the granted project where the person's agents may do team work. */
  teams?: string[];
  /** Vault folders, inside the grant's own, where the person's agents may read, or (folder grants only) create and revise notes. */
  folders?: { path: string; mode: 'read' | 'contribute' }[];
}

/**
 * The mapping, per component of the owner's grant, for team work in a delegated team (resources of that team only).
 * Read-only components (feed, topology) map to nothing. Machine use (channels, the bridge, checkouts), destructive vault
 * operations (delete, rename, restore) and anything not listed here have no mapping, so a ceiling refuses them.
 */
export const TEAM_WORK: Partial<Record<Component, string[]>> = {
  tasks: ['team.member', 'task.*', 'team.report', 'team.complete', 'team.ask', 'team.recruit'],
  messages: ['room.join', 'room.post', 'room.read_history', 'room.invite'],
  blueprint: ['blueprint.read', 'blueprint.write'],
  graph: ['graph.read'],
};
/** Folder delegation: Read, and Contribute on top of it. Export (fs.download) needs the grant's export permission. */
export const FOLDER_READ = ['fs.list', 'fs.read', 'fs.search', 'fs.history', 'fs.conflicts'];
export const FOLDER_CONTRIBUTE = ['fs.create', 'fs.update'];
/** Share work, with the tasks component in a delegated team: shares of that team's live members, and a new share. */
export const SHARE_WORK = ['share.read', 'share.comment', 'share.suggest', 'share.upload', 'share.promote'];

/**
 * The mapping in words, for the grant editor's preview and Account (docs/authorization.md#owner-enforcement): what each
 * part of a delegation permits, with the action names. Built from the same lists as the rules, so the console keeps no copy.
 */
export interface OpLine { label: string; actions: string[] }
const TEAM_LINES: [Component, string, string[]][] = [
  ['tasks', "Tasks, reports, completion, questions and recruiting, and the team's shares", [...TEAM_WORK.tasks!, ...SHARE_WORK, 'share.create']],
  ['messages', 'The team room, and messages with its live members', [...TEAM_WORK.messages!, 'message.send', 'message.receive']],
  ['blueprint', "Read and write the project's Blueprint through this team", TEAM_WORK.blueprint!],
  ['graph', 'Read the whole knowledge graph', TEAM_WORK.graph!],
];
export function teamOps(components: Iterable<string>): OpLine[] {
  const c = new Set(components);
  return TEAM_LINES.filter(([k]) => c.has(k)).map(([, label, actions]) => ({ label, actions }));
}
export function folderOps(mode: 'read' | 'contribute', mayExport: boolean): OpLine[] {
  return [{ label: 'List, read, search, history and conflicts', actions: FOLDER_READ },
    ...(mode === 'contribute' ? [{ label: 'Create and revise notes', actions: FOLDER_CONTRIBUTE }] : []),
    ...(mayExport ? [{ label: 'Download (the grant has Exports)', actions: ['fs.download'] }] : [])];
}
/** Refused whatever is delegated: no mapping exists for these. */
export const NEVER: OpLine[] = [
  { label: 'Delete, rename or restore vault files', actions: ['fs.delete', 'fs.rename', 'fs.restore'] },
  { label: 'Data channels and the bridge', actions: ['channel.open', 'channel.accept', 'channel.use'] },
  { label: 'Checkouts', actions: [] },
];
/**
 * A delegated folder in the preview. `refused` says why its agents get nothing there (the owner cannot see the folder,
 * for example a restricted folder), and its operations are then empty: enforcement drops it the same way.
 */
export interface FolderView { path: string; mode: 'read' | 'contribute'; operations: OpLine[]; refused?: string }
/** A folder grant's delegation in words: each delegated folder at most the grant's own mode. */
export interface FolderDelegationView {
  path: string;
  mode: 'read' | 'contribute';
  folders: FolderView[];
}
export interface DelegationView {
  project_id: string;
  teams: { id: string; name: string; agents: string[]; operations: OpLine[] }[];
  folders: FolderView[];
}

const allow = (id: string, actions: string[], resource: string): Rule => ({ id: `owner:${id}`, effect: 'allow', actions, resource });
const deny = (id: string, actions: string[], resource: string): Rule => ({ id: `owner:${id}`, effect: 'deny', actions, resource });
const ENFORCE_KEY = 'agent_owner.enforcement', CLAIM_KEY = 'agent_owner.claim';

interface UserRow { id: string; username: string; display_name: string | null; role: 'admin' | 'member'; status: string; expires_at: number | null; external: number }

export class OwnerScope {
  constructor(private readonly db: Db, private readonly alias: string) {}

  /** Owner enforcement is on: the admin has claimed the existing agents and switched it on (keys.ts). */
  enforced(): boolean {
    const v = (k: string) => (this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(k) as { value: string } | undefined)?.value;
    return v(CLAIM_KEY) !== undefined && v(ENFORCE_KEY) === 'true';
  }

  /** The app key cap with the agent's owner ceilings on it; the plain cap while enforcement is off. */
  cap(agentId: string, appRules: Rule[]): Cap { return withOwners(appRules, this.layers(agentId)); }

  /**
   * The owner ceilings on an agent: its own owner's, then one per other owner whose agent handed over work it is doing
   * now (a task assigned to it, from assigned to changes_requested, or one it reviews, created by or last reviewed by another owner's agent). Null while enforcement
   * is off. An admin owner adds no ceiling; an unowned agent, or one whose owner cannot be used, gets an empty one.
   */
  layers(agentId: string): OwnerLayer[] | null {
    if (!this.enforced()) return null;
    const own = (this.db.prepare('SELECT owner_user_id o FROM agents WHERE id=?').get(agentId) as { o: string | null } | undefined)?.o ?? null;
    const out: OwnerLayer[] = [];
    const mine = this.layer(own, agentId, 'owner');
    if (mine) out.push(mine);
    for (const h of this.handedOver(agentId, own)) {
      const l = this.layer(h.owner, agentId, 'task', h.task, h.via);
      if (l) out.push(l);
    }
    return out;
  }

  /** Other owners whose agents handed over work this agent is doing now, one per owner, with the first such task. */
  handedOver(agentId: string, own: string | null): { owner: string; task: string; via: 'origin' | 'reviewer' | 'assignee' }[] {
    const rows = this.db.prepare(`SELECT t.id, t.status, t.assignee_agent_id a, t.reviewer_agent_id r, t.review_rounds n, t.origin_owner_id o,
        (SELECT owner_user_id FROM agents WHERE id=t.reviewer_agent_id) ro, (SELECT owner_user_id FROM agents WHERE id=t.assignee_agent_id) ao
      FROM tasks t WHERE (t.assignee_agent_id=? AND t.status IN ('assigned','in_progress','changes_requested')) OR (t.reviewer_agent_id=? AND t.status='in_review') ORDER BY t.updated_at`)
      .all(agentId, agentId) as { id: string; a: string | null; r: string | null; n: number; o: string | null; ro: string | null; ao: string | null }[];
    const seen = new Map<string, { task: string; via: 'origin' | 'reviewer' | 'assignee' }>();
    for (const t of rows) {
      // The assignee acts on the task's text and, after a review, on the reviewer's; the reviewer acts on the submission.
      const from: [string | null, 'origin' | 'reviewer' | 'assignee'][] = t.a === agentId ? [[t.o, 'origin'], [t.n > 0 ? t.ro : null, 'reviewer']] : [[t.o, 'origin'], [t.ao, 'assignee']];
      for (const [o, via] of from) if (o && o !== own && !seen.has(o)) seen.set(o, { task: t.id, via });
    }
    return [...seen].map(([owner, h]) => ({ owner, ...h }));
  }

  /**
   * Whether a notice may reach this agent (docs/authorization.md, "Notices follow the owner"): one about a task needs the
   * agent's own owner to do team work in the task's team. Every other notice is about the agent itself, the operator's
   * rules or feedback, and passes; so does every notice while enforcement is off, or for an admin owner's agent.
   */
  maySeeNotice(agentId: string, ref: { kind: string; id: string } | null): boolean {
    if (ref?.kind !== 'task' || !this.enforced()) return true;
    const t = this.db.prepare('SELECT team_id FROM tasks WHERE id=?').get(ref.id) as { team_id: string | null } | undefined;
    // A task with no team (none is made today) is no team's work, so its notice is delivered as with enforcement off.
    if (!t?.team_id) return true;
    const own = (this.db.prepare('SELECT owner_user_id o FROM agents WHERE id=?').get(agentId) as { o: string | null } | undefined)?.o ?? null;
    const l = this.layer(own, agentId, 'owner');
    return !l || ownerAllows(withOwners([], [l]), 'team.member', `team:${t.team_id}`);
  }

  /**
   * The owner of another agent's text, as a label, when it is a person other than the reader's owner and not an admin:
   * work from another owner's agent is labelled with that owner (null otherwise).
   */
  foreignOwner(readerAgentId: string, authorAgentId: string | null): string | null {
    if (!authorAgentId || authorAgentId === readerAgentId) return null;
    const o = (id: string) => (this.db.prepare('SELECT owner_user_id o FROM agents WHERE id=?').get(id) as { o: string | null } | undefined)?.o ?? null;
    const author = o(authorAgentId);
    if (!author || author === o(readerAgentId)) return null;
    const u = this.db.prepare('SELECT role FROM admin_users WHERE id=?').get(author) as { role: string } | undefined;
    return u && u.role !== 'admin' ? this.label(author) : null;
  }
  /** A person as a label (display name or username), for refusals, the inspector and work labels. */
  label(userId: string | null): string {
    if (!userId) return 'no owner';
    const u = this.db.prepare('SELECT username, display_name FROM admin_users WHERE id=?').get(userId) as { username: string; display_name: string | null } | undefined;
    return u ? u.display_name || u.username : 'an unknown person';
  }

  /** One owner's ceiling for this agent; null for an active admin (no ceiling). */
  private layer(userId: string | null, agentId: string, basis: 'owner' | 'task', task?: string, via?: OwnerLayer['via']): OwnerLayer | null {
    const base = { owner: userId, label: this.label(userId), basis, ...(task ? { task } : {}), ...(via ? { via } : {}) };
    if (!userId) return { ...base, rules: [] };
    const u = this.db.prepare('SELECT id, username, display_name, role, status, expires_at, external FROM admin_users WHERE id=?').get(userId) as UserRow | undefined;
    if (!u || u.status !== 'active' || (u.expires_at !== null && u.expires_at <= Date.now())) return { ...base, rules: [] };
    if (u.role === 'admin') return null;
    const scope = new MemberScope(this.db, u.id, !!u.external);
    return { ...base, rules: this.rules(u.id, agentId, scope), paths: (p) => this.visible(scope, p) };
  }

  /** A vault path ("/<alias>/a/b.md") the owner may see: in a granted folder, and not in a restricted folder hidden from them. */
  private visible(scope: MemberScope, path: string): boolean {
    const pre = `/${this.alias}`;
    if (path !== pre && !path.startsWith(`${pre}/`)) return false;
    const rel = path.slice(pre.length);
    // Checked as a folder: a path is often a folder named without its trailing slash, and a hidden folder's name must
    // not pass as a file's ("/A/R" for the restricted "/A/R/"). A file under a visible folder passes this way too.
    return scope.canSee(rel, true) || scope.isAncestor(rel).length > 0;
  }

  /** The owner's grants, mapped to rules for this agent. */
  private rules(userId: string, agentId: string, scope: MemberScope): Rule[] {
    const out: Rule[] = [allow('tools', ['tool.invoke'], 'tool:*')];
    const grants = this.db.prepare('SELECT project_id, components, delegation, may_export FROM user_project_grants WHERE user_id=?').all(userId) as { project_id: string; components: string; delegation: string; may_export: number }[];
    const peers = new Set<string>(), authors = new Set<string>();
    for (const g of grants) {
      const comps = new Set(JSON.parse(g.components) as Component[]);
      const d = JSON.parse(g.delegation || '{}') as Delegation;
      for (const teamId of d.teams ?? []) {
        const t = this.db.prepare('SELECT id, room_id FROM teams WHERE id=? AND project_id=?').get(teamId, g.project_id) as { id: string; room_id: string | null } | undefined;
        // Team work needs live team membership of the agent, as well as the delegation.
        if (!t || !this.db.prepare('SELECT 1 x FROM team_members WHERE team_id=? AND agent_id=? AND removed_at IS NULL').get(t.id, agentId)) continue;
        for (const c of comps) {
          const acts = TEAM_WORK[c];
          if (!acts) continue;
          const team = acts.filter((a) => !a.startsWith('room.') && !a.startsWith('graph.'));
          if (team.length) out.push(allow(`${c}:${t.id}`, team, `team:${t.id}`));
          if (c === 'messages' && t.room_id) out.push(allow(`room:${t.id}`, acts, `room:${t.room_id}`));
          if (c === 'graph') out.push(allow(`graph:${t.id}`, acts, 'graph:*'));
        }
        const members = (this.db.prepare('SELECT agent_id FROM team_members WHERE team_id=? AND removed_at IS NULL').all(t.id) as { agent_id: string }[]).map((r) => r.agent_id);
        if (comps.has('messages')) for (const m of members) if (m !== agentId) peers.add(m);
        if (comps.has('tasks')) for (const m of members) authors.add(m);
      }
      if (!comps.has('vault')) continue;
      for (const f of d.folders ?? []) {
        const parts = String(f.path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
        if (!parts.length || parts.some((x) => x === '.' || x === '..')) continue;
        const folder = `/${parts.join('/')}/`;
        // Folder delegation only narrows the owner's own folders.
        if (!scope.canSee(folder, true)) continue;
        // A project grant's vault is Read (docs/authorization.md#delegation): Contribute comes only from a folder grant.
        const acts = [...FOLDER_READ, ...(g.may_export ? ['fs.download'] : [])];
        out.push(allow(`folder:${g.project_id}:${folder}`, acts, `path:/${this.alias}${folder}**`));
      }
    }
    // Folder grants (docs/multi-user.md §1.2a): each delegated folder inside its grant, at most the grant's mode, with
    // export only from that grant. One rule per folder, so one folder's write or export never reaches another.
    const fgs = this.db.prepare('SELECT path, mode, may_export, delegation FROM user_folder_grants WHERE user_id=?').all(userId) as { path: string; mode: string; may_export: number; delegation: string }[];
    for (const g of fgs) {
      const d = JSON.parse(g.delegation || '{}') as Delegation;
      for (const f of d.folders ?? []) {
        const parts = String(f.path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
        if (!parts.length || parts.some((x) => x === '.' || x === '..')) continue;
        const folder = `/${parts.join('/')}/`;
        if (!folder.toLowerCase().startsWith(g.path.toLowerCase()) || !scope.canSee(folder, true)) continue;
        const write = g.mode === 'contribute' && f.mode === 'contribute';
        const acts = [...FOLDER_READ, ...(write ? FOLDER_CONTRIBUTE : []), ...(g.may_export ? ['fs.download'] : [])];
        out.push(allow(`fgrant:${g.path}:${folder}`, acts, `path:/${this.alias}${folder}**`));
        // The most specific grant decides: inside a deeper grant of the owner, what that grant does not give (Contribute,
        // export) is refused, even though this outer delegation reaches there.
        for (const inner of fgs) {
          const ip = inner.path.toLowerCase();
          if (ip.length <= g.path.length || !ip.startsWith(g.path.toLowerCase()) || !(ip.startsWith(folder.toLowerCase()) || folder.toLowerCase().startsWith(ip))) continue;
          // Export a project grant gives inside the inner folder stays (memberScope.mayExportFile counts either).
          const exported = !inner.may_export && !out.some((r) => r.id.startsWith('owner:folder:') && r.actions.includes('fs.download')
            && ip.startsWith(r.resource.slice(`path:/${this.alias}`.length, -2).toLowerCase()));
          const more = acts.filter((a) => (FOLDER_CONTRIBUTE.includes(a) && inner.mode !== 'contribute') || (a === 'fs.download' && exported));
          if (more.length) out.push(deny(`fgrant:${inner.path}:inner:${folder}`, more, `path:/${this.alias}${inner.path}**`));
        }
      }
    }
    // Peer recipients: live members of the delegated teams, both ways.
    for (const p of peers) out.push(allow(`peer:${p}`, ['message.send', 'message.receive'], `agent:${p}`));
    if (authors.size) {
      out.push(allow('share:new', ['share.create'], 'share:new'));
      const a = [...authors];
      for (const s of this.db.prepare(`SELECT id FROM shares WHERE author_agent_id IN (${a.map(() => '?').join(',')})`).all(...a) as { id: string }[]) out.push(allow(`share:${s.id}`, SHARE_WORK, `share:${s.id}`));
    }
    return out;
  }

  /** Blueprint access (not decided by key rules): every ceiling must allow it in one of the agent's live teams of the project. */
  blueprint(cap: Cap, agentId: string, projectId: string, teamId: string | null, write: boolean): boolean {
    if (!cap.owners?.length) return true;
    const action = write ? 'blueprint.write' : 'blueprint.read';
    const teams = teamId ? [teamId] : (this.db.prepare('SELECT m.team_id t FROM team_members m JOIN teams x ON x.id=m.team_id WHERE m.agent_id=? AND m.removed_at IS NULL AND x.project_id=?').all(agentId, projectId) as { t: string }[]).map((r) => r.t);
    return cap.owners.every((l) => teams.some((t) => l.rules.some((r) => r.effect === 'allow' && r.resource === `team:${t}` && r.actions.includes(action))));
  }

  /** The person's live agents (not archived) and the teams each is a live member of. */
  private ownAgents(userId: string): { id: string; label: string; archived: boolean; teams: Set<string> }[] {
    const rows = this.db.prepare(`SELECT a.id, a.label, a.status, m.team_id t FROM agents a LEFT JOIN team_members m ON m.agent_id=a.id AND m.removed_at IS NULL
      WHERE a.owner_user_id=? ORDER BY a.label, a.id`).all(userId) as { id: string; label: string; status: string; t: string | null }[];
    const by = new Map<string, { id: string; label: string; archived: boolean; teams: Set<string> }>();
    for (const r of rows) {
      const a = by.get(r.id) ?? { id: r.id, label: r.label, archived: r.status === 'archived', teams: new Set<string>() };
      if (r.t) a.teams.add(r.t);
      by.set(r.id, a);
    }
    return [...by.values()];
  }
  /** The scope a save of these grants would give the person (the saved grants where none are given), for the preview. */
  previewScope(userId: string, over: ScopeOverride): MemberScope {
    const u = this.db.prepare('SELECT external FROM admin_users WHERE id=?').get(userId) as { external: number } | undefined;
    return new MemberScope(this.db, userId, !!u?.external, over);
  }
  /** One delegated folder as the preview shows it: the operations, or none and why, as rules() reads it. */
  private folderView(scope: MemberScope, path: string, mode: 'read' | 'contribute', mayExport: boolean): FolderView {
    const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
    const folder = `/${parts.join('/')}/`;
    if (scope.canSee(folder, true)) return { path, mode, operations: folderOps(mode, mayExport) };
    const r = scope.hiddenBy(folder);
    const refused = !r ? 'This person cannot see this folder, so their agents get nothing here.'
      : scope.external ? `It is in the restricted folder ${r}, which an external person never sees, so their agents get nothing here.`
      : `It is in the restricted folder ${r}, which stays hidden from this person unless a grant names it or a folder inside it, so their agents get nothing here.`;
    return { path, mode, operations: [], refused };
  }
  private teamName(id: string): string { return (this.db.prepare('SELECT name FROM teams WHERE id=?').get(id) as { name: string } | undefined)?.name ?? id; }

  /**
   * What one grant's delegation permits (the grant editor's preview, before save): per delegated team, the operations
   * and which of the person's agents are live members of it (team work needs that); per folder, Read (a project grant's
   * folders are Read for its agents, so a Contribute saved before folder grants shows as Read).
   */
  describe(userId: string, g: { project_id: string; components: string[]; may_export: boolean; delegation: Delegation }, scope: MemberScope): DelegationView {
    const agents = this.ownAgents(userId).filter((a) => !a.archived);
    const ops = teamOps(g.components);
    return {
      project_id: g.project_id,
      teams: (g.delegation.teams ?? []).map((id) => ({ id, name: this.teamName(id), agents: agents.filter((a) => a.teams.has(id)).map((a) => a.label), operations: ops })),
      folders: g.components.includes('vault') ? (g.delegation.folders ?? []).map((f) => this.folderView(scope, f.path, 'read', g.may_export)) : [],
    };
  }

  /** What one folder grant's delegation permits: Contribute only where both the grant and the delegated folder say so. */
  describeFolder(g: { path: string; mode: 'read' | 'contribute'; may_export: boolean; delegation: { folders?: { path: string; mode: 'read' | 'contribute' }[] } }, scope: MemberScope): FolderDelegationView {
    return { path: g.path, mode: g.mode, folders: (g.delegation.folders ?? []).map((f) => {
      const mode = g.mode === 'contribute' && f.mode === 'contribute' ? 'contribute' as const : 'read' as const;
      return this.folderView(scope, f.path, mode, g.may_export);
    }) };
  }

  /**
   * What each of a person's live agents may do in each delegated team it is a live member of: agent id, then team id,
   * then the operations. Account adds these to its rows (admin/accountView.ts decides which agents and teams are listed).
   */
  scopes(userId: string): Map<string, Map<string, OpLine[]>> {
    const grants = (this.db.prepare('SELECT components, delegation FROM user_project_grants WHERE user_id=?').all(userId) as { components: string; delegation: string }[])
      .map((g) => ({ comps: JSON.parse(g.components) as string[], d: JSON.parse(g.delegation || '{}') as Delegation }));
    const out = new Map<string, Map<string, OpLine[]>>();
    for (const a of this.ownAgents(userId)) {
      if (a.archived) continue;
      const m = new Map<string, OpLine[]>();
      for (const g of grants) for (const t of g.d.teams ?? []) if (a.teams.has(t)) m.set(t, teamOps(g.comps));
      out.set(a.id, m);
    }
    return out;
  }
}
