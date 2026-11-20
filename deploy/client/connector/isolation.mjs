/**
 * Which isolation level this connector folder runs at (docs/connector.md, "Hardened isolation").
 *
 * Standard is the default and has no file. Hardened is recorded in `isolation.json` in the connector folder, written last
 * by the install step, once the key service holds every key:
 *
 *   { "level": "hardened", "address": "<the service's pipe or socket>", "view": "<the public key view>", "vault": "<its folder>", "since": "…" }
 *
 * Nothing in the marker or in the view is secret. The view (`keyview.json`) is the key file as the connector may see it:
 * hubs, origins, CAs and agent labels, with a placeholder where a key was. Only the key service opens a real key.
 */
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, atomicWrite, WIN } from './paths.mjs';
import { serviceId } from './service.mjs';

export const markerPath = (home) => join(home, 'isolation.json');

/** `{level: 'standard'}`, or `{level: 'hardened', address, view, vault, since}` for a well-formed marker. A damaged marker reads as hardened with no address, so nothing falls back to keys by accident. */
export function readIsolation(home) {
  const m = readJson(markerPath(home), undefined);
  if (m === undefined) return { level: 'standard' };
  if (!m || m.level !== 'hardened' || typeof m.address !== 'string' || typeof m.view !== 'string') return { level: 'hardened', address: null, view: null, vault: null, since: null, damaged: true };
  return { level: 'hardened', address: m.address, view: m.view, vault: typeof m.vault === 'string' ? m.vault : null, since: typeof m.since === 'string' ? m.since : null };
}
export const isHardened = (home) => readIsolation(home).level === 'hardened';

/** Records Hardened: written after the service holds the keys and can sign in with each of them. */
export function writeMarker(home, { address, view, vault }) { atomicWrite(markerPath(home), JSON.stringify({ level: 'hardened', address, view, vault, since: new Date().toISOString() }) + '\n'); }

/** The placeholder for the app key and for one agent's session key (the tag changes when the key does). */
export const APP_PLACEHOLDER = 'vault:app';
export const PLACEHOLDER_RE = /vault:(?:app|agent:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[0-9a-f]{8})/g;
export const agentPlaceholder = (label, tag) => `vault:agent:${label}:${tag}`;

/** Where the key service listens for one connector folder: a named pipe on Windows, a socket in the service's run folder elsewhere. */
export function vaultAddress(home, platform = process.platform, runDir = '/run/conclave') {
  const id = serviceId(home);
  return platform === 'win32' ? `\\\\.\\pipe\\conclave-vault-${id}` : posixJoin(runDir, `vault-${id}.sock`);
}
const posixJoin = (a, b) => `${a.replace(/\/+$/, '')}/${b}`;

/** The folders the service uses (pure: tests pass a platform). */
export function vaultPlace(home, { platform = process.platform, programData = process.env.ProgramData ?? 'C:\\ProgramData' } = {}) {
  const id = serviceId(home);
  if (platform === 'win32') {
    const root = `${programData.replace(/[\\/]+$/, '')}\\Conclave\\${id}`;
    return { id, root, dir: `${root}\\vault`, app: `${root}\\app`, view: `${root}\\view\\keyview.json`, address: vaultAddress(home, 'win32') };
  }
  const root = `/var/lib/conclave/${id}`;
  return { id, root, dir: `${root}/vault`, app: `${root}/app`, view: `${root}/view/keyview.json`, address: vaultAddress(home, platform) };
}

/**
 * One call to the key service from a synchronous place (the key file's writers are synchronous). A helper process
 * carries it: the payload, which may hold a key, goes in on standard input and never in an argument or a file.
 * `io.run` is replaced by tests.
 */
export const io = {
  run(input, address) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('./vaultcli.mjs', import.meta.url)), address], { input, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.error || r.status !== 0) return { ok: false, reason: 'vault_unavailable' };
    try { return JSON.parse(r.stdout); } catch { return { ok: false, reason: 'vault_unavailable' }; }
  },
};

/** Calls an operation of the key service and returns its answer; throws an error with a fixed `reason` when it fails. */
export function vaultCallSync(home, op, payload) {
  const iso = readIsolation(home);
  if (!iso.address) throw Object.assign(new Error('the key service is not available'), { reason: 'vault_unavailable' });
  const r = io.run(JSON.stringify({ op, payload }), iso.address);
  if (!r?.ok) throw Object.assign(new Error(`the key service refused (${r?.reason ?? 'vault_unavailable'})`), { reason: r?.reason ?? 'vault_unavailable' });
  return r;
}

export { WIN };
