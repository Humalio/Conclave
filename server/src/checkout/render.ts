/**
 * Checkout keys and render (docs/checkout.md §5, §9 F6 and F8): the target table, the render with its push
 * list and the `repo_no_remote` refusal, the checkout kind of onboarding request (one slot per agent, binding forced on),
 * a second app key for another OS user, the new-PC approval, and the successor keys behind pickup, confirm, restored,
 * cancel and expiry.
 *
 * Onboarding is reused, not copied: render creates an `onboarding_requests` row with kind 'checkout' on the target PC, and
 * the existing /onboard pickup and confirm (nonce, 3-issue limit, rate limit, auth) carry the secrets. This class is the
 * request's CheckoutLink: pickup issues Keys.issueSuccessor rows, confirm suspends the old sessions.
 *
 * Handout bodies are L2: their fields are validated here before any of them reaches the prompt or the push list, and
 * `notes` never do.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys, Credential } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Teams } from '../teams/teams.js';
import type { Onboarding, CheckoutLink, RequestRow, SlotRow, CheckoutBodyIn } from '../onboarding/onboarding.js';
import type { ClientFiles } from '../onboarding/http.js';
import type { Checkouts, CheckoutRow, HandoutRow, MergedReport } from './checkout.js';
import { checkoutBranchOf } from './checkout.js';
import { sha256Hex } from '../util/crypto.js';
// Render offers every provider: Codex since the second Codex move trial passed (docs/checkout.md §9 F4).
import { PROVIDERS, PERMISSIONS, validRef, validHead, validRemote, validFolder, validUrl, validModel, oneLine, type Provider, type Permission } from './fields.js';

export { PROVIDERS, PERMISSIONS, validRef, validHead, type Provider, type Permission };

export type Target = 'same_user' | 'other_pc';
export const TARGET_NAMES: readonly Target[] = ['same_user', 'other_pc'];
/**
 * The target table (§5, §9 F6 and F8): where the request lives, which key picks up, whether
 * a PC must be enrolled first, whether agent keys can be reused, and whether commits must be pushed (and so need a remote).
 */
export const TARGETS: Record<Target, { machine: string; pickup_key: string; enrol: string; rotate: 'default_on' | 'forced'; push_list: boolean; needs_remote: boolean }> = {
  same_user: { machine: 'the source PC', pickup_key: "the source PC's onboarding key (already held)", enrol: 'none', rotate: 'default_on', push_list: false, needs_remote: false },
  other_pc: { machine: 'an enrolled PC', pickup_key: "that PC's onboarding key", enrol: 'the PC is added with the connector first (Add PC)', rotate: 'forced', push_list: true, needs_remote: true },
};

export interface AgentChoice { provider: Provider; model: string | null; permissions: Permission }
export interface Choices {
  target: Target; machine_id: string; rotate_agent_keys: boolean; agents: Record<string, AgentChoice>;
  /** The app key that picks up (null for reuse) and the source's. */
  app_key_id: string | null; source_app_key_id: string | null;
}
export interface RenderInput {
  target: string; machine_id?: string | null; new_pc_name?: string | null; rotate_agent_keys?: boolean;
  /** Another user or PC while a handout says its agent's work is unmerged on the source: the operator accepts it stays there. */
  accept_unmerged_work?: boolean;
  agents?: Record<string, { provider?: string; model?: string | null; permissions?: string }>;
}
/**
 * The restore's config scan (§6 step 4): what the connector reports per folder before any folder trust is written.
 * hooks: a tracked .claude/settings.json with hooks; mcp_servers: a tracked .mcp.json; claude_config: other tracked .claude/
 * files; codex_config: tracked .codex/ files; role_file: a tracked CLAUDE.md or AGENTS.md; checkout_diff: agent config the
 * checkout/<id> branch changes.
 */
export const SCAN_KINDS = ['hooks', 'mcp_servers', 'claude_config', 'codex_config', 'role_file', 'checkout_diff'] as const;
export type ScanKind = typeof SCAN_KINDS[number];
export const SCAN_FINDINGS_MAX = 50;
export const SCAN_TEXT_MAX = 300;
export interface ScanFinding { kind: ScanKind; path: string; detail: string }
interface ScanRow { checkout_id: string; folder: string; request_id: string; agent_id: string | null; findings_json: string; findings_sha256: string; decision: 'approved' | 'untrusted' | 'no_findings' | null; decided_by: string | null; decided_at: number | null; reported_at: number }
export interface PushRepo {
  remote_name: string; url: string; clone_folder: string | null; agents: string[];
  branches: { branch: string; heads: string[]; tip: string | null; unreviewed: boolean }[];
  commands: string[];
}

const err = (code: string, msg: string, extra?: Record<string, unknown>) => new KeyError(code, msg, extra);
const sys: Actor = { kind: 'system', id: null };
const parse = <T>(s: string | null, d: T): T => { if (s === null) return d; try { return JSON.parse(s) as T; } catch { return d; } };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const up = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

interface Facts {
  h: HandoutRow; agentId: string; body: Record<string, unknown>;
  repo: { remote_name: string | null; url: string | null; clone_folder: string | null } | null;
  checkpoint: Partial<MergedReport> | null; providerWas: { provider: Provider | null; model: string | null; permissions: Permission | null };
  /** A handout the hub built (proceed) without a complete checkpoint: the agent's work stays on the source PC. */
  unmerged: boolean;
}

export interface CheckoutKeysDeps { db: Db; keys: Keys; teams: Teams; audit: Audit; onboarding: Onboarding; checkouts: Checkouts; files: ClientFiles; hubUrl: string }

export class CheckoutKeys implements CheckoutLink {
  private readonly db: Db; private readonly keys: Keys; private readonly teams: Teams; private readonly audit: Audit;
  private readonly ob: Onboarding; private readonly co: Checkouts;
  constructor(private readonly d: CheckoutKeysDeps) {
    this.db = d.db; this.keys = d.keys; this.teams = d.teams; this.audit = d.audit; this.ob = d.onboarding; this.co = d.checkouts;
    d.onboarding.checkoutLink = this;
    d.onboarding.now = () => this.co.now();
    d.checkouts.onEnded = (c, how) => this.ended(c, how);
    d.checkouts.onRestored = (c) => this.restored(c);
  }

