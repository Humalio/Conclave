/**
 * The connector's builds on this PC (docs/connector.md "Self-update"): ~/.config/conclave/app/<version>/, and
 * app/builds.json naming the current build, the previous one and what each was verified against.
 *
 *   { "version": 1, "current": "1.4.0", "previous": "1.3.0", "pending": {"version": "1.4.0", "boots": 0} | null,
 *     "failed": ["1.4.1"], "rolled_back": "1.4.1" | null,
 *     "builds": { "1.4.0": { "verified": true, "manifest_sha256": "…", "files": { "deploy/client/conclave.mjs": "<sha256>" } } } }
 *
 * `~/.config/conclave/conclave.mjs` is the fixed LAUNCHER (LAUNCHER below): folder entries name it, so an update never
 * rewrites an agent folder. Only the current and the previous build are kept. A rollback goes only to a build that was
 * verified at install and whose files all still have the hashes recorded then; nothing is fetched again for it.
 */
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readState, writeState, atomicWrite, withLock } from './paths.mjs';
import { sha256, VERSION_RE, RELEASE_ROOTS } from './release.mjs';
import { decryptInPlace } from './keyfile.mjs';

/** A build that carries this file reads an encrypted key file; one without it (an older connector) reads only a plain one. */
export const KEY_STORE_FILE = 'deploy/client/connector/keystore.mjs';
const readsEncryptedKeys = (b, version) => !!b.builds[version]?.files?.[KEY_STORE_FILE];

export const appDir = (home) => join(home, 'app');
export const buildsPath = (home) => join(home, 'app', 'builds.json');
export const launcherPath = (home) => join(home, 'conclave.mjs');
const empty = () => ({ version: 1, current: null, previous: null, pending: null, failed: [], rolled_back: null, builds: {} });

export function readBuilds(home) {
  const b = readState(buildsPath(home), null);
  if (!b || b.version !== 1 || typeof b.builds !== 'object' || b.builds === null) return empty();
  return { ...empty(), ...b };
}
const writeBuilds = (home, b) => writeState(buildsPath(home), JSON.stringify(b, null, 2) + '\n');
/** One read-change-write of builds.json under its lock (the launcher writes it too, at a worker's start). */
const locked = (home, fn) => withLock(buildsPath(home), fn);

