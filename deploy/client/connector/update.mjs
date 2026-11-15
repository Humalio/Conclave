/**
 * Self-update (docs/connector.md "Self-update"). The hub says only which versions the operator approved; the code comes
 * from the GitHub Releases page named in this build's own signed `release-keys.json`, and is trusted only after
 * `verifyManifest` and `unpackBundle` (release.mjs) pass. Then the build is unpacked beside the current one, started once
 * to confirm it reports its version, and made current. The previous build stays for a rollback.
 */
import https from 'node:https';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTrust, verifyManifest, unpackBundle, releaseNames, compareVersions, platformId, sha256, MAX_BUNDLE } from './release.mjs';
import { installVerified, activate, readBuilds, appDir, discard } from './builds.mjs';
import { CONNECTOR_VERSION } from './version.mjs';

const ASSET_HOSTS = /^(?:github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|[a-z0-9-]+\.githubusercontent\.com)$/;

/**
 * Fetches one release asset from GitHub over the operating system's trust store (integrity comes from the signature,
 * not from TLS), following at most five redirects and only to GitHub's own hosts. Resolves a Buffer of at most `max`.
 */
export function githubAsset(base, tag) {
  const get = (url, max, hops) => new Promise((res, rej) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ASSET_HOSTS.test(u.hostname)) return rej(Object.assign(new Error('not a GitHub address'), { reason: 'download_failed' }));
    const req = https.get(u, { timeout: 60_000, headers: { 'user-agent': 'conclave-connector', accept: 'application/octet-stream' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); if (hops >= 5) return rej(Object.assign(new Error('too many redirects'), { reason: 'download_failed' })); return get(new URL(r.headers.location, u).href, max, hops + 1).then(res, rej); }
      if (r.statusCode !== 200) { r.resume(); return rej(Object.assign(new Error(`HTTP ${r.statusCode}`), { reason: r.statusCode === 404 ? 'not_published' : 'download_failed' })); }
      const parts = []; let n = 0;
      r.on('data', (c) => { n += c.length; if (n > max) r.destroy(Object.assign(new Error('too large'), { reason: 'download_failed' })); else parts.push(c); });
      r.on('end', () => res(Buffer.concat(parts)));
      r.on('error', (e) => rej(Object.assign(e, { reason: e.reason ?? 'download_failed' })));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { reason: 'download_failed' })));
    req.on('error', (e) => rej(Object.assign(e, { reason: e.reason ?? 'download_failed' })));
  });
  return (name, max) => get(`${base}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, max, 0);
}

/** Starts the new build once, in its own folder: it must print the version it claims and exit 0 within 20 s. */
export function selfTestDefault(home, version) {
  const r = spawnSync(process.execPath, [join(appDir(home), version, 'deploy', 'client', 'conclave.mjs'), 'version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true, env: { ...process.env, CONCLAVE_HOME: home } });
  return r.status === 0 && String(r.stdout).trim() === version;
}

/** The newest approved version above the running one that has not failed here before, or null. */
export function pickUpdate(approved, current = CONNECTOR_VERSION, failed = []) {
  const up = (approved ?? []).filter((v) => compareVersions(v, current) === 1 && !failed.includes(v));
  return up.sort((a, b) => compareVersions(a, b)).at(-1) ?? null;
}

/**
 * Updates this installation to `version`: `{ok: true, version, signer}` or `{ok: false, reason}`. `approved` is the hub's
 * list. `getAsset(name, maxBytes)` and `selfTest(home, version)` are for tests; by default they are GitHub and a real start.
 */
export async function updateTo(home, { version, approved, current = CONNECTOR_VERSION, platform = platformId(), trust = loadTrust(), getAsset, selfTest = selfTestDefault }) {
  const names = releaseNames(version);
  const get = getAsset ?? (trust.release_base ? githubAsset(trust.release_base, names.tag) : null);
  if (!get) return { ok: false, reason: 'no_release_source' };
  let manifestText, signature = null;
  try { manifestText = (await get(names.manifest, 64 * 1024)).toString('utf8'); } catch (e) { return { ok: false, reason: e.reason ?? 'download_failed' }; }
  try { signature = (await get(names.signature, 4096)).toString('utf8').trim() || null; } catch (e) { if (e.reason !== 'not_published') return { ok: false, reason: e.reason ?? 'download_failed' }; }
  const v = verifyManifest({ manifestText, signature, trust, wanted: version, current, platform, approved });
  if (!v.ok) return v;
  let bundle;
  try { bundle = await get(names.bundle, MAX_BUNDLE); } catch (e) { return { ok: false, reason: e.reason ?? 'download_failed' }; }
  const u = unpackBundle(bundle, v.manifest.bundle);
  if (!u.ok) return u;
  installVerified(home, version, u.files, sha256(manifestText));
  if (!(await selfTest(home, version))) { discard(home, version); return { ok: false, reason: 'self_test_failed' }; }
  activate(home, version);
  return { ok: true, version, signer: v.signer };
}

/** The fixed sentence for each refusal, for the order's result and the log (at most 200 characters). */
export const UPDATE_REASONS = {
  unsigned: 'The release has no signature, so it was refused.',
  unknown_key: 'The release is signed by a key this connector does not carry, so it was refused.',
  bad_signature: 'The release signature does not match, so it was refused.',
  manifest_invalid: 'The release manifest is not valid, so it was refused.',
  version_mismatch: 'The release is for another version than the one approved, so it was refused.',
  wrong_platform: 'The release is not for this platform, so it was refused.',
  downgrade: 'The version is not above the one running; downgrades are refused.',
  not_approved: 'The operator has not approved this version, so it was refused.',
  bundle_mismatch: 'The downloaded files do not match the signed release, so they were refused.',
  bundle_invalid: 'The downloaded bundle is not valid, so it was refused.',
  bundle_path: 'The bundle names a file outside the connector, so it was refused.',
  self_test_failed: 'The new version did not start, so this PC stays on the current one.',
  not_published: 'The release is not on the Releases page yet.',
  download_failed: 'The release could not be downloaded.',
  no_release_source: 'This connector names no Releases page, so it cannot update.',
};
export const updateLine = (reason) => UPDATE_REASONS[reason] ?? 'The update failed.';
export const failedVersions = (home) => readBuilds(home).failed ?? [];
