/**
 * The hub's side of the Conclave connector (docs/connector.md, "Hub route contract"): the connector's check-in, PC status,
 * the setup timeline, PC actions (stored orders the connector fetches), Disconnect's states and receipt credential,
 * connector versions, the messages a PC reports shown, and usage. A value no connector has reported is null (Unknown).
 * Nothing here runs on a PC: an order waits until the connector fetches it.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { hmacHex, randomToken, safeEqualHex } from '../util/crypto.js';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import type { LeakGuard } from '../guard/leakGuard.js';
import { scrub } from '../audit/scrub.js';

export const ONLINE_MS = 90_000;
/** A fetched order with no result this long after it was fetched expires, so it never blocks its kind for good. */
export const FETCHED_TTL_MS = 24 * 60 * 60_000;
export const ORDER_TTL_MS = 24 * 3600_000;
export const DISCONNECT_TTL_MS = 7 * 86400_000;
export const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;
const RECEIPT_RE = /^ah_dsc_([a-z2-7]{12})_([a-z2-7]{32})$/;
export const CLIENTS = ['claude_code', 'claude_desktop', 'codex'] as const;
/** What a PC may report about its own agents; Waiting for approval and Ready to open are the hub's states. */
export const PC_REPORTED = ['open', 'repair_connection', 'chat_in_use'] as const;
/** At most this many versions wait for approval because PCs reported them. */
export const MAX_PENDING_REPORTED = 5;
export const ACTION_KINDS = ['check', 'restore', 'update'] as const;
const OPEN_STATES = ['queued', 'fetched'];
const DISCONNECT_OPEN = ['access_revoked', 'cleanup_pending'];
/** A disconnect order still open: no result, not expired into Needs attention, not ended by Re-enrol PC. */
const DSC_OPEN_SQL = "kind='disconnect' AND state IN ('access_revoked','cleanup_pending') AND finished_at IS NULL AND ended_at IS NULL";

export const DISCONNECT_REMOVES = ["This hub's worker and transfers, stopped first", "This hub's keys on the PC", "This hub's folder registrations", "The connector's files for this hub"];
export const DISCONNECT_KEEPS = ['Repositories and worktrees', 'Chat history', "The PC user's own settings", 'Other hubs on the PC'];

/** List prices per million tokens, by model, as the hub's config sets them; none set: every cost is Unknown. */
export interface ModelPrice { input: number; output: number; cache_read?: number; cache_write?: number }

export interface CheckIn {
  version: string; platform?: string | null; node?: string | null; git?: string | null;
  clients?: { client: (typeof CLIENTS)[number]; version: string | null }[];
  auto_update?: boolean | null; remote_cleanup?: boolean | null; remove_connector_with_last_hub?: boolean | null; usage_opt_in?: boolean | null;
  agents?: { agent_id: string; state: (typeof PC_REPORTED)[number] }[];
  /** Restore destinations the PC's user approved on the PC: an id and a label, never a path. */
  destinations?: { id: string; label: string }[];
}
export const DESTINATION_RE = /^dst_[a-z0-9]{6,32}$/;
interface ReportRow {
  machine_id: string; version: string | null; platform: string | null; node: string | null; git: string | null; clients: string;
  auto_update: number | null; remote_cleanup: number | null; remove_with_last_hub: number | null; usage_opt_in: number | null;
  agents: string; destinations: string | null; first_check_in_at: number; last_check_in_at: number;
}
interface ActionRow {
  id: string; machine_id: string; kind: string; state: string; payload: string; result: string | null; created_at: number; created_by: string | null;
  fetched_at: number | null; finished_at: number | null; expires_at: number; receipt_key_id: string | null; receipt_verifier: string | null; ended_at: number | null;
}
export interface UsageRow { agent_id: string; client: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; sessions: number; turns?: number | null }

const bool = (v: number | null) => (v === null ? null : v === 1);
const toInt = (v: boolean | null | undefined) => (v === undefined || v === null ? null : v ? 1 : 0);
const parse = <T>(s: string | null, d: T): T => { if (s === null) return d; try { return JSON.parse(s) as T; } catch { return d; } };
const cmpVersion = (a: string, b: string) => {
  const pa = a.split('-')[0]!.split('.').map(Number), pb = b.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return a.includes('-') === b.includes('-') ? a.localeCompare(b) : a.includes('-') ? -1 : 1; // a pre-release sorts below its release
};
const fail = (code: string, msg: string) => new KeyError(code, msg);
const who = (a: Actor) => (a.kind === 'admin' ? `operator:${a.id}` : a.kind);
const scrubDeep = (v: unknown): unknown => (typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map(scrubDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) : v);

export class Connector {
  /** Text from the PC is L2: a key shape is refused (and alerted), other secrets are redacted (docs/connector.md). */
  guard: LeakGuard | null = null;
  constructor(private db: Db, private keys: Keys, private audit: Audit, private pepper: string, private prices: Record<string, ModelPrice> = {}, private now: () => number = Date.now) {}

