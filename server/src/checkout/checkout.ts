/**
 * Checkout and handouts (docs/checkout.md): one move of one team to another provider, OS user or PC. This is the model
 * and service (§3): guarded states, the expiry sweep, the team pause at ready, audit and the checkout_open guards.
 * Keys and render (render.ts) and the agent tools (mcp/checkoutTools.ts) build on the transitions here.
 *
 * Every state change is a guarded UPDATE ... WHERE id=? AND status IN (...) that fails with `conflict` when the row moved.
 * Handout bodies are L2 (written by a model): stored and shown, never followed. They hold no secret and no hub data.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Teams, TeamRow, Who } from '../teams/teams.js';
import { randomToken, sha256Hex } from '../util/crypto.js';
import { LEFTOVER_KINDS, LEFTOVER_LABELS, LEFTOVER_ITEM_MAX, LEFTOVER_REASON_MAX, LEFTOVERS_PER_KIND, PROVIDERS, PERMISSIONS, validRef, validHead, validRemote, validFolder, validUrl, validModel, oneLine,
  type LeftoverKind, DEFAULT_REPO_HOSTS, REPO_HOSTS_MAX, validRepoHost, repoHost, hostAllowed } from './fields.js';

export type CheckoutStatus = 'collecting' | 'ready' | 'rendered' | 'restoring' | 'restored' | 'cancelled' | 'expired';
export type HandoutStatus = 'requested' | 'checkpointing' | 'merged' | 'written' | 'consumed' | 'removed';

/** Open: the team is held by this checkout (one per team). */
export const OPEN: readonly CheckoutStatus[] = ['collecting', 'ready', 'rendered', 'restoring'];
/** Past collecting: handouts are locked and the team is paused (F5). */
const HELD: readonly CheckoutStatus[] = ['ready', 'rendered', 'restoring'];

/** Fixed, not configurable (§3). */
export const EXPIRY_MS = 48 * 3600_000;
export const BODY_MAX = 8000;
export const NOTES_MAX = 1500;
export const REPORT_MAX = 8000;
/** Attention (§7): a collecting checkout with missing handouts, or a rendered prompt not yet run, shows once this close to expiry. */
export const ATTENTION_SOON_MS = 12 * 3600_000;
const REPO_HOSTS_KEY = 'checkout.repo_hosts';

/** One step of an open checkout that waits on the operator (GET /api/checkouts?open=1, Attention on Home). */
export interface NeedsOperator {
  kind: 'leftovers' | 'handouts_missing' | 'handouts_complete' | 'prompt_expiring';
  /** When the step started waiting. */
  at: number;
  agent_id?: string; count?: number; of?: number; expires_at?: number; pc?: { id: string; name: string } | null; enrolled_from?: string | null;
}

export interface CheckoutRow {
  id: string; team_id: string; status: CheckoutStatus; source_machine_id: string | null; target_machine_id: string | null; request_id: string | null;
  choices: string | null; handout_hashes: string | null; paused_team: number; missing: string; end_reason: string | null; requested_by: string | null;
  created_at: number; updated_at: number; ready_at: number | null; rendered_at: number | null; restoring_at: number | null; restored_at: number | null;
  ended_at: number | null; expires_at: number; overdue_at: number | null;
  /** A whole team, or one agent of it delegated to a collaborator (migration 0143, docs/checkout.md §9 F1). */
  scope: 'team' | 'agent'; agent_id: string | null; delegate_user_id: string | null; delegate_render: string | null;
  prompt_opened_at: number | null; pc_confirmed_at: number | null; pc_refused_at: number | null;
  released_at: number | null; released_by: string | null; release_reason: string | null; drafts_path?: string | null;
}
export interface HandoutRow {
  id: string; checkout_id: string; agent_id: string; status: HandoutStatus; source: 'agent' | 'hub'; report: string | null; body: string | null; version: number;
  created_at: number; updated_at: number; checkpointing_at: number | null; merged_at: number | null; written_at: number | null; consumed_at: number | null;
  removed_at: number | null; new_credential_id: string | null;
  /** Set where the body used to be cleared at once (D63): the purge clears it once its vault page holds this version, or after 7 days. */
  purge_due: number | null;
}
/** One leftover the agent did not clean up: an exception with its reason, approved or refused by the operator only. */
export interface Leftover { kind: LeftoverKind; item: string; reason: string; approved: boolean; refused?: string | null }
/** An exception named by the operator: kind and item, as the report lists it. */
export interface LeftoverRef { kind: LeftoverKind; item: string }
/**
 * The agent's `merged` report (§4 steps 2 and 4): the checkpoint (refs and heads checked), the worktrees still there,
 * whether the tree is clean apart from listed exceptions, and the leftover check (`checked`: every kind was reported).
 */
export interface MergedReport {
  integration_branch?: string; integration_head?: string; merge_commits?: string[]; checkout_head?: string | null;
  /**
   * The branch that holds the agent's unapproved work: checkout/<id> or checkout/<id>-<member>. A report stored before
   * this field existed (or one that leaves it out) means checkout/<id>; read it with checkoutBranchOf().
   */
  checkout_branch?: string;
  /** Nothing to merge (no repository, review-only work): the agent's short reason, in place of the branch, head and merge commits. */
  no_repo?: string;
  worktrees_left: number; clean: boolean; leftovers?: Leftover[]; checked?: LeftoverKind[];
}
/** At most this many characters of no_repo reason. */
export const NO_REPO_MAX = 120;
/** The branch of a checkpoint's unapproved work, or null when it has none. Old reports carry no checkout_branch: checkout/<id>. */
export function checkoutBranchOf(cp: { checkout_head?: unknown; checkout_branch?: unknown } | null | undefined, checkoutId: string): string | null {
  if (!cp || !cp.checkout_head) return null;
  return typeof cp.checkout_branch === 'string' && cp.checkout_branch ? cp.checkout_branch : `checkout/${checkoutId}`;
}
/** A branch name a member may report for its unapproved work: checkout/<id> itself, or checkout/<id>-<anything ref-safe>. */
export const checkoutBranchAllowed = (b: unknown, checkoutId: string): b is string =>
  validRef(b) && (b === `checkout/${checkoutId}` || (b.startsWith(`checkout/${checkoutId}-`) && b.length > `checkout/${checkoutId}-`.length));
/** The member part of checkout/<id>-<member>: the agent's short name made safe for a ref (lower case, a-z 0-9 . _ -). */
export function refSafe(name: string, fallback: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.{2,}/g, '.').replace(/\.lock$/, '').slice(0, 40).replace(/[-.]+$/, '');
  return s || fallback.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'member';
}
/**
 * The checkpoint the hub writes into a handout body from a merged report: the checked refs and heads, the branch of
 * unapproved work (checkout/<id> for a report without checkout_branch), or no_repo with nothing to merge.
 */
export function checkpointOf(r: MergedReport, checkoutId: string): Record<string, unknown> {
  if (r.no_repo !== undefined) return { no_repo: r.no_repo, merge_commits: [] };
  const branch = checkoutBranchOf(r, checkoutId);
  return { integration_branch: r.integration_branch, integration_head: r.integration_head, merge_commits: r.merge_commits ?? [],
    ...(branch ? { checkout_head: r.checkout_head, checkout_branch: branch, unreviewed: true } : {}) };
}
/** Said where the hub does not know the team's integration branch. */
export const INTEGRATION_FALLBACK = 'the branch your team merges approved work into (usually `develop`)';
/** The last line of the checkout notice: tools a session lists are fixed when it connects. */
export const RECONNECT_HINT = "If you don't see `checkout_handout`, reconnect the Conclave server or restart your session.";
/** What does not move with a checkout (§4): stated in the handout answer and the resume answer. */
export const DOES_NOT_MOVE = 'Transcripts and /resume history, auto-memory, subagents, hooks, skills and local session ids do not move (on-demand wakes need the new session ids). Your notes summarise what mattered.';
/** The vault-copy step: before the handout, because the team pauses (and vault writes stop) once every handout is written. */
export const VAULT_COPY_STEP = 'Copy files you want kept to your project folder in the vault now; once every handout is written the team pauses and vault writes stop.';
/**
 * The checkpoint steps of the playbook (L0, hub text): shown by checkout_status and, while a checkout is open, after the
 * team playbook in team_info. They hold for every role and every playbook, edited or not. `integration` names the team's
 * integration branch where the hub knows it, `branch` the member's own branch for unapproved work, `hosts` the repo host
 * allowlist (§8), so a member knows each before it writes the handout.
 */
export function checkpointSteps(o: { integration?: string | null; branch?: string; hosts?: readonly string[] } = {}): string {
  const integration = o.integration ? `your team's integration branch \`${o.integration}\`` : INTEGRATION_FALLBACK;
  const branch = o.branch ? `your own branch \`${o.branch}\`` : 'your own branch checkout/<checkout id>-<your short name>';
  const hosts = o.hosts ? (o.hosts.length ? o.hosts.map((h) => `\`${h}\``).join(', ') : 'none (leave repo.url out)') : "the hub's repo host allowlist";
  return [
    '1. Stop taking new work. Finish or cleanly pause your current step at a good checkpoint (tests passing where the task has them). Report checkout_progress "checkpointing".',
    `2. Commit your work and merge it into ${integration} under the team's normal landing rules: no force, no history rewrite. Work not yet approved goes to ${branch} instead (cut from the integration tip; one branch per member), and its task stays open. With no repository, or review-only work, there is nothing to merge: say so with no_repo in step 6. Never commit local config: keys.env, .mcp.json, .agent-hub.json, .claude/settings.local.json, .codex/, role overlays.`,
    '3. Remove your task worktrees and delete the branches you merged. Leave your own session folder clean at the integration tip.',
    '4. Run the leftover check and report every kind: ' + LEFTOVER_KINDS.map((k) => `${k} (${LEFTOVER_LABELS[k]})`).join('; ') + '. Clean each up, or list it as an exception with a reason; the administrator approves exceptions before you can write your handout.',
    `5. ${VAULT_COPY_STEP}`,
    '6. Report checkout_progress "merged" with the integration branch and head, your merge commits, checkout_branch and checkout_head if you used a checkout branch, worktrees_left, clean and the leftover check. With nothing to merge, send no_repo with a short reason (for example "no repository" or "review-only") in place of the branch, head and merge commits.',
    `7. Write your handout with checkout_handout: folder, repo, provider_was and notes (at most 1500 characters for your next session). A repo url must be on ${hosts}; leave the url out otherwise. Then stop and wait: the team pauses once every handout is written.`,
    "Never push, at the checkpoint or after: the administrator pushes from the render's push list.",
  ].join('\n');
}
/** The steps without a checkout's context (docs and tests); checkout_status and team_info fill in the team's. */
export const CHECKPOINT_STEPS = checkpointSteps();

