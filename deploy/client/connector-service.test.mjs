/**
 * Tests for the connector service (docs/connector.md "The connector service", docs/connector-release.md): signed
 * self-update and its refusals, the bundle's path rule, rollback only to a verified build, PC actions from the fixed
 * list with typed data only, the logon entry per platform, and the worker's check-in and orders against a stub hub.
 * Plain node:test, run with `npm run test:helper` in server/. Nothing touches the real ~/.config/conclave, the user's
 * scheduled tasks, LaunchAgents or systemd units: system commands go to a recording fake, files to temporary folders.
 * Every release key here is a throwaway made for the test.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyManifest, packBundle, unpackBundle, releaseNames, keyIdOf, rolloverText, sha256, compareVersions, MANIFEST_FORMAT, platformId, loadTrust } from './connector/release.mjs';
import { readBuilds, installVerified, activate, adoptRunning, rollback, intact, releaseFiles, launcherPath, LAUNCHER, confirm } from './connector/builds.mjs';
import { updateTo, pickUpdate } from './connector/update.mjs';
import { validateOrder, firstTime } from './connector/orders.mjs';
import { serviceSpec, servicePlace, serviceTargets, installService, removeService, serviceStatus } from './connector/service.mjs';
import { validateEntry } from './connector/manifest.mjs';
import { readSettings, setSwitch } from './connector/settings.mjs';
import { usageOptIn, setUsageOptIn, recordUsageEvent, sessionsPath } from './connector/usage.mjs';
import { markRunning, runningAgents } from './connector/run.mjs';
import { runWorker, runSupervisor, NO_HUBS, LOCKED } from './connector/worker.mjs';
import { runningAs, processesPath, takeProcessLock, lockHolder } from './connector/processes.mjs';
import { workerLockPath, servicePidPath, RESTART_COUNT, RESTART_INTERVAL_MIN } from './connector/service.mjs';
import { markUp } from './connector/builds.mjs';
import { writeState, readState, withLock, bakPath } from './connector/paths.mjs';
import { manifestPath } from './connector/manifest.mjs';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { putHub, caFingerprint, keyFilePath, readKeyFile } from './connector/keyfile.mjs';
import { CONNECTOR_VERSION } from './connector/version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const tmp = [];
const mk = (p = 'conclave-svc-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

// ───────────── throwaway release keys and releases ─────────────
const newKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { priv: privateKey, entry: { id: keyIdOf(der), public_key: der } };
};
const K1 = newKey(), K2 = newKey(), STRANGER = newKey();
const trust1 = { release_base: null, keys: [K1.entry] };

/** The real connector files of this checkout, with version.mjs saying `version`. */
function filesAt(version) {
  return releaseFiles(REPO).map((f) => (f.path === 'deploy/client/connector/version.mjs' ? { path: f.path, data: Buffer.from(`export const CONNECTOR_VERSION = '${version}';\n`) } : f));
}
/** A release as GitHub would serve it: `{assets: {name: Buffer}, manifest, text}`. */
function release(version, { key = K1, files = filesAt(version), platforms = [platformId()], rollover = null, mutate } = {}) {
  const n = releaseNames(version);
  const bundle = packBundle(files);
  const manifest = { format: MANIFEST_FORMAT, version, platforms, bundle: { name: n.bundle, sha256: sha256(bundle), size: bundle.length }, git: null, key_id: key.entry.id, rollover, created_at: '2026-11-20T00:00:00Z' };
  mutate?.(manifest);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const sig = edSign(null, Buffer.from(text), key.priv).toString('base64');
  return { manifest, text, sig, assets: { [n.manifest]: Buffer.from(text), [n.signature]: Buffer.from(sig + '\n'), [n.bundle]: bundle } };
}
const getter = (assets) => async (name) => { if (!(name in assets)) throw Object.assign(new Error('404'), { reason: 'not_published' }); return assets[name]; };
const check = (r, o = {}) => verifyManifest({ manifestText: r.text, signature: r.sig, trust: trust1, wanted: r.manifest.version, current: '1.0.0', platform: platformId(), approved: [r.manifest.version], ...o });

describe('a release is trusted only when signed, approved, for this platform and newer', () => {
  test('a release signed by a carried key, approved and newer, passes', () => {
    const r = check(release('1.1.0'));
    assert.equal(r.ok, true);
    assert.equal(r.signer, K1.entry.id);
  });
  test('an unsigned release is refused', () => assert.equal(check(release('1.1.0'), { signature: null }).reason, 'unsigned'));
  test('a changed manifest is refused: the signature no longer matches', () => {
    const r = release('1.1.0');
    assert.equal(check({ ...r, text: r.text.replace('"1.1.0"', '"1.1.0" ') }).reason, 'bad_signature');
  });
  test('a release signed by a key the connector does not carry is refused', () => assert.equal(check(release('1.1.0', { key: STRANGER })).reason, 'unknown_key'));
  test('a version the operator did not approve is refused', () => assert.equal(check(release('1.1.0'), { approved: ['1.2.0'] }).reason, 'not_approved'));
  test('a downgrade is refused, and so is the same version', () => {
    assert.equal(check(release('0.9.0')).reason, 'downgrade');
    assert.equal(check(release('1.0.0')).reason, 'downgrade');
    assert.equal(check(release('1.0.0-rc.1')).reason, 'downgrade');
  });
  test('a manifest for another version than the one asked for is refused', () => assert.equal(check(release('1.1.0'), { wanted: '1.2.0', approved: ['1.1.0', '1.2.0'] }).reason, 'version_mismatch'));
  test('a release for another platform is refused', () => assert.equal(check(release('1.1.0', { platforms: ['plan9-mips'] })).reason, 'wrong_platform'));
  test('a key rollover is accepted only when a carried key signed it', () => {
    const good = { key: K2.entry, signed_by: K1.entry.id, signature: edSign(null, Buffer.from(rolloverText(K2.entry)), K1.priv).toString('base64') };
    const r = check(release('1.1.0', { key: K2, rollover: good }));
    assert.equal(r.ok, true);
    assert.equal(r.newKey.id, K2.entry.id);
    const forged = { key: K2.entry, signed_by: STRANGER.entry.id, signature: edSign(null, Buffer.from(rolloverText(K2.entry)), STRANGER.priv).toString('base64') };
    assert.equal(check(release('1.1.0', { key: K2, rollover: forged })).reason, 'unknown_key');
    const selfSigned = { key: K2.entry, signed_by: K1.entry.id, signature: edSign(null, Buffer.from(rolloverText(K2.entry)), K2.priv).toString('base64') };
    assert.equal(check(release('1.1.0', { key: K2, rollover: selfSigned })).reason, 'unknown_key');
  });
  test('a key entry whose id does not match its key is not trusted', () => {
    const lying = { ...K1.entry, id: STRANGER.entry.id };
    assert.equal(verifyManifest({ manifestText: release('1.1.0', { key: STRANGER }).text, signature: release('1.1.0', { key: STRANGER }).sig, trust: { keys: [lying] }, wanted: '1.1.0', current: '1.0.0', approved: ['1.1.0'] }).reason, 'bad_signature');
  });
  test('versions compare by number, and a pre-release is below its release', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0', '1.0.0'), null);
    assert.equal(pickUpdate(['1.0.0', '1.2.0', '1.1.0'], '1.0.0', ['1.2.0']), '1.1.0');
  });
  test('the carried release-keys.json is well formed and names the Conclave Releases page', () => {
    const t = loadTrust();
    assert.match(t.release_base, /^https:\/\/github\.com\/.+\/releases\/download$/);
    assert.ok(Array.isArray(t.keys));
    const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'connector', 'release-keys.json'), 'utf8'));
    assert.equal(t.keys.length, raw.keys.length, 'every carried key is a valid Ed25519 key whose id matches it');
    assert.ok(t.keys.some((k) => k.id === 'bda3b8c35cfa902a'), 'the Conclave release signing key');
  });
});