  // ───── reading handouts (L2, validated field by field) ─────
  private facts(c: CheckoutRow): Facts[] {
    return this.co.handouts(c.id).filter((h) => h.status === 'written' || h.status === 'consumed').map((h) => {
      const body = parse<Record<string, unknown>>(h.body, {}) ?? {};
      const r = isObj(body.repo) ? body.repo : null;
      const repo = r ? { remote_name: typeof r.remote_name === 'string' ? r.remote_name : null, url: typeof r.url === 'string' ? r.url : null,
        clone_folder: typeof r.clone_folder === 'string' ? r.clone_folder : null } : null;
      // Only the checkpoint the hub wrote into the body (write() or builtBody()), never the raw report with its leftovers.
      const cp = isObj(body.checkpoint) ? body.checkpoint as Partial<MergedReport> : null;
      const pw = isObj(body.provider_was) ? body.provider_was : {};
      const provider = (PROVIDERS as readonly string[]).includes(pw.provider as string) ? pw.provider as Provider : null;
      const perm = (PERMISSIONS as readonly string[]).includes(pw.permissions as string) ? pw.permissions as Permission : null;
      return { h, agentId: h.agent_id, body, repo, checkpoint: cp, providerWas: { provider, model: typeof pw.model === 'string' ? pw.model : null, permissions: perm },
        unmerged: body.unmerged_work_on_source === true };
    });
  }
  /** Agents whose work stays unmerged on the source (a hub-built handout without a complete checkpoint, §2 step 4). */
  private unmerged(fs: Facts[]): string[] { return fs.filter((f) => f.unmerged).map((f) => f.agentId); }
  /** Agents that reported nothing to merge (no_repo), with their reason (L2, the agent's own words): nothing to push for them. */
  private nothingToMerge(fs: Facts[]): { agent_id: string; reason: string }[] {
    return fs.filter((f) => !f.unmerged && typeof f.checkpoint?.no_repo === 'string' && f.checkpoint.no_repo).map((f) => ({ agent_id: f.agentId, reason: f.checkpoint!.no_repo! }));
  }
  /** Agents whose handout names a repo with no usable remote: their commits cannot reach another user or PC (F8). */
  private noRemote(fs: Facts[]): string[] {
    return fs.filter((f) => f.repo && !(validRemote(f.repo.remote_name) && validUrl(f.repo.url))).map((f) => f.agentId);
  }
  /**
   * The push list (F8): per repo, the branches and heads the operator pushes before running the prompt. The integration
   * branch's tip is the head of the agent that merged last; checkout/<id> holds unreviewed work (F7). Refs are checked.
   */
  pushList(c: CheckoutRow, fs = this.facts(c)): PushRepo[] {
    const byUrl = new Map<string, PushRepo & { order: Map<string, number> }>();
    const sorted = [...fs].sort((a, b) => (a.h.merged_at ?? a.h.written_at ?? 0) - (b.h.merged_at ?? b.h.written_at ?? 0));
    for (const f of sorted) {
      // Unmerged work on the source is never pushed as a checkpoint: it is listed apart (unmerged_work_on_source).
      if (f.unmerged || !f.repo || !validUrl(f.repo.url) || !validRemote(f.repo.remote_name)) continue;
      const cp = f.checkpoint ?? {};
      // Nothing to merge (no_repo): nothing to push for this agent; render and the vault pages say so.
      if (cp.no_repo !== undefined) continue;
      const repo = byUrl.get(f.repo.url) ?? { remote_name: f.repo.remote_name, url: f.repo.url, clone_folder: validFolder(f.repo.clone_folder) ? f.repo.clone_folder : null, agents: [] as string[], branches: [] as PushRepo['branches'], commands: [] as string[], order: new Map<string, number>() };
      byUrl.set(f.repo.url, repo);
      repo.agents.push(f.agentId);
      const add = (branch: unknown, heads: unknown[], tip: unknown, unreviewed: boolean) => {
        if (branch === undefined || branch === null) return;
        if (!validRef(branch)) throw err('invalid_argument', `The handout of ${f.agentId} names a branch that is not a valid ref.`, { agent: f.agentId });
        for (const x of heads) if (!validHead(x)) throw err('invalid_argument', `The handout of ${f.agentId} names a commit that is not 40 hex characters.`, { agent: f.agentId });
        let b = repo.branches.find((x) => x.branch === branch);
        if (!b) { b = { branch, heads: [], tip: null, unreviewed }; repo.branches.push(b); }
        for (const x of heads as string[]) if (!b.heads.includes(x)) b.heads.push(x);
        if (validHead(tip)) b.tip = tip;
      };
      add(cp.integration_branch, [cp.integration_head, ...(cp.merge_commits ?? [])].filter((x) => x !== undefined && x !== null), cp.integration_head, false);
      // Each member's own branch (checkout/<id>-<member>); a checkpoint written before checkout_branch existed means checkout/<id>.
      const own = checkoutBranchOf(cp, c.id);
      if (own) add(own, [cp.checkout_head], cp.checkout_head, true);
    }
    return [...byUrl.values()].map(({ order: _o, ...r }) => ({ ...r, commands: r.branches.map((b) => `git push ${r.remote_name} ${b.branch}`) }));
  }

