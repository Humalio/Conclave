/**
 * Key collection (docs/onboarding.md#collect-on-a-pc-the-codex-wake-picks-up-a-routine-rotation). For a routine rotation of
 * a session key that has logged in, the operator can arm a collection instead of a key prompt: the Codex wake on the key's
 * PC polls with the agent's app key, picks the new key up through POST /onboard/key-pickup with a collect_id, writes it
 * into that agent's keys file and confirms. A collection holds no code and no secret: the key is made at pickup.
 *
 * It is bound to the key's PC, to the one app key the old key last logged in through, and to the wake instance that last
 * polled for it. A second collector (another instance for the variable, or one instance from two addresses) voids it and
 * raises key.collect_conflict; so does a pickup from another instance, and a login with the collected key through any
 * other app key, on that PC or another. A pickup not confirmed in 10 minutes, or confirmed as not written, voids the new
 * secret; an open collection expires after 24 hours.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { BoundElsewhereError, KeyError, SESSION_VAR_RE, type Credential, type Keys } from './keys.js';
import { randomToken } from '../util/crypto.js';
import type { Lockdown } from '../safety/lockdown.js';

export const COLLECT_TTL_MS = 24 * 60 * 60 * 1000;
export const COLLECT_CONFIRM_MS = 10 * 60 * 1000;
/** The wake must have polled within this time for Collect to be offered. */
export const WAKE_SEEN_MS = 7 * 24 * 60 * 60 * 1000;
/** Login records and polls this old tell the hub whether an app key serves more than one agent; polls are kept this long. */
export const SHARED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A second instance, or a second address for one instance, within this time of a collection is a second collector. */
export const CONFLICT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Poll answers: seconds until the next poll, quicker while a collection is open. */
export const POLL_IDLE_S = 60, POLL_OPEN_S = 15;
const INSTANCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const COLLECT_RE = /^kcl_[a-z2-7]{16}$/;
const sys: Actor = { kind: 'system', id: null };

export type OfferReason = 'not_session_key' | 'inactive' | 'never_signed_in' | 'app_inactive' | 'no_pc' | 'not_on_pc' | 'shared_app_key' | 'no_wake' | 'wake_stale' | 'two_instances';
export interface Offer {
  ok: boolean;
  reason: OfferReason | null;
  /** One plain line for the Rotate sheet when Collect is not offered. */
  message: string | null;
  pc: { id: string; name: string } | null;
  session_var: string | null;
  app_credential_id: string | null;
  instance_id: string | null;
  last_seen_at: number | null;
}
interface Row {
  id: string; credential_id: string; machine_id: string; session_var: string; app_credential_id: string; instance_id: string;
  status: 'open' | 'collected' | 'confirmed' | 'signed_in' | 'void' | 'expired' | 'failed'; outcome: string | null;
  created_at: number; expires_at: number; picked_at: number | null; confirmed_at: number | null; signed_in_at: number | null;
  ended_at: number | null; conflict_at: number | null;
}
export interface CollectionView {
  id: string; status: Row['status']; outcome: string | null; pc: string | null; session_var: string; created_at: number; expires_at: number;
  picked_at: number | null; confirmed_at: number | null; signed_in_at: number | null; ended_at: number | null; last_seen_at: number | null;
  /** May the operator arm a new collection after this one (not after a second collector or a use from elsewhere)? */
  retry: boolean;
  /**
   * Why an open collection cannot be picked up right now, read live (null when nothing holds it, or once it is not open):
   * `lockdown` (all writes, the PC or the agent), `app_key_inactive` (the bound app key is suspended, revoked or expired,
   * so the wake's poll is refused), `pc_inactive` (the PC is suspended or retired). It waits, then expires.
   */
  hold: 'lockdown' | 'app_key_inactive' | 'pc_inactive' | null;
  /** The bound app key's state when hold is app_key_inactive (suspended, revoked or expired), else null. */
  app_key_status: string | null;
}
/** Outcome values of an ended collection: binding_changed (the PC changed), cancelled, prompt_instead, revoked, rotated, replaced, conflict (a second collector), expired, write_failed, unconfirmed, elsewhere (used through another app key). */
export type CollectionOutcome = 'binding_changed' | 'cancelled' | 'prompt_instead' | 'revoked' | 'rotated' | 'replaced' | 'conflict' | 'expired' | 'write_failed' | 'unconfirmed' | 'elsewhere';
const ago = (ms: number) => { const d = Math.floor(ms / 86_400_000); if (d >= 1) return `${d} day${d === 1 ? '' : 's'} ago`; const h = Math.floor(ms / 3_600_000); return h >= 1 ? `${h} hour${h === 1 ? '' : 's'} ago` : 'less than an hour ago'; };

