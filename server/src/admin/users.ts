/**
 * Console users (docs/multi-user.md §1): admins and members, project grants, generated passwords, expiry and the 2FA
 * requirement. Decider routing (routing.ts) and members' scoped reads (memberScope.ts) build on these tables.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Config } from '../config.js';
import { KeyError } from '../keys/keys.js';
import { reservedPrefixes } from '../policy/engine.js';
import { peopleAt, folderMarks } from './vaultPeople.js';
import { NEVER, type OwnerScope } from '../policy/ownerScope.js';
import { randomBytes } from 'node:crypto';
import { hashPassword, totp } from '../util/crypto.js';
import { newId } from '../util/ids.js';

export const COMPONENTS = ['blueprint', 'tasks', 'feed', 'messages', 'vault', 'graph', 'topology'] as const;
export type Component = (typeof COMPONENTS)[number];
/** A component that only makes sense with another one (§1.2). */
const NEEDS: Partial<Record<Component, Component>> = { graph: 'vault', topology: 'tasks' };
export const MIN_PASSWORD = 12;
export const GENERATED_PASSWORD_LENGTH = 20;
/** Letters and digits without the look-alikes (0/O, 1/l/I): a generated password is read off a screen and typed. */
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

export interface UserRow {
  id: string; username: string; password_hash: string; totp_secret: string | null; status: 'active' | 'disabled'; created_at: number; last_login_at: number | null;
  role: 'admin' | 'member'; display_name: string | null; external: number; org: string | null; expires_at: number | null; totp_required: number;
  created_by: string | null; expired_at: number | null; password_set: number; totp_last_step: number | null; password_changed_at: number | null;
}
/**
 * A grant's agent delegation (docs/authorization.md#owner-enforcement): teams of the project where the person's agents
 * may do team work, and folders of the grant where they may read or contribute. Omitted on a save: the grant keeps the
 * delegation it has. A new grant delegates nothing.
 */
export interface DelegationInput { teams?: string[]; folders?: { path: string; mode: 'read' | 'contribute' }[] }
export interface GrantInput { project_id: string; components?: string[]; vault_folders?: string[]; may_export?: boolean; delegation?: DelegationInput }
export interface GrantView { project_id: string; project_key: string | null; project_name: string | null; components: Component[]; vault_folders: string[]; may_export: boolean; granted_by: string | null; granted_at: number; delegation: DelegationInput }
/** A folder grant (§1.2a): vault folders shared with a person, no project. Read by default; Contribute writes notes. */
export type FolderMode = 'read' | 'contribute';
export interface FolderGrantInput { path: string; mode?: FolderMode; may_export?: boolean; delegation?: { folders?: { path: string; mode: FolderMode }[] } }
export interface FolderGrantView { path: string; mode: FolderMode; may_export: boolean; granted_by: string | null; granted_at: number; delegation: { folders: { path: string; mode: FolderMode }[] } }

const err = (code: string, msg: string) => new KeyError(code, msg);
/** Folder paths are compared as "/A/B/": a leading and a trailing slash, no "..", no doubled slashes. */
export function normFolder(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((x) => x === '.' || x === '..')) throw err('invalid_argument', `"${p}" is not a vault folder.`);
  return `/${parts.join('/')}/`;
}
const within = (child: string, parent: string) => child.startsWith(parent);

/** A strong password the hub hands to the admin once (20 of 57 symbols, about 116 bits); never contains the username. */
export function generatePassword(username: string): string {
  for (;;) {
    let out = '';
    // 228 = 4 * 57: bytes at or above it are skipped, so every symbol is equally likely.
    while (out.length < GENERATED_PASSWORD_LENGTH) for (const b of randomBytes(32)) if (b < 228 && out.length < GENERATED_PASSWORD_LENGTH) out += PW_ALPHABET[b % 57];
    if (!out.toLowerCase().includes(username.toLowerCase())) return out;
  }
}
/** The rules for a password a user chooses (§1.4). */
export function checkNewPassword(password: string, username: string): void {
  if (password.length < MIN_PASSWORD) throw err('invalid_argument', `Choose a password of at least ${MIN_PASSWORD} characters.`);
  if (password.toLowerCase().includes(username.toLowerCase())) throw err('invalid_argument', 'The password must not contain the username.');
}

export class Users {
  constructor(private readonly db: Db, private readonly audit: Audit, private readonly config: Config) {}
  /**
   * Directive reach follows an owner's grant (docs/directives.md#project-reach): runs a change to a person's grants,
   * role, expiry or status, then tells the agents they own what directives they gained or lost (Directives.refresh).
   */
  reachGuard?: <T>(agentIds: string[], fn: () => T) => T;
  private reached<T>(userId: string, fn: () => T): T {
    return this.reachGuard ? this.reachGuard(this.ownedAgents(userId).map((a) => a.id), fn) : fn();
  }

