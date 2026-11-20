/**
 * Delegate one agent to a collaborator (docs/checkout.md §9 F1, "Delegate one agent"): a one-agent checkout whose
 * delegate is a console member. The agent keeps its identity, owner, team, tasks and history; it moves to an ordinary PC
 * from the admin's list (already enrolled with the connector), and while it runs there the delegate's grant is a ceiling on it
 * (policy/ownerScope.ts delegateLayers).
 *
 * Only the admin delegates and takes back. The prompt never travels outside the hub: the delegate opens it in their own
 * console, behind their sign-in and 2FA, and the hub renders the move at that moment. A PC that is not enrolled yet is
 * refused (add it with the connector first). Take back revokes the key the agent runs with and its tokens at once
 * (Keys.rotate) and ends the ceiling.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { isAdmin } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Teams } from '../teams/teams.js';
import type { Onboarding } from '../onboarding/onboarding.js';
import type { OwnerScope } from '../policy/ownerScope.js';
import { ownerAllows, withOwners } from '../policy/engine.js';
import type { Checkouts, CheckoutRow } from './checkout.js';
import { OPEN } from './checkout.js';
import type { CheckoutKeys, Choices, RenderInput } from './render.js';
import type { Users, FolderGrantInput } from '../admin/users.js';

const err = (code: string, msg: string, extra?: Record<string, unknown>) => new KeyError(code, msg, extra);
const parse = <T>(s: string | null, d: T): T => { if (s === null) return d; try { return JSON.parse(s) as T; } catch { return d; } };
/** A taken-back or ended delegation stays on the delegate's Home this long ("the operator took Rowan back"). */
export const ENDED_SHOWN_MS = 7 * 24 * 3600_000;

interface UserRow { id: string; username: string; display_name: string | null; role: 'admin' | 'member'; status: string; expires_at: number | null; external: number }
export interface DelegateInput {
  user_id: string; team_id?: string | null; machine_id?: string | null; new_pc_name?: string | null;
  agents?: RenderInput['agents'];
  /**
   * Contributor mode's drafts folder ("/Papers/P1/contrib/Rowan/"): the admin's explicit act on the sheet, saved as a
   * Contribute folder grant for the delegate on that folder only, removed when the delegation ends. Without it the agent
   * writes nothing in the vault (an implementation project has no paper folder).
   */
  drafts_folder?: string | null;
}
export interface DelegationDeps { db: Db; keys: Keys; teams: Teams; audit: Audit; onboarding: Onboarding; checkouts: Checkouts; checkoutKeys: CheckoutKeys; ownerScope: OwnerScope; users?: Users }

export class Delegations {
  private readonly db: Db; private readonly keys: Keys; private readonly co: Checkouts; private readonly ck: CheckoutKeys;
  constructor(private readonly d: DelegationDeps) {
    this.db = d.db; this.keys = d.keys; this.co = d.checkouts; this.ck = d.checkoutKeys;
    d.checkouts.onDelegationEnded = (agentId, actor) => this.dropDrafts(agentId, actor);
  }

  private user(id: string): UserRow | null {
    return (this.db.prepare('SELECT id, username, display_name, role, status, expires_at, external FROM admin_users WHERE id=?').get(id) as UserRow | undefined) ?? null;
  }
  private label(u: UserRow | null): string { return u ? u.display_name || u.username : 'an unknown person'; }
  private usable(u: UserRow | null): u is UserRow { return !!u && u.status === 'active' && (u.expires_at === null || u.expires_at > Date.now()); }
  private agentLabel(id: string | null): string { return id ? this.keys.agent(id)?.label ?? id : '?'; }
  private requireAdmin(actor: Actor): void { if (!isAdmin(actor)) throw err('admin_only', 'Only an admin can do this.'); }