describe('the bundle holds connector files only, exactly as signed', () => {
  const one = [{ path: 'deploy/client/conclave.mjs', data: Buffer.from('x') }];
  test('a bundle whose bytes differ from the signed hash is refused', () => {
    const b = packBundle(one);
    assert.equal(unpackBundle(b, { size: b.length, sha256: '0'.repeat(64) }).reason, 'bundle_mismatch');
  });
  test('packing refuses a path outside the connector', () => {
    for (const p of ['../evil.mjs', 'deploy/client/../../evil.mjs', '/etc/passwd', 'C:/x.mjs', 'deploy\\client\\x.mjs', 'server/src/app.ts']) assert.throws(() => packBundle([{ path: p, data: Buffer.from('') }]), /not a bundle path/, p);
  });
  test('unpacking refuses a hand-made bundle with a path outside the connector', () => {
    for (const p of ['deploy/client/../../../evil.mjs', '../x', 'deploy/client/.hidden/../x']) {
      const h = Buffer.from(JSON.stringify({ p, s: 1 }));
      const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
      const b = Buffer.concat([len, h, Buffer.from('x'), Buffer.alloc(4)]);
      assert.equal(unpackBundle(b, { size: b.length, sha256: sha256(b) }).reason, 'bundle_path', p);
    }
  });
  test('the release carries the connector and its modules only: no old client piece, no test file', () => {
    const paths = releaseFiles(REPO).map((f) => f.path);
    for (const p of ['deploy/client/conclave.mjs', 'deploy/client/connector/release.mjs', 'deploy/client/connector/release-keys.json', 'deploy/client/connector/transfers.mjs', 'deploy/client/connector/request.mjs']) assert.ok(paths.includes(p), p);
    for (const p of paths) assert.ok(p === 'deploy/client/conclave.mjs' || p.startsWith('deploy/client/connector/'), `${p} is not a connector file`);
    for (const old of ['setup.mjs', 'agent-hub-headers.mjs', 'agent-hub-headers.py', 'codex-bridge.mjs', 'codex-wake.mjs', 'codex.mjs']) assert.ok(!paths.some((p) => p.endsWith(`/${old}`)), `${old} is not in the bundle`);
    assert.ok(!paths.some((p) => p.startsWith('bridge/')), 'the old bridge is not in the bundle');
    assert.ok(!paths.some((p) => p.endsWith('.test.mjs')));
  });
});

describe('update and rollback on a PC', () => {
  const home = mk();
  before(() => { adoptRunning(home, REPO, '1.0.0'); });

  test('an unsigned release installs nothing', async () => {
    const r = release('1.1.0');
    delete r.assets[releaseNames('1.1.0').signature];
    const u = await updateTo(home, { version: '1.1.0', approved: ['1.1.0'], current: '1.0.0', trust: trust1, getAsset: getter(r.assets) });
    assert.equal(u.reason, 'unsigned');
    assert.equal(readBuilds(home).current, '1.0.0');
    assert.ok(!existsSync(join(home, 'app', '1.1.0')));
  });
  test('an approved version the hub lists but the release does not match is refused', async () => {
    const u = await updateTo(home, { version: '1.1.0', approved: [], current: '1.0.0', trust: trust1, getAsset: getter(release('1.1.0').assets) });
    assert.equal(u.reason, 'not_approved');
  });
  test('a downgrade is refused even when the hub lists it as approved', async () => {
    const u = await updateTo(home, { version: '0.9.0', approved: ['0.9.0'], current: '1.0.0', trust: trust1, getAsset: getter(release('0.9.0').assets) });
    assert.equal(u.reason, 'downgrade');
  });
  test('a tampered bundle is refused after the manifest passed', async () => {
    const r = release('1.1.0');
    const b = Buffer.from(r.assets[releaseNames('1.1.0').bundle]); b[b.length - 10] ^= 1;
    r.assets[releaseNames('1.1.0').bundle] = b;
    const u = await updateTo(home, { version: '1.1.0', approved: ['1.1.0'], current: '1.0.0', trust: trust1, getAsset: getter(r.assets) });
    assert.equal(u.reason, 'bundle_mismatch');
  });
  test('a signed, approved, newer release installs, starts once, and runs through the launcher', async () => {
    const u = await updateTo(home, { version: '1.1.0', approved: ['1.1.0'], current: '1.0.0', trust: trust1, getAsset: getter(release('1.1.0').assets) });
    assert.deepEqual(u, { ok: true, version: '1.1.0', signer: K1.entry.id });
    const b = readBuilds(home);
    assert.equal(b.current, '1.1.0');
    assert.equal(b.previous, '1.0.0');
    assert.equal(b.builds['1.1.0'].verified, true);
    assert.equal(readFileSync(launcherPath(home), 'utf8'), LAUNCHER);
    const out = spawnSync(process.execPath, [launcherPath(home), 'version'], { encoding: 'utf8', env: { ...process.env, CONCLAVE_HOME: home } });
    assert.equal(out.stdout.trim(), '1.1.0');
  });
  test('a rollback to a build that was never verified (the first, adopted one) is refused', () => {
    assert.equal(rollback(home).reason, 'previous_not_verified');
  });
  test('a build that does not start is discarded and the PC stays on the current one', async () => {
    const bad = filesAt('1.2.0').map((f) => (f.path === 'deploy/client/conclave.mjs' ? { ...f, data: Buffer.from('process.exit(3);\n') } : f));
    const u = await updateTo(home, { version: '1.2.0', approved: ['1.2.0'], current: '1.1.0', trust: trust1, getAsset: getter(release('1.2.0', { files: bad }).assets) });
    assert.equal(u.reason, 'self_test_failed');
    assert.equal(readBuilds(home).current, '1.1.0');
    assert.ok(readBuilds(home).failed.includes('1.2.0'));
    assert.equal(pickUpdate(['1.2.0'], '1.1.0', readBuilds(home).failed), null);
  });
  test('rollback goes to the previous verified build, and not when one of its files changed', async () => {
    const u = await updateTo(home, { version: '1.3.0', approved: ['1.3.0'], current: '1.1.0', trust: trust1, getAsset: getter(release('1.3.0').assets) });
    assert.equal(u.ok, true);
    assert.equal(intact(home, '1.1.0'), true);
    const f = join(home, 'app', '1.1.0', 'deploy', 'client', 'connector', 'paths.mjs');
    const keep = readFileSync(f);
    writeFileSync(f, Buffer.concat([keep, Buffer.from('\n// changed\n')]));
    assert.equal(rollback(home).reason, 'previous_not_verified');
    writeFileSync(f, keep);
    assert.deepEqual(rollback(home), { ok: true, version: '1.1.0' });
    assert.equal(readBuilds(home).current, '1.1.0');
  });
});