  // ───── the target table, per checkout ─────
  /** The source PC's key that picks up for a same-user move: the team's onboarding key, else the PC's newest onboarding key. */
  private sourceKey(c: CheckoutRow): Credential | null {
    if (!c.source_machine_id) return null;
    const row = this.db.prepare("SELECT app_credential_id k FROM onboarding_requests WHERE team_id=? AND state='collected' AND machine_id=? ORDER BY collected_at DESC LIMIT 1").get(c.team_id, c.source_machine_id) as { k: string } | undefined;
    const k = row ? this.keys.credential(row.k) : null;
    if (k && k.status === 'active' && k.onboarding_enabled_at) return k;
    return this.ob.pcKey(c.source_machine_id);
  }
  /** Allowed render choices with the reason for each refusal (§7: GET /api/checkouts/:id), and the defaults per agent. */
  options(id: string, fs?: Facts[]) {
    const c = this.co.mustCheckout(id);
    fs ??= this.facts(c);
    const noRemote = this.noRemote(fs);
    const src = c.source_machine_id ? this.keys.machine(c.source_machine_id) : null, srcKey = this.sourceKey(c);
    const remoteWhy = noRemote.length ? 'repo_no_remote' : null;
    const withKey = this.ob.pcKeyMachines();
    const machines = this.keys.machines().filter((m) => m.status === 'active' && m.id !== c.source_machine_id).map((m) => ({ id: m.id, name: m.name, has_key: withKey.has(m.id) }));
    return {
      targets: {
        // Rotation picks up with the source PC's onboarding key; reuse needs none.
        same_user: { allowed: !!src, reason: !src ? 'source_unknown' : null, rotate_agent_keys: { default: true, reuse_allowed: true, rotate_allowed: !!srcKey, rotate_reason: srcKey ? null : 'no_source_key' }, ...TARGETS.same_user },
        other_pc: { allowed: !remoteWhy, reason: remoteWhy, rotate_agent_keys: { default: true, reuse_allowed: false }, machines, ...TARGETS.other_pc },
      },
      repo_no_remote: noRemote,
      // Their work stays on the source PC: another user or PC needs accept_unmerged_work (§2 step 4).
      unmerged_work_on_source: this.unmerged(fs),
      providers: PROVIDERS, permissions: PERMISSIONS,
      agents: Object.fromEntries(fs.map((f) => [f.agentId, this.defaults(f)])),
    };
  }
  private defaults(f: Facts): AgentChoice {
    // An agent keeps the provider it ran on (Claude Code when none is recorded), with its model.
    return { provider: f.providerWas.provider ?? 'claude_code', model: f.providerWas.model, permissions: f.providerWas.permissions ?? 'default' };
  }
  private agentChoices(fs: Facts[], raw: RenderInput['agents']): Record<string, AgentChoice> {
    if (raw !== undefined && !isObj(raw)) throw err('invalid_argument', 'agents: an object {agent_id: {provider, model, permissions}}');
    const ids = new Set(fs.map((f) => f.agentId));
    for (const k of Object.keys(raw ?? {})) if (!ids.has(k)) throw err('invalid_argument', `agents: ${k} is not an agent of this checkout`);
    const out: Record<string, AgentChoice> = {};
    for (const f of fs) {
      const d = this.defaults(f), a = (raw ?? {})[f.agentId] ?? {};
      if (!isObj(a)) throw err('invalid_argument', `agents.${f.agentId}: an object`);
      const provider = (a.provider ?? d.provider) as Provider;
      if (!(PROVIDERS as readonly string[]).includes(provider)) throw err('invalid_argument', `agents.${f.agentId}.provider: ${PROVIDERS.join(' or ')}`);
      let model = a.model === undefined ? (provider === d.provider ? d.model : null) : a.model;
      if (model !== null && !validModel(model)) throw err('invalid_argument', `agents.${f.agentId}.model: up to 80 letters, digits, dot, dash, colon or brackets`);
      model = model ?? null;
      const permissions = (a.permissions ?? d.permissions) as Permission;
      if (!(PERMISSIONS as readonly string[]).includes(permissions)) throw err('invalid_argument', `agents.${f.agentId}.permissions: one of ${PERMISSIONS.join(', ')}`);
      if (PERMISSIONS.indexOf(permissions) > PERMISSIONS.indexOf(d.permissions)) throw err('invalid_argument', `agents.${f.agentId}.permissions: can be lowered from ${d.permissions}, never raised`);
      out[f.agentId] = { provider, model, permissions };
    }
    return out;
  }