  /**
   * What the agent keeps and loses while with this person (the sheet, before Make the prompt): per team it is in, whether
   * the person's grant lets it do team work there; the vault folders it may still reach; the repos the person needs read
   * access to. An admin delegate (Delegate back) keeps everything.
   */
  preview(agentId: string, userId: string) {
    const a = this.keys.agent(agentId);
    if (!a || a.status === 'archived') throw err('not_found', 'agent not found');
    const u = this.user(userId);
    if (!this.usable(u)) throw err('invalid_argument', 'user_id: an active console user.');
    const teams = this.d.teams.teamsOf(agentId).filter((t) => t.status !== 'done' && t.status !== 'stopped');
    const layer = u.role === 'admin' ? null : this.d.ownerScope.ceilingFor(u.id, agentId);
    const cap = layer ? withOwners([], [layer]) : null;
    const kept = teams.map((t) => ({ id: t.id, name: t.name, role: t.my_role, kept: !cap || ownerAllows(cap, 'team.member', `team:${t.id}`),
      reads_project: !cap || ownerAllows(cap, 'blueprint.read', `team:${t.id}`) }));
    const folders = layer ? [...new Set(layer.rules.filter((r) => r.effect === 'allow' && r.resource.startsWith('path:')).map((r) => r.resource.slice('path:'.length).replace(/\*\*$/, '')))] : null;
    return {
      agent: { id: a.id, label: a.label }, delegate: { id: u.id, label: this.label(u), role: u.role, external: !!u.external },
      teams: kept, keeps_team_work: kept.some((t) => t.kept), reads_project: kept.some((t) => t.reads_project),
      // Contributor mode: a member delegate's agent proposes every change to shared work (docs/blueprint.md §4).
      contributor: !!layer,
      loses: kept.filter((t) => !t.kept).map((t) => t.name),
      // null: no ceiling (an admin delegate). Otherwise only these vault folders stay within reach.
      folders,
      repos: this.repoUrls(agentId),
      sentence: !layer ? `${a.label} keeps everything it can do now.`
        : kept.every((t) => t.kept) ? `While with ${this.label(u)}, ${a.label} keeps team work in ${kept.map((t) => t.name).join(', ')}, reaches only ${this.label(u)}'s delegated vault folders, and can't edit shared items: it proposes them.`
        : `While with ${this.label(u)}, ${a.label} can't reach ${kept.filter((t) => !t.kept).map((t) => `team ${t.name}`).join(', ')}${folders && !folders.length ? ', any vault folder' : ''} or edit shared items.`,
    };
  }
  /** Repos the agent's latest handout named: the delegate's git login must read them (§6 step 3, F8). */
  private repoUrls(agentId: string): string[] {
    const rows = this.db.prepare("SELECT body FROM handouts WHERE agent_id=? AND body IS NOT NULL ORDER BY written_at DESC LIMIT 5").all(agentId) as { body: string }[];
    const out = new Set<string>();
    for (const r of rows) { const u = parse<{ repo?: { url?: unknown } } | null>(r.body, null)?.repo?.url; if (typeof u === 'string') out.add(u); }
    return [...out];
  }

  /**
   * Delegate (admin): start a one-agent checkout to the person's PC. The render the admin chose (an enrolled PC) is
   * stored; nothing is rendered until the person opens the prompt in their console.
   */
  delegate(agentId: string, input: DelegateInput, actor: Actor) {
    this.requireAdmin(actor);
    if (!input || typeof input.user_id !== 'string') throw err('invalid_argument', 'user_id: the person who will run the agent');
    if (input.new_pc_name) throw err(input.machine_id ? 'invalid_argument' : 'invalid_state', input.machine_id ? 'Give machine_id (an enrolled PC), not new_pc_name too.' : 'Add this PC with the connector first (install it and pair it with Add PC), then approve a destination on it, then render for that enrolled PC.', input.machine_id ? undefined : { reason: 'add_pc_first' });
    if (!input.machine_id) throw err('invalid_argument', 'Give machine_id (an enrolled PC).');
    const p = this.preview(agentId, input.user_id);
    if (p.delegate.role === 'member' && !p.reads_project) {
      throw err('no_project', `${p.delegate.label}'s grant leaves ${p.agent.label} no project to read in ${p.teams.map((t) => t.name).join(', ') || 'any team'}. Delegate a team's blueprint in their grant first.`, { teams: p.teams });
    }
    const drafts = this.checkDrafts(input.drafts_folder ?? null, p.delegate.role, input.user_id);
    {
      const m = this.keys.machine(input.machine_id);
      if (!m) throw err('not_found', 'PC not found');
      if (m.status !== 'active') throw err('invalid_state', `The PC is ${m.status}.`);
    }
    const render: RenderInput = { target: 'other_pc', machine_id: input.machine_id, ...(input.agents ? { agents: input.agents } : {}) };
    const v = this.co.startAgent(agentId, { teamId: input.team_id ?? null, delegateUserId: input.user_id, render }, actor);
    if (drafts) {
      this.db.prepare('UPDATE checkouts SET drafts_path=? WHERE id=?').run(drafts.path, v.id);
      this.d.users!.setFolderGrants(input.user_id, drafts.grants, actor);
    }
    this.d.audit.event(actor, 'checkout.delegate', { kind: 'checkout', id: v.id }, { agent: agentId, delegate: input.user_id, pc: input.machine_id, loses: p.loses, contributor: p.contributor, drafts: drafts?.path ?? null });
    return { delegation: this.adminView(this.co.mustCheckout(v.id)), preview: p };
  }