  row(id: string): UserRow | null { return (this.db.prepare('SELECT * FROM admin_users WHERE id=?').get(id) as unknown as UserRow) ?? null; }
  private must(id: string): UserRow { const u = this.row(id); if (!u) throw err('not_found', 'user not found'); return u; }
  /** 2FA is required for this user: set by the admin, and always for an external user (§1.4). */
  totpRequired(u: Pick<UserRow, 'totp_required' | 'external'>): boolean { return !!u.totp_required || !!u.external; }
  /** Enrolled in 2FA where it is required: until then the session reaches only /api/me, /api/totp/* and /api/logout. */
  ready(u: Pick<UserRow, 'totp_required' | 'external' | 'totp_secret'>): boolean { return !this.totpRequired(u) || u.totp_secret !== null; }
  isExpired(u: Pick<UserRow, 'expires_at'>, now = Date.now()): boolean { return u.expires_at !== null && u.expires_at <= now; }
  /** The 30-second step a code belongs to (the current one or a neighbour, for clock drift), or null for a wrong code. */
  totpStep(secret: string, code: string, now = Date.now()): number | null {
    const c = code.trim(), at = Math.floor(now / 30_000);
    for (const o of [-1, 0, 1]) if (totp(secret, now, o) === c) return at + o;
    return null;
  }
  /** Check a user's code and use it up: a code counts only for a step after the last one accepted, so each code works once. */
  useTotp(userId: string, secret: string, code: string, now = Date.now()): boolean {
    const step = this.totpStep(secret, code, now);
    return step !== null && this.db.prepare('UPDATE admin_users SET totp_last_step=? WHERE id=? AND (totp_last_step IS NULL OR totp_last_step<?)').run(step, userId, step).changes === 1;
  }

  view(u: UserRow) {
    return {
      id: u.id, username: u.username, display_name: u.display_name, role: u.role, external: !!u.external, org: u.org, status: u.status,
      expires_at: u.expires_at, expired: this.isExpired(u), totp_required: this.totpRequired(u), totp_enrolled: u.totp_secret !== null,
      password_set: !!u.password_set, password_changed_at: u.password_changed_at ?? null,
      created_by: u.created_by, created_at: u.created_at, last_login_at: u.last_login_at, grants: this.grants(u.id), folder_grants: this.folderGrants(u.id), decider_teams: this.deciderTeams(u.id),
    };
  }
  list() { return (this.db.prepare('SELECT * FROM admin_users ORDER BY role, lower(COALESCE(display_name, username))').all() as unknown as UserRow[]).map((u) => this.view(u)); }
  get(id: string) { return this.view(this.must(id)); }

  grants(userId: string): GrantView[] {
    return (this.db.prepare(`SELECT g.*, p.key project_key, p.name project_name FROM user_project_grants g LEFT JOIN projects p ON p.id=g.project_id WHERE g.user_id=? ORDER BY p.key`).all(userId) as
      { project_id: string; project_key: string | null; project_name: string | null; components: string; vault_folders: string; may_export: number; granted_by: string | null; granted_at: number; delegation: string }[])
      .map((g) => ({ project_id: g.project_id, project_key: g.project_key, project_name: g.project_name, components: JSON.parse(g.components), vault_folders: JSON.parse(g.vault_folders), may_export: !!g.may_export, granted_by: g.granted_by, granted_at: g.granted_at, delegation: JSON.parse(g.delegation || '{}') }));
  }
  folderGrants(userId: string): FolderGrantView[] {
    return (this.db.prepare('SELECT * FROM user_folder_grants WHERE user_id=? ORDER BY path').all(userId) as { path: string; mode: FolderMode; may_export: number; granted_by: string | null; granted_at: number; delegation: string }[])
      .map((g) => { const d = JSON.parse(g.delegation || '{}') as { folders?: { path: string; mode: FolderMode }[] }; return { path: g.path, mode: g.mode, may_export: !!g.may_export, granted_by: g.granted_by, granted_at: g.granted_at, delegation: { folders: d.folders ?? [] } }; });
  }
  deciderTeams(userId: string): string[] { return (this.db.prepare('SELECT team_id FROM team_deciders WHERE user_id=? ORDER BY team_id').all(userId) as { team_id: string }[]).map((r) => r.team_id); }