  // ───── render ─────
  /**
   * Render (§2 step 5, §5): checks the combination, creates the checkout's onboarding request on the target PC (no key
   * yet), records the render and its handout hashes, and returns the prompt and the push list. A new render first undoes
   * everything issued under the previous one.
   */
  render(id: string, input: RenderInput, actor: Actor) {
    this.co.assertRepoHosts(id, actor); // the repo host allowlist as it stands now (§8)
    if (!isObj(input)) throw err('invalid_argument', 'body: an object');
    if (input.target === 'same_pc_other_user') throw err('invalid_state', 'That user installs the connector and pairs it (Add PC), then approve a destination on it, then render for that enrolled PC.', { reason: 'other_user_pairs_first' });
    const target = input.target as Target;
    if (!TARGET_NAMES.includes(target)) throw err('invalid_argument', `target: ${TARGET_NAMES.join(', ')}`);
    if (input.rotate_agent_keys !== undefined && typeof input.rotate_agent_keys !== 'boolean') throw err('invalid_argument', 'rotate_agent_keys: true or false');
    if (input.accept_unmerged_work !== undefined && typeof input.accept_unmerged_work !== 'boolean') throw err('invalid_argument', 'accept_unmerged_work: true or false');
    // The restore prompt ships as a template; without it there is nothing to give the operator.
    const template = this.d.files.file('restore-prompt.md')?.text;
    if (!template) throw err('restore_unavailable', 'The restore client is not shipped with this hub yet (restore-prompt.md is missing), so a checkout cannot be rendered.');
    const rotate = input.rotate_agent_keys ?? true;
    if (!rotate && target !== 'same_user') throw err('invalid_argument', 'rotate_agent_keys: keys can be reused only for same_user; another user or PC cannot read them.');
    if (target === 'other_pc' && input.new_pc_name) throw err('invalid_state', 'Add this PC with the connector first (install it and pair it with Add PC), then approve a destination on it, then render for that enrolled PC.', { reason: 'add_pc_first' });
    if (target === 'other_pc' && !input.machine_id) throw err('invalid_argument', 'other_pc: give machine_id (an enrolled PC)');
    if (target !== 'other_pc' && (input.machine_id || input.new_pc_name)) throw err('invalid_argument', `${target}: the target is the source PC; machine_id and new_pc_name are for other_pc`);

    const out = tx(this.db, () => {
      const c = this.co.mustCheckout(id);
      if (c.status !== 'ready' && c.status !== 'rendered') throw err('invalid_state', `The checkout is ${c.status}; render needs it ready (every handout written, or the operator went on without them).`, { status: c.status });
      const t = this.teams.mustTeam(c.team_id);
      // A one-agent checkout (a delegation) goes to another PC: the agent must not run twice on the source.
      if (c.scope === 'agent' && target !== 'other_pc') throw err('invalid_argument', 'A delegated agent moves to another PC: choose other_pc with an enrolled PC.');
      const fs = this.facts(c);
      const agents = this.agentChoices(fs, input.agents);
      const noRemote = TARGETS[target].needs_remote ? this.noRemote(fs) : [];
      if (noRemote.length) throw err('repo_no_remote', `A repo with no remote moves only to the same user (F8): ${noRemote.join(', ')} named a repo without a remote URL.`, { agents: noRemote });
      // Unmerged work stays in the source folders: the same user keeps it in place; another user or PC leaves it behind.
      const unmerged = this.unmerged(fs);
      if (unmerged.length && TARGETS[target].push_list && input.accept_unmerged_work !== true) {
        throw err('unmerged_work', `The work of ${unmerged.join(', ')} is not merged and stays on the source PC (no complete checkpoint). Render again with accept_unmerged_work to leave it there, or cancel.`, { agents: unmerged });
      }
      const push = TARGETS[target].push_list ? this.pushList(c, fs) : [];
      const prev = c.status === 'rendered' ? parse<Choices | null>(c.choices, null) : null;
      if (c.status === 'rendered') this.supersede(c, prev, actor);

      const src = c.source_machine_id ? this.keys.machine(c.source_machine_id) : null;
      if (target !== 'other_pc' && !src) throw err('invalid_state', 'The PC this team runs on is not known (the team was not onboarded), so it can move only to another PC.', { reason: 'source_unknown' });
      let machineId: string, app: Credential | null = null;
      const sourceKey = this.sourceKey(c);
      if (target === 'same_user') {
        machineId = src!.id;
        if (rotate) { app = sourceKey; if (!app) throw err('invalid_state', 'The source PC has no active onboarding key to pick up with. Re-enrol it first.', { reason: 'no_source_key' }); }
      } else {
        const m = this.keys.machine(input.machine_id!);
        if (!m) throw err('not_found', 'PC not found');
        if (m.id === c.source_machine_id) throw err('invalid_argument', 'machine_id is the source PC: choose same_user.');
        if (m.status !== 'active') throw err('invalid_state', `The PC is ${m.status}.`);
        app = this.ob.pcKey(m.id);
        if (!app) throw err('invalid_state', `${m.name} has no active onboarding key (it was added without one). Re-enrol it first.`, { reason: 'no_pc_key' });
        machineId = m.id;
      }

      let requestId: string | null = null;
      if (rotate) {
        const r = this.ob.createCheckoutRequest({ app: app!, teamId: t.id, body: this.requestBody(c, t.name, t.project ?? null), slots: this.slotsFor(c, fs, t.name) }, actor);
        requestId = r.id;
      } else {
        // Reuse (same user only): no key, no pickup. The old logins end now; checkout_resume accepts only a later login (§5).
        let ended = 0;
        for (const m of this.teams.members(t.id)) ended += this.keys.endTokens(m.credential_id, 'checkout_reuse');
        this.audit.event(actor, 'checkout.logins_ended', { kind: 'checkout', id: c.id }, { tokens: ended });
      }
      const choices: Choices = { target, machine_id: machineId, rotate_agent_keys: rotate, agents, app_key_id: app?.id ?? null, source_app_key_id: sourceKey?.id ?? null };
      const row = this.co.recordRender(c.id, { target_machine_id: machineId, request_id: requestId, choices }, actor);
      // recordRender() wrote checkout.rendered with the handout hashes (§3); this adds the target choices.
      this.audit.event(actor, 'checkout.render_choices', { kind: 'checkout', id: c.id }, { target, machine: machineId, rotate, request: requestId, push_repos: push.length, unmerged_work_on_source: unmerged });
      return { row, choices, push, team: t.name, unmerged, none: this.nothingToMerge(fs) };
    });
    return {
      checkout: this.co.view(id), push_list: out.push, unmerged_work_on_source: out.unmerged, nothing_to_merge: out.none,
      prompt: { text: this.prompt(template, out.row, out.choices, out.push, out.team, out.unmerged, out.none.map((x) => x.agent_id)), expires_at: out.row.expires_at },
    };
  }
  private requestBody(c: CheckoutRow, team: string, project: string | null): CheckoutBodyIn {
    const roles = new Map<string, { name: string; team_role: 'coordinator' | 'worker' | 'reviewer' | 'stakeholder'; count: number; job: string }>();
    for (const m of this.teams.members(c.team_id)) {
      if (c.scope === 'agent' && m.agent_id !== c.agent_id) continue; // one agent: its role only
      const a = this.keys.agent(m.agent_id), name = a?.role ?? m.role;
      const r = roles.get(name) ?? { name, team_role: teamRole(m.role), count: 0, job: a?.role_detail ?? '' };
      r.count++; roles.set(name, r);
    }
    return { kind: 'checkout', project: { name: project ?? '', existing: true }, team: { id: c.team_id, name: team }, roles: [...roles.values()], prompt: `checkout ${c.id}` };
  }
  /** One slot per agent: its folder (from the handout, else its source slot), its session variable and its own rules as the ceiling. */
  private slotsFor(c: CheckoutRow, fs: Facts[], team: string) {
    const ms = new Map(this.teams.members(c.team_id).map((m) => [m.agent_id, m]));
    return fs.map((f) => {
      const m = ms.get(f.agentId);
      if (!m) throw err('invalid_state', `${f.agentId} is no longer a member of the team.`);
      const a = this.keys.agent(f.agentId)!;
      const old = this.db.prepare("SELECT folder, session_var FROM onboarding_slots WHERE agent_id=? AND status IN ('issued','confirmed') ORDER BY created_at DESC LIMIT 1").get(f.agentId) as { folder: string; session_var: string } | undefined;
      const folder = validFolder(f.body.folder) ? f.body.folder : old?.folder ?? (slug(a.label) || f.agentId);
      const sessionVar = old?.session_var ?? `CNV_${up(team)}_${up(a.role ?? m.role)}_SESSION_KEY`;
      const cred = this.keys.credential(m.credential_id)!;
      const ceiling = this.keys.rules(cred.policy_id, false).map(({ id: _i, ...r }) => r);
      return { agent_id: f.agentId, role: a.role ?? m.role, team_role: teamRole(m.role), label: a.label, session_var: sessionVar, folder, ceiling };
    });
  }
  /** Undo the previous render: its request ends (unconfirmed successors reverted), its request is ended. */
  private supersede(c: CheckoutRow, prev: Choices | null, actor: Actor): void {
    if (c.request_id) this.ob.endCheckoutRequest(c.request_id, new Set(), 'render superseded', actor);
    this.rewire(c.team_id);
  }
  private rewire(teamId: string): void {
    const t = this.teams.team(teamId);
    if (t && t.status !== 'done' && t.status !== 'stopped') this.teams.rewire(teamId);
  }

