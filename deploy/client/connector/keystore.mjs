/**
 * Where the key file's own secret lives: the "standard isolation" level (docs/connector.md, "Isolation levels").
 *
 * The key file (keyfile.mjs) is AES-256-GCM encrypted at rest. Its 32-byte master secret is held by the platform:
 *
 * - Windows: DPAPI (`ProtectedData`, CurrentUser) through PowerShell; the protected blob is keys.master.
 * - macOS: the login keychain (`security`), one generic password per connector folder.
 * - Linux: the secret service (`secret-tool`) when a session has one, otherwise a 0600 file (keys.master).
 * - Any platform where the store fails: the 0600 file, and `conclave check` says so.
 *
 * What this protects: a key that leaks into a transcript, a log, a backup or a paste is no longer plain text on disk.
 * What it does not: the platform store opens for any process of the same user, so a determined agent running as the PC's
 * user could still ask it. The docs and the local screen say so. The hardened level (an admin-installed key service) closes that.
 *
 * Every system command goes through `io.exec` and every secret goes in through the environment or stdin, never an argument
 * (macOS's `security` takes the secret as an argument: it is on the command line for the moment that command runs).
 * Nothing here ever writes a secret into an error, a log or a reason.
 */
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { readJson, atomicWrite, pathKey } from './paths.mjs';

export const FORMAT = 'conclave-keys-enc';
export const STORES = ['dpapi', 'keychain', 'secret_service', 'file'];
export const masterPath = (home) => join(home, 'keys.master');

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const run = (cmd, args, { input, env } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, input, env: { ...process.env, ...(env ?? {}) } });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
};
/** The seams tests replace: the command runner and the platform. */
export const io = { exec: run, platform: process.platform };

const accountOf = () => { try { return userInfo().username; } catch { return 'user'; } };
const serviceOf = (home) => `conclave-connector-${createHash('sha256').update(pathKey(home)).digest('hex').slice(0, 8)}`;
/** The master secrets already unwrapped by this process, by folder: one DPAPI or keychain call per process, not per read. */
const cache = new Map();
/** Forgets the unwrapped secrets (a test, or a connector that is stopping). */
export const forgetMasters = () => cache.clear();

const DPAPI_PROTECT = "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($env:CONCLAVE_SECRET), $null, 'CurrentUser'))";
const DPAPI_UNPROTECT = "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:CONCLAVE_SECRET), $null, 'CurrentUser'))";
const ps = (script, secret) => io.exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { CONCLAVE_SECRET: secret } });

/** Wraps and unwraps the 32-byte master with one store. `wrap` returns the record kept in keys.master, `unwrap` the master or null. */
const STORE = {
  dpapi: {
    available: () => io.platform === 'win32',
    wrap: (home, master) => { const r = ps(DPAPI_PROTECT, master.toString('base64')); const b = r.stdout.trim(); return r.status === 0 && b ? { blob: b } : null; },
    unwrap: (home, rec) => { if (typeof rec.blob !== 'string') return null; const r = ps(DPAPI_UNPROTECT, rec.blob); return r.status === 0 && r.stdout.trim() ? Buffer.from(r.stdout.trim(), 'base64') : null; },
  },
  keychain: {
    available: () => io.platform === 'darwin',
    wrap: (home, master) => (io.exec('security', ['add-generic-password', '-U', '-s', serviceOf(home), '-a', accountOf(), '-w', master.toString('hex')]).status === 0 ? { ref: serviceOf(home) } : null),
    unwrap: (home) => { const r = io.exec('security', ['find-generic-password', '-s', serviceOf(home), '-a', accountOf(), '-w']); return r.status === 0 && /^[0-9a-f]{64}$/.test(r.stdout.trim()) ? Buffer.from(r.stdout.trim(), 'hex') : null; },
  },
  secret_service: {
    available: () => io.platform === 'linux' && io.exec('secret-tool', ['--version']).status === 0 && !!process.env.DBUS_SESSION_BUS_ADDRESS,
    wrap: (home, master) => (io.exec('secret-tool', ['store', '--label=Conclave connector', 'service', serviceOf(home), 'account', accountOf()], { input: master.toString('hex') }).status === 0 ? { ref: serviceOf(home) } : null),
    unwrap: (home) => { const r = io.exec('secret-tool', ['lookup', 'service', serviceOf(home), 'account', accountOf()]); return r.status === 0 && /^[0-9a-f]{64}$/.test(r.stdout.trim()) ? Buffer.from(r.stdout.trim(), 'hex') : null; },
  },
  file: {
    available: () => true,
    wrap: (home, master) => ({ secret: master.toString('hex') }),
    unwrap: (home, rec) => (typeof rec.secret === 'string' && /^[0-9a-f]{64}$/.test(rec.secret) ? Buffer.from(rec.secret, 'hex') : null),
  },
};