const err = (code: string, msg: string, extra?: Record<string, unknown>) => new KeyError(code, msg, extra);
const parse = <T>(s: string | null, d: T): T => { if (s === null) return d; try { return JSON.parse(s) as T; } catch { return d; } };
const sys: Actor = { kind: 'system', id: null };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The open checkout of a team, or of a PC as its source or target: the `checkout_open` guards use it. */
export function openCheckout(db: Db, by: { teamId?: string; machineId?: string }): CheckoutRow | null {
  const st = OPEN.map(() => '?').join(',');
  if (by.teamId) return (db.prepare(`SELECT * FROM checkouts WHERE team_id=? AND scope='team' AND status IN (${st})`).get(by.teamId, ...OPEN) as unknown as CheckoutRow) ?? null;
  if (by.machineId) return (db.prepare(`SELECT * FROM checkouts WHERE (source_machine_id=? OR target_machine_id=?) AND status IN (${st}) ORDER BY created_at LIMIT 1`).get(by.machineId, by.machineId, ...OPEN) as unknown as CheckoutRow) ?? null;
  return null;
}

export class Checkouts {
  /** Hooks set by CheckoutKeys, run inside the ending transaction: revoke unconfirmed keys and reinstate old sessions (cancel, expiry), revoke old keys (restored). */
  onEnded?: (c: CheckoutRow, how: 'cancelled' | 'expired') => void;
  onRestored?: (c: CheckoutRow) => void;
  /** A delegation of this agent ended (Take back, cancelled, expired, moved again, back with the admin): its drafts grant goes. */
  onDelegationEnded?: (agentId: string, actor: Actor) => void;
  /**
   * Told after a change commits (the vault copy, docs/vault.md): start, a handout written or replaced, ready, render,
   * restoring, restored and the end. Always queued with setImmediate, so it runs after the caller's transaction; `expect`
   * lists the statuses the change leaves, and a run that finds another one (the transaction rolled back) writes nothing.
   */
  onChange?: (checkoutId: string, expect?: readonly CheckoutStatus[]) => void;
  private changed(id: string, expect?: readonly CheckoutStatus[]): void {
    const f = this.onChange;
    if (f) setImmediate(() => { try { f(id, expect); } catch (e) { console.error('checkout change hook failed', id, e); } });
  }
  /** Injectable clock for tests. */
  now: () => number = Date.now;
  /** The repo host allowlist until the operator saves one: CONCLAVE_REPO_HOSTS (app.ts), else DEFAULT_REPO_HOSTS (§8). */
  seedRepoHosts: readonly string[] | null = null;

  constructor(private readonly db: Db, private readonly keys: Keys, private readonly teams: Teams, private readonly audit: Audit) {
    teams.onTick = (now) => this.sweep(now);
    teams.beforeResume = (t) => this.guardResume(t);
    teams.onTeamEnded = (teamId) => this.teamEnded(teamId);
    teams.beforeMembership = (teamId) => this.guardMembership(teamId);
  }

  // ───── lookups ─────
  checkout(id: string): CheckoutRow | null { return (this.db.prepare('SELECT * FROM checkouts WHERE id=?').get(id) as unknown as CheckoutRow) ?? null; }
  mustCheckout(id: string): CheckoutRow { const c = this.checkout(id); if (!c) throw err('not_found', 'checkout not found'); return c; }
  handouts(checkoutId: string): HandoutRow[] { return this.db.prepare('SELECT * FROM handouts WHERE checkout_id=? ORDER BY created_at, rowid').all(checkoutId) as unknown as HandoutRow[]; }
  handout(id: string): HandoutRow | null { return (this.db.prepare('SELECT * FROM handouts WHERE id=?').get(id) as unknown as HandoutRow) ?? null; }
  /** The team's open team checkout (a one-agent checkout of one of its members is not one: see delegations()). */
  openFor(teamId: string): CheckoutRow | null { return openCheckout(this.db, { teamId }); }
  /** The agent's open one-agent checkout. */
  openForAgent(agentId: string): CheckoutRow | null {
    return (this.db.prepare(`SELECT * FROM checkouts WHERE scope='agent' AND agent_id=? AND status IN (${OPEN.map(() => '?').join(',')})`).get(agentId, ...OPEN) as unknown as CheckoutRow) ?? null;
  }
  /**
   * One-agent checkouts that still stand: open, or restored and not released (the agent runs for its delegate). Of one
   * agent, or of the live members of a team. Newest first.
   */
  delegations(by: { agentId?: string; teamId?: string; delegateUserId?: string } = {}): CheckoutRow[] {
    const where = ["scope='agent'", 'released_at IS NULL', `status IN (${[...OPEN, 'restored'].map(() => '?').join(',')})`], args: unknown[] = [...OPEN, 'restored'];
    if (by.agentId) { where.push('agent_id=?'); args.push(by.agentId); }
    if (by.teamId) { where.push('agent_id IN (SELECT agent_id FROM team_members WHERE team_id=? AND removed_at IS NULL)'); args.push(by.teamId); }
    if (by.delegateUserId) { where.push('delegate_user_id=?'); args.push(by.delegateUserId); }
    return this.db.prepare(`SELECT * FROM checkouts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC`).all(...(args as never[])) as unknown as CheckoutRow[];
  }
  /** The agent's handout in an open checkout (an agent belongs to at most one open checkout per team; the oldest first). */
  handoutOf(agentId: string, checkoutId?: string): { c: CheckoutRow; h: HandoutRow } | null {
    const st = OPEN.map(() => '?').join(',');
    const h = this.db.prepare(`SELECT h.* FROM handouts h JOIN checkouts c ON c.id=h.checkout_id WHERE h.agent_id=? AND c.status IN (${st})${checkoutId ? ' AND c.id=?' : ''} ORDER BY c.created_at LIMIT 1`)
      .get(agentId, ...OPEN, ...(checkoutId ? [checkoutId] : [])) as unknown as HandoutRow | undefined;
    return h ? { c: this.checkout(h.checkout_id)!, h } : null;
  }
  view(id: string) {
    const c = this.mustCheckout(id);
    return {
      id: c.id, team_id: c.team_id, status: c.status, source_machine_id: c.source_machine_id, target_machine_id: c.target_machine_id, request_id: c.request_id,
      choices: parse(c.choices, null), handout_hashes: parse(c.handout_hashes, null), paused_team: !!c.paused_team, missing: parse<string[]>(c.missing, []),
      end_reason: c.end_reason, created_at: c.created_at, ready_at: c.ready_at, rendered_at: c.rendered_at, restoring_at: c.restoring_at, restored_at: c.restored_at,
      ended_at: c.ended_at, expires_at: c.expires_at, overdue_at: c.overdue_at, waiting_for: this.waitingFor(c),
      scope: c.scope ?? 'team', agent_id: c.agent_id ?? null, delegate_user_id: c.delegate_user_id ?? null, prompt_opened_at: c.prompt_opened_at ?? null,
      pc_confirmed_at: c.pc_confirmed_at ?? null, pc_refused_at: c.pc_refused_at ?? null, released_at: c.released_at ?? null, release_reason: c.release_reason ?? null,
      // Bodies are visible to the administrator until the purge clears them, once their vault page is written (§3, §7, D63); they are L2 data.
      handouts: this.handouts(c.id).map((h) => ({ id: h.id, agent_id: h.agent_id, status: h.status, source: h.source, version: h.version, report: parse(h.report, null),
        report_sha256: h.report === null ? null : sha256Hex(h.report), body: parse(h.body, null), written_at: h.written_at, consumed_at: h.consumed_at, new_credential_id: h.new_credential_id })),
    };
  }

  /**
   * What an open checkout waits for, in one plain sentence (docs/checkout.md, "What it waits for"): the agents still to
   * write their handout or to resume, the operator's review of leftovers or the restore prompt, or the target. Null once
   * it has ended. agents: the ids it waits on, for the console to name.
   */
  waitingFor(c: CheckoutRow): { on: 'agents' | 'operator' | 'target'; text: string; agents: string[] } | null {
    const H = this.handouts(c.id), n = H.length, of = (k: number, what: string) => `${k} of ${n} ${n === 1 ? 'agent' : 'agents'} ${k === 1 ? 'has' : 'have'} not ${what} yet.`;
    if (c.status === 'collecting') {
      const leftovers = H.filter((h) => h.status === 'merged').reduce((s, h) => s + (parse<MergedReport | null>(h.report, null)?.leftovers ?? []).filter((l) => !l.approved && !l.refused).length, 0);
      if (leftovers) return { on: 'operator', text: `${leftovers === 1 ? 'One leftover waits' : leftovers + ' leftovers wait'} for your review before the agents can finish their handouts.`, agents: [] };
      const missing = H.filter((h) => h.status !== 'written' && h.status !== 'consumed');
      if (missing.length) return { on: 'agents', text: of(missing.length, 'written their handout'), agents: missing.map((h) => h.agent_id) };
      return { on: 'operator', text: 'Every handout is in. Create the restore prompt.', agents: [] };
    }
    if (c.status === 'ready') return { on: 'operator', text: 'Every handout is in. Create the restore prompt.', agents: [] };
    if (c.status === 'rendered') return { on: 'target', text: 'Waiting for the restore prompt to be run on the target.', agents: [] };
    if (c.status === 'restoring') {
      const left = H.filter((h) => h.status !== 'consumed');
      return left.length ? { on: 'agents', text: of(left.length, 'resumed on the target'), agents: left.map((h) => h.agent_id) } : { on: 'target', text: 'Every agent has resumed. Finishing.', agents: [] };
    }
    return null;
  }