  /** Whether a one-agent checkout's delegate is a console member (an admin delegate needs no PC confirmation). */
  delegateIsMember(c: CheckoutRow): boolean {
    if (!c.delegate_user_id) return false;
    return (this.db.prepare('SELECT role FROM admin_users WHERE id=?').get(c.delegate_user_id) as { role: string } | undefined)?.role === 'member';
  }
  /** What the console shows next to the checkout: the target with its enrolment and approval, and the push list. */
  details(id: string) {
    const c = this.co.mustCheckout(id), ch = parse<Choices | null>(c.choices, null);
    const r = c.request_id ? this.ob.request(c.request_id) : null;
    const pc = ch ? this.keys.machine(ch.machine_id) : null;
    const fs = this.facts(c);
    let push: PushRepo[] = [];
    try { push = ch && TARGETS[ch.target].push_list ? this.pushList(c, fs) : []; } catch { push = []; }
    const unmerged = this.unmerged(fs);
    return {
      options: c.status === 'ready' || c.status === 'rendered' ? this.options(id, fs) : null,
      target: ch ? { target: ch.target, pc: pc ? { id: pc.id, name: pc.name, status: pc.status } : null, rotate_agent_keys: ch.rotate_agent_keys,
        request: r ? { id: r.id, state: r.state, pickup_issues: r.pickup_issues, pickup_allowed: r.pickup_allowed } : null } : null,
      push_list: push,
      unmerged_work_on_source: unmerged,
      nothing_to_merge: this.nothingToMerge(fs),
      scans: this.scans(c),
      restore: ch ? this.restoreWay(ch) : null,
      restore_order: this.restoreOrder(id),
    };
  }

