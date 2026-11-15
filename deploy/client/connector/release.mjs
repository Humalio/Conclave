/**
 * Signed connector releases (docs/connector.md "Self-update", docs/connector-release.md). Node 18 or later, no dependencies.
 *
 * A release is three files on the GitHub Releases page: a manifest (JSON), its Ed25519 signature, and a bundle of the
 * connector's files. The connector trusts a release only against the release keys it carries in its own signed files
 * (`release-keys.json`), never against anything the hub says. The hub only says which versions the operator approved.
 *
 * Every check here is pure: bytes in, `{ok, reason}` out. A reason is a fixed code; nothing from the release is echoed.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_FORMAT = 'conclave-connector-release/1';
export const KEYS_FORMAT = 'conclave-release-keys/1';
export const ROLLOVER_CONTEXT = 'conclave-release-key-rollover/1';
export const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
export const MAX_BUNDLE = 25 * 1024 * 1024;
const MAX_FILES = 500;
/** A bundle file: a plain relative path under the connector's two folders, no `..`, no backslash, no drive. */
const FILE_RE = /^deploy\/client(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** This PC's platform as the manifest and the check-in name it: `win32-x64`, `darwin-arm64`, `linux-x64`, … */
export const platformId = (p = process.platform, a = process.arch) => `${p}-${a}`;

/** -1, 0 or 1. A pre-release sorts below its release (1.0.0-rc.1 < 1.0.0). Null if either is not a version. */
export function compareVersions(a, b) {
  if (!VERSION_RE.test(String(a)) || !VERSION_RE.test(String(b))) return null;
  const split = (v) => { const [core, pre] = v.split('-', 2); return { n: core.split('.').map(Number), pre: pre ?? null }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The id of a public key: the first 16 hex digits of the SHA-256 of its SPKI DER (base64 in the files). */
export const keyIdOf = (publicKeyB64) => sha256(Buffer.from(publicKeyB64, 'base64')).slice(0, 16);

/** A public Ed25519 key from a key entry `{id, public_key}`, or null if the entry is malformed or its id does not match. */
export function keyOf(entry) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.public_key !== 'string' || !B64_RE.test(entry.public_key)) return null;
  if (keyIdOf(entry.public_key) !== entry.id) return null;
  try {
    const k = createPublicKey({ key: Buffer.from(entry.public_key, 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ed25519' ? k : null;
  } catch { return null; }
}

/** The release keys this build carries: `{release_base, keys: [{id, public_key}]}`. A malformed entry is left out. */
export function loadTrust(file = join(dirname(fileURLToPath(import.meta.url)), 'release-keys.json')) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return { release_base: null, keys: [] }; }
  if (!j || j.format !== KEYS_FORMAT) return { release_base: null, keys: [] };
  const base = typeof j.release_base === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download$/.test(j.release_base) ? j.release_base : null;
  return { release_base: base, keys: (Array.isArray(j.keys) ? j.keys : []).filter((k) => keyOf(k)) };
}

/** The text a rollover signature covers: the new key's id and public key, under a fixed context. */
export const rolloverText = (key) => `${ROLLOVER_CONTEXT}\n${key.id}\n${key.public_key}\n`;
const sigOk = (text, sigB64, key) => {
  if (typeof sigB64 !== 'string' || !B64_RE.test(sigB64.trim())) return false;
  try { return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(sigB64.trim(), 'base64')); } catch { return false; }
};

/** The asset names of a release, and its tag on the Releases page. */
export const releaseNames = (version) => ({
  tag: `connector-v${version}`,
  manifest: `conclave-connector-${version}.json`,
  signature: `conclave-connector-${version}.json.sig`,
  bundle: `conclave-connector-${version}.bundle`,
  installer: `conclave-install-${version}.mjs`,
});

/** The marker in the installer template (deploy/client/install.mjs) that the release script fills in. */
export const INSTALLER_MARK = '/*@@CONCLAVE_INSTALLER_EMBED@@*/null';
/**
 * The installer for a release: the template with the version, the Releases page and the public release keys filled in.
 * Public values only; the installer checks the release against these keys before anything of it runs.
 */
export function buildInstaller(template, { version, release_base, keys }) {
  if (template.split(INSTALLER_MARK).length !== 2) throw new Error('the installer template has no single embed marker');
  if (!VERSION_RE.test(String(version)) || !Array.isArray(keys) || !keys.length || !keys.every((k) => keyOf(k))) throw new Error('an installer needs a version and at least one valid release key');
  return template.replace(INSTALLER_MARK, () => JSON.stringify({ version, release_base, keys: keys.map((k) => ({ id: k.id, public_key: k.public_key })) }));
}

/**
 * Checks a release manifest before anything is unpacked or run. In this order: signed by a carried key (or by a new key
 * a carried key vouches for), well formed, exactly the version asked for, this platform, above the running version, and
 * approved by the operator. `{ok: true, manifest, signer, newKey}` or `{ok: false, reason}`.
 */
export function verifyManifest({ manifestText, signature, trust, wanted, current, platform = platformId(), approved }) {
  if (typeof manifestText !== 'string' || manifestText.length > 64 * 1024) return { ok: false, reason: 'manifest_invalid' };
  if (!signature) return { ok: false, reason: 'unsigned' };
  let m;
  try { m = JSON.parse(manifestText); } catch { return { ok: false, reason: 'manifest_invalid' }; }
  if (!m || typeof m !== 'object' || m.format !== MANIFEST_FORMAT || typeof m.key_id !== 'string') return { ok: false, reason: 'manifest_invalid' };
  // The signer: a key this build carries, or a rollover key signed by one it carries.
  let signer = (trust?.keys ?? []).find((k) => k.id === m.key_id) ?? null;
  let newKey = null;
  if (!signer && m.rollover && typeof m.rollover === 'object') {
    const r = m.rollover;
    const by = (trust?.keys ?? []).find((k) => k.id === r.signed_by);
    if (by && r.key?.id === m.key_id && keyOf(r.key) && sigOk(rolloverText(r.key), r.signature, keyOf(by))) { signer = r.key; newKey = r.key; }
  }
  if (!signer) return { ok: false, reason: 'unknown_key' };
  if (!sigOk(manifestText, signature, keyOf(signer))) return { ok: false, reason: 'bad_signature' };
  const b = m.bundle;
  if (!VERSION_RE.test(String(m.version)) || String(m.version).length > 40 || !Array.isArray(m.platforms) || !b || typeof b !== 'object'
    || typeof b.name !== 'string' || !SHA_RE.test(String(b.sha256)) || !Number.isSafeInteger(b.size) || b.size <= 0 || b.size > MAX_BUNDLE) return { ok: false, reason: 'manifest_invalid' };
  if (m.version !== wanted) return { ok: false, reason: 'version_mismatch' };
  if (b.name !== releaseNames(m.version).bundle) return { ok: false, reason: 'manifest_invalid' };
  if (!m.platforms.includes(platform)) return { ok: false, reason: 'wrong_platform' };
  const c = compareVersions(m.version, current);
  if (c === null || c <= 0) return { ok: false, reason: 'downgrade' };
  if (!Array.isArray(approved) || !approved.includes(m.version)) return { ok: false, reason: 'not_approved' };
  return { ok: true, manifest: m, signer: signer.id, newKey };
}

// ───────────── the bundle: [u32be header length][JSON {"p", "s"}][bytes] …, ended by a zero length ─────────────

/** Packs `[{path, data}]` into one bundle. Paths are checked the same way unpacking checks them. */
export function packBundle(files) {
  const parts = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!FILE_RE.test(f.path) || f.path.split('/').includes('..')) throw new Error(`not a bundle path: ${f.path}`);
    const h = Buffer.from(JSON.stringify({ p: f.path, s: f.data.length }), 'utf8');
    const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
    parts.push(len, h, f.data);
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

/** Unpacks a bundle whose size and hash match the signed manifest: `{ok, files}` or `{ok: false, reason}`. Nothing is written. */
export function unpackBundle(buf, expect) {
  if (!Buffer.isBuffer(buf) || buf.length !== expect.size || sha256(buf) !== expect.sha256) return { ok: false, reason: 'bundle_mismatch' };
  const files = [], seen = new Set();
  let o = 0;
  for (;;) {
    if (o + 4 > buf.length) return { ok: false, reason: 'bundle_invalid' };
    const n = buf.readUInt32BE(o); o += 4;
    if (n === 0) break;
    if (n > 4096 || o + n > buf.length) return { ok: false, reason: 'bundle_invalid' };
    let h;
    try { h = JSON.parse(buf.subarray(o, o + n).toString('utf8')); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    o += n;
    if (!h || typeof h.p !== 'string' || !FILE_RE.test(h.p) || h.p.split('/').includes('..') || seen.has(h.p.toLowerCase())) return { ok: false, reason: 'bundle_path' };
    if (!Number.isSafeInteger(h.s) || h.s < 0 || o + h.s > buf.length) return { ok: false, reason: 'bundle_invalid' };
    seen.add(h.p.toLowerCase());
    files.push({ path: h.p, data: buf.subarray(o, o + h.s) });
    o += h.s;
    if (files.length > MAX_FILES) return { ok: false, reason: 'bundle_invalid' };
  }
  if (o !== buf.length) return { ok: false, reason: 'bundle_invalid' };
  if (!files.some((f) => f.path === 'deploy/client/conclave.mjs')) return { ok: false, reason: 'bundle_invalid' };
  return { ok: true, files };
}

/** The files a release carries, relative to the repository root (the release script and the tests use this list). */
export const RELEASE_ROOTS = ['deploy/client/conclave.mjs', 'deploy/client/connector'];