/** A collection that has not ended: still open, or picked up and not yet failed or void. */
export const LIVE_STATUSES: readonly string[] = ['open', 'collected', 'confirmed', 'signed_in'];

export class KeyCollections {
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly audit: Audit) {
    keys.collectGuard = (ses, app) => this.onLogin(ses, app);
  }

  /** Set in app.ts: a lockdown holds an open collection (shown as hold: lockdown). */
  lockdown: Lockdown | null = null;

  private chainSql = `WITH RECURSIVE ch(id) AS (SELECT ? UNION SELECT c.replaces_credential_id FROM credentials c JOIN ch ON c.id=ch.id WHERE c.replaces_credential_id IS NOT NULL)`;

  /** Whether Collect is offered for this key's next rotation, and if not, why, in one line for the operator. */
  offer(credentialId: string): Offer {
    this.sweep();
    const c = this.keys.credential(credentialId); if (!c) throw new KeyError('not_found', 'key not found');
    const no = (reason: OfferReason, message: string, more: Partial<Offer> = {}): Offer => ({ ok: false, reason, message, pc: null, session_var: null, app_credential_id: null, instance_id: null, last_seen_at: null, ...more });
    if (c.kind !== 'session_key') return no('not_session_key', 'Only a session key can be collected.');
    if (c.status === 'revoked') return no('inactive', 'This key is revoked.');
    // The one app key that may collect: the one the key (through its rotation chain) last logged in through. No fallback.
    const last = this.db.prepare(`${this.chainSql}
      SELECT t.app_credential_id id FROM session_tokens t WHERE t.session_credential_id IN (SELECT id FROM ch) ORDER BY t.created_at DESC LIMIT 1`).get(c.id) as { id: string } | undefined;
    if (!last) return no('never_signed_in', 'This key has never signed in, so it has no proven app key. Use a key prompt.');
    const t = this.keys.keyTarget(c.id);
    if (!t.pc) return no('no_pc', 'This key has no PC to collect it on. Use a key prompt.');
    const pc = { id: t.pc.id, name: t.pc.name }, more = { pc, session_var: t.session_var };
    const app = this.keys.credential(last.id);
    if (!app || this.keys.effectiveStatus(app) !== 'active') return no('app_inactive', `The app key this agent last signed in through on ${pc.name} is not active. Use a key prompt.`, more);
    if (app.machine_id !== pc.id) return no('not_on_pc', `This agent last signed in from another PC than ${pc.name}. Use a key prompt.`, more);
    if (t.pc.status !== 'active') return no('not_on_pc', `The PC ${pc.name} is ${t.pc.status}. Use a key prompt.`, more);
    if (!t.session_var) return no('no_pc', 'This key has no session variable yet. Use a key prompt.', more);
    const since = Date.now() - SHARED_WINDOW_MS;
    // A shared app key, from the hub's own login records (another agent's session key logged in through it) or from the
    // wake (it polled for another variable with it). Either way, whoever holds it could collect for this agent.
    const others = this.db.prepare(`${this.chainSql}
      SELECT COUNT(DISTINCT s.agent_id) n FROM session_tokens t JOIN credentials s ON s.id=t.session_credential_id
      WHERE t.app_credential_id=? AND t.created_at>? AND t.session_credential_id NOT IN (SELECT id FROM ch) AND s.agent_id IS NOT NULL AND s.agent_id<>?`).get(c.id, app.id, since, c.agent_id ?? '') as { n: number };
    const vars = this.db.prepare('SELECT COUNT(DISTINCT session_var) n FROM key_collect_polls WHERE app_credential_id=? AND session_var<>? AND last_at>?').get(app.id, t.session_var, since) as { n: number };
    if (others.n > 0 || vars.n > 0) {
      const n = Math.max(others.n, vars.n);
      return no('shared_app_key', `This agent shares its app key with ${n} other agent${n === 1 ? '' : 's'} on ${pc.name}. Give it its own app key to use Collect.`, more);
    }
    const polls = this.db.prepare('SELECT instance_id, app_credential_id, MAX(last_at) at FROM key_collect_polls WHERE machine_id=? AND session_var=? AND last_at>? GROUP BY instance_id, app_credential_id')
      .all(pc.id, t.session_var, Date.now() - WAKE_SEEN_MS) as { instance_id: string; app_credential_id: string; at: number }[];
    const instances = new Set(polls.map((p) => p.instance_id));
    if (instances.size > 1 || polls.length > 1) return no('two_instances', `Two copies of the Codex wake asked for this key. Use a key prompt and check ${pc.name}.`, more);
    const mine = polls.find((p) => p.app_credential_id === app.id);
    if (!mine) {
      const seen = this.db.prepare('SELECT MAX(last_at) at FROM key_collect_polls WHERE app_credential_id=? AND session_var=?').get(app.id, t.session_var) as { at: number | null };
      if (seen.at) return no('wake_stale', `The Codex wake on ${pc.name} was last seen ${ago(Date.now() - seen.at)}.`, { ...more, last_seen_at: seen.at });
      return no('no_wake', `No Codex wake on ${pc.name} collects this agent's key.`, more);
    }
    return { ok: true, reason: null, message: null, pc, session_var: t.session_var, app_credential_id: app.id, instance_id: mine.instance_id, last_seen_at: mine.at };
  }

  /**
   * Arm a collection for a key just rotated (the new credential), from the offer computed before the rotation. The key's
   * secret stops working at once; no code is made. Audited key.collect_armed. Call inside the rotation's transaction.
   */
  arm(credentialId: string, offer: Offer, actor: Actor): CollectionView {
    const pcId = offer.pc?.id;
    if (!offer.ok || !pcId || !offer.session_var || !offer.app_credential_id || !offer.instance_id) throw new KeyError('invalid_state', offer.message ?? 'Collect is not offered for this key.');
    return tx(this.db, () => {
      const c = this.keys.credential(credentialId); if (!c) throw new KeyError('not_found', 'key not found');
      if (c.kind !== 'session_key' || c.status !== 'active') throw new KeyError('invalid_state', 'only an active session key can be collected');
      const now = Date.now(), id = `kcl_${randomToken(10).slice(0, 16)}`, expires = now + COLLECT_TTL_MS;
      this.db.prepare("UPDATE key_pickups SET status='void' WHERE credential_id=? AND status='open'").run(c.id);
      this.db.prepare("UPDATE key_collections SET status='void', outcome='replaced', ended_at=? WHERE credential_id=? AND status='open'").run(now, c.id);
      this.keys.blankSecret(c.id, 'pickup');
      this.db.prepare(`INSERT INTO key_collections(id,credential_id,machine_id,session_var,app_credential_id,instance_id,status,created_at,expires_at,created_by_admin)
        VALUES (?,?,?,?,?,?,'open',?,?,?)`).run(id, c.id, pcId, offer.session_var, offer.app_credential_id, offer.instance_id, now, expires, actor.kind === 'admin' ? actor.id : null);
      this.audit.event(actor, 'key.collect_armed', { kind: 'credential', id: c.id }, { pc: pcId, session_var: offer.session_var, app: offer.app_credential_id, instance: offer.instance_id, expires_at: expires });
      return this.view(this.row(id)!);
    });
  }

  /** The newest collection of a key (open or ended), for the key page. */
  latest(credentialId: string): CollectionView | null {
    this.sweep();
    const r = this.db.prepare('SELECT * FROM key_collections WHERE credential_id=? ORDER BY created_at DESC LIMIT 1').get(credentialId) as Row | undefined;
    return r ? this.view(r) : null;
  }

  /**
   * Cancel: the open collection is void and the key keeps no usable secret, as an unused prompt. Show a key prompt instead
   * (prompt_instead) also ends a collection already picked up, confirmed or signed in, so neither the confirmation timer
   * nor a later login elsewhere can blank the key the prompt is about to make.
   */
  cancel(credentialId: string, actor: Actor, outcome: 'cancelled' | 'prompt_instead' = 'cancelled'): CollectionView {
    const statuses = outcome === 'prompt_instead' ? LIVE_STATUSES : ['open'];
    const r = this.db.prepare(`SELECT * FROM key_collections WHERE credential_id=? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`).get(credentialId, ...statuses) as Row | undefined;
    if (!r) throw new KeyError('invalid_state', 'This key has no open collection.');
    this.db.prepare("UPDATE key_collections SET status='void', outcome=?, ended_at=? WHERE id=?").run(outcome, Date.now(), r.id);
    this.audit.event(actor, 'key.collect_cancelled', { kind: 'credential', id: credentialId }, { pc: r.machine_id, session_var: r.session_var, outcome });
    return this.view(this.row(r.id)!);
  }

  /**
   * The wake's heartbeat for one opted-in entry, with that entry's app key. Records the instance and address, spots a
   * second collector, and lists (collect_ids) the open collections this app key, variable and instance may pick up. Never a secret.
   */
  poll(app: Credential, body: Record<string, unknown>, source: string): { collect_ids: string[]; poll_after_s: number } {
    const instance = body.instance_id, sv = body.session_var;
    if (typeof instance !== 'string' || !INSTANCE_RE.test(instance)) throw new KeyError('invalid_argument', 'instance_id: the Codex wake\'s instance id, 16 to 64 letters, digits, - or _');
    if (typeof sv !== 'string' || !SESSION_VAR_RE.test(sv)) throw new KeyError('invalid_argument', 'session_var: the entry\'s session variable');
    if (!app.machine_id) throw new KeyError('invalid_state', 'This app key belongs to no PC.');
    this.sweep();
    const now = Date.now();
    this.db.prepare(`INSERT INTO key_collect_polls(app_credential_id,machine_id,session_var,instance_id,source,first_at,last_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(app_credential_id,session_var,instance_id,source) DO UPDATE SET last_at=excluded.last_at`).run(app.id, app.machine_id, sv, instance, source, now, now);
    this.detectConflict(app.machine_id, sv);
    const open = this.db.prepare("SELECT id, session_var FROM key_collections WHERE app_credential_id=? AND session_var=? AND instance_id=? AND status='open' AND expires_at>?")
      .all(app.id, sv, instance, now) as { id: string; session_var: string }[];
    return { collect_ids: open.map((o) => o.id), poll_after_s: open.length ? POLL_OPEN_S : POLL_IDLE_S };
  }

  /**
   * A second collector for a variable on a PC: within 24 hours of an open or recent collection, a second instance id
   * polled for it, or the expected instance polled from two addresses. Voids the open collection, alerts once.
   */
  private detectConflict(machineId: string, sv: string): void {
    const now = Date.now(), since = now - CONFLICT_WINDOW_MS;
    const cols = this.db.prepare(`SELECT * FROM key_collections WHERE machine_id=? AND session_var=? AND conflict_at IS NULL
      AND (status='open' OR (status IN ('collected','confirmed','signed_in') AND created_at>?))`).all(machineId, sv, since) as unknown as Row[];
    if (!cols.length) return;
    const polls = this.db.prepare('SELECT instance_id, source, app_credential_id FROM key_collect_polls WHERE machine_id=? AND session_var=? AND last_at>?').all(machineId, sv, since) as { instance_id: string; source: string; app_credential_id: string }[];
    for (const c of cols) {
      const recent = polls;
      const instances = [...new Set(recent.map((p) => p.instance_id))];
      const addresses = [...new Set(recent.filter((p) => p.instance_id === c.instance_id).map((p) => p.source))];
      const apps = [...new Set(recent.map((p) => p.app_credential_id))];
      const kind = instances.some((i) => i !== c.instance_id) || apps.some((a) => a !== c.app_credential_id) ? 'second_instance' : addresses.length > 1 ? 'two_addresses' : null;
      if (kind) this.conflict(c, kind, { instances, addresses: [...new Set(recent.map((p) => p.source))] });
    }
  }

  /** Mark a second collector on a collection: an open one is void, the alert fires once per collection. */
  private conflict(c: Row, kind: 'second_instance' | 'two_addresses' | 'unexpected_pickup', more: Record<string, unknown>): void {
    const now = Date.now();
    if (c.status === 'open') this.db.prepare("UPDATE key_collections SET status='void', outcome='conflict', ended_at=?, conflict_at=? WHERE id=?").run(now, now, c.id);
    else this.db.prepare('UPDATE key_collections SET conflict_at=? WHERE id=?').run(now, c.id);
    this.audit.alert('warning', 'key.collect_conflict', c.credential_id, { kind, credential: c.credential_id, pc: c.machine_id, session_var: c.session_var, expected_instance: c.instance_id, app: c.app_credential_id, ...more });
  }

  /**
   * The pickup with a collect_id instead of a code (POST /onboard/key-pickup): only the bound app key, on the
   * collection's PC, from the expected instance. Another app key or PC gets not_found; another instance gets not_found and
   * voids the collection with key.collect_conflict. `refuse` may stop it for the key's agent (a lockdown), leaving it open.
   */
  redeem(app: Credential, collectId: unknown, instanceId: unknown, refuse?: (agentId: string | null) => string | null): { session_var: string; secret: string; label: string; pc: string; credential_id: string } {
    this.sweep();
    if (typeof collectId !== 'string' || !COLLECT_RE.test(collectId)) throw new KeyError('not_found', 'Unknown key collection.');
    if (typeof instanceId !== 'string' || !INSTANCE_RE.test(instanceId)) throw new KeyError('invalid_argument', 'instance_id: the Codex wake\'s instance id');
    type Redeemed = { session_var: string; secret: string; label: string; pc: string; credential_id: string };
    const out = tx(this.db, (): { conflict: Row } | { result: Redeemed } => {
      const r = this.row(collectId);
      if (!r || r.app_credential_id !== app.id || r.machine_id !== app.machine_id) throw new KeyError('not_found', 'Unknown key collection.');
      if (r.instance_id !== instanceId) return { conflict: r };
      if (r.status !== 'open') throw new KeyError('invalid_state', r.status === 'expired' ? 'This key collection has expired.' : 'This key collection was already used or cancelled.');
      if (r.expires_at <= Date.now()) throw new KeyError('invalid_state', 'This key collection has expired.');
      const c = this.keys.credential(r.credential_id)!;
      if (c.bound_machine_id && c.bound_machine_id !== r.machine_id) throw new KeyError('invalid_state', 'This key is now bound to another PC, so the collection was cancelled.');
      if (this.keys.effectiveStatus(c) !== 'active') throw new KeyError('invalid_state', `The key is ${this.keys.effectiveStatus(c)}.`);
      const no = refuse?.(c.agent_id); if (no) throw new KeyError('lockdown', no);
      const secret = this.keys.issueSessionSecret(c.id), now = Date.now();
      this.db.prepare("UPDATE key_collections SET status='collected', picked_at=? WHERE id=?").run(now, r.id);
      const pc = this.keys.machine(r.machine_id)!;
      this.audit.event(sys, 'key.pickup', { kind: 'credential', id: c.id }, { via: 'collect', pc: pc.id, session_var: r.session_var, instance: instanceId, app: app.id });
      return { result: { session_var: r.session_var, secret, label: c.label, pc: pc.name, credential_id: c.id } };
    });
    if ('conflict' in out) {
      const cf = out.conflict;
      // Outside the refusal's transaction, so the void and the alert stay when the pickup is refused.
      if (['open', 'collected', 'confirmed', 'signed_in'].includes(cf.status)) this.conflict(cf, 'unexpected_pickup', { instances: [cf.instance_id, instanceId] });
      throw new KeyError('not_found', 'Unknown key collection.');
    }
    return out.result;
  }

  /** The wake's word that it wrote the key (ok) or could not (the new secret is void at once). */
  confirm(app: Credential, body: Record<string, unknown>): { ok: true; status: Row['status'] } {
    const id = body.collect_id, instance = body.instance_id, ok = body.ok;
    if (typeof ok !== 'boolean') throw new KeyError('invalid_argument', 'ok: true when the keys file holds the new key, false when it could not be written');
    this.sweep();
    const r = typeof id === 'string' && COLLECT_RE.test(id) ? this.row(id) : null;
    if (!r || r.app_credential_id !== app.id || r.instance_id !== instance) throw new KeyError('not_found', 'Unknown key collection.');
    if (r.status !== 'collected' && r.status !== 'signed_in') throw new KeyError('invalid_state', r.status === 'confirmed' ? 'This key collection is already confirmed.' : 'This key collection is not waiting for a confirmation.');
    const now = Date.now();
    return tx(this.db, () => {
      if (ok) {
        if (r.status === 'collected') this.db.prepare("UPDATE key_collections SET status='confirmed', confirmed_at=? WHERE id=?").run(now, r.id);
        else this.db.prepare('UPDATE key_collections SET confirmed_at=? WHERE id=?').run(now, r.id);
        this.audit.event(sys, 'key.collect_confirmed', { kind: 'credential', id: r.credential_id }, { pc: r.machine_id, session_var: r.session_var, instance: r.instance_id });
        return { ok: true as const, status: r.status === 'collected' ? 'confirmed' as const : r.status };
      }
      if (r.status === 'signed_in') {
        // The key already signed in from this PC, so a late "write failed" is not acted on: the key stays usable.
        this.audit.event(sys, 'key.collect_confirm_ignored', { kind: 'credential', id: r.credential_id }, { pc: r.machine_id, session_var: r.session_var, instance: r.instance_id, reason: 'already_signed_in' });
        return { ok: true as const, status: 'signed_in' as const };
      }
      this.fail(r, 'write_failed');
      return { ok: true as const, status: 'failed' as const };
    });
  }

  /** The new secret is void at once and the collection failed (not written, not confirmed, or used from elsewhere). */
  private fail(r: Row, outcome: 'write_failed' | 'unconfirmed' | 'elsewhere'): void {
    const now = Date.now();
    this.keys.blankSecret(r.credential_id, 'collect_failed');
    this.db.prepare("UPDATE key_collections SET status='failed', outcome=?, ended_at=? WHERE id=?").run(outcome, now, r.id);
    if (outcome !== 'elsewhere') this.audit.event(sys, 'key.collect_unconfirmed', { kind: 'credential', id: r.credential_id }, { pc: r.machine_id, session_var: r.session_var, instance: r.instance_id, reason: outcome });
  }

  /**
   * Runs at each login with a valid session key (Keys.collectGuard). A collected key logging in through its bound app key
   * is Signed in; through any other app key, on the same PC or another, the collection fails, the new secret is void,
   * key.collect_conflict fires and the login is refused (as bound_key_elsewhere from another PC, as an invalid key on it).
   */
  onLogin(ses: Credential, app: Credential): void {
    const r = this.db.prepare(`SELECT * FROM key_collections WHERE credential_id=? AND (status IN ('collected','confirmed') OR (status='signed_in' AND expires_at>?))
      ORDER BY created_at DESC LIMIT 1`).get(ses.id, Date.now()) as Row | undefined;
    if (!r) return;
    if (app.id === r.app_credential_id && app.machine_id === r.machine_id) {
      if (r.status !== 'signed_in') this.db.prepare("UPDATE key_collections SET status='signed_in', signed_in_at=? WHERE id=?").run(Date.now(), r.id);
      return;
    }
    tx(this.db, () => this.fail(r, 'elsewhere'));
    this.audit.alert('warning', 'key.collect_conflict', r.credential_id, { kind: 'used_elsewhere', credential: r.credential_id, pc: r.machine_id, session_var: r.session_var,
      expected_app: r.app_credential_id, used_app: app.id, used_from_pc: app.machine_id, same_pc: app.machine_id === r.machine_id });
    if (app.machine_id !== r.machine_id) throw new BoundElsewhereError(ses, app);
    throw new KeyError('invalid', 'this session key was collected for another app key');
  }

  /** Expiry (24 h) and missing confirmations (10 min); prunes heartbeats older than 30 days. Cheap; runs on each use and in the upkeep. */
  sweep(): void {
    const now = Date.now();
    const expired = this.db.prepare("SELECT * FROM key_collections WHERE status='open' AND expires_at<=?").all(now) as unknown as Row[];
    const late = this.db.prepare("SELECT * FROM key_collections WHERE status='collected' AND picked_at<=?").all(now - COLLECT_CONFIRM_MS) as unknown as Row[];
    if (!expired.length && !late.length) { this.prune(now); return; }
    tx(this.db, () => {
      for (const r of expired) {
        this.db.prepare("UPDATE key_collections SET status='expired', outcome='expired', ended_at=? WHERE id=? AND status='open'").run(now, r.id);
        this.audit.event(sys, 'key.collect_expired', { kind: 'credential', id: r.credential_id }, { pc: r.machine_id, session_var: r.session_var });
      }
      for (const r of late) this.fail(r, 'unconfirmed');
    });
    this.prune(now);
  }
  private lastPrune = 0;
  private prune(now: number): void {
    if (now - this.lastPrune < 60 * 60 * 1000) return;
    this.lastPrune = now;
    this.db.prepare('DELETE FROM key_collect_polls WHERE last_at<?').run(now - SHARED_WINDOW_MS);
  }

  private row(id: string): Row | null { return (this.db.prepare('SELECT * FROM key_collections WHERE id=?').get(id) as Row | undefined) ?? null; }
  private view(r: Row): CollectionView {
    const seen = this.db.prepare('SELECT MAX(last_at) at FROM key_collect_polls WHERE app_credential_id=? AND session_var=? AND instance_id=?').get(r.app_credential_id, r.session_var, r.instance_id) as { at: number | null };
    return { id: r.id, status: r.status, outcome: r.outcome, pc: this.keys.machine(r.machine_id)?.name ?? null, session_var: r.session_var, created_at: r.created_at, expires_at: r.expires_at,
      picked_at: r.picked_at, confirmed_at: r.confirmed_at, signed_in_at: r.signed_in_at, ended_at: r.ended_at, last_seen_at: seen.at,
      retry: !(r.outcome === 'conflict' || r.outcome === 'elsewhere' || r.conflict_at !== null), ...this.holdOf(r) };
  }
  private holdOf(r: Row): { hold: CollectionView['hold']; app_key_status: string | null } {
    if (r.status !== 'open') return { hold: null, app_key_status: null };
    const agentId = this.keys.credential(r.credential_id)?.agent_id ?? null;
    const lk = this.lockdown;
    if (lk && (lk.writes() || lk.pc(r.machine_id) || (agentId !== null && lk.agent(agentId)))) return { hold: 'lockdown', app_key_status: null };
    // The PC first: a suspended PC also makes its app keys inactive.
    if (this.keys.machine(r.machine_id)?.status !== 'active') return { hold: 'pc_inactive', app_key_status: null };
    const app = this.keys.credential(r.app_credential_id), st = app ? this.keys.effectiveStatus(app) : 'revoked';
    if (st !== 'active') return { hold: 'app_key_inactive', app_key_status: st };
    return { hold: null, app_key_status: null };
  }
}