/** Writes the files of one build into app/<version> through a temporary folder and a rename. Returns the file hashes. */
function placeBuild(home, version, files) {
  if (!VERSION_RE.test(version)) throw new Error('not a version');
  const dest = join(appDir(home), version);
  const tmp = join(appDir(home), `.${version}.${randomBytes(4).toString('hex')}.tmp`);
  const hashes = {};
  try {
    for (const f of files) {
      const p = join(tmp, ...f.path.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.data);
      hashes[f.path] = sha256(f.data);
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return hashes;
}

/** Installs a build that passed every release check (it is not current yet). */
export function installVerified(home, version, files, manifestSha256) {
  if (readBuilds(home).current === version) throw new Error('that build is the one running');
  const hashes = placeBuild(home, version, files);
  return locked(home, () => {
  const b = readBuilds(home);
  if (b.current === version) throw new Error('that build is the one running');
  b.builds[version] = { verified: true, manifest_sha256: manifestSha256, files: hashes, installed_at: new Date().toISOString() };
  writeBuilds(home, b);
  });
}

/** Removes an installed build that is neither current nor previous (one that failed its first start). */
export function discard(home, version) {
  const ok = locked(home, () => {
    const b = readBuilds(home);
    if (version === b.current || version === b.previous) return false;
    delete b.builds[version];
    if (!b.failed.includes(version)) b.failed.push(version);
    writeBuilds(home, b);
    return true;
  });
  if (!ok) return false;
  rmSync(join(appDir(home), version), { recursive: true, force: true });
  return true;
}

/** The connector's own files under `root` (a repository checkout or an unpacked build), as `[{path, data}]`. */
export function releaseFiles(root) {
  const out = [];
  const walk = (rel) => {
    const p = join(root, ...rel.split('/'));
    const st = statSync(p);
    if (st.isDirectory()) { for (const n of readdirSync(p).sort()) if (!n.endsWith('.test.mjs') && !n.startsWith('.')) walk(`${rel}/${n}`); }
    else if (st.isFile()) out.push({ path: rel, data: readFileSync(p) });
  };
  for (const r of RELEASE_ROOTS) walk(r);
  return out;
}

/**
 * Takes the running copy (a developer checkout, or what an installer unpacked) as the first build when none is
 * installed. It is recorded as NOT verified, so it is never a rollback target.
 */
export function adoptRunning(home, root, version) {
  const b = readBuilds(home);
  if (b.current) return false;
  const hashes = placeBuild(home, version, releaseFiles(root));
  b.builds[version] = { verified: false, manifest_sha256: null, files: hashes, installed_at: new Date().toISOString() };
  b.current = version;
  writeBuilds(home, b);
  writeLauncher(home);
  return true;
}

/** True if the build was verified at install and every file it had still has the recorded hash. */
export function intact(home, version) {
  const e = readBuilds(home).builds[version];
  if (!e?.verified || !e.files || !VERSION_RE.test(version)) return false;
  try { return Object.entries(e.files).every(([p, h]) => sha256(readFileSync(join(appDir(home), version, ...p.split('/')))) === h); } catch { return false; }
}

/** Makes an installed build current; the one before becomes the previous build, older ones are deleted. */
export function activate(home, version) {
  locked(home, () => activateNow(home, version));
  writeLauncher(home);
}
function activateNow(home, version) {
  const b = readBuilds(home);
  if (!b.builds[version]) throw new Error('that build is not installed');
  if (b.current !== version) { b.previous = b.current; b.current = version; }
  b.pending = { version, boots: 0 };
  b.rolled_back = null;
  for (const v of Object.keys(b.builds)) if (v !== b.current && v !== b.previous) { delete b.builds[v]; rmSync(join(appDir(home), v), { recursive: true, force: true }); }
  writeBuilds(home, b);
}

/** The new build ran its first good check-in: it no longer counts failed starts. */
export function confirm(home) {
  return locked(home, () => {
    const b = readBuilds(home);
    if (!b.pending) return false;
    b.pending = null;
    writeBuilds(home, b);
    return true;
  });
}

/** How long a worker runs before its start no longer counts as a failed one. */
export const UP_MS = 60_000;
/**
 * The worker of the new build has run for a minute (UP_MS): its start no longer counts as a failed one. The launcher
 * counts every start of a new build before it runs; a start that stays up a minute takes its count back, so only starts
 * that crash early lead to a rollback. A PC that starts offline (no first check-in, so no `confirm`) keeps its update.
 */
export function markUp(home, version) {
  return locked(home, () => {
    const b = readBuilds(home);
    if (!b.pending || b.pending.version !== version || !(b.pending.boots > 0)) return false;
    b.pending.boots--;
    writeBuilds(home, b);
    return true;
  });
}

/**
 * `conclave rollback`: back to the previous build, only if it was verified and is intact. `{ok, version}` or `{ok: false, reason}`.
 * A previous build that cannot read an encrypted key file gets it back in plain form first; when it cannot be decrypted
 * the rollback is refused (`keys_unreadable`, with the key file's own reason) and the PC stays where it is.
 */
export function rollback(home) { return locked(home, () => rollbackNow(home)); }
function rollbackNow(home) {
  const b = readBuilds(home);
  if (!b.previous) return { ok: false, reason: 'no_previous_build' };
  if (!intact(home, b.previous)) return { ok: false, reason: 'previous_not_verified' };
  if (!readsEncryptedKeys(b, b.previous)) {
    const k = decryptInPlace(home);
    if (!k.ok) return { ok: false, reason: 'keys_unreadable', detail: k.reason, version: b.previous };
  }
  const from = b.current;
  b.current = b.previous; b.previous = null; b.pending = null; b.rolled_back = from;
  if (from && !b.failed.includes(from)) b.failed.push(from);
  writeBuilds(home, b);
  return { ok: true, version: b.current };
}

/**
 * The fixed launcher. It runs the current build only while its files still have the hashes recorded at install: a build
 * with a changed file is refused at every start, and the launcher goes back to the previous verified build, or stops.
 * It counts each start of a new build's worker; the worker takes its count
 * back once it has run a minute (`markUp`), so only starts that crash early stay counted. After more than three of those
 * it goes back to the previous build, but only to one verified at install whose files still match (the same rule as
 * `rollback`, repeated here because the launcher must not depend on the build it is judging).
 * It cannot open the platform store, so when the build it goes back to cannot read an encrypted key file it says so.
 */
export const LAUNCHER = `#!/usr/bin/env node
// Conclave connector launcher. Written by the connector; do not edit. It runs the current build named in app/builds.json.
import { readFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const app = join(dirname(fileURLToPath(import.meta.url)), 'app');
const file = join(app, 'builds.json');
const V = /^\\d+\\.\\d+\\.\\d+(-[a-z0-9.]+)?$/;
const fail = () => { process.stderr.write('conclave: no connector build is installed here. Reinstall the connector.\\n'); process.exit(1); };
const put = (p, s) => { const t = p + '.' + process.pid + '.tmp'; const fd = openSync(t, 'w'); try { writeSync(fd, s); fsyncSync(fd); } finally { closeSync(fd); } renameSync(t, p); };
// Two flushed copies, the .bak first, as the connector writes its state files (paths.mjs writeState).
const save = (b) => { const s = JSON.stringify(b, null, 2) + '\\n'; put(file + '.bak', s); put(file, s); };
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const unchanged = (b, v) => { const e = b.builds && b.builds[v]; if (!V.test(String(v)) || !e || !e.files || !Object.keys(e.files).length) return false;
  try { return Object.entries(e.files).every(([p, h]) => createHash('sha256').update(readFileSync(join(app, v, ...p.split('/')))).digest('hex') === h); } catch { return false; } };
const intact = (b, v) => unchanged(b, v) && b.builds[v].verified === true;
// After going back: a build without the key store cannot read a key file the newer build encrypted, so say why.
const keysNote = (v) => { let k; try { k = read(join(dirname(app), 'keys.json')); } catch { return; }
  if (k && k.format === 'conclave-keys-enc' && !(b.builds[v] && b.builds[v].files && b.builds[v].files['${KEY_STORE_FILE}']))
    process.stderr.write('conclave: the key file is encrypted and build ' + v + ' cannot read it, so it finds no keys. The keys are still in the file: install the newer connector again to use them.\\n'); };
let b;
try { b = read(file); } catch { try { b = read(file + '.bak'); } catch { fail(); } }
if (process.argv[2] === 'service' && process.argv[3] === 'worker' && b.pending && b.pending.version === b.current) {
  b.pending.boots = (b.pending.boots || 0) + 1;
  if (b.pending.boots > 3 && b.previous && intact(b, b.previous)) {
    b.failed = [...(b.failed || []), b.current]; b.rolled_back = b.current; b.current = b.previous; b.previous = null; b.pending = null;
    keysNote(b.current);
  }
  save(b);
  // A worker that stops only because this PC has no hub yet (exit 76, e.g. before \`conclave migrate\`), or because another
  // worker of this installation runs (exit 77), is not a failed start.
  process.on('exit', (code) => {
    if (code !== 76 && code !== 77) return;
    try { const c = read(file); if (c.pending && c.pending.version === b.current && c.pending.boots > 0) { c.pending.boots--; save(c); } } catch { /* leave the count */ }
  });
}
if (!V.test(String(b.current))) fail();
// Every start: a build whose files changed since install is never run (a file transfer or another program may have written there).
if (!unchanged(b, b.current)) {
  const bad = b.current;
  if (!(b.previous && intact(b, b.previous))) { process.stderr.write('conclave: the connector build ' + bad + ' has a file that changed since it was installed, and there is no verified build to go back to. Reinstall the connector.\\n'); process.exit(1); }
  b.failed = [...(b.failed || []).filter((x) => x !== bad), bad]; b.rolled_back = bad; b.current = b.previous; b.previous = null; b.pending = null;
  save(b);
  process.stderr.write('conclave: the connector build ' + bad + ' has a file that changed since it was installed; running ' + b.current + ' instead.\\n');
  keysNote(b.current);
}
// The build serves the installation this launcher sits in, whatever the environment it was started from says.
process.env.CONCLAVE_HOME = dirname(app);
await import(pathToFileURL(join(app, b.current, 'deploy', 'client', 'conclave.mjs')).href);
`;

export function writeLauncher(home) {
  if (existsSync(launcherPath(home)) && readFileSync(launcherPath(home), 'utf8') === LAUNCHER) return;
  atomicWrite(launcherPath(home), LAUNCHER);
}