  /** The latest Restore order for this checkout: its state, what it waits for, and the start lines once it is done. */
  private restoreOrder(id: string): { state: string; note: string | null; reason: string | null; start_lines: string[] } | null {
    const a = this.db.prepare("SELECT state, result FROM pc_actions WHERE kind='restore' AND json_extract(payload,'$.checkout_id')=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as { state: string; result: string | null } | undefined;
    if (!a) return null;
    const r = parse<{ progress?: string; reason?: string; start_lines?: string[] } | null>(a.result, null);
    return { state: a.state, note: r?.progress ?? null, reason: r?.reason ?? null, start_lines: Array.isArray(r?.start_lines) ? r!.start_lines! : [] };
  }

  /**
   * How this checkout gets restored, in plain words (§6 "Restore by the connector"). The connector on an enrolled PC carries out
   * the operator's Restore into a destination its user approved. A PC that has not enrolled needs Add PC first, and another OS user on a PC
   * pairs their own connector; this says so instead of leaving the operator to find out.
   */
  private restoreWay(ch: Choices): { via: 'connector' | 'no_destination' | 'add_pc_first'; text: string; destinations: { id: string; label: string }[] } {
    const pc = this.keys.machine(ch.machine_id);
    const name = pc?.name ?? 'the PC';
    const rep = this.db.prepare('SELECT destinations FROM connector_reports WHERE machine_id=?').get(ch.machine_id) as { destinations: string | null } | undefined;
    if (!rep) return { via: 'add_pc_first', destinations: [], text: `The connector on ${name} has not reported in. Add the PC (Add PC), have its user pair the connector, then render this checkout for it.` };
    const destinations = parse<{ id: string; label: string }[]>(rep.destinations, []);
    if (!destinations.length) return { via: 'no_destination', destinations, text: `The user of ${name} has not approved a destination for a restored team. Ask them to approve a folder on the connector's screen, then send Restore.` };
    return { via: 'connector', destinations, text: `The connector on ${name} restores this team when you send Restore, into a folder its user approved.` };
  }

  // ───── the restore client's view and the config scan (§6) ─────
  /**
   * What the connector reads from GET /onboard/requests/:id: the agents with their render choices, folder, session
   * variable and handout body (L2, raw, so the client checks it against the render hash), and the scan per folder. No secret.
   */
  clientView(r: RequestRow): unknown {
    const c = this.db.prepare('SELECT * FROM checkouts WHERE request_id=?').get(r.id) as unknown as CheckoutRow | undefined;
    if (!c) return null;
    const ch = parse<Choices | null>(c.choices, null), hashes = parse<Record<string, string>>(c.handout_hashes, {});
    const slots = this.ob.slots(r.id), hs = new Map(this.co.handouts(c.id).map((h) => [h.agent_id, h]));
    return {
      id: c.id, status: c.status, target: ch?.target ?? null, rotate_agent_keys: ch?.rotate_agent_keys ?? null, team: this.teams.team(c.team_id)?.name ?? null,
      // One agent of the team (a delegation) or the whole team: the connector words its result by it.
      scope: c.scope ?? 'team', delegate: c.scope === 'agent' && c.delegate_user_id ? this.co.personLabel(c.delegate_user_id) : null,
      agents: slots.filter((s) => s.status !== 'closed').map((s) => {
        const h = hs.get(s.agent_id), ac = ch?.agents[s.agent_id];
        return { agent_id: s.agent_id, label: s.label, role: s.role, team_role: s.team_role, folder: s.folder, session_var: s.session_var,
          provider: ac?.provider ?? 'claude_code', model: ac?.model ?? null, permissions: ac?.permissions ?? 'default',
          handout: h ? { status: h.status, body: h.body, render_sha256: hashes[s.agent_id] ?? null } : null };
      }),
      scans: this.scans(c),
    };
  }
  private scanRows(c: CheckoutRow): ScanRow[] {
    if (!c.request_id) return [];
    return this.db.prepare('SELECT * FROM checkout_scans WHERE checkout_id=? AND request_id=? ORDER BY folder').all(c.id, c.request_id) as unknown as ScanRow[];
  }
  /** The scan per folder of the current render: findings (L2), their hash, the decision, and whether the folder may be trusted. */
  scans(c: CheckoutRow) {
    return this.scanRows(c).map((s) => ({ folder: s.folder, agent_id: s.agent_id, findings: parse<ScanFinding[]>(s.findings_json, []), findings_sha256: s.findings_sha256,
      decision: s.decision, decided_by: s.decided_by, decided_at: s.decided_at, reported_at: s.reported_at,
      waiting: s.decision === null, trusted: s.decision === 'approved' || s.decision === 'no_findings' }));
  }
  /**
   * POST /onboard/requests/:id/scan, body {folders: [{folder, findings: [{kind, path, detail}]}]}. Each folder must be a slot
   * folder of this request. A folder with findings waits for the operator; one without is 'no_findings'. A report with the
   * same findings keeps an earlier decision; different findings reset it.
   */
  reportScan(r: RequestRow, raw: unknown): unknown {
    const c = this.byRequest(r);
    if (c.status !== 'rendered') throw err('invalid_state', `The checkout is ${c.status}; the config scan is reported before confirm.`, { status: c.status });
    if (!isObj(raw) || !Array.isArray(raw.folders) || !raw.folders.length) throw err('invalid_argument', 'folders: [{folder, findings: [{kind, path, detail}]}]');
    const slots = this.ob.slots(r.id).filter((s) => s.status !== 'closed'), byFolder = new Map(slots.map((s) => [s.folder, s]));
    const clean: { folder: string; agent: string; findings: ScanFinding[] }[] = [];
    for (const f of raw.folders as unknown[]) {
      if (!isObj(f) || !validFolder(f.folder) || !byFolder.has(f.folder)) throw err('invalid_argument', 'folders[].folder: a folder of this checkout');
      if (clean.some((x) => x.folder === f.folder)) throw err('invalid_argument', `folders: ${f.folder} is listed twice`);
      if (!Array.isArray(f.findings) || f.findings.length > SCAN_FINDINGS_MAX) throw err('invalid_argument', `folders[].findings: a list of at most ${SCAN_FINDINGS_MAX}`);
      const findings = (f.findings as unknown[]).map((x) => {
        if (!isObj(x) || !(SCAN_KINDS as readonly string[]).includes(x.kind as string) || typeof x.path !== 'string' || !x.path || (x.detail !== undefined && typeof x.detail !== 'string')) {
          throw err('invalid_argument', `findings[]: {kind: ${SCAN_KINDS.join('|')}, path, detail}`);
        }
        return { kind: x.kind as ScanKind, path: oneLine(x.path).slice(0, SCAN_TEXT_MAX), detail: oneLine((x.detail as string | undefined) ?? '').slice(0, SCAN_TEXT_MAX) };
      });
      clean.push({ folder: f.folder, agent: byFolder.get(f.folder)!.agent_id, findings });
    }
    const now = this.co.now();
    tx(this.db, () => {
      for (const f of clean) {
        const json = JSON.stringify(f.findings), sha = sha256Hex(json);
        const old = this.db.prepare('SELECT * FROM checkout_scans WHERE checkout_id=? AND folder=?').get(c.id, f.folder) as unknown as ScanRow | undefined;
        const keep = old && old.request_id === r.id && old.findings_sha256 === sha;
        const decision = f.findings.length ? (keep ? old.decision : null) : 'no_findings';
        this.db.prepare(`INSERT INTO checkout_scans(checkout_id,folder,request_id,agent_id,findings_json,findings_sha256,decision,decided_by,decided_at,reported_at) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(checkout_id,folder) DO UPDATE SET request_id=excluded.request_id, agent_id=excluded.agent_id, findings_json=excluded.findings_json, findings_sha256=excluded.findings_sha256,
          decision=excluded.decision, decided_by=excluded.decided_by, decided_at=excluded.decided_at, reported_at=excluded.reported_at`)
          .run(c.id, f.folder, r.id, f.agent, json, sha, decision, keep ? old.decided_by : null, keep ? old.decided_at : null, now);
      }
      this.audit.event(sys, 'checkout.scan_reported', { kind: 'checkout', id: c.id }, { request: r.id, app_key: r.app_credential_id,
        folders: clean.map((f) => ({ folder: f.folder, findings: f.findings.length, kinds: [...new Set(f.findings.map((x) => x.kind))] })) });
    });
    return { scans: this.scans(this.co.mustCheckout(c.id)) };
  }
  /** POST /api/checkouts/:id/scan/:folder (admin): approve the folder's findings (trust may be written) or leave it untrusted. */
  decideScan(id: string, folder: string, decision: 'approve' | 'leave_untrusted', findingsSha: string, actor: Actor) {
    const requestId = tx(this.db, () => {
      const c = this.co.mustCheckout(id);
      if (c.status !== 'rendered') throw err('invalid_state', `The checkout is ${c.status}; a scan is decided before the restore confirms.`, { status: c.status });
      const s = this.scanRows(c).find((x) => x.folder === folder);
      if (!s) throw err('not_found', 'No config scan for this folder yet.');
      if (s.decision === 'no_findings') throw err('invalid_state', 'The scan found nothing in this folder; there is nothing to decide.');
      if (s.findings_sha256 !== findingsSha) throw err('conflict', 'The findings changed since you looked. Reload and decide again.');
      const d = decision === 'approve' ? 'approved' : 'untrusted';
      this.db.prepare('UPDATE checkout_scans SET decision=?, decided_by=?, decided_at=? WHERE checkout_id=? AND folder=?').run(d, actor.id, this.co.now(), c.id, folder);
      this.audit.event(actor, 'checkout.scan_decided', { kind: 'checkout', id: c.id }, { folder, decision: d, findings: parse<ScanFinding[]>(s.findings_json, []).length, findings_sha256: s.findings_sha256 });
      return c.request_id!;
    });
    this.ob.notify(requestId);
    return this.co.view(id);
  }
  /** Pickup and confirm wait while a reported folder waits for the operator, or while a slot folder has not been scanned. */
  scanGate(r: RequestRow): void {
    const c = this.byRequest(r);
    if (c.status === 'restored') return; // a re-enrolled target: plain onboarding
    const rows = new Map(this.scanRows(c).map((s) => [s.folder, s]));
    const folders = this.ob.slots(r.id).filter((s) => s.status !== 'closed').map((s) => s.folder);
    const missing = folders.filter((f) => !rows.has(f)), waiting = folders.filter((f) => rows.get(f)?.decision === null);
    if (missing.length || waiting.length) {
      throw err('scan_pending', missing.length ? `Report the config scan of every folder first (POST /onboard/requests/${r.id}/scan): ${missing.join(', ')}.`
        : `The administrator has not decided the config scan of ${waiting.join(', ')} yet. Wait, then run the restore again.`, { missing, waiting });
    }
  }
  trust(r: RequestRow): Record<string, boolean> | null {
    const c = this.byRequest(r);
    if (c.status === 'restored') return null;
    const rows = new Map(this.scanRows(c).map((s) => [s.folder, s]));
    return Object.fromEntries(this.ob.slots(r.id).filter((s) => s.status !== 'closed').map((s) => {
      const d = rows.get(s.folder)?.decision;
      return [s.folder, d === 'approved' || d === 'no_findings'];
    }));
  }

  // ───── the prompt ─────
  /**
   * The restore prompt (§6): the hub's template (restore-prompt.md), filled by the hub. Keys
   * are placeholders only; handout facts appear only in a fenced block labelled as data, and notes never.
   */
  private prompt(tpl: string, c: CheckoutRow, ch: Choices, push: PushRepo[], team: string, unmerged: string[] = [], none: string[] = []): string {
    const slots = c.request_id ? this.ob.slots(c.request_id) : [];
    const agents = this.co.handouts(c.id).map((h) => {
      const a = this.keys.agent(h.agent_id), s = slots.find((x) => x.agent_id === h.agent_id), ac = ch.agents[h.agent_id];
      const old = s ? null : this.db.prepare("SELECT folder, session_var FROM onboarding_slots WHERE agent_id=? AND status IN ('issued','confirmed') ORDER BY created_at DESC LIMIT 1").get(h.agent_id) as { folder: string; session_var: string } | undefined;
      return { agent_id: h.agent_id, label: a?.label ?? h.agent_id, role: a?.role ?? null, folder: s?.folder ?? old?.folder ?? null, session_key: `\${${s?.session_var ?? old?.session_var ?? 'SESSION_KEY'}}`, ...ac };
    });
    const pc = this.keys.machine(ch.machine_id);
    const where = ch.target === 'same_user' ? `the same OS user on ${pc?.name}` : `the PC ${pc?.name}`;
    const collect = !ch.rotate_agent_keys
      ? 'Keys are reused (same user): there is nothing to run, so skip steps 2 to 4, this command and step 6. Each agent keeps its folder and its key. Tell me to start each agent again in its folder as before (one terminal each); its first call there is `checkout_resume`, accepted only from a login made after this prompt was created. If an agent changes provider, remove the previous provider\'s MCP config from its folder first.'
      : 'The connector on the target PC restores this checkout; there is nothing to run here. If the PC has no connector yet, install it and pair it with Add PC in the console (another OS user pairs their own connector, then the administrator renders for that PC), and the PC user approves a restore destination (`conclave destinations add <folder>`). Then the administrator sends Restore from the console, and the connector builds every folder, picks the keys up and confirms. Wait for it, then start each agent with the line the connector shows (`conclave restores`).';
    const pushText = (push.length
      ? push.map((r) => `- ${r.url} (${r.remote_name}): ${r.branches.map((b) => `${b.branch} at ${b.tip ?? b.heads.at(-1)}${b.unreviewed ? ' (not approved yet)' : ''}`).join('; ')}`).join('\n')
      : '(nothing to push: same user, the clone is already there)')
      + (unmerged.length ? `\nNot merged, stays on the source PC (no complete checkpoint): ${unmerged.join(', ')}` : '')
      // Agent ids only: the reason is the agent's own text (L2) and stays out of the prompt; the console and the vault page show it.
      + (none.length ? `\nNothing to merge (the agent reported no repository): ${none.join(', ')}` : '');
    const vals: Record<string, string> = {
      HUB_URL: this.d.hubUrl, CHECKOUT_ID: c.id, REQUEST_ID: c.request_id ?? '', TEAM_NAME: team, TARGET: where,
      COLLECT: collect, PUSH_LIST: pushText, AGENTS: JSON.stringify(agents, null, 2),
      SETUP_SHA256: this.d.files.file('setup.mjs')?.sha256 ?? '(setup.mjs not installed on the hub)', HELPER_SHA256: this.d.files.file('agent-hub-headers.mjs')?.sha256 ?? '(agent-hub-headers.mjs not installed on the hub)', CA_SHA256: this.d.files.ca()?.sha256 ?? '(no CA certificate configured on the hub)',
      EXPIRES_AT: new Date(c.expires_at).toISOString(),
    };
    return tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => vals[k] ?? m);
  }

