/**
 * The connector's key file: ~/.config/conclave/keys.json, one section per hub (docs/connector.md).
 *
 * A section is keyed by the hub's identity AND the fingerprint of its CA, so two hubs never share a key and a hub whose
 * CA changed is a different section until the PC user confirms the change locally. Each section holds the hub's
 * pinned origin, the CA certificate, the PC's app key and the session key of every agent registered for that hub.
 * The file belongs to the connector and is written only through this module: values never leave it except through
 * `agentKeys`, which the relay calls in its own process. Nothing here ever puts a key into an error, a log or a reason.
 *
 *   { "version": 1, "hubs": { "<hub id>@<CA sha-256>": {
 *       "hub_id": "…", "origin": "https://host:8443", "ca_sha256": "<64 hex>", "ca_pem": "-----BEGIN CERTIFICATE-----…",
 *       "app_key": "…", "agents": { "<agent label>": { "session_key": "…" } } } } }
 */
import { X509Certificate } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeState, withLock, bakPath, WIN } from './paths.mjs';
import { isEncrypted, encrypt, decrypt } from './keystore.mjs';
import { readIsolation, vaultCallSync } from './isolation.mjs';

export const HUB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;
export const keyFilePath = (home) => join(home, 'keys.json');
export const hubKeyOf = (hubId, caSha256) => `${hubId}@${caSha256}`;

/** How many PEM blocks a text holds. A pinned CA is exactly one: Node would trust every certificate of a bundle. */
export const pemBlocks = (pem) => (String(pem ?? '').match(/-----BEGIN [^-\r\n]+-----/g) ?? []).length;
/**
 * The one CA certificate of a PEM text, re-encoded from the parsed certificate (so nothing else in the text is kept),
 * or null: no certificate, or more than one PEM block. Only this text is pinned and stored.
 */
export function singleCaPem(pem) {
  if (pemBlocks(pem) !== 1) return null;
  try { return new X509Certificate(String(pem)).toString(); } catch { return null; }
}
/**
 * The SHA-256 of a CA certificate (PEM), as 64 lower-case hex digits, or null if it is not exactly one certificate.
 * A text with a second certificate has no fingerprint: the first one's would pin a file that trusts both.
 */
export function caFingerprint(pem) {
  const one = singleCaPem(pem);
  try { return one ? new X509Certificate(one).fingerprint256.replace(/:/g, '').toLowerCase() : null; } catch { return null; }
}

/** The origin, normalised (https, host and optional port only), or null: no plain http, no credentials, no path. */
export function normalizeOrigin(o) {
  let u;
  try { u = new URL(String(o)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  return u.origin;
}

/**
 * Reads the key file: `{ok: true, data}`, or `{ok: false, reason}` with a fixed reason code. A missing file is an empty
 * one. On macOS and Linux a file other users can read is refused (Windows reports mode bits that never pass this test;
 * NTFS ACLs on the profile protect the file there).
 */
export function readKeyFile(home) {
  const iso = readIsolation(home);
  if (iso.level === 'hardened') return readView(iso);
  const path = keyFilePath(home);
  let st;
  try { st = statSync(path); } catch (e) { if (e.code === 'ENOENT') return { ok: true, data: { version: 1, hubs: {} } }; return { ok: false, reason: 'keyfile_unreadable' }; }
  if (!st.isFile()) return { ok: false, reason: 'keyfile_unreadable' };
  if (!WIN && (st.mode & 0o077)) return { ok: false, reason: 'keyfile_unsafe' };
  let data = readJson(path);
  // A file a crash left unreadable is read from its flushed copy (paths.mjs `writeState`), under the same mode rule.
  if (data === null) { try { const b = statSync(bakPath(path)); if (b.isFile() && (WIN || !(b.mode & 0o077))) data = readJson(bakPath(path), null); } catch { /* no copy */ } }
  // At rest the file is encrypted (keystore.mjs); a plain file from an older connector is still read and is encrypted at its next write.
  if (isEncrypted(data)) { try { data = decrypt(home, data); } catch (e) { return { ok: false, reason: e.reason ?? 'keyfile_unreadable' }; } }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !data.hubs || typeof data.hubs !== 'object' || Array.isArray(data.hubs)) return { ok: false, reason: 'keyfile_unreadable' };
  return { ok: true, data };
}

/**
 * At the hardened level the connector's "key file" is the key service's public view: the same shape, a placeholder where
 * every key was (isolation.mjs). Nothing here is secret, and the file is not the user's to write.
 */
function readView(iso) {
  const v = iso.view ? readJson(iso.view, undefined) : undefined;
  if (v === undefined) return { ok: false, reason: 'vault_unavailable' };
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.version !== 1 || !v.hubs || typeof v.hubs !== 'object' || Array.isArray(v.hubs)) return { ok: false, reason: 'keyfile_unreadable' };
  return { ok: true, data: v };
}
/** Writes the user-level key file directly (the key service's uninstall puts the keys back; nothing else may bypass the hardened level). */
export function restoreKeyFile(home, data) { write(home, data); }
/** Whether this PC has a key file at all (the service's view counts at the hardened level). */
export function keyFilePresent(home) {
  const iso = readIsolation(home);
  try { statSync(iso.level === 'hardened' ? (iso.view ?? '') : keyFilePath(home)); return true; } catch { return false; }
}