  /** Open checkouts, oldest first, or the latest checkouts in any state (GET /api/checkouts). */
  list(o: { open?: boolean; limit?: number } = {}): CheckoutRow[] {
    if (o.open) return this.db.prepare(`SELECT * FROM checkouts WHERE status IN (${OPEN.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(...OPEN) as unknown as CheckoutRow[];
    return this.db.prepare('SELECT * FROM checkouts ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.min(Math.max(o.limit ?? 50, 1), 200)) as unknown as CheckoutRow[];
  }
  /**
   * What of an open checkout waits on the operator (§7, Attention): leftover exceptions to decide (one per agent), every
   * handout in (render), handouts still missing close to expiry (go on or cancel), and a rendered prompt close to expiry.
   * The new-PC approval is added by the route, which knows the enrolment (CheckoutKeys.details).
   */
  needsOperator(c: CheckoutRow, now = this.now()): NeedsOperator[] {
    const out: NeedsOperator[] = [], H = this.handouts(c.id), soon = c.expires_at - now <= ATTENTION_SOON_MS;
    if (c.status === 'collecting') {
      for (const h of H) {
        if (h.status !== 'merged') continue;
        const waiting = (parse<MergedReport | null>(h.report, null)?.leftovers ?? []).filter((l) => !l.approved && !l.refused).length;
        if (waiting) out.push({ kind: 'leftovers', agent_id: h.agent_id, count: waiting, at: h.merged_at ?? h.updated_at });
      }
      const missing = H.filter((h) => h.status !== 'written').length;
      if (missing && soon) out.push({ kind: 'handouts_missing', count: missing, of: H.length, expires_at: c.expires_at, at: Math.max(c.created_at, c.expires_at - ATTENTION_SOON_MS) });
    } else if (c.status === 'ready') {
      out.push({ kind: 'handouts_complete', count: H.length - parse<string[]>(c.missing, []).length, of: H.length, at: c.ready_at ?? c.updated_at });
    } else if (c.status === 'rendered' && soon) {
      out.push({ kind: 'prompt_expiring', expires_at: c.expires_at, at: Math.max(c.rendered_at ?? c.updated_at, c.expires_at - ATTENTION_SOON_MS) });
    }
    return out;
  }

  // ───── the repo host allowlist (§8) ─────
  /** The allowlist in force and where it comes from: the operator's saved list, CONCLAVE_REPO_HOSTS, or the default. */
  repoHosts(): { hosts: string[]; source: 'settings' | 'env' | 'default' } {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(REPO_HOSTS_KEY) as { value: string } | undefined;
    const saved = row ? parse<unknown>(row.value, null) : null;
    const clean = (L: readonly unknown[]) => [...new Set(L.filter(validRepoHost).map((h) => h.toLowerCase()))];
    if (Array.isArray(saved)) return { hosts: clean(saved), source: 'settings' };
    if (this.seedRepoHosts) return { hosts: clean(this.seedRepoHosts), source: 'env' };
    return { hosts: [...DEFAULT_REPO_HOSTS], source: 'default' };
  }
  /** Save the allowlist (admin): exact host names, lower-cased and deduplicated; no wildcards, ports or leading '-'. An empty list allows no repo URL. */
  setRepoHosts(list: unknown, actor: Actor): ReturnType<Checkouts['repoHosts']> {
    if (!Array.isArray(list)) throw err('invalid_argument', 'repo_hosts: a list of host names such as github.com');
    if (list.length > REPO_HOSTS_MAX) throw err('invalid_argument', `repo_hosts: at most ${REPO_HOSTS_MAX} hosts`);
    const hosts: string[] = [];
    for (const x of list) {
      const h = typeof x === 'string' ? x.trim().toLowerCase() : '';
      if (!validRepoHost(h)) throw err('invalid_argument', `repo_hosts: ${JSON.stringify(String(x).slice(0, 80))} is not a host name (exact names only: no scheme, port, path, "*" or leading "-")`);
      if (!hosts.includes(h)) hosts.push(h);
    }
    const before = this.repoHosts();
    this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(REPO_HOSTS_KEY, JSON.stringify(hosts), this.now());
    this.audit.event(actor, 'checkout.repo_hosts_set', null, { before: before.hosts, after: hosts, was: before.source });
    return this.repoHosts();
  }
  /**
   * Render's first check (§8): every handout's repo URL must name a host on the allowlist as it stands now, so a host the
   * operator removed after the handout was written is refused here too. Refusals are audited.
   */
  assertRepoHosts(id: string, actor?: Actor, at: 'render' | 'pickup' = 'render'): void {
    const c = this.mustCheckout(id), allow = this.repoHosts().hosts, refused: { agent_id: string; host: string | null }[] = [];
    if (c.status !== 'ready' && c.status !== 'rendered') return; // render's own status check answers invalid_state
    for (const h of this.handouts(c.id)) {
      const b = parse<Record<string, unknown> | null>(h.body, null), r = isObj(b) && isObj(b.repo) ? b.repo : null;
      if (r && r.url !== undefined && r.url !== null && !hostAllowed(r.url, allow)) refused.push({ agent_id: h.agent_id, host: repoHost(r.url) });
    }
    if (!refused.length) return;
    const hosts = [...new Set(refused.map((x) => x.host ?? '(not a valid URL)'))], agents = refused.map((x) => x.agent_id);
    if (actor) this.audit.event(actor, 'checkout.repo_host_refused', { kind: 'checkout', id: c.id }, { at, agents, hosts });
    throw err('repo_host_not_allowed', `The handouts of ${agents.join(', ')} name a repo on a host that is not on the repo host allowlist (${hosts.join(', ')}). Add the host in Settings → Checkout if you trust it, then ${at === 'pickup' ? 'pick the key up again' : 'render again'}; or cancel the checkout.`, { agents, hosts });
  }

  // ───── guarded transitions ─────
  private move(id: string, from: readonly CheckoutStatus[], to: CheckoutStatus, set: Record<string, unknown> = {}): void {
    const cols = Object.keys(set);
    const r = this.db.prepare(`UPDATE checkouts SET status=?, updated_at=?${cols.map((k) => `, ${k}=?`).join('')} WHERE id=? AND status IN (${from.map(() => '?').join(',')})`)
      .run(to, this.now(), ...cols.map((k) => set[k] as never), id, ...from);
    if (!r.changes) throw err('conflict', `The checkout is no longer ${from.join(' or ')}. Reload it.`);
    this.audit.settle('checkout_overdue', id); // finished or cancelled: its overdue alert has nothing left to ask
  }
  private moveHandout(id: string, from: readonly HandoutStatus[], to: HandoutStatus, set: Record<string, unknown> = {}): void {
    const cols = Object.keys(set);
    const r = this.db.prepare(`UPDATE handouts SET status=?, updated_at=?${cols.map((k) => `, ${k}=?`).join('')} WHERE id=? AND status IN (${from.map(() => '?').join(',')})`)
      .run(to, this.now(), ...cols.map((k) => set[k] as never), id, ...from);
    if (!r.changes) throw err('conflict', `The handout is no longer ${from.join(' or ')}. Reload it.`);
  }
  /** Re-read inside a transaction: cancel, expiry and a new render cannot race a transition. */
  private requireStatus(id: string, allowed: readonly CheckoutStatus[]): CheckoutRow {
    const c = this.mustCheckout(id);
    if (!allowed.includes(c.status)) throw err('invalid_state', `The checkout is ${c.status}${allowed.length ? `; this needs it ${allowed.join(' or ')}` : ''}.`, { status: c.status });
    return c;
  }

  // ───── start (admin) ─────
  /** The PC the team runs on: the PC of its latest collected onboarding request, if it was onboarded. */
  private sourceMachine(teamId: string): string | null {
    return (this.db.prepare("SELECT machine_id FROM onboarding_requests WHERE team_id=? AND state='collected' ORDER BY collected_at DESC LIMIT 1").get(teamId) as { machine_id: string } | undefined)?.machine_id ?? null;
  }
  start(teamId: string, actor: Actor): ReturnType<Checkouts['view']> {
    const t = this.teams.mustTeam(teamId);
    if (t.status !== 'running' && t.status !== 'paused') throw err('invalid_state', `A ${t.status} team cannot be checked out.`);
    const members = this.teams.members(teamId);
    if (!members.length) throw err('invalid_state', 'The team has no members to move.');
    const id = tx(this.db, () => {
      const open = this.openFor(teamId);
      if (open) throw err('checkout_open', `The team already has an open checkout (${open.id}, ${open.status}).`, { checkout_id: open.id });
      // A delegated member runs elsewhere for its delegate: take it back first (F1).
      const away = this.delegations({ teamId });
      if (away.length) {
        const list = away.map((d) => ({ agent_id: d.agent_id!, label: this.keys.agent(d.agent_id!)?.label ?? d.agent_id!, delegate: this.personLabel(d.delegate_user_id), checkout_id: d.id }));
        throw err('checkout_conflict', `${list.map((x) => `${x.label} is with ${x.delegate}`).join('; ')}. Take ${list.length === 1 ? 'it' : 'them'} back first, then move the team.`, { delegated: list });
      }
      const pending = this.db.prepare("SELECT id FROM onboarding_requests WHERE team_id=? AND kind='add_agents' AND state IN ('submitted','needs_changes','approved')").get(teamId) as { id: string } | undefined;
      if (pending) throw err('invalid_state', `The team has a pending add-agents request (${pending.id}). Decide or cancel it first.`, { request_id: pending.id });
      const id = `cko_${randomToken(10)}`, now = this.now();
      this.db.prepare("INSERT INTO checkouts(id,team_id,status,source_machine_id,requested_by,created_at,updated_at,expires_at) VALUES (?,?,'collecting',?,?,?,?,?)")
        .run(id, teamId, this.sourceMachine(teamId), actor.id, now, now, now + EXPIRY_MS);
      const ins = this.db.prepare("INSERT INTO handouts(id,checkout_id,agent_id,status,created_at,updated_at) VALUES (?,?,?,'requested',?,?)");
      for (const m of members) ins.run(`hnd_${randomToken(10)}`, id, m.agent_id, now, now);
      const integration = this.integrationOf(teamId);
      for (const m of members) this.keys.notify(m.agent_id, 'checkout_requested', this.requestText(t, id, m.agent_id, integration), { kind: 'checkout', id });
      this.audit.event(actor, 'checkout.start', { kind: 'checkout', id }, { team: teamId, agents: members.length });
      return id;
    });
    this.teams.wake();
    this.changed(id);
    return this.view(id);
  }
  /** A person as a label (display name or username). */
  personLabel(userId: string | null): string {
    if (!userId) return 'nobody';
    const u = this.db.prepare('SELECT username, display_name FROM admin_users WHERE id=?').get(userId) as { username: string; display_name: string | null } | undefined;
    return u ? u.display_name || u.username : 'an unknown person';
  }
  /**
   * Start a one-agent checkout (docs/checkout.md §9 F1): the agent alone checkpoints and writes its handout, the rest of
   * the team keeps working. It refuses a team with an open team checkout and an agent with an open checkout
   * (`checkout_conflict`, `checkout_open`), and an agent that is the only coordinator of a team it is in. The team is the
   * one named, else the agent's first live team; the source PC is the PC its key is bound to, else the team's.
   * `delegate` and `render` are stored for Delegations (delegate.ts): who runs it, and the render the admin chose.
   */
  startAgent(agentId: string, o: { teamId?: string | null; delegateUserId: string; render: unknown }, actor: Actor): ReturnType<Checkouts['view']> {
    const a = this.keys.agent(agentId);
    if (!a || a.status === 'archived') throw err('not_found', 'agent not found');
    const mine = this.teams.teamsOf(agentId).filter((t) => t.status === 'running' || t.status === 'paused');
    const t = o.teamId ? mine.find((x) => x.id === o.teamId) : mine[0];
    if (!t) throw err('invalid_state', o.teamId ? `${a.label} is not a member of that team, or the team is not running or paused.` : `${a.label} is in no running or paused team, so there is nothing to resume it into.`);
    // A team's only coordinator would leave it without planning, asks and relays for the whole away window.
    for (const x of mine) {
      if (x.my_role !== 'coordinator') continue;
      if (!this.teams.members(x.id).some((m) => m.role === 'coordinator' && m.agent_id !== agentId)) {
        throw err('only_coordinator', `${a.label} is the only coordinator of team "${x.name}". Add another coordinator first, or move the whole team.`, { team_id: x.id });
      }
    }
    const id = tx(this.db, () => {
      for (const x of mine) {
        const open = this.openFor(x.id);
        if (open) throw err('checkout_conflict', `Team "${x.name}" has an open checkout (${open.id}, ${open.status}). Finish or cancel it first.`, { checkout_id: open.id });
      }
      const mineOpen = this.openForAgent(agentId);
      if (mineOpen) throw err('checkout_open', `${a.label} already has an open checkout (${mineOpen.id}, ${mineOpen.status}).`, { checkout_id: mineOpen.id });
      const m = this.teams.members(t.id).find((x) => x.agent_id === agentId)!;
      const bound = this.keys.credential(m.credential_id)?.bound_machine_id ?? null;
      const id = `cko_${randomToken(10)}`, now = this.now();
      this.db.prepare("INSERT INTO checkouts(id,team_id,status,source_machine_id,requested_by,created_at,updated_at,expires_at,scope,agent_id,delegate_user_id,delegate_render) VALUES (?,?,'collecting',?,?,?,?,?,'agent',?,?,?)")
        .run(id, t.id, bound ?? this.sourceMachine(t.id), actor.id, now, now, now + EXPIRY_MS, agentId, o.delegateUserId, JSON.stringify(o.render ?? null));
      this.db.prepare("INSERT INTO handouts(id,checkout_id,agent_id,status,created_at,updated_at) VALUES (?,?,?,'requested',?,?)").run(`hnd_${randomToken(10)}`, id, agentId, now, now);
      this.keys.notify(agentId, 'checkout_requested', this.requestText(t, id, agentId, this.integrationOf(t.id), this.personLabel(o.delegateUserId)), { kind: 'checkout', id });
      this.audit.event(actor, 'checkout.start', { kind: 'checkout', id }, { team: t.id, agents: 1, scope: 'agent', agent: agentId, delegate: o.delegateUserId });
      return id;
    });
    this.teams.wake();
    this.changed(id);
    return this.view(id);
  }
  private requestText(t: TeamRow, id: string, agentId: string, integration: string | null, delegate?: string): string {
    if (delegate) {
      return `The administrator is moving you alone to ${delegate}'s PC (checkout ${id}); the rest of team "${t.name}" keeps working. Stop taking new work and stop at a good checkpoint. Report checkout_progress `
        + `"checkpointing"; commit and merge your work into ${integration ? `your team's integration branch \`${integration}\`` : INTEGRATION_FALLBACK} under the normal landing rules (no force, no history rewrite), `
        + `or unapproved work into your own branch \`${this.memberBranch(id, agentId)}\` with its task left open (with no repository, report no_repo instead). Never push, and never commit local config. Remove your task worktrees, run the leftover check, `
        + `copy files you want kept to the vault, report "merged", then write your handout with checkout_handout. Your tasks stay yours and your reviews go to another reviewer while you move. ${RECONNECT_HINT}`;
    }
    return `The administrator is moving team "${t.name}" (checkout ${id}). Stop taking new work and stop at a good checkpoint. Report checkout_progress `
      + `"checkpointing"; commit and merge your work into ${integration ? `your team's integration branch \`${integration}\`` : INTEGRATION_FALLBACK} under the normal landing rules (no force, no history rewrite), `
      + `or unapproved work into your own branch \`${this.memberBranch(id, agentId)}\` with its task left open (with no repository, report no_repo instead). Never push, and never commit local config. Remove your task worktrees, run the leftover check, `
      + `copy files you want kept to the vault (the team pauses once every handout is written), report "merged", then write your handout with checkout_handout. ${RECONNECT_HINT}`;
  }
  /**
   * The team's integration branch where the hub knows it: the one named by the latest checkpoint report of any of the
   * team's checkouts (a checked ref). Null when no report names one.
   */
  integrationOf(teamId: string): string | null {
    const rows = this.db.prepare("SELECT h.report FROM handouts h JOIN checkouts c ON c.id=h.checkout_id WHERE c.team_id=? AND h.report IS NOT NULL ORDER BY h.merged_at DESC LIMIT 20").all(teamId) as { report: string }[];
    for (const r of rows) { const b = parse<MergedReport | null>(r.report, null)?.integration_branch; if (validRef(b)) return b; }
    return null;
  }
  /** The member's own branch for unapproved work: checkout/<id>-<short name made safe for a ref>. */
  memberBranch(checkoutId: string, agentId: string): string {
    return `checkout/${checkoutId}-${refSafe(this.keys.agent(agentId)?.label ?? agentId, agentId)}`;
  }
  /** The checkpoint steps for one member of an open checkout: its integration branch, its own branch and the repo hosts. */
  stepsFor(c: CheckoutRow, agentId: string): string {
    return checkpointSteps({ integration: this.integrationOf(c.team_id), branch: this.memberBranch(c.id, agentId), hosts: this.repoHosts().hosts });
  }

