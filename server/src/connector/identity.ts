/**
 * The hub's identity for connector pairing (docs/connector.md, "Add PC: download and pairing"): one stable id per hub,
 * made the first time it is asked for and kept in its settings, the HTTPS origin a code is bound to, and the short CA
 * check the console shows beside the pairing code.
 */
import type { Db } from '../db/db.js';
import { randomToken } from '../util/crypto.js';

export const HUB_ID_RE = /^hub-[a-z2-7]{12}$/;
/** A pairing code is valid for 30 minutes, the same lifetime as a checkout's code (review v2 §1 point 1). */
export const PAIRING_MS = 30 * 60_000;

/** The hub's id, `hub-` and 12 base32 characters. Two calls on a new hub agree: the first insert wins. */
export function hubIdentity(db: Db): string {
  const read = () => {
    const r = db.prepare("SELECT value FROM system_settings WHERE key='hub_id'").get() as { value: string } | undefined;
    try { const v = r ? JSON.parse(r.value) : null; return typeof v === 'string' && HUB_ID_RE.test(v) ? v : null; } catch { return null; }
  };
  const have = read();
  if (have) return have;
  db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES ('hub_id',?,?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(`hub-${randomToken(10).slice(0, 12)}`), Date.now());
  return read()!;
}

/** The origin a pairing code is bound to: the hub's public URL when it is HTTPS, otherwise null (nothing to pin). */
export function httpsOrigin(url: string | null | undefined): string | null {
  try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.origin : null; } catch { return null; }
}

/** The short CA check the console shows and the PC's user types: the first 16 hex characters, in groups of four. */
export const caCheck = (sha256: string): string => sha256.slice(0, 16).match(/.{4}/g)!.join(' ');

/**
 * The prompt for a PC with the connector (docs/onboarding.md, "The prompt and the request"). It carries no code and no
 * key: the code goes into the connector's own pairing screen, and the agent only drafts and files the team request.
 */
export function connectorPrompt(o: { pc: string; hubUrl: string; relay?: string }): string {
  return [
    `Set up a Conclave team on this PC ("${o.pc}", hub ${o.hubUrl}${o.relay ? `, through relay "${o.relay}"` : ''}).`,
    '',
    'The Conclave connector is installed and paired on this PC; you never handle a pairing code or a key.',
    '1. Ask the user what the team should do, then draft the team request as a JSON file. `conclave setup schema` prints its shape and rules.',
    '2. Check it with `conclave setup request --file <path> --check` and fix what it reports.',
    '3. File it with `conclave setup request --file <path>`. The operator approves it in the Conclave console.',
    '4. Tell the user that the connector\'s screen shows each agent once it is approved, with the way to open it.',
  ].join('\n');
}