  private pcText<T>(machineId: string, v: T): T {
    if (this.guard?.scan(v)) {
      this.audit.alert('warning', 'connector_key_in_report', machineId, { pc: machineId });
      throw fail('contains_key', 'What the PC reported contains a Conclave key; it was refused.');
    }
    return scrubDeep(v) as T;
  }
  /** Agents whose session key is bound to this PC: the only ones it may report on. */
  private ownAgents(machineId: string): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT agent_id FROM credentials WHERE kind='session_key' AND bound_machine_id=? AND status<>'revoked' AND agent_id IS NOT NULL").all(machineId) as { agent_id: string }[]).map((r) => r.agent_id));
  }

  // ───── the connector's report ─────
  checkIn(machineId: string, report: CheckIn): { ok: true; orders: number; ignored_agents: number } {
    const r = this.pcText(machineId, report); // every string from the PC passes the leak guard
    const now = this.now(), own = this.ownAgents(machineId);
    const agents = (r.agents ?? []).filter((a) => own.has(a.agent_id));
    tx(this.db, () => {
      const had = this.db.prepare('SELECT 1 FROM connector_reports WHERE machine_id=?').get(machineId);
      const vals = [r.version, r.platform ?? null, r.node ?? null, r.git ?? null, JSON.stringify(r.clients ?? []), toInt(r.auto_update), toInt(r.remote_cleanup),
        toInt(r.remove_connector_with_last_hub), toInt(r.usage_opt_in), JSON.stringify(agents), r.destinations === undefined ? null : JSON.stringify(r.destinations)];
      if (had) this.db.prepare('UPDATE connector_reports SET version=?,platform=?,node=?,git=?,clients=?,auto_update=?,remote_cleanup=?,remove_with_last_hub=?,usage_opt_in=?,agents=?,destinations=?,last_check_in_at=? WHERE machine_id=?').run(...vals, now, machineId);
      else this.db.prepare('INSERT INTO connector_reports(version,platform,node,git,clients,auto_update,remote_cleanup,remove_with_last_hub,usage_opt_in,agents,destinations,first_check_in_at,last_check_in_at,machine_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, now, now, machineId);
      if (this.noteReported(r.version, machineId)) this.audit.alert('info', 'connector_version_pending', r.version, { version: r.version, pc: machineId });
    });
    this.expire();
    return { ok: true, orders: (this.db.prepare(`SELECT COUNT(*) n FROM pc_actions WHERE machine_id=? AND state='queued'`).get(machineId) as { n: number }).n, ignored_agents: (r.agents ?? []).length - agents.length };
  }

  /** The PC's connector status, every field null until reported (docs/connector.md, "PC status"). */
  status(machineId: string) {
    const r = this.db.prepare('SELECT * FROM connector_reports WHERE machine_id=?').get(machineId) as unknown as ReportRow | undefined;
    const approved = this.approvedVersions();
    // Disconnected (until Re-enrol PC ends it) and Suspended come before Online: neither reads "Offline since".
    const held = this.disconnected(machineId) ? 'disconnected' as const : this.keys.machine(machineId)?.status === 'suspended' ? 'suspended' as const : null;
    if (!r) {
      return { online: false, status: held ?? 'never' as const, first_check_in_at: null, last_check_in_at: null, version: null, platform: null, node: null, git: null, clients: [],
        auto_update: null, remote_cleanup: null, remove_connector_with_last_hub: null, usage_opt_in: null, destinations: null, version_status: null, update_available: null };
    }
    const online = !held && this.now() - r.last_check_in_at < ONLINE_MS;
    const vs = r.version ? (this.db.prepare('SELECT status FROM connector_versions WHERE version=?').get(r.version) as { status: string } | undefined)?.status ?? null : null;
    const newer = r.version ? approved.filter((v) => cmpVersion(v, r.version!) > 0) : [];
    return {
      online, status: held ?? (online ? 'online' as const : 'offline' as const), first_check_in_at: r.first_check_in_at, last_check_in_at: r.last_check_in_at,
      version: r.version, platform: r.platform, node: r.node, git: r.git, clients: parse(r.clients, [] as unknown[]),
      auto_update: bool(r.auto_update), remote_cleanup: bool(r.remote_cleanup), remove_connector_with_last_hub: bool(r.remove_with_last_hub), usage_opt_in: bool(r.usage_opt_in),
      destinations: parse(r.destinations, null as { id: string; label: string }[] | null),
      version_status: vs, update_available: newer.length ? newer[newer.length - 1]! : null,
    };
  }

  // ───── agents and the setup timeline ─────
  timeline(machineId: string) {
    const pc = this.keys.machine(machineId);
    if (!pc) throw fail('not_found', 'PC not found');
    const st = this.status(machineId);
    const reported = new Map(parse((this.db.prepare('SELECT agents FROM connector_reports WHERE machine_id=?').get(machineId) as { agents: string } | undefined)?.agents ?? null, [] as { agent_id: string; state: string }[]).map((a) => [a.agent_id, a.state]));
    const bridge = this.db.prepare("SELECT created_at FROM bridge_keys WHERE machine_id=? AND status<>'revoked' ORDER BY created_at DESC LIMIT 1").get(machineId) as { created_at: number } | undefined;
    const reqs = this.db.prepare("SELECT id, state, body, filed_at, decided_at, collected_at, team_id FROM onboarding_requests WHERE machine_id=? AND state NOT IN ('denied','withdrawn','cancelled') ORDER BY filed_at").all(machineId) as { id: string; state: string; body: string; filed_at: number; decided_at: number | null; collected_at: number | null; team_id: string | null }[];
    const slots = this.db.prepare(`SELECT s.agent_id, s.label, s.status, r.team_id, a.connected_at, a.last_active_at FROM onboarding_slots s JOIN onboarding_requests r ON r.id=s.request_id JOIN agents a ON a.id=s.agent_id
      WHERE r.machine_id=? AND s.status<>'closed' ORDER BY s.created_at`).all(machineId) as { agent_id: string; label: string; status: string; team_id: string | null; connected_at: number | null; last_active_at: number | null }[];

    type Next = { action: string; who: 'you' | 'pc_user' | 'agent' } | null;
    type Agent = { agent_id: string | null; label: string; team_id: string | null; state: 'waiting_for_approval' | 'ready_to_open' | 'connected'; next: Next; connected_at: number | null; last_active_at: number | null; pc_reported: string | null };
    const agents: Agent[] = [];
    for (const q of reqs.filter((x) => x.state === 'submitted' || x.state === 'needs_changes')) {
      const roles = parse(q.body, {} as { roles?: { name?: string; count?: number }[] }).roles ?? [];
      for (const ro of roles) for (let i = 1; i <= Math.min(Math.max(ro.count ?? 1, 1), 50); i++) {
        agents.push({ agent_id: null, label: (ro.count ?? 1) > 1 ? `${ro.name ?? 'agent'} ${i}` : String(ro.name ?? 'agent'), team_id: q.team_id, state: 'waiting_for_approval', next: { action: 'Approve the team request', who: 'you' }, connected_at: null, last_active_at: null, pc_reported: null });
      }
    }
    for (const s of slots) {
      // Three states (review v2 §3): keys not collected yet is Ready to open, with the PC user's next step.
      const state = s.connected_at ? 'connected' as const : 'ready_to_open' as const;
      const next: Next = s.connected_at ? null : s.status === 'waiting' ? { action: 'Continue setup on the PC', who: 'pc_user' } : { action: 'Open the agent on the PC', who: 'pc_user' };
      agents.push({ agent_id: s.agent_id, label: s.label, team_id: s.team_id, state, next, connected_at: s.connected_at, last_active_at: s.last_active_at, pc_reported: reported.get(s.agent_id) ?? null });
    }

    type Step = { step: string; state: 'done' | 'waiting' | 'failed' | 'not_yet'; at: number | null; reason: string | null; next: { action: string; who: 'you' | 'pc_user' | 'agent' } | null };
    // Paired from the moment the PC's own code was redeemed (pairing or setup.mjs enrol), else its first check-in.
    const redeemed = (this.db.prepare("SELECT MIN(used_at) AS at FROM enrolment_codes WHERE machine_id=? AND expires_at IS NULL AND used_at IS NOT NULL AND status<>'revoked'").get(machineId) as { at: number | null }).at;
    const pairedAt = redeemed ?? st.first_check_in_at ?? bridge?.created_at ?? null;
    const steps: Step[] = [{ step: 'added', state: 'done', at: pc.created_at, reason: null, next: null }];
    steps.push(pairedAt !== null ? { step: 'paired', state: 'done', at: pairedAt, reason: null, next: null }
      : { step: 'paired', state: 'waiting', at: null, reason: 'The connector has not paired with this hub yet.', next: { action: 'Enter the pairing code on the PC', who: 'pc_user' } });
    const filed = reqs[0];
    steps.push(filed ? { step: 'request_filed', state: 'done', at: filed.filed_at, reason: null, next: null }
      : { step: 'request_filed', state: pairedAt !== null ? 'waiting' : 'not_yet', at: null, reason: null, next: pairedAt !== null ? { action: 'Ask for a team on the PC', who: 'pc_user' } : null });
    const pending = reqs.filter((x) => x.state === 'submitted' || x.state === 'needs_changes');
    const decided = reqs.filter((x) => x.decided_at !== null && x.state !== 'submitted' && x.state !== 'needs_changes');
    steps.push(!filed ? { step: 'approved', state: 'not_yet', at: null, reason: null, next: null }
      : pending.some((x) => x.state === 'needs_changes') ? { step: 'approved', state: 'waiting', at: null, reason: 'You asked for changes to the request.', next: { action: 'Change the request and file it again', who: 'agent' } }
      : pending.length ? { step: 'approved', state: 'waiting', at: null, reason: null, next: { action: 'Approve the team request', who: 'you' } }
      : { step: 'approved', state: 'done', at: Math.max(...decided.map((x) => x.decided_at!)) || null, reason: null, next: null });
    const uncollected = slots.filter((s) => s.status === 'waiting');
    steps.push(!slots.length ? { step: 'keys_collected', state: 'not_yet', at: null, reason: null, next: null }
      : uncollected.length ? { step: 'keys_collected', state: 'waiting', at: null, reason: `${uncollected.length} of ${slots.length} agents have no keys on the PC yet.`, next: { action: 'Collect the keys on the PC', who: 'pc_user' } }
      : { step: 'keys_collected', state: 'done', at: Math.max(0, ...reqs.map((x) => x.collected_at ?? 0)) || null, reason: null, next: null });
    const ready = agents.filter((a) => a.state === 'ready_to_open' && a.agent_id && slots.find((s) => s.agent_id === a.agent_id)?.status !== 'waiting');
    const broken = agents.filter((a) => a.pc_reported === 'repair_connection');
    steps.push(!slots.length || uncollected.length === slots.length ? { step: 'agents_connected', state: 'not_yet', at: null, reason: null, next: null }
      : broken.length ? { step: 'agents_connected', state: 'failed', at: null, reason: `The PC reports that ${broken.map((a) => a.label).join(', ')} cannot reach the hub.`, next: { action: 'Repair the connection on the PC', who: 'pc_user' } }
      : ready.length ? { step: 'agents_connected', state: 'waiting', at: null, reason: `${ready.length} of ${slots.length} agents have not made their first call yet.`, next: { action: 'Open the agent on the PC', who: 'pc_user' } }
      : { step: 'agents_connected', state: 'done', at: Math.max(0, ...agents.map((a) => a.connected_at ?? 0)) || null, reason: null, next: null });
    return { steps, agents };
  }

  // ───── PC actions ─────
  private view(a: ActionRow) {
    const { receipt_key_id: _k, receipt_verifier: _v, payload, result, ...rest } = a;
    return { ...rest, payload: parse(payload, {}), result: parse(result, null) };
  }
  private expire(): void {
    const now = this.now();
    this.db.prepare("UPDATE pc_actions SET state='expired', finished_at=? WHERE kind<>'disconnect' AND state='queued' AND expires_at<=?").run(now, now);
    this.db.prepare("UPDATE pc_actions SET state='expired', finished_at=?, result=? WHERE kind<>'disconnect' AND state='fetched' AND fetched_at<=?")
      .run(now, JSON.stringify({ reason: 'The connector took this order but did not report a result within 24 hours.' }), now - FETCHED_TTL_MS);
    // A disconnect with no result by expires_at needs attention, and its receipt is retired with it.
    const late = this.db.prepare(`SELECT * FROM pc_actions WHERE ${DSC_OPEN_SQL} AND expires_at<=?`).all(now) as unknown as ActionRow[];
    for (const a of late) {
      const left = a.state === 'access_revoked' ? 'The connector did not fetch the cleanup within 7 days. Its keys no longer work; its files are still on the PC.'
        : 'The connector fetched the cleanup but did not report it within 7 days. Its keys no longer work; check the PC.';
      this.db.prepare("UPDATE pc_actions SET state='needs_attention', finished_at=?, result=?, receipt_verifier=NULL WHERE id=?").run(now, JSON.stringify({ left: [left] }), a.id);
    }
  }
  actions(machineId: string) {
    this.expire();
    return (this.db.prepare('SELECT * FROM pc_actions WHERE machine_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(machineId) as unknown as ActionRow[]).map((a) => this.view(a));
  }
  createAction(machineId: string, b: { kind: (typeof ACTION_KINDS)[number]; checkout_id?: string; destination_id?: string; version?: string }, actor: Actor) {
    const pc = this.keys.machine(machineId);
    if (!pc) throw fail('not_found', 'PC not found');
    if (pc.status !== 'active') throw fail('invalid_state', 'This PC is suspended or retired; resume it first.');
    this.expire();
    let payload: Record<string, unknown> = {};
    if (b.kind === 'restore') {
      const c = b.checkout_id ? this.db.prepare('SELECT id, status, target_machine_id FROM checkouts WHERE id=?').get(b.checkout_id) as { id: string; status: string; target_machine_id: string | null } | undefined : undefined;
      if (!c) throw fail('not_found', 'Checkout not found');
      if (c.status !== 'rendered' || c.target_machine_id !== machineId) throw fail('invalid_state', 'Restore needs a checkout whose restore prompt is ready and that targets this PC.');
      // Only to a destination the PC's user approved on that PC, named by its id: the order never carries a path.
      const dest = this.status(machineId).destinations?.find((d) => d.id === b.destination_id);
      if (!dest) throw fail('invalid_state', "Restore goes only to a destination the PC's user approved on that PC. Ask them to approve one, then try again.");
      payload = { checkout_id: c.id, destination_id: dest.id };
    } else if (b.kind === 'update') {
      if (!b.version || !VERSION_RE.test(b.version)) throw fail('invalid_argument', 'version must look like 1.4.0');
      const v = this.db.prepare('SELECT status FROM connector_versions WHERE version=?').get(b.version) as { status: string } | undefined;
      if (v?.status !== 'approved') throw fail('invalid_state', 'Only an approved connector version can be installed.');
      const runs = this.status(machineId).version;
      if (runs && cmpVersion(b.version, runs) <= 0) throw fail('invalid_argument', `This PC runs ${runs}; an update must be a newer version (no downgrades).`);
      payload = { version: b.version };
    }
    if (this.db.prepare(`SELECT 1 FROM pc_actions WHERE machine_id=? AND kind=? AND state IN ('queued','fetched')`).get(machineId, b.kind)) throw fail('conflict', 'This PC already has an open order of that kind.');
    const id = `pca_${randomToken(10)}`, now = this.now();
    this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at) VALUES (?,?,?,'queued',?,?,?,?)").run(id, machineId, b.kind, JSON.stringify(payload), now, who(actor), now + ORDER_TTL_MS);
    this.audit.event(actor, 'pc.action_create', { kind: 'pc', id: machineId }, { action: id, kind: b.kind, ...payload });
    return this.view(this.db.prepare('SELECT * FROM pc_actions WHERE id=?').get(id) as unknown as ActionRow);
  }
  /** The connector's pinned poll: the PC's queued orders, each moved to fetched (one-time). */
  fetchOrders(machineId: string) {
    this.expire();
    const now = this.now();
    return tx(this.db, () => {
      const rows = this.db.prepare(`SELECT * FROM pc_actions WHERE machine_id=? AND kind<>'disconnect' AND state='queued' ORDER BY created_at`).all(machineId) as unknown as ActionRow[];
      for (const r of rows) this.db.prepare("UPDATE pc_actions SET state='fetched', fetched_at=? WHERE id=?").run(now, r.id);
      return rows.map((r) => ({ id: r.id, kind: r.kind, payload: parse(r.payload, {}) }));
    });
  }
  reportOrder(machineId: string, id: string, state: 'done' | 'failed', result: unknown) {
    const a = this.db.prepare("SELECT * FROM pc_actions WHERE id=? AND machine_id=? AND kind<>'disconnect'").get(id, machineId) as unknown as ActionRow | undefined;
    // One result per order, only from its own PC: anything else is not_found.
    if (!a || a.state !== 'fetched') throw fail('not_found', 'Order not found');
    const clean = this.pcText(machineId, result ?? null);
    this.db.prepare('UPDATE pc_actions SET state=?, result=?, finished_at=? WHERE id=?').run(state, JSON.stringify(clean), this.now(), id);
    this.audit.event({ kind: 'system', id: null }, 'pc.action_report', { kind: 'pc', id: machineId }, { action: id, kind: a.kind, state });
    return { ok: true };
  }

  // ───── Disconnect this hub from this PC ─────
  disconnectView(machineId: string) {
    this.expire();
    const a = this.db.prepare("SELECT * FROM pc_actions WHERE machine_id=? AND kind='disconnect' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(machineId) as unknown as ActionRow | undefined;
    if (!a) return null;
    const p = parse(a.payload, {} as { remote_cleanup?: boolean | null }), res = parse(a.result, {} as { left?: string[]; cleanup_off?: boolean });
    return { id: a.id, state: a.state, created_at: a.created_at, fetched_at: a.fetched_at, finished_at: a.finished_at, expires_at: a.expires_at, ended_at: a.ended_at,
      removes: DISCONNECT_REMOVES, keeps: DISCONNECT_KEEPS, remote_cleanup: p.remote_cleanup ?? null, cleanup_off: res.cleanup_off === true, left: res.left ?? [] };
  }
  /**
   * Revokes the PC's access at once (it is suspended: its app keys, bridge key and its agents' sessions stop working) and
   * stores one disconnect order. Its narrow receipt credential is issued only to the connector (issueReceipt). The cleanup
   * itself is the connector's.
   */
  disconnect(machineId: string, actor: Actor) {
    const pc = this.keys.machine(machineId);
    if (!pc) throw fail('not_found', 'PC not found');
    if (pc.status === 'retired') throw fail('invalid_state', 'A retired PC has no access to revoke.');
    this.expire();
    if (this.db.prepare(`SELECT 1 FROM pc_actions WHERE machine_id=? AND ${DSC_OPEN_SQL}`).get(machineId)) throw fail('conflict', 'A disconnect of this PC is already under way.');
    const remote_cleanup = this.status(machineId).remote_cleanup;
    const now = this.now(), id = `pca_${randomToken(10)}`;
    tx(this.db, () => {
      if (pc.status === 'active') this.keys.setMachineStatus(machineId, 'suspended', actor);
      this.db.prepare("UPDATE bridge_keys SET status='revoked', revoked_at=? WHERE machine_id=? AND status<>'revoked'").run(now, machineId);
      // Revoke any other open order: nothing else reaches this PC now.
      this.db.prepare(`UPDATE pc_actions SET state='expired', finished_at=? WHERE machine_id=? AND kind<>'disconnect' AND state IN ('queued','fetched')`).run(now, machineId);
      this.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at) VALUES (?,?,'disconnect','access_revoked',?,?,?,?)")
        .run(id, machineId, JSON.stringify({ remote_cleanup }), now, who(actor), now + DISCONNECT_TTL_MS);
    });
    this.audit.event(actor, 'pc.disconnect', { kind: 'pc', id: machineId }, { action: id, remote_cleanup });
    return { disconnect: this.disconnectView(machineId)! };
  }
  /**
   * The receipt credential, for the connector only: the hub answers the PC's own (now refused) key with it while a disconnect
   * is open. Each issue replaces the last one, so a lost answer is recovered by calling again; the console never sees it.
   */
  issueReceipt(machineId: string): string | null {
    this.expire();
    // Only while the order is open: after its result, its expiry or Re-enrol PC, the key gets a plain 401.
    const a = this.db.prepare(`SELECT id FROM pc_actions WHERE machine_id=? AND ${DSC_OPEN_SQL} ORDER BY created_at DESC LIMIT 1`).get(machineId) as { id: string } | undefined;
    if (!a) return null;
    const keyId = randomToken(8).slice(0, 12), secret = randomToken(20).slice(0, 32);
    this.db.prepare('UPDATE pc_actions SET receipt_key_id=?, receipt_verifier=? WHERE id=?').run(keyId, hmacHex(this.pepper, secret), a.id);
    return `ah_dsc_${keyId}_${secret}`;
  }
  /** The order a receipt credential may fetch; KeyError('invalid') for anything else. */
  verifyReceipt(presented: string): ActionRow {
    const m = RECEIPT_RE.exec(String(presented).trim());
    const a = m ? this.db.prepare("SELECT * FROM pc_actions WHERE receipt_key_id=? AND kind='disconnect'").get(m[1]!) as unknown as ActionRow | undefined : undefined;
    if (!m || !a || !a.receipt_verifier || !safeEqualHex(a.receipt_verifier, hmacHex(this.pepper, m[2]!))) throw fail('invalid', 'unknown receipt credential');
    if (!DISCONNECT_OPEN.includes(a.state) || a.finished_at !== null || a.ended_at !== null || a.expires_at <= this.now()) throw fail('revoked', 'this receipt credential is retired');
    return a;
  }
  fetchDisconnect(a: ActionRow) {
    if (a.state === 'access_revoked') this.db.prepare("UPDATE pc_actions SET state='cleanup_pending', fetched_at=? WHERE id=?").run(this.now(), a.id);
    const p = parse(a.payload, {} as { remote_cleanup?: boolean | null });
    return { id: a.id, kind: 'disconnect', remote_cleanup: p.remote_cleanup ?? null, removes: DISCONNECT_REMOVES, keeps: DISCONNECT_KEEPS };
  }
  reportDisconnect(a: ActionRow, state: 'removed' | 'needs_attention' | 'cleanup_off', left: string[]) {
    const now = this.now(), clean = this.pcText(a.machine_id, left);
    // After the result the credential is retired: its verifier goes, so it can never be used again. Cleanup turned off on
    // the PC ends the order at Access revoked, said as such.
    const final = state === 'cleanup_off' ? 'access_revoked' : state;
    this.db.prepare('UPDATE pc_actions SET state=?, result=?, finished_at=?, receipt_verifier=NULL WHERE id=?').run(final, JSON.stringify({ left: clean, ...(state === 'cleanup_off' ? { cleanup_off: true } : {}) }), now, a.id);
    this.audit.event({ kind: 'system', id: null }, 'pc.action_report', { kind: 'pc', id: a.machine_id }, { action: a.id, kind: 'disconnect', state });
    return { ok: true };
  }
  /** True while the PC has a disconnect that Re-enrol PC has not ended; Reactivate is refused then. */
  disconnected(machineId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pc_actions WHERE machine_id=? AND kind='disconnect' AND ended_at IS NULL").get(machineId);
  }
  /** Re-enrol PC ends a disconnect: the receipt is retired, the bridge key revoked and the PC active again. */
  endDisconnect(machineId: string, actor: Actor): boolean {
    if (!this.disconnected(machineId)) return false;
    const now = this.now();
    tx(this.db, () => {
      this.db.prepare("UPDATE pc_actions SET ended_at=?, receipt_verifier=NULL WHERE machine_id=? AND kind='disconnect' AND ended_at IS NULL").run(now, machineId);
      this.db.prepare("UPDATE bridge_keys SET status='revoked', revoked_at=? WHERE machine_id=? AND status<>'revoked'").run(now, machineId);
      if (this.keys.machine(machineId)?.status === 'suspended') this.keys.setMachineStatus(machineId, 'active', actor);
    });
    this.audit.event(actor, 'pc.disconnect_end', { kind: 'pc', id: machineId }, {});
    return true;
  }

  // ───── versions ─────
  /** Records a version the first time it is seen; true when it is new (and so pending). */
  private noteVersion(version: string, machineId: string | null): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO connector_versions(version,status,first_seen_at,first_seen_pc) VALUES (?,'pending',?,?)").run(version, this.now(), machineId).changes > 0;
  }
  /** A reported version becomes pending only above the newest approved one, and while fewer than 5 wait. */
  private noteReported(version: string, machineId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM connector_versions WHERE version=?').get(version)) return false;
    const top = this.approvedVersions().at(-1);
    if (top && cmpVersion(version, top) <= 0) return false;
    if ((this.db.prepare("SELECT COUNT(*) n FROM connector_versions WHERE status='pending'").get() as { n: number }).n >= MAX_PENDING_REPORTED) return false;
    return this.noteVersion(version, machineId);
  }
  approvedVersions(): string[] {
    return (this.db.prepare("SELECT version FROM connector_versions WHERE status='approved'").all() as { version: string }[]).map((r) => r.version).sort(cmpVersion);
  }
  versions() {
    const rows = this.db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM connector_reports r WHERE r.version=v.version) pcs FROM connector_versions v`).all() as { version: string }[];
    return rows.sort((a, b) => cmpVersion(b.version, a.version));
  }
  addVersion(version: string, actor: Actor) {
    if (!VERSION_RE.test(version) || version.length > 40) throw fail('invalid_argument', 'version must look like 1.4.0');
    if (this.noteVersion(version, null)) {
      this.audit.event(actor, 'connector.version_add', null, { version });
      this.audit.alert('info', 'connector_version_pending', version, { version, pc: null });
    }
    return this.versions().find((v) => v.version === version)!;
  }
  decideVersion(version: string, status: 'approved' | 'refused', actor: Actor) {
    const r = this.db.prepare('UPDATE connector_versions SET status=?, decided_at=?, decided_by=? WHERE version=?').run(status, this.now(), who(actor), version);
    if (!r.changes) throw fail('not_found', 'Connector version not found');
    this.audit.event(actor, status === 'approved' ? 'connector.version_approve' : 'connector.version_refuse', null, { version });
    this.db.prepare("UPDATE security_alerts SET status='closed', updated_at=? WHERE type='connector_version_pending' AND subject=? AND status<>'closed'").run(this.now(), version);
    return this.versions().find((v) => v.version === version)!;
  }

  // ───── messages: shown on the PC ─────
  /** The PC reports the highest message its reminder line showed the agent; only for an agent whose key is bound here. */
  reportShown(machineId: string, agentId: string, roomId: string, seq: number) {
    const bound = this.db.prepare("SELECT 1 FROM credentials WHERE kind='session_key' AND agent_id=? AND bound_machine_id=? AND status='active'").get(agentId, machineId);
    if (!bound) throw fail('not_found', 'No agent with a key bound to this PC');
    const room = this.db.prepare('SELECT last_seq FROM rooms WHERE id=?').get(roomId) as { last_seq: number } | undefined;
    if (!room || !this.db.prepare('SELECT 1 FROM room_memberships WHERE room_id=? AND agent_id=? AND left_at IS NULL').get(roomId, agentId)) throw fail('not_found', 'Room not found');
    const s = Math.min(seq, room.last_seq), now = this.now();
    this.db.prepare(`INSERT INTO message_shown(agent_id,room_id,shown_seq,machine_id,reported_at) VALUES (?,?,?,?,?)
      ON CONFLICT(agent_id,room_id) DO UPDATE SET shown_seq=MAX(shown_seq, excluded.shown_seq), machine_id=excluded.machine_id, reported_at=excluded.reported_at`).run(agentId, roomId, s, machineId, now);
    return { ok: true };
  }
  messageStates(agentId: string, roomId?: string) {
    const rooms = this.db.prepare(`SELECT DISTINCT room_id FROM room_memberships WHERE agent_id=? AND left_at IS NULL ${roomId ? 'AND room_id=?' : ''}`).all(...(roomId ? [agentId, roomId] : [agentId])) as { room_id: string }[];
    return rooms.map(({ room_id }) => {
      const c = this.db.prepare('SELECT MAX(delivered_seq) d, MAX(acked_seq) k FROM message_delivery_cursors WHERE agent_id=? AND room_id=?').get(agentId, room_id) as { d: number | null; k: number | null };
      const sh = this.db.prepare('SELECT shown_seq, reported_at FROM message_shown WHERE agent_id=? AND room_id=?').get(agentId, room_id) as { shown_seq: number; reported_at: number } | undefined;
      const last = (this.db.prepare('SELECT last_seq FROM rooms WHERE id=?').get(room_id) as { last_seq: number } | undefined)?.last_seq ?? 0;
      return { room_id, last_seq: last, delivered_seq: c.d ?? 0, shown_seq: sh?.shown_seq ?? null, shown_reported_at: sh?.reported_at ?? null, acked_seq: c.k ?? 0 };
    });
  }

  /**
   * What the reminder line counts for an agent whose key is bound to this PC: messages it has not read (past the highest
   * position any of its logins acknowledged), grouped by who sent them, and the top message of each such room, for the
   * PC's shown report. Counts and sender labels only, never message text. A message from no agent is the operator's.
   * Reading this changes nothing: it never advances a delivery position.
   */
  unreadSummary(machineId: string, agentId: string) {
    const bound = this.db.prepare("SELECT 1 FROM credentials WHERE kind='session_key' AND agent_id=? AND bound_machine_id=? AND status='active'").get(agentId, machineId);
    if (!bound) throw fail('not_found', 'No agent with a key bound to this PC');
    const rows = this.db.prepare(`SELECT m.room_id, m.sender_agent_id, a.label, COUNT(*) n, MAX(m.seq) top FROM messages m
      JOIN room_memberships rm ON rm.room_id=m.room_id AND rm.agent_id=? AND rm.left_at IS NULL
      LEFT JOIN agents a ON a.id=m.sender_agent_id
      WHERE m.redacted_at IS NULL AND m.sender_agent_id IS NOT ?
        AND m.seq>COALESCE((SELECT MAX(acked_seq) FROM message_delivery_cursors c WHERE c.agent_id=? AND c.room_id=m.room_id),0)
      GROUP BY m.room_id, m.sender_agent_id`).all(agentId, agentId, agentId) as { room_id: string; sender_agent_id: string | null; label: string | null; n: number; top: number }[];
    const senders = new Map<string, { from: 'operator' | 'agent'; label: string | null; count: number }>();
    const rooms = new Map<string, number>();
    for (const r of rows) {
      const k = r.sender_agent_id ?? '';
      const e = senders.get(k) ?? { from: r.sender_agent_id === null ? 'operator' as const : 'agent' as const, label: r.sender_agent_id === null ? null : r.label, count: 0 };
      e.count += r.n; senders.set(k, e);
      rooms.set(r.room_id, Math.max(rooms.get(r.room_id) ?? 0, r.top));
    }
    const list = [...senders.values()].sort((x, y) => y.count - x.count).slice(0, 5);
    return { total: [...senders.values()].reduce((t, x) => t + x.count, 0), senders: list, rooms: [...rooms].slice(0, 20).map(([room_id, top_seq]) => ({ room_id, top_seq })) };
  }

  /** Where each agent in a conversation stands on its messages: fetched (delivered), shown on its PC (null until a PC reports), read. */
  roomDelivery(roomId: string) {
    const last = (this.db.prepare('SELECT last_seq FROM rooms WHERE id=?').get(roomId) as { last_seq: number } | undefined)?.last_seq ?? 0;
    const members = this.db.prepare('SELECT agent_id FROM room_memberships WHERE room_id=? AND agent_id IS NOT NULL AND left_at IS NULL').all(roomId) as { agent_id: string }[];
    return {
      last_seq: last,
      members: members.map(({ agent_id }) => {
        const s = this.messageStates(agent_id, roomId)[0];
        return { agent_id, delivered_seq: s?.delivered_seq ?? 0, shown_seq: s?.shown_seq ?? null, shown_reported_at: s?.shown_reported_at ?? null, acked_seq: s?.acked_seq ?? 0 };
      }),
    };
  }

  // ───── usage (admin only) ─────
  reportUsage(machineId: string, day: string, report: UsageRow[]) {
    const rows = this.pcText(machineId, report); // the model and client names too
    const st = this.status(machineId);
    if (st.usage_opt_in !== true) throw fail('invalid_state', "The PC's user has not turned usage reports on.");
    const own = this.ownAgents(machineId), other = rows.find((r) => !own.has(r.agent_id));
    if (other) throw fail('invalid_argument', `${other.agent_id} has no key bound to this PC.`);
    const now = this.now();
    tx(this.db, () => {
      this.db.prepare('DELETE FROM connector_usage WHERE machine_id=? AND day=?').run(machineId, day);
      for (const r of rows) {
        this.db.prepare(`INSERT INTO connector_usage(machine_id,day,agent_id,client,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,sessions,turns,reported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(machine_id,day,agent_id,client,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
          cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens, sessions=sessions+excluded.sessions,
          turns=CASE WHEN turns IS NULL OR excluded.turns IS NULL THEN NULL ELSE turns+excluded.turns END`)
          .run(machineId, day, r.agent_id, r.client, r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.sessions, r.turns ?? null, now);
      }
    });
    return { ok: true };
  }
  private cost(r: UsageRow): number | null {
    const p = this.prices[r.model];
    if (!p) return null;
    return (r.input_tokens * p.input + r.output_tokens * p.output + r.cache_read_tokens * (p.cache_read ?? p.input) + r.cache_write_tokens * (p.cache_write ?? p.input)) / 1e6;
  }
  /** Since when a window of `days` days runs, today included. */
  private since(days: number) { return new Date(this.now() - (days - 1) * 86400_000).toISOString().slice(0, 10); }
  /** Rows with their cost, and the total: a cost or a turn count is null (Unknown) when any row has none. */
  private priced(rows: (UsageRow & { day: string })[]) {
    const withCost = rows.map((r) => ({ day: r.day, agent_id: r.agent_id, client: r.client, model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens, sessions: r.sessions, turns: r.turns ?? null, cost_usd: this.cost(r) }));
    return { rows: withCost, total: this.totalOf(withCost) };
  }
  private totalOf(rows: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; turns: number | null; cost_usd: number | null }[]) {
    const sum = (k: 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens') => rows.reduce((s, r) => s + r[k], 0);
    return {
      input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cache_read_tokens: sum('cache_read_tokens'), cache_write_tokens: sum('cache_write_tokens'),
      turns: rows.length && rows.every((r) => r.turns !== null) ? rows.reduce((s, r) => s + r.turns!, 0) : null,
      cost_usd: rows.length && rows.every((r) => r.cost_usd !== null) ? Math.round(rows.reduce((s, r) => s + r.cost_usd!, 0) * 100) / 100 : null,
    };
  }
  usage(machineId: string, days: number) {
    const rows = this.db.prepare('SELECT * FROM connector_usage WHERE machine_id=? AND day>=? ORDER BY day DESC, agent_id, model').all(machineId, this.since(days)) as unknown as (UsageRow & { day: string })[];
    const p = this.priced(rows);
    return { opted_in: this.status(machineId).usage_opt_in, days: p.rows, total: p.total, priced_at: 'API list prices' };
  }
  /**
   * Usage of a set of agents across every PC that reported it (the agent and team views): the total and one line per PC
   * (`by: 'pc'`) or per agent (`by: 'agent'`). `reported` is false while no PC sent anything for them in the window, and
   * the console then reads Unknown, not zero.
   */
  usageOf(agentIds: string[], days: number, by: 'pc' | 'agent') {
    const ids = [...new Set(agentIds)];
    const rows = ids.length ? this.db.prepare(`SELECT u.*, m.name AS pc_name FROM connector_usage u JOIN machines m ON m.id=u.machine_id
      WHERE u.agent_id IN (${ids.map(() => '?').join(',')}) AND u.day>=? ORDER BY u.day DESC, u.agent_id, u.model`).all(...ids, this.since(days)) as unknown as (UsageRow & { day: string; machine_id: string; pc_name: string })[] : [];
    const p = this.priced(rows);
    const groups = new Map<string, { key: string; name: string | null; rows: typeof p.rows }>();
    p.rows.forEach((r, i) => {
      const key = by === 'pc' ? rows[i]!.machine_id : r.agent_id;
      const g = groups.get(key) ?? { key, name: by === 'pc' ? rows[i]!.pc_name : null, rows: [] };
      g.rows.push(r); groups.set(key, g);
    });
    return {
      reported: rows.length > 0, total: p.total, priced_at: 'API list prices',
      by: [...groups.values()].map((g) => ({ [by === 'pc' ? 'pc_id' : 'agent_id']: g.key, ...(by === 'pc' ? { pc_name: g.name } : {}), ...this.totalOf(g.rows) }))
        .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)),
    };
  }
  /** The current members of a team, or null when there is no such team. */
  teamAgents(teamId: string): string[] | null {
    if (!this.db.prepare('SELECT 1 FROM teams WHERE id=?').get(teamId)) return null;
    return (this.db.prepare('SELECT agent_id FROM team_members WHERE team_id=? AND removed_at IS NULL').all(teamId) as { agent_id: string }[]).map((r) => r.agent_id);
  }
  /** Open orders of a PC, for the console's buttons. */
  openKinds(machineId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT kind FROM pc_actions WHERE machine_id=? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`).all(machineId, ...OPEN_STATES) as { kind: string }[]).map((r) => r.kind);
  }
}