describe('the launcher goes back after a new build fails to start', () => {
  const stub = (v, code) => [{ path: 'deploy/client/conclave.mjs', data: Buffer.from(`console.log('build ${v} ' + process.argv.slice(2).join(' ')); process.exit(${code});\n`) }];
  const launch = (home) => spawnSync(process.execPath, [launcherPath(home), 'service', 'worker'], { encoding: 'utf8' });
  test('after the fourth failed start of the worker it runs the previous verified build', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', 0), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    installVerified(home, '1.1.0', stub('1.1.0', 1), 'b'.repeat(64)); activate(home, '1.1.0');
    for (let i = 0; i < 3; i++) assert.match(launch(home).stdout, /build 1\.1\.0/);
    assert.match(launch(home).stdout, /build 1\.0\.0 service worker/);
    const b = readBuilds(home);
    assert.equal(b.current, '1.0.0');
    assert.equal(b.rolled_back, '1.1.0');
    assert.ok(b.failed.includes('1.1.0'));
  });
  test('it does not go back to a previous build whose files changed', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', 0), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    installVerified(home, '1.1.0', stub('1.1.0', 1), 'b'.repeat(64)); activate(home, '1.1.0');
    writeFileSync(join(home, 'app', '1.0.0', 'deploy', 'client', 'conclave.mjs'), "console.log('changed');\n");
    for (let i = 0; i < 5; i++) assert.match(launch(home).stdout, /build 1\.1\.0/);
    assert.equal(readBuilds(home).current, '1.1.0');
  });
  test('a build whose file changed since install is refused at every start, and the launcher goes back to the previous verified build', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', 0), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    installVerified(home, '1.1.0', stub('1.1.0', 0), 'b'.repeat(64)); activate(home, '1.1.0'); confirm(home);
    assert.match(launch(home).stdout, /build 1\.1\.0/);
    writeFileSync(join(home, 'app', '1.1.0', 'deploy', 'client', 'conclave.mjs'), "console.log('changed');\n");
    const r = spawnSync(process.execPath, [launcherPath(home), 'version'], { encoding: 'utf8' });
    assert.match(r.stdout, /build 1\.0\.0 version/);
    assert.doesNotMatch(r.stdout, /changed/);
    assert.match(r.stderr, /1\.1\.0 has a file that changed/);
    const b = readBuilds(home);
    assert.equal(b.current, '1.0.0');
    assert.equal(b.rolled_back, '1.1.0');
    assert.ok(b.failed.includes('1.1.0'));
  });
  test('a changed build with no verified build to go back to is not run at all', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', 0), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    writeFileSync(join(home, 'app', '1.0.0', 'deploy', 'client', 'conclave.mjs'), "console.log('changed');\n");
    const r = spawnSync(process.execPath, [launcherPath(home), 'version'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Reinstall the connector/);
  });
  test('the build serves the installation the launcher sits in, not the default folder', () => {
    const home = mk();
    installVerified(home, '1.0.0', [{ path: 'deploy/client/conclave.mjs', data: Buffer.from('console.log(process.env.CONCLAVE_HOME);\n') }], 'a'.repeat(64)); activate(home, '1.0.0');
    const env = { ...process.env }; delete env.CONCLAVE_HOME;
    const out = spawnSync(process.execPath, [launcherPath(home), 'version'], { encoding: 'utf8', env });
    assert.equal(out.stdout.trim(), home);
  });
  test('a worker that stops because this PC has no hub yet (exit 76) does not count as a failed start', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', 0), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    installVerified(home, '1.1.0', stub('1.1.0', NO_HUBS), 'b'.repeat(64)); activate(home, '1.1.0');
    for (let i = 0; i < 8; i++) assert.match(launch(home).stdout, /build 1\.1\.0/);
    const b = readBuilds(home);
    assert.equal(b.current, '1.1.0', 'the new build stays');
    assert.deepEqual(b.failed, []);
    assert.equal(b.pending.boots, 0);
    // a real failure is still counted
    installVerified(home, '1.2.0', stub('1.2.0', 1), 'c'.repeat(64)); activate(home, '1.2.0');
    for (let i = 0; i < 3; i++) launch(home);
    assert.equal(readBuilds(home).pending.boots, 3);
  });
  test('an MCP start does not count as a failed start', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', 0), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    installVerified(home, '1.1.0', stub('1.1.0', 0), 'b'.repeat(64)); activate(home, '1.1.0');
    for (let i = 0; i < 5; i++) spawnSync(process.execPath, [launcherPath(home), 'mcp', home]);
    assert.equal(readBuilds(home).pending.boots, 0);
  });
});