  /** The project's vault roots (§1.2); an empty list means the default /Projects/<name>/. */
  vaultRoots(projectId: string): string[] {
    const p = this.db.prepare('SELECT name, vault_roots FROM projects WHERE id=?').get(projectId) as { name: string; vault_roots: string } | undefined;
    if (!p) throw err('not_found', 'project not found');
    const roots = JSON.parse(p.vault_roots) as string[];
    return roots.length ? roots.map(normFolder) : [normFolder(`/Projects/${p.name}/`)];
  }
  /** A restricted folder at or above this path: granting the path (or anything inside it) needs care (§1.2, §1.4). */
  restrictedAt(folder: string): string | null {
    const rows = this.db.prepare('SELECT path FROM vault_folder_flags WHERE restricted=1').all() as { path: string }[];
    return rows.map((r) => normFolder(r.path)).find((r) => within(folder, r)) ?? null;
  }
  /** Restricted folders inside this path, for the "never inside a member grant unless named" rule. */
  restrictedInside(folder: string): string[] {
    return (this.db.prepare('SELECT path FROM vault_folder_flags WHERE restricted=1').all() as { path: string }[]).map((r) => normFolder(r.path)).filter((r) => r !== folder && within(r, folder));
  }

  // ───── create, update, disable ─────
  create(i: { username: string; display_name?: string | null; role?: 'admin' | 'member'; external?: boolean; org?: string | null; expires_at?: number | null; totp_required?: boolean }, actor: Actor) {
    const username = i.username.trim();
    if (!USERNAME.test(username)) throw err('invalid_argument', 'A username is 2 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.');
    if (this.db.prepare('SELECT 1 x FROM admin_users WHERE lower(username)=lower(?)').get(username)) throw err('conflict', 'That username is taken.');
    if (i.expires_at !== undefined && i.expires_at !== null && i.expires_at <= Date.now()) throw err('invalid_argument', 'expires_at is in the past.');
    const id = newId.admin(), now = Date.now(), role = i.role ?? 'member', external = i.external ? 1 : 0;
    if (role === 'admin' && external) throw err('invalid_argument', 'An admin is never external: create an external user as a member.');
    // The hub generates the password and returns it once; only its hash is stored. The admin hands it over.
    const password = generatePassword(username);
    this.db.prepare(`INSERT INTO admin_users(id,username,password_hash,status,created_at,role,display_name,external,org,expires_at,totp_required,created_by,password_set,password_changed_at)
      VALUES (?,?,?,'active',?,?,?,?,?,?,?,?,1,?)`).run(id, username, hashPassword(password), now, role, i.display_name?.trim() || null, external, i.org?.trim() || null,
      i.expires_at ?? null, i.totp_required || external ? 1 : 0, actor.id, now);
    this.audit.event(actor, 'user.create', { kind: 'user', id }, { username, role, external: !!external, org: i.org ?? null, expires_at: i.expires_at ?? null });
    return { user: this.get(id), password };
  }
  update(id: string, p: { display_name?: string | null; role?: 'admin' | 'member'; external?: boolean; org?: string | null; expires_at?: number | null; totp_required?: boolean }, actor: Actor) {
    return this.reached(id, () => this.update_(id, p, actor));
  }
  private update_(id: string, p: { display_name?: string | null; role?: 'admin' | 'member'; external?: boolean; org?: string | null; expires_at?: number | null; totp_required?: boolean }, actor: Actor) {
    const u = this.must(id);
    if (p.role === 'member' && u.role === 'admin') this.keepAnAdmin(id, 'demote');
    // An expiry on an admin (or a user becoming one) needs another admin with no expiry (no lockout by expiry).
    if ((p.role ?? u.role) === 'admin' && p.expires_at !== undefined && p.expires_at !== null) this.keepAnAdmin(id, 'set an expiry on');
    if (p.expires_at !== undefined && p.expires_at !== null && p.expires_at <= Date.now()) throw err('invalid_argument', 'expires_at is in the past.');
    if (p.external === true && !u.external) {
      const bad = [...this.grants(id).flatMap((g) => g.vault_folders), ...this.folderGrants(id).map((g) => g.path)].find((f) => this.restrictedAt(f));
      if (bad) throw err('invalid_argument', `An external user never gets restricted folders: remove ${bad} from the grants first.`);
    }
    const next = {
      display_name: p.display_name === undefined ? u.display_name : p.display_name?.trim() || null, role: p.role ?? u.role,
      external: p.external === undefined ? u.external : p.external ? 1 : 0, org: p.org === undefined ? u.org : p.org?.trim() || null,
      expires_at: p.expires_at === undefined ? u.expires_at : p.expires_at, totp_required: p.totp_required === undefined ? u.totp_required : p.totp_required ? 1 : 0,
    };
    if (next.external) next.totp_required = 1;
    if (next.role === 'admin' && next.external) throw err('invalid_argument', 'An admin is never external: set external to false in the same change.');
    // The admin acts as the admin, never as a team's decider: promotion takes the user off every decider list.
    const leaves = next.role === 'admin' && u.role !== 'admin' ? this.deciderTeams(id) : [];
    tx(this.db, () => {
      this.db.prepare('UPDATE admin_users SET display_name=?, role=?, external=?, org=?, expires_at=?, totp_required=?, expired_at=CASE WHEN ? IS NULL OR ? > ? THEN NULL ELSE expired_at END WHERE id=?')
        .run(next.display_name, next.role, next.external, next.org, next.expires_at, next.totp_required, next.expires_at, next.expires_at, Date.now(), id);
      // A changed role or a new 2FA requirement takes effect at once: end the user's sessions.
      if (next.role !== u.role || (next.totp_required && !u.totp_required && u.totp_secret === null)) this.endSessions(id);
      if (leaves.length) this.db.prepare('DELETE FROM team_deciders WHERE user_id=?').run(id);
    });
    const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => (u as unknown as Record<string, unknown>)[k] !== v));
    if (Object.keys(changed).length) this.audit.event(actor, 'user.update', { kind: 'user', id }, changed);
    for (const t of leaves) this.audit.event(actor, 'team.deciders_set', { kind: 'team', id: t }, { removed: id, reason: 'promoted to admin' });
    // An expired account whose expiry is lifted or moved later is usable again (unless it is disabled): its agents hear it.
    if (this.isExpired(u) && !this.isExpired(next) && u.status === 'active') this.onOwnerAccess?.(id, 'renewed');
    return this.get(id);
  }
  /** The agents this person owns (docs/authorization.md#agent-owners), named when the admin disables them. */
  ownedAgents(id: string): { id: string; label: string }[] { return this.db.prepare('SELECT id, label FROM agents WHERE owner_user_id=? ORDER BY label').all(id) as { id: string; label: string }[]; }
  setStatus(id: string, status: 'active' | 'disabled', actor: Actor) { return this.reached(id, () => this.setStatus_(id, status, actor)); }
  private setStatus_(id: string, status: 'active' | 'disabled', actor: Actor) {
    const u = this.must(id);
    if (u.status === status) return this.get(id);
    if (status === 'disabled') {
      if (id === actor.id) throw err('invalid_argument', 'You cannot disable yourself.');
      if (u.role === 'admin') this.keepAnAdmin(id, 'disable');
    }
    tx(this.db, () => {
      this.db.prepare('UPDATE admin_users SET status=? WHERE id=?').run(status, id);
      if (status === 'disabled') this.endSessions(id);
    });
    this.audit.event(actor, status === 'disabled' ? 'user.disable' : 'user.enable', { kind: 'user', id });
    if (status === 'disabled') this.onOwnerAccess?.(id, 'disabled');
    else if (!this.isExpired(u)) this.onOwnerAccess?.(id, 'enabled');
    return this.get(id);
  }
  /**
   * At least one other active admin who can sign in and has no expiry must remain. Counting admins with a later expiry
   * is not enough: admins who all have expiries end in a lockout, whatever the order they were set in. A user who is not
   * such an admin (an admin whose account expires anyway, say) takes nothing from that rule: changing them needs only
   * another admin who can sign in now.
   */
  private keepAnAdmin(id: string, what: string) {
    const u = this.must(id);
    if (u.role === 'admin' && u.status === 'active' && u.password_set && u.expires_at === null) {
      const n = (this.db.prepare("SELECT COUNT(*) n FROM admin_users WHERE role='admin' AND status='active' AND password_set=1 AND expires_at IS NULL AND id<>?").get(id) as { n: number }).n;
      if (!n) throw err('invalid_state', `Cannot ${what} the last active admin without an expiry: another active admin with no expiry must remain.`);
      return;
    }
    const n = (this.db.prepare("SELECT COUNT(*) n FROM admin_users WHERE role='admin' AND status='active' AND password_set=1 AND (expires_at IS NULL OR expires_at>?) AND id<>?").get(Date.now(), id) as { n: number }).n;
    if (!n) throw err('invalid_state', `Cannot ${what} the last admin who can sign in.`);
  }
  endSessions(id: string) { this.db.prepare('DELETE FROM admin_sessions WHERE admin_id=?').run(id); }

  /**
   * Expiry (§1.4): at expires_at the user cannot sign in, live sessions end and the user leaves every decider list
   * (routing falls back to the admin). Audited once as user.expired.
   */
  enforceExpiry(u: UserRow, now = Date.now()): void {
    if (!this.isExpired(u, now) || u.expired_at !== null) { if (this.isExpired(u, now)) this.endSessions(u.id); return; }
    const teams = this.deciderTeams(u.id);
    tx(this.db, () => {
      this.db.prepare('UPDATE admin_users SET expired_at=? WHERE id=? AND expired_at IS NULL').run(now, u.id);
      this.endSessions(u.id);
      this.db.prepare('DELETE FROM team_deciders WHERE user_id=?').run(u.id);
    });
    this.audit.event({ kind: 'system', id: null }, 'user.expired', { kind: 'user', id: u.id }, { expires_at: u.expires_at, decider_teams_left: teams });
    this.onOwnerAccess?.(u.id, 'expired');
  }
  /**
   * Set by app.ts: tells the agents a person owns that their rules changed, when the account becomes unusable (expires,
   * is disabled) or usable again (a disabled one that has not expired is enabled; an expired one that is active gets its
   * expiry lifted or moved later).
   */
  onOwnerAccess: ((userId: string, why: 'expired' | 'disabled' | 'enabled' | 'renewed') => void) | null = null;
  /** Expire every user past expires_at (maintenance tick and tests). */
  sweepExpired(now = Date.now()): number {
    const due = this.db.prepare('SELECT * FROM admin_users WHERE expires_at IS NOT NULL AND expires_at<=? AND expired_at IS NULL').all(now) as unknown as UserRow[];
    for (const u of due) this.enforceExpiry(u, now);
    return due.length;
  }

  // ───── passwords (§1.4) ─────
  /** A new generated password, returned once; the old one stops working and every session of the user ends. */
  resetPassword(userId: string, actor: Actor) {
    const u = this.must(userId);
    if (u.status !== 'active') throw err('invalid_state', 'The user is disabled.');
    const password = generatePassword(u.username);
    tx(this.db, () => {
      this.db.prepare('UPDATE admin_users SET password_hash=?, password_set=1, password_changed_at=? WHERE id=?').run(hashPassword(password), Date.now(), userId);
      this.endSessions(userId);
    });
    this.audit.event(actor, 'user.password_reset', { kind: 'user', id: userId });
    return { password };
  }
  /** The signed-in user replaces their own password (the caller checked the current one); their other sessions end. */
  setOwnPassword(u: UserRow, password: string, keepSessionHash: Buffer) {
    checkNewPassword(password, u.username);
    tx(this.db, () => {
      this.db.prepare('UPDATE admin_users SET password_hash=?, password_set=1, password_changed_at=? WHERE id=?').run(hashPassword(password), Date.now(), u.id);
      this.db.prepare('DELETE FROM admin_sessions WHERE admin_id=? AND id_hash<>?').run(u.id, keepSessionHash);
    });
    this.audit.event({ kind: 'admin', id: u.id, role: u.role }, 'user.password_changed', { kind: 'user', id: u.id });
  }

  /**
   * A delegation as saved: teams of this project only, folders inside the grant's own folders. Anything else is refused.
   * For an external person, a folder at or inside a restricted folder is refused too: enforcement would drop it, so the
   * save, the preview and Account must never show it as permitted.
   */
  private checkDelegation(projectId: string, folders: string[], d: DelegationInput, external: boolean): DelegationInput {
    const teams = [...new Set(d.teams ?? [])];
    for (const t of teams) if (!this.db.prepare('SELECT 1 x FROM teams WHERE id=? AND project_id=?').get(t, projectId)) throw err('invalid_argument', `Team ${t} is not a team of this project.`);
    const fs = (d.folders ?? []).map((f) => ({ path: normFolder(f.path), mode: f.mode }));
    for (const f of fs) if (!folders.some((g) => within(f.path, g))) throw err('invalid_argument', `${f.path} is outside this grant's folders: an agent's folders narrow its owner's.`);
    if (external) for (const f of fs) this.refuseRestricted(f.path);
    // A project grant's vault is Read for the person, so it is Read for the agents too (a Read grant caps them at Read).
    for (const f of fs) if (f.mode === 'contribute') throw err('invalid_argument', `${f.path}: a project grant's folders are Read, so its agents can only read there. Contribute needs a folder grant with Contribute.`);
    return { teams, folders: fs };
  }

  /** An agent folder of an external person's grant never sits at or inside a restricted folder (§1.2). */
  private refuseRestricted(path: string) {
    const restricted = this.restrictedAt(path);
    if (restricted) throw err('invalid_argument', `${path} is in the restricted folder ${restricted}; an external person's agents never get restricted folders.`);
  }

  // ───── grants (§1.2) ─────
  /** Each grant checked and normalised, for setGrants and previewGrants alike: the same refusals for both. */
  private checkGrants(userId: string, input: GrantInput[]) {
    const u = this.must(userId);
    if (u.role === 'admin') throw err('invalid_argument', 'Admins see every project; grants are for members.');
    const seen = new Set<string>();
    return input.map((g) => {
      if (seen.has(g.project_id)) throw err('invalid_argument', `Project ${g.project_id} is listed twice.`);
      seen.add(g.project_id);
      const roots = this.vaultRoots(g.project_id);
      const unknown = (g.components ?? []).filter((c) => !(COMPONENTS as readonly string[]).includes(c));
      if (unknown.length) throw err('invalid_argument', `Unknown component ${unknown.join(', ')}; components are ${COMPONENTS.join(', ')}.`);
      const comps = COMPONENTS.filter((c) => c === 'blueprint' || (g.components ?? []).includes(c));
      for (const [c, need] of Object.entries(NEEDS) as [Component, Component][]) if (comps.includes(c) && !comps.includes(need)) throw err('invalid_argument', `The ${c} component needs ${need}.`);
      const folders = [...new Set((g.vault_folders ?? []).map(normFolder))];
      if (comps.includes('vault') && !folders.length) throw err('invalid_argument', 'The vault component needs at least one folder.');
      if (!comps.includes('vault') && folders.length) throw err('invalid_argument', 'Vault folders need the vault component.');
      for (const f of folders) {
        if (!roots.some((r) => within(f, r))) throw err('invalid_argument', `${f} is outside the project's vault roots (${roots.join(', ')}).`);
        const restricted = this.restrictedAt(f);
        if (restricted && u.external) throw err('invalid_argument', `${f} is in the restricted folder ${restricted}; an external user never gets restricted folders.`);
      }
      return { project_id: g.project_id, components: comps, vault_folders: folders, may_export: g.may_export ? 1 : 0, delegation: g.delegation === undefined ? undefined : this.checkDelegation(g.project_id, folders, g.delegation, !!u.external) };
    });
  }

  /**
   * The grants as a save would store them, checked the same way and saved nowhere: the grant editor's preview of what
   * the person's agents may do (docs/authorization.md#owner-enforcement). A grant that leaves delegation out shows the
   * one it has now.
   */
  previewGrants(userId: string, input: GrantInput[]): { project_id: string; components: Component[]; vault_folders: string[]; may_export: boolean; delegation: DelegationInput }[] {
    const rows = this.checkGrants(userId, input);
    const kept = new Map(this.grants(userId).map((b) => [b.project_id, b.delegation]));
    return rows.map((r) => ({ project_id: r.project_id, components: r.components, vault_folders: r.vault_folders, may_export: !!r.may_export, delegation: r.delegation ?? kept.get(r.project_id) ?? {} }));
  }

  /** Replace the user's project grants. Blueprint is always on; folders lie within the project's vault roots. */
  setGrants(userId: string, input: GrantInput[], actor: Actor) { return this.reached(userId, () => this.setGrants_(userId, input, actor)); }
  private setGrants_(userId: string, input: GrantInput[], actor: Actor) {
    const rows = this.checkGrants(userId, input);
    const seen = new Set(rows.map((r) => r.project_id));
    const before = this.grants(userId);
    const kept = new Map(before.map((b) => [b.project_id, b.delegation]));
    const now = Date.now();
    const dropped = before.filter((b) => !seen.has(b.project_id)).map((b) => b.project_id);
    let removedDecider: string[] = [];
    tx(this.db, () => {
      this.db.prepare('DELETE FROM user_project_grants WHERE user_id=?').run(userId);
      for (const r of rows) this.db.prepare('INSERT INTO user_project_grants(user_id,project_id,components,vault_folders,may_export,granted_by,granted_at,delegation) VALUES (?,?,?,?,?,?,?,?)')
        .run(userId, r.project_id, JSON.stringify(r.components), JSON.stringify(r.vault_folders), r.may_export, actor.id, now, JSON.stringify(r.delegation ?? kept.get(r.project_id) ?? {}));
      // A decider must hold a grant on the team's project: losing it removes them as decider (§1.3).
      if (dropped.length) {
        const ph = dropped.map(() => '?').join(',');
        removedDecider = (this.db.prepare(`SELECT d.team_id FROM team_deciders d JOIN teams t ON t.id=d.team_id WHERE d.user_id=? AND t.project_id IN (${ph})`).all(userId, ...dropped) as { team_id: string }[]).map((r) => r.team_id);
        for (const t of removedDecider) this.db.prepare('DELETE FROM team_deciders WHERE team_id=? AND user_id=?').run(t, userId);
      }
    });
    const after = this.grants(userId);
    this.audit.event(actor, 'user.grant_set', { kind: 'user', id: userId }, {
      before: before.map((g) => ({ project: g.project_id, components: g.components, folders: g.vault_folders, may_export: g.may_export, delegation: g.delegation })),
      after: after.map((g) => ({ project: g.project_id, components: g.components, folders: g.vault_folders, may_export: g.may_export, delegation: g.delegation })),
    });
    for (const t of removedDecider) this.audit.event(actor, 'team.deciders_set', { kind: 'team', id: t }, { removed: userId, reason: 'grant removed' });
    // Folders granted that hold restricted folders: they stay out unless named (memberScope.ts enforces it on reads); say so.
    const notes = after.flatMap((g) => g.vault_folders.flatMap((f) => this.restrictedInside(f).filter((r) => !g.vault_folders.includes(r)).map((r) => `${r} is restricted and stays hidden inside ${f}`)));
    return { user: this.get(userId), notes };
  }

  // ───── folder grants (§1.2a) ─────
  /** A folder the hub writes (99 Conclave) or the vault root is never granted. */
  private checkGrantable(path: string): void {
    if (path === '/') throw err('invalid_argument', 'The vault root cannot be shared; choose a folder.');
    const xs = path.split('/').filter(Boolean).map((s) => s.toLowerCase());
    for (const r of reservedPrefixes()) {
      const rs = r.split('/').filter(Boolean).slice(1).map((s) => s.toLowerCase());
      if (rs.length && xs.length >= rs.length && rs.every((s, i) => s === xs[i])) throw err('invalid_argument', `${path} is in the hub's own folder, which is never shared.`);
    }
  }
  /**
   * Replace the person's folder grants. Read by default; a delegation narrows the grant and a Read grant delegates Read
   * only. An external user never gets a folder at or inside a restricted folder. Creates no key.
   */
  /** Each folder grant checked and normalised, for setFolderGrants and previewFolderGrants alike: the same refusals for both. */
  private checkFolderGrants(userId: string, input: FolderGrantInput[]) {
    const u = this.must(userId);
    if (u.role === 'admin') throw err('invalid_argument', 'Admins see the whole vault; folder grants are for members.');
    const kept = new Map(this.folderGrants(userId).map((b) => [b.path, b.delegation]));
    const seen = new Set<string>();
    return input.map((g) => {
      const path = normFolder(g.path);
      if (seen.has(path)) throw err('invalid_argument', `${path} is listed twice.`);
      seen.add(path);
      this.checkGrantable(path);
      const restricted = this.restrictedAt(path);
      if (restricted && u.external) throw err('invalid_argument', `${path} is in the restricted folder ${restricted}; an external user never gets restricted folders.`);
      const mode: FolderMode = g.mode ?? 'read';
      let delegation = kept.get(path) ?? { folders: [] };
      if (g.delegation !== undefined) {
        const fs = (g.delegation.folders ?? []).map((f) => ({ path: normFolder(f.path), mode: f.mode }));
        for (const f of fs) {
          if (!within(f.path, path)) throw err('invalid_argument', `${f.path} is outside ${path}: an agent's folders narrow its owner's.`);
          if (f.mode === 'contribute' && mode !== 'contribute') throw err('invalid_argument', `${f.path}: a Read grant caps its agents at Read. Make the grant Contribute first.`);
          if (u.external) this.refuseRestricted(f.path);
        }
        delegation = { folders: fs };
      }
      return { path, mode, may_export: g.may_export ? 1 : 0, delegation };
    });
  }
  /** The folder grants as a save would store them, checked the same way and saved nowhere: the editor's preview. */
  previewFolderGrants(userId: string, input: FolderGrantInput[]): { path: string; mode: FolderMode; may_export: boolean; delegation: { folders: { path: string; mode: FolderMode }[] } }[] {
    return this.checkFolderGrants(userId, input).map((r) => ({ path: r.path, mode: r.mode, may_export: !!r.may_export, delegation: { folders: r.delegation.folders ?? [] } }));
  }
  setFolderGrants(userId: string, input: FolderGrantInput[], actor: Actor) {
    const before = this.folderGrants(userId);
    const rows = this.checkFolderGrants(userId, input);
    const now = Date.now();
    tx(this.db, () => {
      this.db.prepare('DELETE FROM user_folder_grants WHERE user_id=?').run(userId);
      for (const r of rows) this.db.prepare('INSERT INTO user_folder_grants(user_id,path,mode,may_export,delegation,granted_by,granted_at) VALUES (?,?,?,?,?,?,?)')
        .run(userId, r.path, r.mode, r.may_export, JSON.stringify(r.delegation), actor.id, now);
    });
    const after = this.folderGrants(userId);
    const brief = (g: FolderGrantView) => ({ path: g.path, mode: g.mode, may_export: g.may_export, delegation: g.delegation });
    this.audit.event(actor, 'user.folder_grant_set', { kind: 'user', id: userId }, { before: before.map(brief), after: after.map(brief) });
    // Restricted folders inside a granted folder stay hidden and unwritable unless granted by name; say so.
    const named = new Set(after.map((g) => g.path));
    const notes = after.flatMap((g) => this.restrictedInside(g.path).filter((r) => !named.has(r)).map((r) => `${r} is restricted and stays hidden inside ${g.path}`));
    return { user: this.get(userId), notes };
  }
}

