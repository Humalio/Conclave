/**
 * Session-token caches, one per hub and per agent: ~/.config/conclave/tokens/<hub>/<agent>.json (docs/connector.md).
 *
 * A cached token is reused only while it was issued for the very key that is in the key file now: the file stores a
 * short hash of that key beside the token, so a rotation, a removal or a migration drops the token on its next use
 * (review-v2 §1 point 3). Two hubs, or two agents, never share a cache file.
 */
import { join } from 'node:path';
import { rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite } from './paths.mjs';
import { LABEL_RE } from './keyfile.mjs';

const hubDir = (home, hubKey) => join(home, 'tokens', createHash('sha256').update(hubKey).digest('hex').slice(0, 24));
const tokenPath = (home, hubKey, label) => {
  if (!LABEL_RE.test(String(label))) throw new Error('invalid agent label');
  return join(hubDir(home, hubKey), `${label}.json`);
};
/** A short fingerprint of the session key the token was issued for. It does not reveal the key. */
export const keyTag = (sessionKey) => createHash('sha256').update(`conclave-token-tag\0${sessionKey}`).digest('hex').slice(0, 16);

/** The cached token for this hub, agent and key, or null. A token cached for another key is deleted. */
export function readToken(home, hubKey, label, sessionKey) {
  const p = tokenPath(home, hubKey, label);
  const t = readJson(p);
  if (!t || typeof t.token !== 'string' || !t.token) return null;
  if (t.key_tag !== keyTag(sessionKey)) { invalidate(home, hubKey, label); return null; }
  return t.token;
}

export function writeToken(home, hubKey, label, sessionKey, token) {
  atomicWrite(tokenPath(home, hubKey, label), JSON.stringify({ token, key_tag: keyTag(sessionKey) }) + '\n', true);
}

/** Drops one agent's cached token. */
export function invalidate(home, hubKey, label) {
  try { rmSync(tokenPath(home, hubKey, label), { force: true }); } catch { /* already gone */ }
}

/** Drops every token of a hub: when its section is removed, its CA changes, or the PC is migrated. */
export function invalidateHub(home, hubKey) {
  try { rmSync(hubDir(home, hubKey), { recursive: true, force: true }); } catch { /* already gone */ }
}

/** Drops every cached token (migration to the connector, before the old caches could be mistaken for new ones). */
export function invalidateAll(home) {
  try { rmSync(join(home, 'tokens'), { recursive: true, force: true }); } catch { /* already gone */ }
}

export const countTokens = (home, hubKey) => { try { return readdirSync(hubDir(home, hubKey)).length; } catch { return 0; } };