function write(home, data) { writeState(keyFilePath(home), JSON.stringify(encrypt(home, data)) + '\n', true); }
/** One read-change-write of the key file under its lock. */
const locked = (home, fn) => withLock(keyFilePath(home), fn);

/** Encrypts a plain key file from an older connector in place. Returns whether it changed anything; a file that cannot be read is left alone. */
export function encryptInPlace(home) {
  if (readIsolation(home).level === 'hardened') return false;
  // Looked at first without the lock: with no key file (an uninstalled folder) nothing is created, not even the lock.
  const first = readJson(keyFilePath(home), undefined);
  if (!first || isEncrypted(first)) return false;
  return locked(home, () => {
  const raw = readJson(keyFilePath(home), undefined);
  if (!raw || isEncrypted(raw)) return false;
  const r = readKeyFile(home);
  if (!r.ok) return false;
  write(home, r.data);
  return true;
}); }
function load(home) {
  const r = readKeyFile(home);
  if (!r.ok) throw Object.assign(new Error(`the key file cannot be used (${r.reason})`), { reason: r.reason });
  return r.data;
}

/** Validates the parts of a hub section that are not secrets; throws a plain error naming the field. */
function checkHub({ hubId, origin, caPem }) {
  if (!HUB_ID_RE.test(String(hubId))) throw new Error('hub id: letters, digits, dot, dash and underscore only');
  const o = normalizeOrigin(origin);
  if (!o) throw new Error('hub origin must be a plain https address (no plain http, no credentials, no path)');
  const fp = caFingerprint(caPem);
  if (!fp) throw new Error('the hub CA must be exactly one PEM certificate');
  return { origin: o, ca_sha256: fp, ca_pem: singleCaPem(caPem) };
}

/** Adds or replaces the section for a hub (called by pairing). Its agents are kept when the section already exists. */
export function putHub(home, { hubId, origin, caPem, appKey }) {
  const { origin: o, ca_sha256, ca_pem } = checkHub({ hubId, origin, caPem });
  if (typeof appKey !== 'string' || !appKey) throw new Error('an app key is required');
  if (readIsolation(home).level === 'hardened') return vaultCallSync(home, 'put_hub', { hubId, origin, caPem, appKey }).hub_key;
  return locked(home, () => {
    const data = load(home);
    const k = hubKeyOf(hubId, ca_sha256);
    data.hubs[k] = { hub_id: hubId, origin: o, ca_sha256, ca_pem, app_key: appKey, agents: data.hubs[k]?.agents ?? {} };
    write(home, data);
    return k;
  });
}