  // ───── CheckoutLink: pickup and confirm of the checkout request ─────
  private byRequest(r: RequestRow): CheckoutRow {
    const c = this.db.prepare('SELECT * FROM checkouts WHERE request_id=?').get(r.id) as unknown as CheckoutRow | undefined;
    if (!c) throw err('invalid_state', 'This request has no checkout.');
    return c;
  }
  pickupMode(r: RequestRow): 'successor' | 'normal' {
    const c = this.byRequest(r);
    if (c.status === 'restored') return 'normal'; // Re-enrol on the target reopened it: plain keys, as onboarding.
    if (c.status !== 'rendered') throw err('invalid_state', `The checkout is ${c.status}; its keys cannot be picked up.`, { status: c.status });
    // The agents rendered with a body must be exactly those with a body now, each with the same hash: a body that went
    // away (or appeared) since render counts as changed too.
    const hashes = parse<Record<string, string>>(c.handout_hashes, {});
    const hs = this.co.handouts(c.id), withBody = new Set(hs.filter((h) => h.body !== null).map((h) => h.agent_id));
    const changed = [...new Set([
      ...hs.filter((h) => h.body !== null && hashes[h.agent_id] !== sha256Hex(h.body)).map((h) => h.agent_id),
      ...Object.keys(hashes).filter((a) => !withBody.has(a)),
    ])];
    if (changed.length) throw err('handout_changed', 'A handout does not match the one rendered. Ask the administrator to render again.', { agents: changed });
    return 'successor';
  }
  issue(r: RequestRow, s: SlotRow): { credential: Credential; secret: string } {
    const c = this.byRequest(r);
    const m = this.teams.members(c.team_id).find((x) => x.agent_id === s.agent_id);
    if (!m) throw err('invalid_state', `${s.agent_id} is no longer a member of the team.`);
    // The label names the team's checkout, never its id: the operator reads it in the console (docs/design-guidelines.md, no ids in titles).
    return this.keys.issueSuccessor(m.credential_id, r.machine_id, sys, `${s.label} (moved by the ${this.teams.team(c.team_id)?.name ?? 'team'} checkout)`);
  }
  unissue(r: RequestRow, s: SlotRow, reason: string): void {
    const c = this.byRequest(r);
    this.keys.revertSuccessor(s.credential_id!, reason, sys, c.id);
    this.rewire(c.team_id);
  }
  confirmed(r: RequestRow, slots: SlotRow[]): void {
    const c = this.byRequest(r);
    if (c.status === 'restored') return; // a re-enrolled target: plain onboarding keys, nothing to settle
    this.co.markRestoring(c.id, sys); // guarded: rendered -> restoring, or the confirm rolls back
    let suspended = 0;
    for (const s of slots) {
      const k = s.credential_id ? this.keys.credential(s.credential_id) : null;
      if (!k?.replaces_credential_id) continue;
      // The old key must still stand: one revoked or suspended since pickup (operator, leak guard) cannot hand over.
      const old = this.keys.credential(k.replaces_credential_id);
      if (old?.status !== 'active' || old.succession !== 'superseded_pending' || k.status !== 'active') {
        throw err('invalid_state', `The key of ${s.agent_id} was suspended or revoked after pickup; it cannot move. Ask the administrator.`, { agent: s.agent_id });
      }
      suspended += this.keys.confirmSuccessor(k.id, c.id, sys);
      this.db.prepare('UPDATE handouts SET new_credential_id=? WHERE checkout_id=? AND agent_id=?').run(k.id, c.id, s.agent_id);
    }
    this.audit.event(sys, 'checkout.confirmed', { kind: 'checkout', id: c.id }, { request: r.id, agents: slots.length, old_tokens_suspended: suspended });
  }