/** The store this PC prefers: CONCLAVE_KEY_STORE=file forces the file (tests, and a user who wants no platform store); else the platform's own. */
export function preferredStores(env = process.env) {
  if (env.CONCLAVE_KEY_STORE === 'file') return ['file'];
  const first = io.platform === 'win32' ? 'dpapi' : io.platform === 'darwin' ? 'keychain' : 'secret_service';
  return [first, 'file'];
}

/** The master secret for this folder, or null when it has none yet and `create` is false. Throws `{reason: 'keystore_unavailable'}` when it exists but cannot be opened. */
export function masterKey(home, { create = false } = {}) {
  const k = pathKey(home);
  if (cache.has(k)) return cache.get(k);
  const rec = readJson(masterPath(home), undefined);
  if (rec === null) throw Object.assign(new Error('the key store record cannot be read'), { reason: 'keystore_unavailable' });
  if (rec) {
    const st = STORE[rec.store];
    const m = st?.available() ? st.unwrap(home, rec) : null;
    if (!m || m.length !== 32) throw Object.assign(new Error(`the key store (${rec.store}) did not give the key file's secret back`), { reason: 'keystore_unavailable' });
    cache.set(k, m);
    return m;
  }
  if (!create) return null;
  const master = randomBytes(32);
  for (const name of preferredStores()) {
    const st = STORE[name];
    if (!st.available()) continue;
    const wrapped = st.wrap(home, master);
    if (!wrapped) continue;
    const check = name === 'file' ? master : st.unwrap(home, wrapped);
    if (!check || !check.equals(master)) continue;
    atomicWrite(masterPath(home), JSON.stringify({ version: 1, store: name, ...wrapped }) + '\n', true);
    cache.set(k, master);
    return master;
  }
  throw Object.assign(new Error('no key store could hold the key file\'s secret'), { reason: 'keystore_unavailable' });
}

/** Which store holds this folder's secret ('dpapi', 'keychain', 'secret_service', 'file'), or null before the first key is written. */
export const storeName = (home) => { const r = readJson(masterPath(home), undefined); return r && STORES.includes(r.store) ? r.store : null; };

/** What `conclave check` and the local screen may say about the store, in plain words. */
export const STORE_LINES = {
  dpapi: 'The key file is encrypted with this Windows user\'s DPAPI key.',
  keychain: 'The key file is encrypted; its secret is in the macOS login keychain.',
  secret_service: 'The key file is encrypted; its secret is in the Linux secret service.',
  file: 'The key file is encrypted; its secret is in a private file next to it (this PC has no platform store the connector can use).',
};

/** True if `text` is an encrypted key file. */
export const isEncrypted = (obj) => !!obj && typeof obj === 'object' && obj.format === FORMAT;

/** The key file's JSON object, encrypted. */
export function encrypt(home, obj) {
  const master = masterKey(home, { create: true });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { format: FORMAT, version: 2, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** The key file's object from its encrypted form; throws `{reason: 'keystore_unavailable' | 'keyfile_unreadable'}`. */
export function decrypt(home, env) {
  const master = masterKey(home);
  if (!master) throw Object.assign(new Error('the key file is encrypted but its secret is gone'), { reason: 'keystore_unavailable' });
  try {
    const d = createDecipheriv('aes-256-gcm', master, Buffer.from(env.iv, 'base64'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8'));
  } catch { throw Object.assign(new Error('the key file cannot be decrypted'), { reason: 'keyfile_unreadable' }); }
}