/** Sets an agent's session key in a hub's section (called by pairing, and by a collected rotation). */
export function putAgentKey(home, hubKey, label, sessionKey) {
  if (!LABEL_RE.test(String(label))) throw new Error('agent label: letters, digits, dash and underscore only');
  if (typeof sessionKey !== 'string' || !sessionKey) throw new Error('a session key is required');
  if (readIsolation(home).level === 'hardened') { vaultCallSync(home, 'put_agent', { hubKey, label, sessionKey }); return; }
  locked(home, () => {
    const data = load(home);
    if (!data.hubs[hubKey]) throw new Error('no such hub section');
    data.hubs[hubKey].agents[label] = { session_key: sessionKey };
    write(home, data);
  });
}

/** Removes one agent's key, or a whole hub's section (disconnect). Returns whether anything was removed. */
export function removeAgentKey(home, hubKey, label) {
  if (readIsolation(home).level === 'hardened') return vaultCallSync(home, 'remove_agent', { hubKey, label }).removed === true;
  return locked(home, () => {
  const data = load(home);
  if (!data.hubs[hubKey]?.agents?.[label]) return false;
  delete data.hubs[hubKey].agents[label];
  write(home, data);
  return true;
}); }
/**
 * Marks a hub's section as disconnected (Disconnect with remote cleanup off: nothing on disk is removed, the keys are dead).
 * The worker then stops checking in with it. Pairing again writes the section anew, which clears the mark.
 */
export function markDisconnected(home, hubKey, at = new Date().toISOString()) {
  // At the hardened level the key service owns the file: it marks the section, and its public view (what the worker reads) shows it.
  if (readIsolation(home).level === 'hardened') return vaultCallSync(home, 'mark_disconnected', { hubKey, at }).marked === true;
  return locked(home, () => {
    const data = load(home);
    if (!data.hubs[hubKey] || data.hubs[hubKey].disconnected_at) return false;
    data.hubs[hubKey].disconnected_at = at;
    write(home, data);
    return true;
  });
}

export function removeHub(home, hubKey) {
  if (readIsolation(home).level === 'hardened') return vaultCallSync(home, 'remove_hub', { hubKey }).removed === true;
  return locked(home, () => {
  const data = load(home);
  if (!data.hubs[hubKey]) return false;
  delete data.hubs[hubKey];
  write(home, data);
  return true;
}); }

/**
 * Finds the section a registered folder belongs to, by hub identity AND CA fingerprint. Never falls back to another
 * section: `{reason: 'ca_changed'}` when the hub is known under another CA, `{reason: 'no_hub_key'}` when it is not known.
 */
export function findHub(data, hubId, caSha256) {
  const k = hubKeyOf(hubId, caSha256);
  const s = data.hubs[k];
  // A section whose CA text holds more than one certificate is never used, whatever its fingerprint says.
  if (s && pemBlocks(s.ca_pem) !== 1) return { ok: false, reason: 'ca_bundle' };
  if (s && s.hub_id === hubId && s.ca_sha256 === caSha256 && caFingerprint(s.ca_pem) === caSha256 && normalizeOrigin(s.origin)) return { ok: true, hubKey: k, section: s };
  if (!s && Object.values(data.hubs).some((x) => x && x.hub_id === hubId)) return { ok: false, reason: 'ca_changed' };
  if (s && !normalizeOrigin(s.origin)) return { ok: false, reason: 'not_https' };
  return { ok: false, reason: 'no_hub_key' };
}

/** The session key of one agent in a section, or null. For the relay only. */
export const agentKey = (section, label) => (typeof section?.agents?.[label]?.session_key === 'string' && section.agents[label].session_key) || null;

/** What the console and `conclave check` may say about the file: hub keys, agent labels and counts, never a value. */
export function describe(data) {
  return Object.entries(data.hubs).map(([k, s]) => ({ hub_key: k, hub_id: s.hub_id, origin: s.origin, ca_sha256: s.ca_sha256, agents: Object.keys(s.agents ?? {}) }));
}