  // ───── agent side: checkpoint and handout ─────
  /** checkpointing: the agent stopped taking work and is checkpointing. Allowed from requested (or repeated). */
  checkpointing(agentId: string, checkoutId?: string): HandoutRow {
    return tx(this.db, () => {
      const { c, h } = this.mine(agentId, checkoutId);
      this.collecting(c);
      this.moveHandout(h.id, ['requested', 'checkpointing'], 'checkpointing', { checkpointing_at: h.checkpointing_at ?? this.now() });
      if (h.status !== 'checkpointing') this.audit.event({ kind: 'agent', id: agentId }, 'checkout.handout_checkpointing', { kind: 'handout', id: h.id }, { checkout: c.id });
      return this.handout(h.id)!;
    });
  }
  /**
   * merged: the agent's checkpoint report (§4 steps 2 and 4). Refs and heads are checked, and the leftover check must
   * report every kind: an empty list when cleaned up, else exceptions with a reason. A later report replaces it; an
   * exception the operator already approved stays approved only if it comes back word for word.
   */
  merged(agentId: string, report: unknown, checkoutId?: string): HandoutRow {
    return tx(this.db, () => {
      const { c, h } = this.mine(agentId, checkoutId);
      this.collecting(c);
      const r = this.checkReport(report, c.id);
      if (h.status === 'requested') throw err('invalid_state', 'Report checkout_progress "checkpointing" first, then report "merged" once your checkpoint is done.', { status: h.status });
      const prev = parse<MergedReport | null>(h.report, null)?.leftovers ?? [];
      const same = (a: Leftover, b: Leftover) => a.kind === b.kind && a.item === b.item && a.reason === b.reason;
      const leftovers = (r.leftovers ?? []).map((l) => ({ ...l, approved: prev.some((p) => p.approved && same(p, l)) }));
      const text = JSON.stringify({ ...r, leftovers });
      if (text.length > REPORT_MAX) throw err('too_large', `report: at most ${REPORT_MAX} characters of JSON`);
      this.moveHandout(h.id, ['checkpointing', 'merged'], 'merged', { report: text, merged_at: this.now() });
      this.audit.event({ kind: 'agent', id: agentId }, 'checkout.handout_merged', { kind: 'handout', id: h.id }, { checkout: c.id, worktrees_left: r.worktrees_left, clean: r.clean,
        leftovers: leftovers.length, kinds: [...new Set(leftovers.map((l) => l.kind))], checkout_branch: checkoutBranchOf(r, c.id), no_repo: r.no_repo !== undefined, replaced: h.status === 'merged' });
      return this.handout(h.id)!;
    });
  }
  /** Validate a merged report field by field (L2 from a model). Returns the stored shape; exceptions are never approved here. */
  private checkReport(report: unknown, checkoutId: string): MergedReport {
    if (!isObj(report)) throw err('invalid_argument', 'report: an object');
    const known = new Set(['integration_branch', 'integration_head', 'merge_commits', 'checkout_head', 'checkout_branch', 'no_repo', 'worktrees_left', 'clean', 'leftover_check']);
    for (const k of Object.keys(report)) if (!known.has(k)) throw err('invalid_argument', `report.${k}: not a report field (${[...known].join(', ')})`);
    if (typeof report.worktrees_left !== 'number' || !Number.isInteger(report.worktrees_left) || report.worktrees_left < 0) throw err('invalid_argument', 'report.worktrees_left: a whole number');
    if (typeof report.clean !== 'boolean') throw err('invalid_argument', 'report.clean: true or false');
    // Nothing to merge: a short reason in place of the branch, head and merge commits; never both.
    let noRepo: string | undefined;
    if (report.no_repo !== undefined) {
      noRepo = typeof report.no_repo === 'string' ? oneLine(report.no_repo) : '';
      if (!noRepo || noRepo.length > NO_REPO_MAX) throw err('invalid_argument', `report.no_repo: a short reason (at most ${NO_REPO_MAX} characters), for example "no repository" or "review-only"`);
      const both = ['integration_branch', 'integration_head', 'merge_commits', 'checkout_head', 'checkout_branch'].filter((k) => report[k] !== undefined && report[k] !== null);
      if (both.length) throw err('invalid_argument', `report.no_repo: give either no_repo or the branch and head, never both (also sent: ${both.join(', ')})`);
    } else {
      if (!validRef(report.integration_branch)) throw err('invalid_argument', 'report.integration_branch: a branch name (ref-name rules, no leading "-"), or no_repo with a short reason when there is nothing to merge');
      if (!validHead(report.integration_head)) throw err('invalid_argument', 'report.integration_head: the commit right after your merge, 40 hex characters, or no_repo with a short reason when there is nothing to merge');
    }
    const mc = report.merge_commits ?? [];
    if (!Array.isArray(mc) || mc.length > 100 || !mc.every(validHead)) throw err('invalid_argument', 'report.merge_commits: a list of at most 100 commits, 40 hex characters each');
    const ch = report.checkout_head ?? null;
    if (ch !== null && !validHead(ch)) throw err('invalid_argument', 'report.checkout_head: the tip of your checkout branch after your merge, 40 hex characters');
    const cb = report.checkout_branch ?? undefined;
    if (cb !== undefined && cb !== null) {
      if (ch === null) throw err('invalid_argument', 'report.checkout_branch: give checkout_head too (the tip of that branch)');
      if (!checkoutBranchAllowed(cb, checkoutId)) throw err('invalid_argument', `report.checkout_branch: a branch that starts with checkout/${checkoutId}, for example checkout/${checkoutId}-<your short name>`);
    }
    const lc = report.leftover_check;
    if (!isObj(lc)) throw err('invalid_argument', `report.leftover_check: an object with every kind (${LEFTOVER_KINDS.join(', ')}), each a list of exceptions {item, reason}; an empty list means cleaned up`);
    for (const k of Object.keys(lc)) if (!(LEFTOVER_KINDS as readonly string[]).includes(k)) throw err('invalid_argument', `report.leftover_check.${k}: not a kind (${LEFTOVER_KINDS.join(', ')})`);
    const leftovers: Leftover[] = [];
    for (const kind of LEFTOVER_KINDS) {
      const list = lc[kind];
      if (!Array.isArray(list)) throw err('invalid_argument', `report.leftover_check.${kind}: a list (empty when ${LEFTOVER_LABELS[kind]} are cleaned up)`);
      if (list.length > LEFTOVERS_PER_KIND) throw err('invalid_argument', `report.leftover_check.${kind}: at most ${LEFTOVERS_PER_KIND} exceptions`);
      for (const l of list) {
        const item = isObj(l) && typeof l.item === 'string' ? oneLine(l.item) : '', reason = isObj(l) && typeof l.reason === 'string' ? oneLine(l.reason) : '';
        if (!item || item.length > LEFTOVER_ITEM_MAX) throw err('invalid_argument', `report.leftover_check.${kind}: entries {item, reason}, item at most ${LEFTOVER_ITEM_MAX} characters`);
        if (!reason || reason.length > LEFTOVER_REASON_MAX) throw err('invalid_argument', `report.leftover_check.${kind}: every exception needs a reason (at most ${LEFTOVER_REASON_MAX} characters)`);
        leftovers.push({ kind, item, reason, approved: false });
      }
    }
    const base = { worktrees_left: report.worktrees_left, clean: report.clean, leftovers, checked: [...LEFTOVER_KINDS] };
    if (noRepo !== undefined) return { no_repo: noRepo, merge_commits: [], checkout_head: null, ...base };
    return { integration_branch: report.integration_branch as string, integration_head: report.integration_head as string, merge_commits: mc as string[], checkout_head: ch as string | null,
      ...(ch !== null && typeof cb === 'string' ? { checkout_branch: cb } : {}), ...base };
  }
  /**
   * The operator decides the exceptions an agent listed in its leftover check (§4 step 4): approve them (all, or the
   * named items), or refuse them with a note so the agent cleans up and reports again. The agent is told either way.
   * The decision is tied to the report the operator saw: `reportSha256` is the sha256 of that report (view()'s
   * report_sha256), and a report replaced since is refused with `conflict`. Named items match on kind and item.
   */
  approveLeftovers(checkoutId: string, agentId: string, reportSha256: string, actor: Actor, items?: LeftoverRef[]): HandoutRow {
    return this.decideLeftovers(checkoutId, agentId, actor, { approve: true, items, reportSha256 });
  }
  refuseLeftovers(checkoutId: string, agentId: string, reportSha256: string, note: string, actor: Actor, items?: LeftoverRef[]): HandoutRow {
    if (typeof note !== 'string' || !oneLine(note)) throw err('invalid_argument', 'note: say what to clean up');
    return this.decideLeftovers(checkoutId, agentId, actor, { approve: false, items, note: oneLine(note).slice(0, 500), reportSha256 });
  }
  private decideLeftovers(checkoutId: string, agentId: string, actor: Actor, o: { approve: boolean; items?: LeftoverRef[]; note?: string; reportSha256: string }): HandoutRow {
    if (typeof o.reportSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.reportSha256)) throw err('invalid_argument', 'report_sha256: the sha256 of the report you decided on (report_sha256 in the checkout view)');
    if (o.items !== undefined && (!Array.isArray(o.items) || !o.items.length || !o.items.every((i) => isObj(i) && (LEFTOVER_KINDS as readonly string[]).includes(i.kind as string) && typeof i.item === 'string'))) {
      throw err('invalid_argument', 'items: a list of {kind, item} from the report');
    }
    return tx(this.db, () => {
      const c = this.requireStatus(checkoutId, ['collecting']);
      const h = this.handouts(c.id).find((x) => x.agent_id === agentId);
      if (!h || h.status !== 'merged' || h.report === null) throw err('invalid_state', 'There is no merged report to decide for this agent.');
      if (sha256Hex(h.report) !== o.reportSha256) throw err('conflict', 'The agent reported again since you loaded the checkout. Reload it and decide on the new report.');
      const r = parse<MergedReport>(h.report, { worktrees_left: 0, clean: false });
      const all = r.leftovers ?? [];
      if (!all.length) throw err('invalid_state', 'The merged report lists no exceptions.');
      const key = (x: { kind: string; item: string }) => JSON.stringify([x.kind, x.item]);
      const pick = o.items ? new Set(o.items.map(key)) : null;
      if (o.items) for (const i of o.items) if (!all.some((l) => key(l) === key(i))) throw err('invalid_argument', `items: ${JSON.stringify(`${i.kind}: ${i.item}`.slice(0, 80))} is not an exception in this report`);
      const hit = (l: Leftover) => !pick || pick.has(key(l));
      const leftovers = all.map((l) => !hit(l) ? l : o.approve ? { ...l, approved: true, refused: null } : { ...l, approved: false, refused: o.note! });
      const res = this.db.prepare("UPDATE handouts SET report=?, updated_at=? WHERE id=? AND status='merged' AND report=?").run(JSON.stringify({ ...r, leftovers }), this.now(), h.id, h.report);
      if (!res.changes) throw err('conflict', 'The report changed. Reload it.');
      const decided = all.filter(hit).map((l) => `${l.kind}: ${l.item}`);
      this.audit.event(actor, o.approve ? 'checkout.leftovers_approved' : 'checkout.leftovers_refused', { kind: 'handout', id: h.id }, { checkout: c.id, agent: agentId, items: decided, ...(o.note ? { note: o.note } : {}) });
      const open = leftovers.filter((l) => !l.approved).length;
      this.keys.notify(agentId, 'checkout_leftovers', o.approve
        ? `The administrator approved ${decided.length} leftover exception(s) of checkout ${c.id}.${open ? ` ${open} still wait.` : ' Write your handout with checkout_handout if you have not yet.'}`
        : `The administrator refused ${decided.length} leftover exception(s) of checkout ${c.id} with the note ${JSON.stringify(o.note)}. Clean them up, then report checkout_progress "merged" again; checkout_status lists them.`);
      return this.handout(h.id)!;
    });
  }
  /** Whether the checkpoint is complete: merged, the leftover check reported, clean, no worktree left and every exception approved. Null when it is. */
  incomplete(h: HandoutRow): string | null {
    if (h.status !== 'merged' && h.status !== 'written') return 'Report "merged" with checkout_progress first.';
    const r = parse<MergedReport | null>(h.report, null);
    if (!r) return 'Report "merged" with checkout_progress first.';
    const missing = LEFTOVER_KINDS.filter((k) => !(r.checked ?? []).includes(k));
    if (missing.length) return `Run the leftover check and report every kind with checkout_progress "merged" (missing: ${missing.join(', ')}).`;
    if (!r.clean) return 'Your merged report shows uncommitted work. Commit and merge it (or list what must stay as an exception), then report again.';
    // A worktree that stays must be an exception the administrator approved.
    const keptWorktrees = (r.leftovers ?? []).filter((l) => l.kind === 'worktrees' && l.approved).length;
    if (r.worktrees_left > keptWorktrees) return `Your merged report shows ${r.worktrees_left} worktree(s) left. Remove them (or list one that must stay as an exception), then report again.`;
    const refused = (r.leftovers ?? []).filter((l) => l.refused);
    // Counts and kinds only: items and reasons are the agent's own text (L2); checkout_status lists them, labelled.
    const kinds = (ls: Leftover[]) => [...new Set(ls.map((l) => l.kind))].join(', ');
    if (refused.length) return `The administrator refused ${refused.length} leftover exception(s) (${kinds(refused)}) with the note ${JSON.stringify([...new Set(refused.map((l) => l.refused))].join(' / ').slice(0, 400))}. Clean them up, then report "merged" again.`;
    const open = (r.leftovers ?? []).filter((l) => !l.approved);
    if (open.length) return `The administrator has not approved ${open.length} of your leftover exception(s) yet (${kinds(open)}).`;
    return null;
  }
  /**
   * Write or replace the handout while collecting (§4): typed fields only (folder, repo, provider_was, notes). The hub adds
   * the checkpoint from the agent's merged report and the approved exceptions, so the handout cannot disagree with it.
   * When every handout is written the checkout is ready and the handouts are locked.
   */
  write(agentId: string, body: unknown, checkoutId?: string): HandoutRow {
    if (!isObj(body)) throw err('invalid_argument', 'body: an object');
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > NOTES_MAX)) throw err('invalid_argument', `body.notes: a string of at most ${NOTES_MAX} characters`);
    if (JSON.stringify(body).length > BODY_MAX) throw err('too_large', `body: at most ${BODY_MAX} characters of JSON`);
    const facts = checkBody(body);
    // The repo host allowlist (§8), checked here and again at render, only once the agent owns a handout still being
    // collected: an agent with no open checkout learns nothing about the list. The audit stays outside the tx.
    const url = isObj(facts.repo) ? facts.repo.url : undefined;
    if (url !== undefined && !hostAllowed(url, this.repoHosts().hosts)) {
      const { c } = this.mine(agentId, checkoutId);
      this.collecting(c);
      const host = repoHost(url);
      this.audit.event({ kind: 'agent', id: agentId }, 'checkout.repo_host_refused', { kind: 'checkout', id: c.id }, { at: 'handout', checkout: c.id, host });
      throw err('repo_host_not_allowed', `body.repo.url: the host ${JSON.stringify(host)} is not on this hub's repo host allowlist. Leave the url out, or ask the administrator to allow the host.`, { host });
    }
    const out = tx(this.db, () => {
      const { c, h } = this.mine(agentId, checkoutId);
      this.collecting(c);
      const why = this.incomplete(h);
      if (why) throw err('checkpoint_incomplete', why);
      const r = parse<MergedReport>(h.report, { worktrees_left: 0, clean: false });
      const checkpoint = checkpointOf(r, c.id);
      const exceptions = (r.leftovers ?? []).map(({ kind, item, reason }) => ({ kind, item, reason }));
      const text = JSON.stringify({ ...facts, checkpoint, ...(exceptions.length ? { exceptions } : {}) });
      if (text.length > BODY_MAX) throw err('too_large', `body: at most ${BODY_MAX} characters of JSON, with the checkpoint`);
      this.moveHandout(h.id, ['merged', 'written'], 'written', { body: text, written_at: this.now(), version: h.version + 1 });
      this.audit.event({ kind: 'agent', id: agentId }, h.status === 'written' ? 'checkout.handout_replaced' : 'checkout.handout_written', { kind: 'handout', id: h.id }, { checkout: c.id, version: h.version + 1, chars: text.length, sha256: sha256Hex(text) });
      if (this.handouts(c.id).every((x) => x.status === 'written')) this.toReady(c, sys);
      return this.handout(h.id)!;
    });
    this.teams.wake();
    this.changed(out.checkout_id);
    return out;
  }
  private mine(agentId: string, checkoutId?: string): { c: CheckoutRow; h: HandoutRow } {
    const m = this.handoutOf(agentId, checkoutId);
    // Membership is frozen while a checkout is open (guardMembership); this is the second check.
    if (!m || !this.teams.roleOf(m.c.team_id, agentId)) throw err('not_found', 'No checkout for your team: no open checkout asks for your handout.');
    return m;
  }
  /**
   * The agent tools' gate (called before every checkout_* tool): the agent's open checkout, then Teams.checkoutGate
   * (membership, lockdown, grant), which a team pause never refuses. Returns the checkout and handout.
   */
  gate(w: Who, checkoutId?: string): { c: CheckoutRow; h: HandoutRow } {
    const m = this.mine(w.agentId, checkoutId);
    this.teams.checkoutGate(w, m.c.team_id);
    return m;
  }
  private collecting(c: CheckoutRow): void {
    if (c.status !== 'collecting') throw err('invalid_state', `The checkout is ${c.status}: handouts are locked.`, { status: c.status });
  }

  // ───── ready: lock handouts and pause the team (F5) ─────
  /** The operator goes on without the missing handouts: each is built from the onboarding slot and the agent row, with no notes. */
  proceed(id: string, actor: Actor): ReturnType<Checkouts['view']> {
    tx(this.db, () => this.toReady(this.requireStatus(id, ['collecting']), actor));
    this.teams.wake();
    this.changed(id);
    return this.view(id);
  }
  private toReady(c: CheckoutRow, actor: Actor): void {
    const now = this.now(), missing: string[] = [];
    for (const h of this.handouts(c.id)) {
      if (h.status === 'written') continue;
      missing.push(h.agent_id);
      this.moveHandout(h.id, [h.status], 'written', { body: JSON.stringify(this.builtBody(h)), source: 'hub', written_at: now, version: h.version + 1 });
    }
    const t = this.teams.mustTeam(c.team_id);
    // A one-agent checkout pauses nothing: the agent alone is away from now until it resumes (F1).
    const pause = c.scope !== 'agent' && t.status === 'running';
    this.move(c.id, ['collecting'], 'ready', { ready_at: now, paused_team: pause ? 1 : 0, missing: JSON.stringify(missing) });
    if (pause) this.teams.pause(t.id, `checkout:${c.id}`, sys);
    if (c.scope === 'agent' && c.agent_id) this.teams.setAway(c.agent_id, c.expires_at);
    this.audit.event(actor, 'checkout.ready', { kind: 'checkout', id: c.id }, { team: c.team_id, missing, paused_team: pause, already_paused: t.status === 'paused' ? t.paused_reason : null });
  }
  /**
   * A missing handout: only what the hub knows locally (the onboarding slot's folder), no notes. Only a complete checkpoint
   * (merged, clean, every exception approved) goes in, as its checked refs and heads, never the leftovers; otherwise the
   * agent's work counts as unmerged on the source (`unmerged_work_on_source`): render leaves it off the push list, says so,
   * and moves to another user or PC only when the operator accepts that.
   */
  private builtBody(h: HandoutRow): Record<string, unknown> {
    const slot = this.db.prepare("SELECT folder, session_var FROM onboarding_slots WHERE agent_id=? AND role<>'rotate' AND status IN ('confirmed','issued') ORDER BY created_at DESC LIMIT 1").get(h.agent_id) as { folder: string; session_var: string } | undefined;
    const a = this.keys.agent(h.agent_id);
    const r = h.status === 'merged' && this.incomplete(h) === null ? parse<MergedReport | null>(h.report, null) : null;
    const ok = !!r && (r.no_repo !== undefined
      ? typeof r.no_repo === 'string' && !!r.no_repo && r.no_repo.length <= NO_REPO_MAX
      : validRef(r.integration_branch) && validHead(r.integration_head) && (r.merge_commits ?? []).every(validHead) && (r.checkout_head == null || validHead(r.checkout_head))
        && (r.checkout_branch === undefined || checkoutBranchAllowed(r.checkout_branch, h.checkout_id)));
    const checkpoint = ok ? checkpointOf(r!, h.checkout_id) : null;
    return { built_by: 'hub', folder: slot?.folder && validFolder(slot.folder) ? slot.folder : null, provider_was: { model: a?.model_label ?? null }, notes: '',
      ...(checkpoint ? { checkpoint } : {}), unmerged_work_on_source: !checkpoint };
  }

  // ───── render, restoring, consume, restored ─────
  /** Record a render: target, choices, request and a hash of each handout body. A new render supersedes the earlier one and resets expiry. */
  recordRender(id: string, r: { target_machine_id: string | null; request_id: string | null; choices: unknown }, actor: Actor): CheckoutRow {
    // Render runs inside CheckoutKeys' own transaction: the change is told only if that commits (expect rendered).
    this.changed(id, ['rendered']);
    return tx(this.db, () => {
      const c = this.requireStatus(id, ['ready', 'rendered']);
      const hashes: Record<string, string> = {};
      for (const h of this.handouts(c.id)) if (h.body !== null) hashes[h.agent_id] = sha256Hex(h.body);
      const now = this.now();
      this.move(c.id, [c.status], 'rendered', { target_machine_id: r.target_machine_id, request_id: r.request_id, choices: JSON.stringify(r.choices ?? null),
        handout_hashes: JSON.stringify(hashes), rendered_at: now, expires_at: now + EXPIRY_MS, pc_confirmed_at: null, pc_refused_at: null });
      if (c.scope === 'agent' && c.agent_id) this.db.prepare('UPDATE team_members SET away_until=? WHERE agent_id=? AND removed_at IS NULL AND away_until IS NOT NULL').run(now + EXPIRY_MS, c.agent_id);
      if (c.status === 'rendered') this.audit.event(actor, 'checkout.render_superseded', { kind: 'checkout', id: c.id }, { previous_request: c.request_id, previous_target: c.target_machine_id });
      this.audit.event(actor, 'checkout.rendered', { kind: 'checkout', id: c.id }, { target: r.target_machine_id, request: r.request_id, handout_hashes: hashes });
      return this.checkout(c.id)!;
    });
  }
  /** The onboarding confirm on the target: the old sessions stop, the new agents start. */
  markRestoring(id: string, actor: Actor): CheckoutRow {
    this.changed(id, ['restoring', 'restored']);
    return tx(this.db, () => {
      this.move(id, ['rendered'], 'restoring', { restoring_at: this.now() });
      this.audit.event(actor, 'checkout.restoring', { kind: 'checkout', id });
      return this.checkout(id)!;
    });
  }
  /**
   * An accepted checkout_resume: the handout moves to consumed once, its body is returned and marked for the deferred purge (D63) in the same transaction.
   * The checkout status is re-checked here. A reuse move has no confirm, so the first resume moves it from rendered to restoring.
   * When every handout is consumed the checkout is restored. `verify` (checkout_resume's credential check) runs inside the
   * transaction, after the status re-check; a refusal it returns is audited as checkout.resume_refused.
   */
  consume(handoutId: string, newCredentialId: string | null, actor: Actor, verify?: (c: CheckoutRow, h: HandoutRow) => { reason: string; message: string } | null): { body: unknown; restored: boolean } {
    let refused: string | null = null;
    let detail: Record<string, unknown> = {};
    const run = () => tx(this.db, () => {
      const h = this.handout(handoutId);
      if (!h) throw err('not_found', 'handout not found');
      if (h.status === 'consumed') { refused = 'consumed'; throw err('handout_consumed', 'This handout was already used.'); }
      const c = this.requireStatus(h.checkout_id, ['rendered', 'restoring']);
      if (h.status !== 'written' || h.body === null) throw err('invalid_state', `The handout is ${h.status}.`);
      const no = verify?.(c, h) ?? null;
      if (no) { refused = no.reason; detail = { agent: h.agent_id, credential: newCredentialId }; throw err('resume_refused', no.message, { reason: no.reason }); }
      const hash = parse<Record<string, string>>(c.handout_hashes, {})[h.agent_id];
      if (!hash || hash !== sha256Hex(h.body)) {
        refused = 'hash_mismatch';
        throw err('handout_changed', 'The handout does not match the one rendered. Ask the administrator to render again.');
      }
      if (c.status === 'rendered') { this.move(c.id, ['rendered'], 'restoring', { restoring_at: this.now() }); this.audit.event(actor, 'checkout.restoring', { kind: 'checkout', id: c.id }, { by: 'first_resume' }); }
      // The body waits for its vault page (D63): purge_due marks it, the purge clears it once the page is written.
      this.moveHandout(h.id, ['written'], 'consumed', { purge_due: this.now(), consumed_at: this.now(), new_credential_id: newCredentialId });
      this.audit.event(actor, 'checkout.handout_consumed', { kind: 'handout', id: h.id }, { checkout: c.id, agent: h.agent_id, credential: newCredentialId });
      // The agent runs on the target now: it is no longer away (F1).
      if (c.scope === 'agent') this.teams.setAway(h.agent_id, null);
      const restored = this.handouts(c.id).every((x) => x.status === 'consumed');
      if (restored) this.toRestored(this.checkout(c.id)!, actor);
      return { body: JSON.parse(h.body) as unknown, restored };
    });
    let out: { body: unknown; restored: boolean };
    try { out = run(); } catch (e) {
      // Recorded after the rollback, so the refusal stays in the audit log.
      if (refused) this.audit.event(actor, 'checkout.resume_refused', { kind: 'handout', id: handoutId }, { reason: refused, ...detail });
      throw e;
    }
    this.teams.wake();
    const hc = this.handout(handoutId);
    if (hc) this.changed(hc.checkout_id);
    return out;
  }

  // ───── agent tools: status and resume ─────
  /**
   * checkout_status: whether an open checkout asks for this agent's handout, where its checkpoint stands, what is left and
   * the checkpoint steps (L0). Null when no open checkout asks for it.
   */
  status(w: Who, checkoutId?: string) {
    const m = this.handoutOf(w.agentId, checkoutId);
    if (!m) return null;
    this.teams.checkoutGate(w, m.c.team_id);
    const { c, h } = m, t = this.teams.mustTeam(c.team_id);
    const r = parse<MergedReport | null>(h.report, null);
    const why = c.status === 'collecting' && (h.status === 'merged' || h.status === 'written') ? this.incomplete(h) : null;
    const team = this.handouts(c.id).map((x) => ({ agent_id: x.agent_id, status: x.status, me: x.agent_id === w.agentId }));
    return {
      checkout: { id: c.id, status: c.status, team_id: c.team_id, team: t.name, expires_at: c.expires_at,
        // The member's own branch for unapproved work; the integration branch where the hub knows it; the repo hosts a handout may name.
        checkout_branch: this.memberBranch(c.id, w.agentId), integration_branch: this.integrationOf(c.team_id), repo_hosts: this.repoHosts().hosts },
      handout: { id: h.id, status: h.status, version: h.version, written_at: h.written_at, sha256: h.body ? sha256Hex(h.body) : null,
        checkpoint: r ? { integration_branch: r.integration_branch, integration_head: r.integration_head, merge_commits: r.merge_commits ?? [], checkout_head: r.checkout_head ?? null,
          checkout_branch: checkoutBranchOf(r, c.id), ...(r.no_repo !== undefined ? { no_repo: r.no_repo } : {}), worktrees_left: r.worktrees_left, clean: r.clean } : null,
        leftovers: (r?.leftovers ?? []).map((l) => ({ kind: l.kind, item: l.item, reason: l.reason, state: l.approved ? 'approved' : l.refused ? 'refused' : 'waiting', ...(l.refused ? { note: l.refused } : {}) })),
        incomplete: why },
      team, next: this.nextStep(c, h, why), steps: this.stepsFor(c, w.agentId), does_not_move: DOES_NOT_MOVE,
    };
  }
  private nextStep(c: CheckoutRow, h: HandoutRow, why: string | null): string {
    if (c.status === 'collecting') {
      // Until the handout is written, the vault copy is still possible: say so with every step (the pause at ready stops it).
      const vault = ` Before your handout: ${VAULT_COPY_STEP}`;
      if (h.status === 'requested') return `Stop taking new work, stop at a good checkpoint and report checkout_progress "checkpointing" (steps 1-2).${vault}`;
      if (h.status === 'checkpointing') return `Merge your work (or put unapproved work on your checkout branch, or report no_repo with nothing to merge), remove your worktrees, run the leftover check, then report checkout_progress "merged" (steps 2-6).${vault}`;
      if (h.status === 'merged') return `${why ?? 'Write your handout with checkout_handout (step 7).'}${vault}`;
      return 'Your handout is written. You may replace it while the checkout is collecting; otherwise stop and wait, and do not start work.';
    }
    if (c.status === 'ready') return 'Handouts are locked and the team is paused. Do not start work; the administrator chooses where the team goes.';
    if (h.status === 'consumed') return 'You resumed on the target. Carry on with session_whoami, team_info, task_list, message_read, team_decisions and bp_read.';
    return 'The administrator rendered the move. This session stops when the restore on the target confirms; do not start work here. On the target, the moved agent calls checkout_resume first.';
  }
  /**
   * checkout_resume (§5, §7, F2 C): accepted only from a login of the key the restore issued for this agent (new_credential_id,
   * set at confirm) made after confirm, or, for a same-user reuse move, a login of the agent's key made after render. Checks the
   * render hash, returns the handout once, consumes it and marks the body for the deferred purge in one transaction. The client name is audit only.
   */
  resume(w: Who, o: { client?: string | null; app?: string | null } = {}): { checkout_id: string; team_id: string; body: unknown; restored: boolean } {
    // The open checkout decides: one still collecting or ready is not resumable yet, even if an older move was consumed.
    const open = this.handoutOf(w.agentId);
    if (open && (open.c.status === 'collecting' || open.c.status === 'ready')) {
      throw err('invalid_state', `The checkout is ${open.c.status}: checkout_resume is for the moved agent on the target, once the administrator has rendered the move and the restore has run.`, { status: open.c.status });
    }
    const h = open?.h ?? this.db.prepare("SELECT h.* FROM handouts h JOIN checkouts c ON c.id=h.checkout_id WHERE h.agent_id=? AND c.status='restored' ORDER BY c.restored_at DESC, h.rowid DESC LIMIT 1")
      .get(w.agentId) as unknown as HandoutRow | undefined;
    const actor: Actor = { kind: 'agent', id: w.agentId };
    if (!h) throw err('not_found', 'No checkout has a handout for you to resume.');
    if (h.status === 'consumed') {
      this.audit.event(actor, 'checkout.resume_refused', { kind: 'handout', id: h.id }, { reason: 'consumed', agent: h.agent_id, credential: w.credId });
      throw err('handout_consumed', 'This handout was already used. Carry on with session_whoami, team_info and task_list.');
    }
    const c0 = this.checkout(h.checkout_id)!;
    this.teams.checkoutGate(w, c0.team_id);
    const out = this.consume(h.id, w.credId, actor, (c, hh) => this.resumeRefusal(c, hh, w));
    this.audit.event(actor, 'checkout.resumed', { kind: 'checkout', id: c0.id }, { agent: w.agentId, credential: w.credId, app: o.app ?? null, client: o.client ?? null, restored: out.restored });
    return { checkout_id: c0.id, team_id: c0.team_id, ...out };
  }
  private resumeRefusal(c: CheckoutRow, h: HandoutRow, w: Who): { reason: string; message: string } | null {
    const tok = this.db.prepare('SELECT t.session_credential_id, t.created_at, a.machine_id FROM session_tokens t JOIN credentials a ON a.id=t.app_credential_id WHERE t.token_hash=?')
      .get(w.tokenHash) as { session_credential_id: string; created_at: number; machine_id: string | null } | undefined;
    if (!tok || tok.session_credential_id !== w.credId) return { reason: 'no_login', message: 'Log in with your session key, then call checkout_resume.' };
    // The login must come through an app key of the PC the move targets, never a session on another PC.
    if (!c.target_machine_id || tok.machine_id !== c.target_machine_id) return { reason: 'other_machine', message: 'checkout_resume is accepted only from a login on the PC the move targets.' };
    const ch = parse<{ rotate_agent_keys?: boolean } | null>(c.choices, null);
    if (ch?.rotate_agent_keys === false) {
      // Reuse (same user only): the same key goes on; only a login made after render counts (§5).
      const m = this.teams.members(c.team_id).find((x) => x.agent_id === h.agent_id);
      if (!m || m.credential_id !== w.credId) return { reason: 'other_credential', message: 'checkout_resume is accepted only from the key this agent moved with.' };
      if (tok.created_at < (c.rendered_at ?? Infinity)) return { reason: 'login_before_render', message: 'This login was made before the move was rendered. Log in again with your session key, then call checkout_resume.' };
      return null;
    }
    // Rotation: the successor issued at pickup and confirmed by the restore, and a login made after confirm.
    if (!h.new_credential_id) return { reason: 'not_confirmed', message: 'The restore has not confirmed this agent yet. Run the restore prompt to the end, then start the agent with its new key.' };
    if (h.new_credential_id !== w.credId) return { reason: 'old_credential', message: 'checkout_resume is accepted only from the key the restore issued for this move. Start the agent on the target with its new key.' };
    if (tok.created_at < (c.restoring_at ?? Infinity)) return { reason: 'login_before_confirm', message: 'This login was made before the restore confirmed. Log in again with your new session key, then call checkout_resume.' };
    return null;
  }
  private toRestored(c: CheckoutRow, actor: Actor): void {
    this.move(c.id, ['restoring'], 'restored', { restored_at: this.now() });
    this.db.prepare('UPDATE handouts SET purge_due=COALESCE(purge_due, ?) WHERE checkout_id=? AND body IS NOT NULL').run(this.now(), c.id);
    this.onRestored?.(c);
    this.liftPause(c);
    if (c.scope === 'agent' && c.agent_id) {
      const now = this.now();
      this.teams.setAway(c.agent_id, null);
      // The agent left its earlier delegate: that delegation ends here. One to the admin ("Delegate back") ends at once.
      this.db.prepare("UPDATE checkouts SET released_at=?, released_by=?, release_reason='moved_again', updated_at=? WHERE scope='agent' AND agent_id=? AND id<>? AND status='restored' AND released_at IS NULL")
        .run(now, actor.id, now, c.agent_id, c.id);
      const role = c.delegate_user_id ? (this.db.prepare('SELECT role FROM admin_users WHERE id=?').get(c.delegate_user_id) as { role: string } | undefined)?.role : null;
      if (role !== 'member') this.db.prepare("UPDATE checkouts SET released_at=?, released_by=?, release_reason='back_with_admin', updated_at=? WHERE id=?").run(now, actor.id, now, c.id);
      this.onDelegationEnded?.(c.agent_id, actor);
    }
    this.audit.event(actor, 'checkout.restored', { kind: 'checkout', id: c.id }, { team: c.team_id, ...(c.scope === 'agent' ? { scope: 'agent', agent: c.agent_id, delegate: c.delegate_user_id } : {}) });
  }
  /**
   * Take back a restored delegation (delegate.ts): the delegation ends and the ceiling with it. The caller revokes the key.
   * Guarded: only a restored, unreleased one-agent checkout.
   */
  release(id: string, reason: string, actor: Actor): void {
    const now = this.now();
    const r = this.db.prepare("UPDATE checkouts SET released_at=?, released_by=?, release_reason=?, updated_at=? WHERE id=? AND scope='agent' AND status='restored' AND released_at IS NULL").run(now, actor.id, reason, now, id);
    if (!r.changes) throw err('conflict', 'This delegation has already ended. Reload it.');
    const c = this.mustCheckout(id);
    if (c.agent_id) this.onDelegationEnded?.(c.agent_id, actor);
    this.changed(id);
  }

  // ───── cancel, expiry, team end ─────
  /**
   * Cancel: mark the bodies for the deferred purge, revoke unconfirmed keys, reinstate old sessions, lift the pause. The checkpoint merges stay.
   * While restoring, some agents may already run on the target: the team stays paused unless `force`, so the source copies
   * do not run beside them. The operator then resumes by hand, or uses finish instead.
   */
  cancel(id: string, note: string | null, actor: Actor, opts: { force?: boolean } = {}): ReturnType<Checkouts['view']> {
    tx(this.db, () => {
      const c = this.requireStatus(id, OPEN);
      this.end(c, 'cancelled', note ?? 'cancelled', actor, c.status !== 'restoring' || !!opts.force);
    });
    this.teams.wake();
    this.changed(id);
    return this.view(id);
  }
  /**
   * Finish by hand (§3): a checkout overdue in restoring is marked restored. Handouts not resumed are removed, bodies marked for the deferred purge,
   * old keys revoked and the pause lifted, so the team runs on the target.
   */
  finish(id: string, actor: Actor): ReturnType<Checkouts['view']> {
    tx(this.db, () => {
      const c = this.requireStatus(id, ['restoring']);
      if (!c.overdue_at) throw err('invalid_state', 'The checkout is still restoring within its time. Finish it once it is overdue, or let the agents resume.');
      const now = this.now(), left = this.handouts(c.id).filter((h) => h.status !== 'consumed').map((h) => h.agent_id);
      this.db.prepare("UPDATE handouts SET status='removed', purge_due=COALESCE(purge_due, ?), removed_at=?, updated_at=? WHERE checkout_id=? AND status NOT IN ('consumed','removed')").run(now, now, now, c.id);
      this.audit.event(actor, 'checkout.finished', { kind: 'checkout', id: c.id }, { team: c.team_id, not_resumed: left });
      this.toRestored(c, actor);
    });
    this.teams.wake();
    this.changed(id);
    return this.view(id);
  }
  private end(c: CheckoutRow, how: 'cancelled' | 'expired', reason: string, actor: Actor, lift = true): void {
    const now = this.now();
    this.move(c.id, [c.status], how, { ended_at: now, end_reason: reason.slice(0, 500) });
    // Status changes as before; the bodies wait for their vault pages (D63, the purge in mirror.ts clears them).
    this.db.prepare("UPDATE handouts SET status='removed', removed_at=?, updated_at=? WHERE checkout_id=? AND status NOT IN ('consumed','removed')").run(now, now, c.id);
    this.db.prepare('UPDATE handouts SET purge_due=COALESCE(purge_due, ?) WHERE checkout_id=? AND body IS NOT NULL').run(now, c.id);
    this.onEnded?.(c, how);
    if (lift) this.liftPause(c);
    const t = this.teams.team(c.team_id);
    if (c.scope === 'agent' && c.agent_id) {
      // One agent: it is back on its source PC with its old key (unless it already resumed on the target), and no longer away.
      this.teams.setAway(c.agent_id, null);
      this.db.prepare('UPDATE checkouts SET released_at=COALESCE(released_at, ?), release_reason=COALESCE(release_reason, ?) WHERE id=?').run(now, how, c.id);
      this.onDelegationEnded?.(c.agent_id, actor);
      const resumed = this.handouts(c.id).some((h) => h.status === 'consumed');
      if (t && t.status !== 'done' && t.status !== 'stopped' && !resumed) {
        this.keys.notify(c.agent_id, 'checkout_ended', `Your move (checkout ${c.id}) was ${how}. Your checkpoint merges stay; open tasks go on from your checkout branch where you used one. Carry on in this folder.`);
      }
    } else if (t && t.status !== 'done' && t.status !== 'stopped') {
      const text = lift
        ? `The move of team "${t.name}" (checkout ${c.id}) was ${how}. Your checkpoint merges stay; open tasks go on from your checkout branch (checkout/${c.id}, or checkout/${c.id}-<your short name>) where you used one. Carry on in this folder.`
        : `The move of team "${t.name}" (checkout ${c.id}) was ${how} while restoring. The team stays paused until the administrator resumes it. Do not start work.`;
      for (const m of this.teams.members(c.team_id)) this.keys.notify(m.agent_id, 'checkout_ended', text);
    }
    this.audit.event(actor, `checkout.${how}`, { kind: 'checkout', id: c.id }, { team: c.team_id, from: c.status, reason, pause_kept: !lift && !!c.paused_team });
  }
  /** Resume the team only if this checkout paused it and it is still paused for it. */
  private liftPause(c: CheckoutRow): void {
    if (!c.paused_team) return;
    const t = this.teams.team(c.team_id);
    if (t && t.status === 'paused' && t.paused_reason === `checkout:${c.id}`) this.teams.resume(t.id, sys);
  }
  /**
   * The expiry sweep (Teams.tick): past-due checkouts before restoring expire. One that is restoring keeps its confirmed keys
   * and raises an Attention item once instead; the operator cancels or finishes it by hand.
   */
  sweep(now = this.now()): { expired: string[]; overdue: string[] } {
    const due = this.db.prepare("SELECT * FROM checkouts WHERE status IN ('collecting','ready','rendered','restoring') AND expires_at<=? AND overdue_at IS NULL").all(now) as unknown as CheckoutRow[];
    const expired: string[] = [], overdue: string[] = [];
    for (const c of due) {
      try {
        this.atomic(() => {
          const cur = this.checkout(c.id)!;
          if (!OPEN.includes(cur.status) || cur.expires_at > now || cur.overdue_at) return;
          if (cur.status === 'restoring') {
            this.db.prepare('UPDATE checkouts SET overdue_at=?, updated_at=? WHERE id=? AND status=?').run(now, now, cur.id, 'restoring');
            this.audit.alert('warning', 'checkout_overdue', cur.id, { team: cur.team_id, team_id: cur.team_id, status: cur.status, expired_at: cur.expires_at });
            this.audit.event(sys, 'checkout.overdue', { kind: 'checkout', id: cur.id }, { team: cur.team_id });
            overdue.push(cur.id);
          } else {
            this.end(cur, 'expired', 'expired', sys);
            expired.push(cur.id);
            this.changed(cur.id, ['expired']); // runs after the sweep's (or the caller's) transaction; nothing if it rolled back
          }
        });
      } catch (e) { this.audit.event(sys, 'checkout.sweep_failed', { kind: 'checkout', id: c.id }, { error: (e as Error).message.slice(0, 300) }); }
    }
    if (expired.length || overdue.length) this.teams.wake();
    return { expired, overdue };
  }
  /**
   * All or nothing, also inside a caller's transaction: tx() is flat when nested, so a swallowed sweep failure would
   * otherwise commit half an expiry with the caller's transaction. A savepoint rolls back just this checkout's writes.
   */
  private atomic<T>(fn: () => T): T {
    if (!this.db.isTransaction) return tx(this.db, fn);
    const name = `cko_${++this.sp}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const r = fn(); this.db.exec(`RELEASE ${name}`); return r; }
    catch (e) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw e; }
  }
  private sp = 0;
  /** Membership is frozen while a checkout is open: a recruit would get no handout, a removed member's handout would block ready. */
  private guardMembership(teamId: string): void {
    const c = this.openFor(teamId);
    if (c) throw err('checkout_open', `Team membership cannot change during checkout ${c.id} (${c.status}). Cancel or finish the checkout first.`, { checkout_id: c.id });
  }
  private guardResume(t: TeamRow): void {
    const c = this.openFor(t.id);
    if (c && HELD.includes(c.status)) throw err('checkout_open', `The team is held by checkout ${c.id} (${c.status}). Cancel the checkout to resume the team here.`, { checkout_id: c.id });
  }
  /** A team that is stopped or completes ends its open checkout (inside the ending transaction). */
  private teamEnded(teamId: string): void {
    const c = this.openFor(teamId);
    if (c) { this.end(c, 'cancelled', 'team_ended', sys); this.changed(c.id, ['cancelled']); }
    // An open one-agent checkout into this team has nothing left to resume into.
    for (const a of this.db.prepare(`SELECT * FROM checkouts WHERE scope='agent' AND team_id=? AND status IN (${OPEN.map(() => '?').join(',')})`).all(teamId, ...OPEN) as unknown as CheckoutRow[]) {
      this.end(a, 'cancelled', 'team_ended', sys); this.changed(a.id, ['cancelled']);
    }
  }
}

/**
 * The handout's typed fields (§4 table): folder, repo, provider_was and notes. Anything else is refused, so nothing a model
 * writes can pose as hub data; the checkpoint is added by the hub from the merged report.
 */
export function checkBody(body: Record<string, unknown>): Record<string, unknown> {
  const known = ['folder', 'repo', 'provider_was', 'notes'];
  for (const k of Object.keys(body)) {
    if (k === 'checkpoint') throw err('invalid_argument', 'body.checkpoint: the hub takes it from your merged report; leave it out');
    if (!known.includes(k)) throw err('invalid_argument', `body.${k}: not a handout field (${known.join(', ')})`);
  }
  if (!validFolder(body.folder)) throw err('invalid_argument', 'body.folder: your folder name under the project root ([A-Za-z0-9._-], at most 64 characters)');
  const out: Record<string, unknown> = { folder: body.folder };
  if (body.repo !== undefined) {
    const r = body.repo;
    if (!isObj(r)) throw err('invalid_argument', 'body.repo: {remote_name, url, clone_folder}');
    for (const k of Object.keys(r)) if (!['remote_name', 'url', 'clone_folder'].includes(k)) throw err('invalid_argument', `body.repo.${k}: not a repo field (remote_name, url, clone_folder)`);
    if (r.remote_name !== undefined && !validRemote(r.remote_name)) throw err('invalid_argument', 'body.repo.remote_name: a remote name such as origin');
    if (r.url !== undefined && !validUrl(r.url)) throw err('invalid_argument', 'body.repo.url: an https, ssh or scp-like remote URL');
    if (r.url !== undefined && r.remote_name === undefined) throw err('invalid_argument', 'body.repo.remote_name: needed with url');
    if (r.clone_folder !== undefined && !validFolder(r.clone_folder)) throw err('invalid_argument', 'body.repo.clone_folder: a folder name ([A-Za-z0-9._-], at most 64 characters)');
    out.repo = { ...(r.remote_name !== undefined ? { remote_name: r.remote_name } : {}), ...(r.url !== undefined ? { url: r.url } : {}), ...(r.clone_folder !== undefined ? { clone_folder: r.clone_folder } : {}) };
  }
  if (body.provider_was !== undefined) {
    const p = body.provider_was;
    if (!isObj(p)) throw err('invalid_argument', 'body.provider_was: {provider, model, effort, permissions}');
    for (const k of Object.keys(p)) if (!['provider', 'model', 'effort', 'permissions'].includes(k)) throw err('invalid_argument', `body.provider_was.${k}: not a provider field (provider, model, effort, permissions)`);
    if (!(PROVIDERS as readonly string[]).includes(p.provider as string)) throw err('invalid_argument', `body.provider_was.provider: ${PROVIDERS.join(' or ')}`);
    if (p.model !== undefined && p.model !== null && !validModel(p.model)) throw err('invalid_argument', 'body.provider_was.model: up to 80 letters, digits, dot, dash, colon or brackets');
    if (p.effort !== undefined && p.effort !== null && (typeof p.effort !== 'string' || !/^[a-z]{1,20}$/.test(p.effort))) throw err('invalid_argument', 'body.provider_was.effort: a word such as low, medium or high');
    if (p.permissions !== undefined && !(PERMISSIONS as readonly string[]).includes(p.permissions as string)) throw err('invalid_argument', `body.provider_was.permissions: one of ${PERMISSIONS.join(', ')}`);
    out.provider_was = { provider: p.provider, ...(p.model != null ? { model: p.model } : {}), ...(p.effort != null ? { effort: p.effort } : {}), ...(p.permissions !== undefined ? { permissions: p.permissions } : {}) };
  }
  out.notes = typeof body.notes === 'string' ? body.notes : '';
  return out;
}