  // ───── restored, cancel and expiry (hooks of the checkout service, inside its transactions) ─────
  /** Restored: the old keys are revoked; for another OS user the source key goes too once no live slot uses it (§5). */
  private restored(c: CheckoutRow): void {
    const ch = parse<Choices | null>(c.choices, null);
    if (!c.request_id || !ch) return; // reuse: the same keys go on
    const moved = this.settle(c);
    this.audit.event(sys, 'checkout.keys_settled', { kind: 'checkout', id: c.id }, { old_keys_revoked: moved });
  }
  /** Revoke the old key of every confirmed successor and close the moved agents' earlier slots. Returns how many. */
  private settle(c: CheckoutRow, only?: Set<string>): number {
    let n = 0;
    for (const s of this.ob.slots(c.request_id!)) {
      if (s.status !== 'confirmed' || !s.credential_id || (only && !only.has(s.agent_id))) continue;
      const k = this.keys.credential(s.credential_id);
      if (!k?.replaces_credential_id) continue;
      this.keys.finishSuccessor(k.id, sys);
      this.db.prepare("UPDATE onboarding_slots SET status='closed' WHERE agent_id=? AND request_id<>? AND status<>'closed'").run(s.agent_id, c.request_id);
      n++;
    }
    return n;
  }
  /**
   * Cancel or expiry (§3, §5): unconfirmed successors are revoked; a confirmed successor whose agent has not resumed is
   * undone (membership and grants back, old sessions reinstated); an agent that already resumed on the target stays moved.
   */
  private ended(c: CheckoutRow, how: 'cancelled' | 'expired'): void {
    const ch = parse<Choices | null>(c.choices, null);
    if (!c.request_id) return; // not rendered, or reuse: the old keys never changed
    const resumed = new Set(this.co.handouts(c.id).filter((h) => h.status === 'consumed').map((h) => h.agent_id));
    for (const s of this.ob.slots(c.request_id)) {
      if (s.status !== 'confirmed' || !s.credential_id || resumed.has(s.agent_id)) continue;
      const k = this.keys.credential(s.credential_id);
      if (k?.replaces_credential_id && k.status !== 'revoked') this.keys.revertSuccessor(k.id, `checkout ${how}`, sys, c.id);
    }
    if (resumed.size) this.settle(c, resumed);
    this.ob.endCheckoutRequest(c.request_id, resumed, `checkout ${how}`, sys);
    this.rewire(c.team_id);
    this.audit.event(sys, 'checkout.keys_undone', { kind: 'checkout', id: c.id }, { how, kept_moved: [...resumed] });
  }
}

/** Slots take the onboarding team roles; any other member role (a curator) gets the worker playbook. */
function teamRole(role: string): 'coordinator' | 'worker' | 'reviewer' | 'stakeholder' {
  return role === 'coordinator' || role === 'reviewer' || role === 'stakeholder' ? role : 'worker';
}
