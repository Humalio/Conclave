/**
 * Registered relays (docs/relay.md): a relay passes requests on to this hub for PCs that cannot reach it directly. The hub
 * trusts the real client address a relay sends (X-Conclave-Relay-Client) only with that relay's own secret
 * (X-Conclave-Relay-Secret, `ah_rly_<12>_<32>`, shown once, kept only as a verifier).
 */
import type { Db } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import { hmacHex, randomToken, safeEqualHex } from '../util/crypto.js';
import { isIP } from 'node:net';
import { newId } from '../util/ids.js';

export const RELAY_SECRET_RE = /^ah_rly_([a-z2-7]{12})_([a-z2-7]{32})$/;
export const RELAY_SECRET_HEADER = 'x-conclave-relay-secret';
export const RELAY_CLIENT_HEADER = 'x-conclave-relay-client';
const SEEN_EVERY_MS = 30_000;

interface Row { id: string; name: string; origin: string; ca_sha256: string; key_id: string; verifier: string; created_at: number; rotated_at: number | null; last_seen_at: number | null; last_seen_ip: string | null }
export interface RelayView { id: string; name: string; origin: string; ca_sha256: string; created_at: number; rotated_at: number | null; last_seen_at: number | null; last_seen_ip: string | null }
export interface RelayInfo { id: string; name: string; origin: string; ca_sha256: string }

const view = (r: Row): RelayView => ({ id: r.id, name: r.name, origin: r.origin, ca_sha256: r.ca_sha256, created_at: r.created_at, rotated_at: r.rotated_at, last_seen_at: r.last_seen_at, last_seen_ip: r.last_seen_ip });

