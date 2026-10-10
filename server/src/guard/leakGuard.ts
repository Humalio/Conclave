/**
 * Leak guard (SPECIFICATION F7). Scans every string an agent sends for Agent Hub keys
 * and tokens, including spaced, split, case-changed, base64- or hex-encoded forms, and
 * any known key id. A hit is an incident: the caller rejects the call, suspends the key
 * and alerts the admin.
 */

const PREFIXES = '(?:app|ses|tok|brg|set)';
/** Raw form with optional separators between the parts. */
const RAW = new RegExp(`ah[\\s_\\-.:|/\\\\]{0,4}${PREFIXES}[\\s_\\-.:|/\\\\]{0,4}[a-z2-7]{6,}`, 'i');
/** Compact form after removing every non-alphanumeric character. */
const COMPACT = new RegExp(`ah${PREFIXES}[a-z2-7]{40,}`);

const INVISIBLE = /[​-‏⁠-⁤﻿­]/g;

export interface LeakHit { field: string; kind: 'key_pattern' | 'known_key_id' | 'encoded_key'; }

export interface LeakGuardOptions {
  /** Public key ids of all credentials; a match anywhere is a hit. */
  knownKeyIds: () => Iterable<string>;
}

export class LeakGuard {
  constructor(private readonly opts: LeakGuardOptions) {}

  /** Scan any JSON-like value. `skip` lists top-level fields that legitimately carry a key. */
  scan(value: unknown, skip: ReadonlySet<string> = new Set()): LeakHit | null {
    const ids = [...this.opts.knownKeyIds()].map((s) => s.toLowerCase()).filter((s) => s.length >= 8);
    const walk = (v: unknown, field: string, depth: number): LeakHit | null => {
      if (depth > 20) return null;
      if (typeof v === 'string') return this.scanString(v, field, ids, 0);
      if (Array.isArray(v)) { for (const [i, x] of v.entries()) { const h = walk(x, `${field}[${i}]`, depth + 1); if (h) return h; } return null; }
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (depth === 0 && skip.has(k)) continue;
          const kh = this.scanString(k, field ? `${field}.${k}` : k, ids, 0); if (kh) return kh;
          const h = walk(x, field ? `${field}.${k}` : k, depth + 1); if (h) return h;
        }
      }
      return null;
    };
    return walk(value, '', 0);
  }

  scanString(s: string, field: string, ids: string[] = [...this.opts.knownKeyIds()].map((x) => x.toLowerCase()), depth = 0): LeakHit | null {
    if (s.length < 8) return null;
    const visible = s.replace(INVISIBLE, '');
    if (RAW.test(visible)) return { field, kind: depth ? 'encoded_key' : 'key_pattern' };
    const compact = visible.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (COMPACT.test(compact)) return { field, kind: depth ? 'encoded_key' : 'key_pattern' };
    for (const id of ids) if (compact.includes(id)) return { field, kind: 'known_key_id' };
    if (depth < 2) {
      for (const decoded of decodeCandidates(visible)) {
        const h = this.scanString(decoded, field, ids, depth + 1);
        if (h) return { field, kind: 'encoded_key' };
      }
    }
    return null;
  }
}

/** Decode base64 / base64url / hex runs long enough to hide a key. */
function decodeCandidates(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{20,}={0,2}/g)) {
    const b = Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    if (/^[\x20-\x7e\s]+$/.test(b)) out.push(b);
  }
  for (const m of s.matchAll(/(?:[0-9a-fA-F]{2}){12,}/g)) {
    const b = Buffer.from(m[0], 'hex').toString('latin1');
    if (/^[\x20-\x7e\s]+$/.test(b)) out.push(b);
  }
  return out;
}