describe('crash safety: one worker, restarts, kept updates, state files', () => {
  const BUILDS = pathToFileURL(join(HERE, 'connector', 'builds.mjs')).href;
  const stub = (v, body) => [{ path: 'deploy/client/conclave.mjs', data: Buffer.from(body) }];
  const launch = (home) => spawnSync(process.execPath, [launcherPath(home), 'service', 'worker'], { encoding: 'utf8' });
  const installed = () => { const h = mk(); writeFileSync(manifestPath(h), '{}\n'); return h; };

  test('a second worker stops at once and names the one that runs; so does a second service', async () => {
    const home = installed();
    const held = takeProcessLock(workerLockPath(home), 'worker');
    assert.equal(held.ok, true);
    try {
      const r = spawnSync(process.execPath, [join(HERE, 'conclave.mjs'), 'service', 'worker'], { encoding: 'utf8', env: { ...process.env, CONCLAVE_HOME: home } });
      assert.equal(r.status, LOCKED, r.stderr);
      assert.match(r.stderr, new RegExp('another connector worker is running \\(process ' + process.pid));
      const sv = spawnSync(process.execPath, ['--input-type=module', '-e', 'import { takeProcessLock } from ' + JSON.stringify(pathToFileURL(join(HERE, 'connector', 'processes.mjs')).href) + '; const r = takeProcessLock(process.argv[1], "service"); console.log(JSON.stringify(r.ok ? { ok: true } : r));', servicePidPath(home)], { encoding: 'utf8' });
      assert.deepEqual(JSON.parse(sv.stdout).ok, true, 'the service lock is a separate one');
    } finally { held.release(); }
    assert.equal(existsSync(workerLockPath(home)), false, 'released');
  });

  test('two processes racing for the lock: exactly one gets it, the other names it', async () => {
    const home = installed();
    const src = 'import { takeProcessLock } from ' + JSON.stringify(pathToFileURL(join(HERE, 'connector', 'processes.mjs')).href) + '; const r = takeProcessLock(process.argv[1], "worker"); console.log(JSON.stringify(r.ok ? { ok: true } : { ok: false, pid: r.holder.pid })); if (r.ok) setTimeout(() => {}, 1500);';
    const { spawn } = await import('node:child_process');
    const run = () => new Promise((res) => { const c = spawn(process.execPath, ['--input-type=module', '-e', src, workerLockPath(home)], { stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('exit', () => res({ pid: c.pid, r: JSON.parse(out) })); });
    const [a, b] = await Promise.all([run(), run()]);
    const won = [a, b].filter((x) => x.r.ok);
    assert.equal(won.length, 1, JSON.stringify([a, b]));
    const lost = [a, b].find((x) => !x.r.ok);
    assert.equal(lost.r.pid, won[0].pid, 'the loser names the winner');
  });

  test('a lock left by a crashed worker is taken over; one whose id was reused by another program is too', () => {
    const home = installed();
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(workerLockPath(home), JSON.stringify({ pid: 2 ** 30, started_ms: 1, what: 'worker' }));
    const a = takeProcessLock(workerLockPath(home), 'worker');
    assert.equal(a.ok, true); a.release();
    writeFileSync(workerLockPath(home), JSON.stringify({ pid: process.ppid, started_ms: 1, what: 'worker' }));
    assert.equal(lockHolder(workerLockPath(home), { startTime: () => 1_000_000 }), null, 'same id, another start time: not the holder');
  });

  test('service remove ends the worker the lock names, and leaves a live one alone with noKill', () => {
    const home = installed();
    mkdirSync(join(home, 'run'), { recursive: true });
    const ended = [];
    const lockDeps = { alive: () => true, startTime: () => 5000 };
    writeFileSync(workerLockPath(home), JSON.stringify({ pid: 4242, started_ms: 5000, what: 'worker' }));
    removeService(home, { platform: 'win32', exec: () => ({ status: 0, stdout: '', stderr: '' }), killTree: (pid) => ended.push(pid), lockDeps, noKill: true });
    assert.deepEqual(ended, []); assert.equal(existsSync(workerLockPath(home)), true, 'noKill never frees a live worker\'s lock');
    removeService(home, { platform: 'win32', exec: () => ({ status: 0, stdout: '', stderr: '' }), killTree: (pid) => ended.push(pid), lockDeps });
    assert.deepEqual(ended, [4242]); assert.equal(existsSync(workerLockPath(home)), false);
  });

  test('Windows: Task Scheduler restarts the service when it dies, every minute', () => {
    const s = serviceSpec(mk(), { platform: 'win32', node: 'C:\\node.exe' });
    assert.match(s.install[0][2], new RegExp('-RestartCount ' + RESTART_COUNT + ' -RestartInterval \\(New-TimeSpan -Minutes ' + RESTART_INTERVAL_MIN + '\\)'));
    assert.ok(RESTART_INTERVAL_MIN <= 1 && RESTART_COUNT >= 100);
  });

  test('a worker that is killed is started again by the supervisor after a short pause', async () => {
    const home = mk();
    writeFileSync(join(home, 'conclave.mjs'), 'setInterval(() => {}, 1000);\n');
    const ac = new AbortController();
    const done = runSupervisor({ home, log: () => {}, signal: ac.signal, deps: { backoffMs: 50 } });
    const worker = () => { try { return JSON.parse(readFileSync(processesPath(home), 'utf8')).processes.find((x) => x.what === 'service worker')?.pid ?? null; } catch { return null; } };
    try {
      let first = null;
      for (let i = 0; i < 200 && !first; i++) { await new Promise((r) => setTimeout(r, 25)); first = worker(); }
      assert.ok(first, 'a worker runs');
      process.kill(first);
      const t0 = Date.now();
      let next = null;
      for (let i = 0; i < 400 && !(next && next !== first); i++) { await new Promise((r) => setTimeout(r, 25)); next = worker(); }
      assert.ok(next && next !== first, 'a new worker runs');
      assert.ok(Date.now() - t0 < 10_000);
    } finally { ac.abort(); await done; }
  });

  test('a second supervisor stops at once and names the first', async () => {
    const home = mk();
    const held = takeProcessLock(servicePidPath(home), 'service');
    try {
      // the holder is this process; a child process is the real second supervisor
      const r = spawnSync(process.execPath, [join(HERE, 'conclave.mjs'), 'service', 'run'], { encoding: 'utf8', env: { ...process.env, CONCLAVE_HOME: home }, timeout: 20_000 });
      assert.equal(r.status, LOCKED, r.stderr + r.stdout);
      assert.match(r.stderr + r.stdout, new RegExp('already running \\(process ' + process.pid));
    } finally { held.release(); }
  });

  test('an update that starts three times while the PC is offline is kept: only starts that crash early count', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', "console.log('build 1.0.0'); process.exit(0);\n"), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    // the new build runs past its first minute (markUp) and then stops, as a worker with no network may
    installVerified(home, '1.1.0', stub('1.1.0', "import { markUp } from " + JSON.stringify(BUILDS) + "; console.log('build 1.1.0'); markUp(process.env.CONCLAVE_HOME, '1.1.0'); process.exit(1);\n"), 'b'.repeat(64)); activate(home, '1.1.0');
    for (let i = 0; i < 6; i++) assert.match(launch(home).stdout, /build 1\.1\.0/);
    const b = readBuilds(home);
    assert.equal(b.current, '1.1.0'); assert.deepEqual(b.failed, []); assert.equal(b.pending.boots, 0);
    assert.equal(markUp(home, '9.9.9'), false, 'another version is not marked');
  });

  test('a worker that stops because another one runs (exit 77) is not a failed start', () => {
    const home = mk();
    installVerified(home, '1.0.0', stub('1.0.0', 'process.exit(0);\n'), 'a'.repeat(64)); activate(home, '1.0.0'); confirm(home);
    installVerified(home, '1.1.0', stub('1.1.0', "console.log('build 1.1.0'); process.exit(" + LOCKED + ");\n"), 'b'.repeat(64)); activate(home, '1.1.0');
    for (let i = 0; i < 6; i++) assert.match(launch(home).stdout, /build 1\.1\.0/);
    assert.equal(readBuilds(home).pending.boots, 0);
  });

  test('a state file whose write was cut off is read from its .bak; a torn .bak leaves the main file', () => {
    const d = mk(), p = join(d, 'registry.json');
    writeState(p, JSON.stringify({ n: 1 }));
    writeState(p, JSON.stringify({ n: 2 }));
    assert.deepEqual(readState(p, null), { n: 2 });
    writeFileSync(p, '{"n": 3, "cut');
    assert.deepEqual(readState(p, null), { n: 2 }, 'the flushed .bak of the last good write');
    writeState(p, JSON.stringify({ n: 4 }));
    writeFileSync(bakPath(p), '{"cut');
    assert.deepEqual(readState(p, null), { n: 4 });
    assert.deepEqual(readFileSync(bakPath(p), 'utf8'), '{"cut', 'reading changes nothing');
  });

  test('each read-change-write waits for the lock; a lock whose holder is gone is taken over', () => {
    const d = mk(), p = join(d, 'keys.json');
    writeFileSync(p + '.lock', JSON.stringify({ pid: process.ppid, at: Date.now() }));
    assert.throws(() => withLock(p, () => 1, { waitMs: 150 }), (e) => e.reason === 'state_locked' && new RegExp(String(process.ppid)).test(e.message));
    writeFileSync(p + '.lock', JSON.stringify({ pid: 2 ** 30, at: Date.now() }));
    assert.equal(withLock(p, () => 'ran', { waitMs: 150 }), 'ran');
    assert.equal(existsSync(p + '.lock'), false, 'released after');
    writeFileSync(p + '.lock', JSON.stringify({ pid: process.ppid, at: Date.now() - 120_000 }));
    assert.equal(withLock(p, () => 'ran', { waitMs: 150 }), 'ran', 'a lock held far too long is taken as stuck');
  });
});

describe('PC actions: the fixed list, typed data only, each id once', () => {
  test('the four kinds with their typed fields are accepted', () => {
    assert.equal(validateOrder({ id: 'pca_a1', kind: 'check', payload: {} }).ok, true);
    assert.equal(validateOrder({ id: 'pca_a2', kind: 'update', payload: { version: '1.4.0' } }).ok, true);
    assert.equal(validateOrder({ id: 'pca_a3', kind: 'restore', payload: { checkout_id: 'chk_9xYz', destination_id: 'dst_k3m9q2' } }).ok, true);
    assert.equal(validateOrder({ id: 'pca_a4', kind: 'disconnect', payload: {} }).ok, true);
  });
  test('a path or a command in any field makes the whole order invalid', () => {
    for (const v of ['../1.4.0', '1.4.0;rm', 'C:', '/tmp/x', '$(id)', '`id`', '1.4.0|x', 'a\\b', '~']) {
      assert.equal(validateOrder({ id: 'pca_b', kind: 'update', payload: { version: v } }).reason, 'path_or_command', v);
    }
    assert.equal(validateOrder({ id: 'pca_c', kind: 'restore', payload: { checkout_id: 'C:\\Users\\x', destination_id: 'dst_k3m9q2' } }).reason, 'path_or_command');
    assert.equal(validateOrder({ id: 'pca_c', kind: 'restore', payload: { checkout_id: 'chk_9xYz', destination_id: 'D:\\Projects' } }).reason, 'path_or_command');
  });
  test('a restore names its destination by id: a path field, a missing id or a malformed id is refused', () => {
    const restore = (payload) => validateOrder({ id: 'pca_r', kind: 'restore', payload }).reason;
    assert.equal(restore({ checkout_id: 'chk_9xYz' }), 'invalid_order');
    assert.equal(restore({ checkout_id: 'chk_9xYz', path: 'projects' }), 'invalid_order');
    assert.equal(restore({ checkout_id: 'chk_9xYz', destination_id: 'dst_k3m9q2', path: 'projects' }), 'invalid_order');
    for (const d of ['dst_ABCDEF', 'dst_12345', 'dst_' + 'a'.repeat(33), 'dest_k3m9q2', 'k3m9q2', '']) assert.equal(restore({ checkout_id: 'chk_9xYz', destination_id: d }), 'invalid_order', d);
    assert.equal(restore({ checkout_id: 'chk_9xYz', destination_id: 7 }), 'invalid_order');
  });
  test('another kind, an extra field or a missing field is refused', () => {
    assert.equal(validateOrder({ id: 'pca_d', kind: 'run', payload: { command: 'id' } }).reason, 'unknown_kind');
    assert.equal(validateOrder({ id: 'pca_d', kind: 'toString', payload: {} }).reason, 'unknown_kind');
    assert.equal(validateOrder({ id: 'pca_e', kind: 'check', payload: { path: 'x' } }).reason, 'invalid_order');
    assert.equal(validateOrder({ id: 'pca_f', kind: 'update', payload: {} }).reason, 'invalid_order');
    assert.equal(validateOrder({ id: 'pca_g', kind: 'update', payload: { version: 140 } }).reason, 'invalid_order');
    assert.equal(validateOrder({ id: 'pca_h', kind: 'check', payload: {}, command: 'id' }).reason, 'invalid_order');
    assert.equal(validateOrder({ id: 'not-an-order', kind: 'check', payload: {} }).reason, 'invalid_order');
  });
  test('an order id is handled once per hub', () => {
    const home = mk();
    assert.equal(firstTime(home, 'hub@x', 'pca_once'), true);
    assert.equal(firstTime(home, 'hub@x', 'pca_once'), false);
    assert.equal(firstTime(home, 'hub@y', 'pca_once'), true);
  });
});

describe('the logon service is installed and removed as the user', () => {
  const home = 'C:\\Users\\Dev User\\.config\\conclave';
  test('Windows: a scheduled task at logon from Register-ScheduledTask, hidden, never schtasks', () => {
    const s = serviceSpec(home, { platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe' });
    const script = s.install[0][2];
    assert.match(script, /Register-ScheduledTask/);
    assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User/);
    assert.match(script, /-RunLevel Limited/);
    assert.match(script, /conhost\.exe/);
    assert.match(script, /--headless "C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\Dev User\\\.config\\conclave\\conclave\.mjs" service run/);
    assert.doesNotMatch(script + s.remove[0][2], /schtasks/i);
    assert.match(s.remove[0][2], /Unregister-ScheduledTask/);
    assert.ok(s.install[0][1].includes('-EncodedCommand'));
    assert.equal(Buffer.from(s.install[0][1].at(-1), 'base64').toString('utf16le'), script);
  });
  test('a single quote in a path cannot end the PowerShell string', () => {
    const s = serviceSpec("C:\\Users\\O'Brien\\.config\\conclave", { platform: 'win32', node: 'C:\\node.exe' });
    assert.match(s.install[0][2], /O''Brien/);
  });
  test('macOS: a LaunchAgent in the user\'s GUI session, with the paths escaped', () => {
    const userHome = mk();
    const s = serviceSpec('/Users/a&b/.config/conclave', { platform: 'darwin', node: '/usr/local/bin/node', userHome, uid: 501 });
    assert.equal(s.place.target, join(userHome, 'Library', 'LaunchAgents', `${s.place.name}.plist`));
    assert.match(s.file, /<string>\/Users\/a&amp;b\/\.config\/conclave\/conclave\.mjs<\/string><string>service<\/string><string>run<\/string>/);
    assert.match(s.file, /<key>RunAtLoad<\/key><true\/>/);
    assert.deepEqual(s.install.at(-1).slice(0, 2), ['launchctl', ['bootstrap', 'gui/501', s.place.target]]);
  });
  test('Linux: a systemd user unit, and XDG autostart where there is no systemd session', () => {
    const userHome = mk();
    const u = serviceSpec('/home/dev user/.config/conclave', { platform: 'linux', node: '/usr/bin/node', userHome, systemd: true });
    assert.match(u.file, /ExecStart="\/usr\/bin\/node" "\/home\/dev user\/\.config\/conclave\/conclave\.mjs" service run/);
    assert.match(u.file, /WantedBy=default\.target/);
    assert.deepEqual(u.install.at(-1).slice(0, 2), ['systemctl', ['--user', 'enable', '--now', u.place.name]]);
    const x = serviceSpec('/home/dev user/.config/conclave', { platform: 'linux', node: '/usr/bin/node', userHome, systemd: false });
    assert.equal(x.place.target, join(userHome, '.config', 'autostart', x.place.name));
    assert.match(x.file, /Exec="\/usr\/bin\/node" "\/home\/dev user\/\.config\/conclave\/conclave\.mjs" service run/);
  });
  for (const [platform, systemd] of [['darwin', true], ['linux', true], ['linux', false]]) {
    test(`${platform}${platform === 'linux' ? (systemd ? ' (systemd)' : ' (autostart)') : ''}: install writes the entry and runs the user commands; remove takes both away`, () => {
      const userHome = mk(), h = mk();
      const calls = [];
      const exec = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; };
      const o = { platform, userHome, uid: 501, systemd, exec, node: '/usr/bin/node', noStart: true, spawnDetached: () => {} };
      const r = installService(h, o);
      assert.equal(r.ok, true);
      assert.ok(existsSync(r.place.target));
      assert.ok(!calls.some((c) => /sudo|schtasks|\/etc\//.test(c)), calls.join('\n'));
      assert.equal(serviceStatus(h, o).installed, true);
      removeService(h, { ...o, noKill: true });
      assert.ok(!existsSync(r.place.target));
      assert.equal(serviceStatus(h, o).installed, false);
      if (platform === 'darwin') assert.ok(calls.some((c) => c.startsWith('launchctl bootout gui/501/')));
      if (platform === 'linux' && systemd) assert.ok(calls.some((c) => c.startsWith('systemctl --user disable --now')));
    });
  }
  test('a failed system command is reported, not hidden', () => {
    const r = installService(mk(), { platform: 'linux', userHome: mk(), systemd: true, node: '/usr/bin/node', exec: () => ({ status: 1, stdout: '', stderr: 'Failed to connect to bus\n' }) });
    assert.deepEqual([r.ok, r.reason, r.detail], [false, 'service_install_failed', 'Failed to connect to bus']);
  });
  test('the manifest records the logon entry only at its platform\'s place', () => {
    const h = mk();
    const ctx = { home: h, folders: [], claudeJson: join(h, 'c.json'), serviceTargets: serviceTargets(h) };
    assert.equal(validateEntry({ kind: 'service_entry', target: servicePlace(h).target, installed: {} }, ctx).ok, true);
    assert.equal(validateEntry({ kind: 'service_entry', target: join(h, 'evil.plist'), installed: {} }, ctx).reason, 'wrong_place');
    assert.equal(validateEntry({ kind: 'launcher', target: join(h, 'conclave.mjs'), pointer: null, installed: 'launcher' }, ctx).ok, true);
  });
  test('two installations under two folders get two entries', () => assert.notEqual(servicePlace('/a').name, servicePlace('/b').name));
});

describe('switches and liveness', () => {
  test('auto-update reads null until the PC user sets it', () => {
    const h = mk();
    assert.equal(readSettings(h).auto_update, null);
    setSwitch(h, 'auto-update', false);
    assert.equal(readSettings(h).auto_update, false);
    assert.throws(() => setSwitch(h, 'everything', true));
  });
  test('the usage switch is one choice: conclave settings usage and conclave usage read and write the same file', () => {
    const h = mk();
    setSwitch(h, 'usage', true);
    assert.equal(usageOptIn(h), true);
    setUsageOptIn(h, false);
    assert.equal(readSettings(h).usage_opt_in, false);
    assert.equal(readSettings(h).auto_update, null);
  });
  test('a preferences file that is not an object is replaced by one when a switch is set', () => {
    for (const bad of ['[1,2]', '"x"', '7', 'null']) {
      const h = mk();
      writeFileSync(join(h, 'preferences.json'), bad);
      assert.equal(readSettings(h).auto_update, null);
      assert.equal(setSwitch(h, 'auto-update', false).auto_update, false);
      assert.deepEqual(JSON.parse(readFileSync(join(h, 'preferences.json'), 'utf8')), { auto_update: false });
    }
  });
  test('an agent counts as open only while its relay process is alive', () => {
    const h = mk();
    const unmark = markRunning(h, 'hub@x', 'dev-1', 'agent-abc');
    markRunning(h, 'hub@x', 'dev-2', 'agent-dead', 2 ** 30);
    assert.deepEqual(runningAgents(h, 'hub@x'), [{ agent_id: 'agent-abc', state: 'open' }]);
    unmark();
    assert.deepEqual(runningAgents(h, 'hub@x'), []);
  });
  test('a run file whose id now runs another program does not count as open', () => {
    const h = mk();
    markRunning(h, 'hub@x', 'dev-1', 'agent-abc', process.pid, process.env, join(h, 'not-node.exe'), join(h, 'conclave.mjs'));
    assert.deepEqual(runningAgents(h, 'hub@x'), []);
  });
});

// ───────────── nothing outlives an uninstall ─────────────
describe('after an uninstall nothing comes back', () => {
  const noExec = () => ({ status: 1, stdout: '', stderr: '' });
  test('with the connector folder gone, or left with only the user\'s files, the worker stops and re-creates nothing', async () => {
    const gone = join(mk(), 'conclave');
    const left = mk();
    writeFileSync(join(left, 'notes.txt'), 'mine');
    for (const home of [gone, left]) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10_000);
      const why = await runWorker({ home, signal: ac.signal, claudeJson: join(left, 'claude.json'), deps: { noBridge: true, noBroker: true, intervalMs: 20, exec: noExec } });
      clearTimeout(t);
      assert.equal(why, 'no_hubs');
    }
    assert.equal(existsSync(gone), false, 'the folder is not created again');
    assert.deepEqual(readdirSync(left), ['notes.txt'], 'no connector.log or other file appears');
  });

  test('the supervisor records its worker so a removal can end it, forgets it on exit, and stops once the connector is gone', async () => {
    const home = mk();
    writeFileSync(join(home, 'conclave.mjs'), 'setInterval(() => {}, 1000);\n');
    // The supervisor is always stopped in `finally`, so a failed check never leaves a worker running (the suite would hang).
    const ac = new AbortController();
    const done = runSupervisor({ home, log: () => {}, signal: ac.signal });
    let rec = null;
    try {
      for (let i = 0; i < 200 && !rec; i++) {
        await new Promise((r) => setTimeout(r, 25));
        try { rec = JSON.parse(readFileSync(processesPath(home), 'utf8')).processes.find((x) => x.what === 'service worker') ?? null; } catch { /* not yet */ }
      }
      assert.ok(rec, 'the worker is in processes.json');
      assert.equal(rec.script, join(home, 'conclave.mjs'), 'with the script it runs');
      assert.equal(runningAs(rec.pid, process.execPath, rec.script), true, 'recognised as the program and script it runs (on Linux by /proc/<pid>/exe)');
    } finally {
      ac.abort();
      await done;
    }
    assert.deepEqual(JSON.parse(readFileSync(processesPath(home), 'utf8')).processes, [], 'forgotten once it exited');
    assert.equal(runningAs(rec.pid, process.execPath), false, 'and it is gone');

    // A worker that finds no hub left after the connector removed itself: the supervisor ends too, without a signal.
    const h2 = mk();
    writeFileSync(join(h2, 'conclave.mjs'), `import { rmSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; rmSync(fileURLToPath(import.meta.url)); process.exit(${NO_HUBS});\n`);
    const ac2 = new AbortController();
    let timer;
    const ended = runSupervisor({ home: h2, log: () => {}, signal: ac2.signal }).then(() => 'ended');
    try {
      const r = await Promise.race([ended, new Promise((res) => { timer = setTimeout(() => res('still running'), 15_000); })]);
      assert.equal(r, 'ended', 'the supervisor stops by itself');
    } finally {
      clearTimeout(timer);
      ac2.abort();
      await ended;
    }
  });
});

// ───────────── the worker against a stub hub over HTTPS ─────────────
function findOpenssl() {
  for (const c of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}
const OPENSSL = findOpenssl();
function makePki() {
  const d = mk('conclave-pki-');
  const o = (...a) => execFileSync(OPENSSL, a, { cwd: d, stdio: 'ignore' });
  o('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=svc-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  o('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 's.key', '-out', 's.csr', '-subj', '/CN=localhost');
  writeFileSync(join(d, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n');
  o('x509', '-req', '-in', 's.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 's.pem', '-days', '2', '-extfile', 'ext.cnf');
  return { ca: readFileSync(join(d, 'ca.pem'), 'utf8'), cert: readFileSync(join(d, 's.pem'), 'utf8'), key: readFileSync(join(d, 's.key'), 'utf8') };
}
const APP = 'ah_app_FAKEappKEYforSERVICEtests0001';
const GONE = 'ah_app_FAKEdisconnectedKEYforTESTS01';

describe('the worker checks in and answers orders on the pinned poll', { skip: OPENSSL ? false : 'openssl is not available on this PC' }, () => {
  let pki, hub;
  const seen = { checkIns: [], results: [], auth: new Set(), usage: [], hardware: [] };
  let queue = [], measureOnly = false;
  before(async () => {
    pki = makePki();
    hub = https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.auth.add(req.headers.authorization);
        const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.headers.authorization === `Bearer ${GONE}`) return json(401, { error: 'disconnected' });
        if (req.headers.authorization !== `Bearer ${APP}`) return json(401, { error: 'unauthorized' });
        if (req.url === '/connector/v1/check-in') { seen.onCheckIn?.(); seen.checkIns.push(JSON.parse(raw)); return json(200, { ok: true, orders: queue.length, ignored_agents: 0, ...(measureOnly ? { measure_only: true } : {}) }); }
        if (req.url === '/connector/v1/hardware') { seen.hardware.push(JSON.parse(raw)); return json(200, { accepted: 1 }); }
        if (req.url === '/connector/v1/orders') { const o = queue; queue = []; return json(200, { orders: o }); }
        if (req.url === '/connector/v1/versions/approved') return json(200, { versions: ['9.9.9'] });
        if (req.url === '/connector/v1/usage') { seen.usage.push(JSON.parse(raw)); return json(200, { ok: true }); }
        const m = /^\/connector\/v1\/orders\/([^/]+)\/result$/.exec(req.url);
        if (m) { seen.results.push({ id: m[1], ...JSON.parse(raw) }); return json(200, { ok: true }); }
        return json(404, { error: 'not_found' });
      });
    });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  });
  after(() => new Promise((r) => hub.close(r)));

  const worker = async (home, deps = {}) => {
    const ac = new AbortController();
    const done = runWorker({ home, signal: ac.signal, log: () => {}, claudeJson: join(home, 'claude.json'), deps: { noBridge: true, intervalMs: 50, exec: () => ({ status: 1, stdout: '', stderr: '' }), ...deps } });
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && (seen.checkIns.length < 2 || queue.length)) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    return done;
  };
  const freshHome = () => {
    const home = mk();
    putHub(home, { hubId: 'hub-svc', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.ca, appKey: APP });
    return home;
  };

  test('the check-in carries the versions, the switches and the running agents, and never another key', async () => {
    const home = freshHome();
    setSwitch(home, 'auto-update', false);
    const hubKey = `hub-svc@${caFingerprint(pki.ca)}`;
    const unmark = markRunning(home, hubKey, 'dev-1', 'agent-live');
    seen.checkIns.length = 0;
    assert.equal(await worker(home), 'stopped');
    unmark();
    const c = seen.checkIns[0];
    assert.equal(c.version, CONNECTOR_VERSION);
    assert.equal(c.platform, platformId());
    assert.equal(c.node, process.versions.node);
    assert.equal(c.auto_update, false);
    assert.equal(c.remote_cleanup, null);
    assert.deepEqual(c.agents, [{ agent_id: 'agent-live', state: 'open' }]);
    assert.deepEqual([...seen.auth], [`Bearer ${APP}`]);
  });

  test('a plain key file is encrypted only after the first check-in, so a rollback to the build before can still read it', async () => {
    const home = freshHome();
    const plainAtCheckIn = [];
    writeFileSync(keyFilePath(home), JSON.stringify(readKeyFile(home).data) + '\n'); // as the build before wrote it
    seen.checkIns.length = 0;
    seen.onCheckIn = () => plainAtCheckIn.push(readFileSync(keyFilePath(home), 'utf8').includes(APP));
    try { assert.equal(await worker(home), 'stopped'); } finally { seen.onCheckIn = null; }
    assert.equal(plainAtCheckIn[0], true, 'still readable by the previous build when the hub is first asked');
    assert.equal(readFileSync(keyFilePath(home), 'utf8').includes(APP), false, 'encrypted once the check-in went through');
  });

  test('a compute machine: samples go to its hub only while measuring is on, and orders but Update are refused', async () => {
    const fixed = { at: 1795190000000, cpu_pct: 41.5, cpu_count: 8, mem_used_gb: 12.25, mem_total_gb: 32, gpus: [{ util_pct: 80, mem_used_gb: 6, mem_total_gb: 24 }] };
    const waitFor = async (ok) => { const t0 = Date.now(); while (Date.now() - t0 < 10_000 && !ok()) await new Promise((r) => setTimeout(r, 25)); };
    const run = (home) => { const ac = new AbortController(); const done = runWorker({ home, signal: ac.signal, log: () => {}, claudeJson: join(home, 'claude.json'), deps: { noBridge: true, intervalMs: 50, sampleMs: 10, sampler: () => () => fixed, exec: () => ({ status: 1, stdout: '', stderr: '' }), updateTo: async () => ({ ok: false, reason: 'download_failed' }) } }); return { ac, done }; };
    measureOnly = true;
    try {
      // Measuring never turned on: the check-in says null and nothing is sent.
      let home = freshHome();
      seen.checkIns.length = 0; seen.hardware.length = 0;
      let w = run(home);
      await waitFor(() => seen.checkIns.length >= 4);
      w.ac.abort(); await w.done;
      assert.equal(seen.checkIns[0].hardware_opt_in, null);
      assert.equal(seen.hardware.length, 0);
      // Turned on: the fixed samples reach the hub, numbers only; a check is refused, an update is tried.
      home = freshHome();
      setSwitch(home, 'hardware', true);
      seen.checkIns.length = 0; seen.results.length = 0;
      queue = [{ id: 'pca_hwcheck', kind: 'check', payload: {} }, { id: 'pca_hwrestore', kind: 'restore', payload: { checkout_id: 'co_1', destination_id: 'dst_abcdef' } }];
      w = run(home);
      await waitFor(() => seen.hardware.length >= 1 && seen.results.length >= 2);
      w.ac.abort(); await w.done;
      assert.equal(seen.checkIns[0].hardware_opt_in, true);
      assert.deepEqual(seen.hardware[0].samples[0], fixed);
      assert.deepEqual(Object.keys(seen.hardware[0]), ['samples']);
      for (const id of ['pca_hwcheck', 'pca_hwrestore']) {
        const r = seen.results.find((x) => x.id === id);
        assert.equal(r.state, 'failed');
        assert.match(r.result.reason, /only measures itself/);
      }
      // Turned off again: nothing more is sent.
      setSwitch(home, 'hardware', false);
      const sent = seen.hardware.length;
      seen.checkIns.length = 0;
      w = run(home);
      await waitFor(() => seen.checkIns.length >= 4);
      w.ac.abort(); await w.done;
      assert.equal(seen.hardware.length, sent);
    } finally { measureOnly = false; queue = []; }
  });

  test('orders: a check is answered with its rows, an update is refused while updates are off, a path is refused, a replay does nothing', async () => {
    const home = freshHome();
    setSwitch(home, 'auto-update', false);
    let updates = 0;
    seen.checkIns.length = 0; seen.results.length = 0;
    queue = [
      { id: 'pca_check1', kind: 'check', payload: {} },
      { id: 'pca_upd1', kind: 'update', payload: { version: '9.9.9' } },
      { id: 'pca_bad1', kind: 'update', payload: { version: '../../9.9.9' } },
      { id: 'pca_run1', kind: 'shell', payload: { command: 'whoami' } },
      { id: 'pca_check1', kind: 'check', payload: {} },
    ];
    await worker(home, { updateTo: async () => { updates++; return { ok: true }; } });
    const by = Object.fromEntries(seen.results.map((r) => [r.id, r]));
    assert.equal(seen.results.filter((r) => r.id === 'pca_check1').length, 1);
    assert.equal(by.pca_check1.state, 'done');
    assert.ok(by.pca_check1.result.checks.some((c) => c.name === 'Connector' && c.ok));
    assert.ok(by.pca_check1.result.checks.some((c) => c.name === 'Updates' && /turned off/.test(c.detail)));
    assert.deepEqual([by.pca_upd1.state, by.pca_upd1.result.reason], ['failed', 'Updates are turned off on this PC by its user.']);
    assert.match(by.pca_bad1.result.reason, /path or a command/);
    assert.match(by.pca_run1.result.reason, /not on the fixed list/);
    assert.equal(updates, 0);
  });

  test('a hub that disconnected this PC makes the worker finish the disconnect, again on each tick until it is over; a refused key does not', async () => {
    const run = async (appKey) => {
      const home = mk();
      putHub(home, { hubId: 'hub-svc', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.ca, appKey });
      const calls = [];
      const ac = new AbortController();
      const done = runWorker({ home, signal: ac.signal, log: () => {}, claudeJson: join(home, 'claude.json'), deps: { noBridge: true, intervalMs: 50, exec: () => ({ status: 1, stdout: '', stderr: '' }), disconnect: async (h, scope) => { calls.push(scope); return { state: 'resume_later' }; } } });
      const t0 = Date.now();
      while (Date.now() - t0 < (appKey === GONE ? 10_000 : 600) && calls.length < 2) await new Promise((r) => setTimeout(r, 25));
      ac.abort();
      await done;
      return calls;
    };
    const calls = await run(GONE);
    assert.ok(calls.length >= 2, 'tried again at the next check-in');
    assert.deepEqual(calls[0], { hubId: 'hub-svc', caSha256: caFingerprint(pki.ca) });
    assert.deepEqual(await run('ah_app_FAKErevokedKEYforSERVICEtest1'), []);
  });

  test('a disconnect with remote cleanup off marks the hub as disconnected, and the worker stops checking in with it', async () => {
    const home = mk();
    putHub(home, { hubId: 'hub-svc', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.ca, appKey: GONE });
    const calls = [], lines = [];
    const ac = new AbortController();
    const done = runWorker({ home, signal: ac.signal, log: (l) => lines.push(l), claudeJson: join(home, 'claude.json'), deps: { noBridge: true, intervalMs: 50, exec: () => ({ status: 1, stdout: '', stderr: '' }), disconnect: async (h, scope) => { calls.push(scope); return { state: 'cleanup_off', reported: true }; } } });
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !calls.length) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 800)); // many more ticks
    ac.abort();
    await done;
    assert.equal(calls.length, 1, 'the disconnect is not run again');
    const section = Object.values(readKeyFile(home).data.hubs)[0];
    assert.match(section.disconnected_at, /^\d{4}-/);
    assert.equal(lines.filter((l) => /no more check-ins until it is paired again/.test(l)).length, 1, 'said once in the log');
    putHub(home, { hubId: 'hub-svc', origin: `https://127.0.0.1:${hub.address().port}`, caPem: pki.ca, appKey: APP });
    assert.equal(Object.values(readKeyFile(home).data.hubs)[0].disconnected_at, undefined, 'pairing again clears the mark');
  });

  test('the worker sends usage only after the PC user opted in: numbers per day for its own hub, no session id or folder', async () => {
    const home = freshHome();
    const ca = caFingerprint(pki.ca);
    const folder = join(home, 'secret agent folder');
    writeFileSync(sessionsPath(home), JSON.stringify({ version: 1, sessions: {
      'codex:sess-private-1': { client: 'codex', session_id: 'sess-private-1', agent_id: 'agent-1', hub_id: 'hub-svc', ca_sha256: ca, folder },
      'codex:sess-other-hub': { client: 'codex', session_id: 'sess-other-hub', agent_id: 'agent-2', hub_id: 'hub-other', ca_sha256: ca, folder },
    } }));
    for (const id of ['sess-private-1', 'sess-private-1', 'sess-other-hub']) recordUsageEvent(home, { client: 'codex', sessionId: id, model: 'gpt-5', input: 100, output: 20 });

    seen.checkIns.length = 0; seen.usage.length = 0;
    await worker(home, { usageMs: 0 });
    assert.deepEqual(seen.usage, [], 'nothing is sent while the user has not opted in');

    setUsageOptIn(home, true);
    seen.checkIns.length = 0;
    await worker(home, { usageMs: 0 });
    assert.ok(seen.usage.length >= 1);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(seen.usage[0], { day: today, rows: [{ agent_id: 'agent-1', client: 'codex', model: 'gpt-5', input_tokens: 200, output_tokens: 40, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 1, turns: 2 }] });
    const sent = JSON.stringify(seen.usage);
    for (const secret of ['sess-private-1', 'sess-other-hub', 'agent-2', 'secret agent folder']) assert.ok(!sent.includes(secret), `${secret} never leaves the PC`);
  });

  test('with updates on, an update order runs the update and the worker stops to restart on it', async () => {
    const home = freshHome();
    const asked = [];
    seen.checkIns.length = 0; seen.results.length = 0;
    queue = [{ id: 'pca_upd2', kind: 'update', payload: { version: '9.9.9' } }];
    const why = await worker(home, { updateTo: async (_h, o) => { asked.push(o); return { ok: true, version: o.version }; } });
    assert.equal(why, 'restart');
    assert.deepEqual(asked.map((o) => [o.version, o.approved]), [['9.9.9', ['9.9.9']]]);
    assert.equal(seen.results.find((r) => r.id === 'pca_upd2').state, 'done');
  });

  test('a refused update reports its fixed reason', async () => {
    const home = freshHome();
    seen.checkIns.length = 0; seen.results.length = 0;
    queue = [{ id: 'pca_upd3', kind: 'update', payload: { version: '9.9.9' } }];
    await worker(home, { updateTo: async () => ({ ok: false, reason: 'unsigned' }) });
    assert.equal(seen.results.find((r) => r.id === 'pca_upd3').result.reason, 'The release has no signature, so it was refused.');
  });
});