  /**
   * The drafts folder grant the admin asked for, checked before anything is written: a member delegate only, a folder they
   * have no grant on yet (so the end of the delegation removes exactly what Delegate added), Contribute on it and for their agents.
   */
  private checkDrafts(path: string | null, role: string, userId: string): { path: string; grants: FolderGrantInput[] } | null {
    if (!path) return null;
    if (role !== 'member') throw err('invalid_argument', 'drafts_folder: only for a member delegate. An admin delegate has no ceiling.');
    if (!this.d.users) throw err('invalid_state', 'Folder grants are not available on this hub.');
    const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some((x) => x === '..' || x === '.')) throw err('invalid_argument', 'drafts_folder: a vault folder, such as /Papers/P1/contrib/Rowan/.');
    const norm = `/${parts.join('/')}/`;
    const have = this.d.users.folderGrants(userId);
    if (have.some((g) => g.path.toLowerCase() === norm.toLowerCase())) throw err('invalid_argument', `drafts_folder: the delegate already has a grant on ${norm}. Pick a new folder, or leave drafts out.`);
    const grants: FolderGrantInput[] = [...have.map((g) => ({ path: g.path, mode: g.mode, may_export: g.may_export, delegation: g.delegation })),
      { path: norm, mode: 'contribute', delegation: { folders: [{ path: norm, mode: 'contribute' }] } }];
    this.d.users.previewFolderGrants(userId, grants); // the grant editor's own checks: grantable, not restricted for an external user
    return { path: norm, grants };
  }
  /** A delegation of the agent ended: remove the drafts grant Delegate added, if it is still there. */
  private dropDrafts(agentId: string, actor: Actor): void {
    if (!this.d.users) return;
    const rows = this.db.prepare("SELECT id, delegate_user_id u, drafts_path p FROM checkouts WHERE scope='agent' AND agent_id=? AND drafts_path IS NOT NULL AND released_at IS NOT NULL").all(agentId) as { id: string; u: string; p: string }[];
    for (const r of rows) {
      const have = this.d.users.folderGrants(r.u);
      if (have.some((g) => g.path === r.p)) this.d.users.setFolderGrants(r.u, have.filter((g) => g.path !== r.p).map((g) => ({ path: g.path, mode: g.mode, may_export: g.may_export, delegation: g.delegation })), actor);
      // The audit log keeps it (user.folder_grant_set, checkout.drafts_removed); the row no longer names a live grant.
      this.db.prepare('UPDATE checkouts SET drafts_path=NULL WHERE id=?').run(r.id);
      this.d.audit.event(actor, 'checkout.drafts_removed', { kind: 'checkout', id: r.id }, { agent: agentId, delegate: r.u, path: r.p });
    }
  }

  /** The admin's view of one delegation: the checkout, the delegate, the PC, the step, and no prompt. */
  adminView(c: CheckoutRow) {
    const u = c.delegate_user_id ? this.user(c.delegate_user_id) : null;
    const r = parse<RenderInput | null>(c.delegate_render, null), ch = parse<Choices | null>(c.choices, null);
    const pc = ch ? this.keys.machine(ch.machine_id) : r?.machine_id ? this.keys.machine(r.machine_id) : null;
    return {
      id: c.id, status: c.status, agent_id: c.agent_id, agent: this.agentLabel(c.agent_id), team_id: c.team_id,
      delegate: u ? { id: u.id, label: this.label(u), role: u.role } : null,
      pc: pc ? { id: pc.id, name: pc.name, status: pc.status } : null,
      prompt_opened_at: c.prompt_opened_at,
      released_at: c.released_at, release_reason: c.release_reason, expires_at: c.expires_at, drafts_folder: c.drafts_path ?? null,
      contributor: !!u && u.role === 'member',
      step: this.adminStep(c, u),
    };
  }
  private adminStep(c: CheckoutRow, u: UserRow | null): string {
    const who = this.label(u), a = this.agentLabel(c.agent_id);
    if (c.released_at) return c.release_reason === 'taken_back' ? `You took ${a} back.` : `The delegation ended (${c.release_reason ?? c.status}).`;
    switch (c.status) {
      case 'collecting': return `${a} is checkpointing; ${who} can open the prompt once its handout is written.`;
      case 'ready': return `Waiting for ${who} to open the prompt in their console.`;
      case 'rendered': return `${who} has the prompt; waiting for the restore on their PC.`;
      case 'restoring': return `Restored on ${who}'s PC; waiting for ${a} to resume there.`;
      case 'restored': return `${a} runs for ${who}.`;
      default: return `The delegation was ${c.status}.`;
    }
  }

  /** The person's delegations for their Home: standing ones, and ones that ended in the last week (read-only rows). */
  mine(userId: string) {
    const since = Date.now() - ENDED_SHOWN_MS;
    const rows = this.db.prepare(`SELECT * FROM checkouts WHERE scope='agent' AND delegate_user_id=? AND (
        (released_at IS NULL AND status IN ('collecting','ready','rendered','restoring','restored')) OR COALESCE(released_at, ended_at, 0) >= ?) ORDER BY created_at DESC LIMIT 20`)
      .all(userId, since) as unknown as CheckoutRow[];
    return rows.map((c) => this.memberRow(c));
  }
  /** One Home row: what the delegate sees and may do. No checkout internals, no key, no PC list. */
  private memberRow(c: CheckoutRow) {
    const by = c.requested_by ? this.user(c.requested_by) : null, a = this.agentLabel(c.agent_id), owner = this.label(by);
    const ch = parse<Choices | null>(c.choices, null), r = parse<RenderInput | null>(c.delegate_render, null);
    const pcName = (ch ? this.keys.machine(ch.machine_id)?.name : r?.machine_id ? this.keys.machine(r.machine_id)?.name : null) ?? null;
    const ended = !!c.released_at || (!OPEN.includes(c.status) && c.status !== 'restored');
    const state = ended ? (c.release_reason === 'taken_back' ? 'taken_back' : 'ended') : c.status === 'restored' ? 'running' : c.status;
    const text = state === 'taken_back' ? `${owner} took ${a} back.`
      : state === 'ended' ? `The move of ${a} was ${c.release_reason ?? c.status}.`
      : state === 'running' ? `You run ${a} for ${owner}${pcName ? ` on ${pcName}` : ''}.`
      : state === 'collecting' ? `${owner} is lending you ${a}. It is checkpointing; the prompt appears here once it is ready.`
      : state === 'ready' ? `${owner} is lending you ${a}. Open the prompt and run it on ${pcName ?? 'your PC'}.`
      : state === 'rendered' ? `The connector on ${pcName ?? 'your PC'} restores ${a} when the administrator sends Restore; ${a} starts there once it confirms.`
      : `Restored on ${pcName ?? 'your PC'}: start ${a} there.`;
    return {
      id: c.id, agent: a, for: owner, pc: pcName, state, text,
      prompt_available: !ended && (c.status === 'ready' || (c.status === 'rendered' && this.reRenderable(c) === null)),
      repos: !ended && c.status !== 'restored' ? this.repoUrls(c.agent_id!) : [],
      updated_at: c.updated_at,
    };
  }
  private mustMine(id: string, userId: string): CheckoutRow {
    const c = this.co.checkout(id);
    // Someone else's delegation is not found, the same answer as a missing one.
    if (!c || c.scope !== 'agent' || c.delegate_user_id !== userId) throw err('not_found', 'delegation not found');
    return c;
  }
  /** Why a rendered delegation cannot be rendered again for its delegate (null when it can): the restore already started. */
  private reRenderable(c: CheckoutRow): string | null {
    const r = c.request_id ? this.d.onboarding.request(c.request_id) : null;
    if (r && r.pickup_issues > 0) return 'The restore has already picked up the key on the PC. Ask the administrator if it needs to run again.';
    return null;
  }

  /**
   * The delegate opens the prompt (their console, signed in): the hub renders the move now with the admin's choices.
   * Opening it again renders again until the restore has started.
   */
  openPrompt(id: string, userId: string) {
    const c = this.mustMine(id, userId);
    const u = this.user(userId);
    if (!this.usable(u)) throw err('not_found', 'delegation not found');
    if (c.released_at || !OPEN.includes(c.status)) throw err('invalid_state', 'This delegation has ended.');
    if (c.status === 'collecting') throw err('not_ready', `${this.agentLabel(c.agent_id)} is still checkpointing. The prompt appears once its handout is written.`);
    if (c.status === 'restoring') throw err('invalid_state', 'The restore has confirmed; there is no prompt to open.');
    if (c.status === 'rendered') { const why = this.reRenderable(c); if (why) throw err('prompt_in_use', why); }
    const input = parse<RenderInput | null>(c.delegate_render, null);
    if (!input) throw err('invalid_state', 'This delegation has no render choices. Ask the administrator to delegate again.');
    const actor: Actor = { kind: 'admin', id: u.id, role: u.role };
    const out = this.ck.render(c.id, input, actor);
    const now = this.co.now();
    this.db.prepare('UPDATE checkouts SET prompt_opened_at=?, updated_at=? WHERE id=?').run(now, now, c.id);
    this.d.audit.event(actor, 'checkout.prompt_opened', { kind: 'checkout', id: c.id }, { agent: c.agent_id });
    return { prompt: out.prompt.text, expires_at: out.prompt.expires_at, row: this.memberRow(this.co.mustCheckout(c.id)) };
  }

  /**
   * Take back (admin): the delegation ends at once. While the move is still open it is cancelled (the agent goes on with
   * its old key on its source PC). Once restored, the key it runs with on the delegate's PC is revoked with every token
   * (Keys.rotate), the new key is bound to the source PC for a key prompt, and the ceiling ends. Unmerged work on the
   * delegate's PC is not recovered: Delegate back (a new delegation to the admin, checkpoint first) is the way for that.
   */
  takeBack(id: string, _o: Record<string, never> = {}, actor: Actor) {
    this.requireAdmin(actor);
    const c0 = this.co.mustCheckout(id);
    if (c0.scope !== 'agent') throw err('invalid_state', 'This is a team checkout: cancel it from the checkout.');
    if (c0.released_at || (!OPEN.includes(c0.status) && c0.status !== 'restored')) throw err('invalid_state', 'This delegation has already ended.');
    let newKey: string | null = null, revoked: string | null = null;
    if (OPEN.includes(c0.status)) {
      this.co.cancel(id, 'taken back', actor, { force: true });
      this.db.prepare("UPDATE checkouts SET release_reason='taken_back', released_by=? WHERE id=?").run(actor.id, id);
    } else {
      tx(this.db, () => {
        const h = this.co.handouts(id).find((x) => x.agent_id === c0.agent_id && x.status === 'consumed');
        const m = this.d.teams.members(c0.team_id).find((x) => x.agent_id === c0.agent_id);
        const cur = [h?.new_credential_id, m?.credential_id].map((k) => (k ? this.keys.credential(k) : null)).find((k) => k && k.status !== 'revoked') ?? null;
        if (cur) {
          const r = this.keys.rotate(cur.id, actor, { reason: 'suspected_leak' });
          revoked = cur.id; newKey = r.credential.id;
          const src = c0.source_machine_id ? this.keys.machine(c0.source_machine_id) : null;
          this.keys.setBinding(r.credential.id, src && src.status === 'active' ? src.id : null, actor);
        }
        this.co.release(id, 'taken_back', actor);
      });
    }
    this.d.teams.wake();
    this.d.audit.event(actor, 'checkout.take_back', { kind: 'checkout', id }, { agent: c0.agent_id, delegate: c0.delegate_user_id, from: c0.status, revoked_credential: revoked, replacement_credential: newKey });
    return { delegation: this.adminView(this.co.mustCheckout(id)), new_key_id: newKey };
  }

  /** Delegations for the admin: standing ones (open or running for someone), newest first, or one agent's. */
  list(o: { agentId?: string } = {}) { return this.co.delegations({ agentId: o.agentId }).map((c) => this.adminView(c)); }
}