/** `https://host:port` with nothing else: the form a browser sends as Origin. */
export function relayOrigin(v: unknown): string {
  let u: URL;
  try { u = new URL(String(v)); } catch { throw new KeyError('invalid_argument', 'origin: a URL like https://192.168.1.5:8443'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new KeyError('invalid_argument', 'origin: https://<address>:<port> only, with no path');
  return u.origin;
}

export class Relays {
  private seen = new Map<string, number>();
  constructor(private readonly db: Db, private readonly pepper: string, private readonly audit: Audit, private readonly now: () => number = Date.now) {}

  list(): RelayView[] { return (this.db.prepare('SELECT * FROM relays ORDER BY created_at').all() as unknown as Row[]).map(view); }

  /** The origins of the registered relays: allowed for the console's same-origin check and for MCP. */
  origins(): string[] { return (this.db.prepare('SELECT origin FROM relays').all() as { origin: string }[]).map((r) => r.origin); }

  get(id: string): RelayInfo | null {
    const r = this.db.prepare('SELECT * FROM relays WHERE id=?').get(id) as unknown as Row | undefined;
    return r ? { id: r.id, name: r.name, origin: r.origin, ca_sha256: r.ca_sha256 } : null;
  }

  private mint(): { keyId: string; secret: string; text: string } {
    const keyId = randomToken(10).slice(0, 12), secret = randomToken(20).slice(0, 32);
    return { keyId, secret, text: `ah_rly_${keyId}_${secret}` };
  }

  /** Register a relay. The secret is in the answer once and nowhere else. */
  create(i: { name: string; origin: string; caSha256: string }, actor: Actor): { relay: RelayView; secret: string } {
    const name = String(i.name ?? '').trim();
    if (!name || name.length > 80) throw new KeyError('invalid_argument', 'name: 1 to 80 characters');
    const origin = relayOrigin(i.origin), ca = String(i.caSha256 ?? '').replace(/[\s:]/g, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(ca)) throw new KeyError('invalid_argument', 'ca_sha256: the relay CA certificate\'s SHA-256 fingerprint (64 hex characters)');
    if (this.db.prepare('SELECT 1 FROM relays WHERE name=? OR origin=?').get(name, origin)) throw new KeyError('conflict', 'A relay with this name or origin is already registered.');
    const m = this.mint(), id = newId.relay();
    this.db.prepare('INSERT INTO relays(id,name,origin,ca_sha256,key_id,verifier,created_at) VALUES (?,?,?,?,?,?,?)').run(id, name, origin, ca, m.keyId, hmacHex(this.pepper, m.secret), this.now());
    this.audit.event(actor, 'relay.create', { kind: 'relay', id }, { name, origin });
    return { relay: view(this.row(id)), secret: m.text };
  }

  /** A new secret; the old one stops working at once. */
  rotate(id: string, actor: Actor): { relay: RelayView; secret: string } {
    const r = this.row(id), m = this.mint();
    this.db.prepare('UPDATE relays SET key_id=?, verifier=?, rotated_at=? WHERE id=?').run(m.keyId, hmacHex(this.pepper, m.secret), this.now(), id);
    this.audit.event(actor, 'relay.rotate', { kind: 'relay', id }, { name: r.name });
    return { relay: view(this.row(id)), secret: m.text };
  }

  remove(id: string, actor: Actor): { removed: true } {
    const r = this.row(id);
    this.db.prepare('DELETE FROM relays WHERE id=?').run(id);
    this.seen.delete(id);
    this.audit.event(actor, 'relay.remove', { kind: 'relay', id }, { name: r.name, origin: r.origin });
    return { removed: true };
  }

  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM relays WHERE id=?').get(id) as unknown as Row | undefined;
    if (!r) throw new KeyError('not_found', 'No such relay.');
    return r;
  }

  /** The relay a presented secret belongs to, or null. Constant-time on the verifier; a malformed value costs nothing. */
  verify(presented: unknown): RelayInfo | null {
    const m = typeof presented === 'string' ? RELAY_SECRET_RE.exec(presented.trim()) : null;
    if (!m) return null;
    const r = this.db.prepare('SELECT * FROM relays WHERE key_id=?').get(m[1]!) as unknown as Row | undefined;
    if (!r || !safeEqualHex(r.verifier, hmacHex(this.pepper, m[2]!))) return null;
    return { id: r.id, name: r.name, origin: r.origin, ca_sha256: r.ca_sha256 };
  }

  /** Last seen: from a request with a valid secret, written at most every 30 seconds per relay. */
  touch(id: string, ip: string): void {
    const t = this.now(), last = this.seen.get(id);
    if (last !== undefined && t - last < SEEN_EVERY_MS) return;
    this.seen.set(id, t);
    this.db.prepare('UPDATE relays SET last_seen_at=?, last_seen_ip=? WHERE id=?').run(t, ip, id);
  }

  /** Exact check for the leak guard: is this an issued relay secret? */
  isIssued(keyId: string, secret: string): boolean {
    const r = this.db.prepare('SELECT verifier FROM relays WHERE key_id=?').get(keyId) as { verifier: string } | undefined;
    return !!r && safeEqualHex(r.verifier, hmacHex(this.pepper, secret));
  }
}

declare module 'fastify' { interface FastifyRequest { relay?: RelayInfo | null } }

/** The client address a relay reports: one IPv4 or IPv6 address and nothing else, else null. */
export function clientAddress(v: string): string | null {
  const s = v.trim();
  return s.length <= 45 && isIP(s) ? s : null;
}

/** Where a PC behind a relay finds the signed connector releases: the relay passes this path on to the hub. */
export const releaseBase = (origin: string): string => `${origin}/connector/v1/release`;

/** What a prompt made "through relay X" carries: the relay's origin, its CA fingerprint and the release base. */
export interface ThroughRelay { id: string; name: string; origin: string; ca_sha256: string; release_base: string }
export const through = (r: RelayInfo): ThroughRelay => ({ id: r.id, name: r.name, origin: r.origin, ca_sha256: r.ca_sha256, release_base: releaseBase(r.origin) });
export const relayLines = (r: ThroughRelay): string[] => [`Through relay "${r.name}": ${r.origin}`, `Relay CA certificate SHA-256: ${r.ca_sha256}`, `Release base (signed connector updates): ${r.release_base}`];