/** The /api/users* routes (admin only, declared in the scope registry). */
export function registerUsersApi(api: FastifyInstance, users: Users, actor: (req: FastifyRequest) => Actor, ownerScope?: OwnerScope, db?: Db): void {
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const when = z.union([z.number().int(), z.string()]).nullable().optional().transform((v, ctx) => {
    if (v === null) return null;
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isNaN(n)) { ctx.addIssue({ code: 'custom', message: 'invalid date' }); return z.NEVER; }
    return n;
  });
  const delegation = z.object({ teams: z.array(z.string().min(1).max(100)).max(50).optional(), folders: z.array(z.object({ path: z.string().min(1).max(1024), mode: z.enum(['read', 'contribute']) }).strict()).max(50).optional() }).strict();
  const grant = z.object({ project_id: z.string().min(1).max(100), components: z.array(z.string().max(20)).max(10).optional(), vault_folders: z.array(z.string().min(1).max(1024)).max(50).optional(), may_export: z.boolean().optional(), delegation: delegation.optional() }).strict();
  const grantsBody = z.object({ grants: z.array(grant).max(200) }).strict();
  const userFields = { display_name: z.string().max(120).nullable().optional(), role: z.enum(['admin', 'member']).optional(), external: z.boolean().optional(),
    org: z.string().max(120).nullable().optional(), expires_at: when, totp_required: z.boolean().optional() };

  api.get('/api/users', async () => ({ users: users.list() }));
  api.get('/api/users/:id', async (req) => ({ user: users.get(idOf(req)) }));
  api.post('/api/users', async (req) => {
    const b = body(z.object({ username: z.string().min(1).max(64), ...userFields }).strict(), req);
    return users.create(b, actor(req));
  });
  api.patch('/api/users/:id', async (req) => ({ user: users.update(idOf(req), body(z.object(userFields).strict(), req), actor(req)) }));
  // Disabling a person who owns agents is never refused (their agents stop at once while owner enforcement is on); the
  // answer names those agents, so the admin can hand them on (POST /api/agent-owners/:id/reassign).
  api.post('/api/users/:id/disable', async (req) => {
    const user = users.setStatus(idOf(req), 'disabled', actor(req));
    const owned = users.ownedAgents(idOf(req));
    return { user, owned_agents: owned };
  });
  api.post('/api/users/:id/enable', async (req) => ({ user: users.setStatus(idOf(req), 'active', actor(req)) }));
  api.post('/api/users/:id/reset-password', async (req) => users.resetPassword(idOf(req), actor(req)));
  api.put('/api/users/:id/grants', async (req) => {
    return users.setGrants(idOf(req), body(grantsBody, req).grants, actor(req));
  });
  // The grant editor's preview (docs/authorization.md#owner-enforcement): the exact operations the delegation permits, from
  // the policy service's own mapping, checked like a save and saved nowhere; and what stays refused whatever is delegated.
  api.post('/api/users/:id/grants/preview', async (req) => {
    // Read against the grants as proposed (and the saved folder grants): a folder the save would leave hidden shows why.
    const rows = users.previewGrants(idOf(req), body(grantsBody, req).grants);
    if (!ownerScope) return { grants: [], never: NEVER };
    const scope = ownerScope.previewScope(idOf(req), { grants: rows });
    return { grants: rows.map((r) => ownerScope.describe(idOf(req), r, scope)), never: NEVER };
  });
  // Folder grants (§1.2a): vault folders without a project, Read or Contribute.
  api.get('/api/users/:id/folder-grants', async (req) => ({ folder_grants: users.get(idOf(req)).folder_grants }));
  const fmode = z.enum(['read', 'contribute']);
  const folderGrant = z.object({ path: z.string().min(1).max(1024), mode: fmode.optional(), may_export: z.boolean().optional(),
    delegation: z.object({ folders: z.array(z.object({ path: z.string().min(1).max(1024), mode: fmode }).strict()).max(50).optional() }).strict().optional() }).strict();
  const folderGrantsBody = z.object({ grants: z.array(folderGrant).max(200) }).strict();
  api.put('/api/users/:id/folder-grants', async (req) => users.setFolderGrants(idOf(req), body(folderGrantsBody, req).grants, actor(req)));
  // Who reaches a vault folder, from the same MemberScope that enforces every member read and write; and the marks the folder picker draws for a person.
  if (db) {
    api.get('/api/vault/people', async (req) => ({ people: peopleAt(db, String((req.query as { path?: string }).path ?? '')) }));
    api.get('/api/users/:id/folder-marks', async (req) => { users.get(idOf(req)); return folderMarks(db, idOf(req)); });
  }
  // The same preview for folder grants: what each grant's agents may do in its folders, Contribute only under a Contribute grant.
  api.post('/api/users/:id/folder-grants/preview', async (req) => {
    const rows = users.previewFolderGrants(idOf(req), body(folderGrantsBody, req).grants);
    if (!ownerScope) return { folder_grants: [], never: NEVER };
    const scope = ownerScope.previewScope(idOf(req), { folderGrants: rows });
    return { folder_grants: rows.map((r) => ownerScope.describeFolder(r, scope)), never: NEVER };
  });
}
