#!/usr/bin/env node
/**
 * Connector releases, run by the maintainer on their own PC (docs/connector-release.md). The private release key never enters the
 * repository, the hub or a log: this script reads it from the path given and prints only public values.
 *
 *   node deploy/release/connector-release.mjs keygen --out <folder outside the repository>
 *   node deploy/release/connector-release.mjs sign --key <private key .pem> --out <empty folder> [--rollover <statement.json>]
 *   node deploy/release/connector-release.mjs rollover --old-key <old .pem> --new-key <new .pem> [--out <statement.json>]
 *   node deploy/release/connector-release.mjs verify --dir <folder with the three files>
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packBundle, verifyManifest, unpackBundle, releaseNames, keyIdOf, loadTrust, rolloverText, sha256, MANIFEST_FORMAT, platformId, buildInstaller } from '../client/connector/release.mjs';
import { releaseFiles } from '../client/connector/builds.mjs';
import { CONNECTOR_VERSION } from '../client/connector/version.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLATFORMS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
/** The portable git the release pins (proof 8): checked by setup against this hash, never taken from anywhere else. */
const PINNED_GIT = { platform: 'win32-x64', version: '2.56.1', name: 'MinGit-2.56.1-64-bit.zip', sha256: '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd' };

const die = (m) => { process.stderr.write(`connector-release: ${m}\n`); process.exit(1); };
const args = (argv) => { const o = {}; for (let i = 0; i < argv.length; i += 2) { if (!argv[i].startsWith('--') || argv[i + 1] === undefined) die(`bad argument ${argv[i]}`); o[argv[i].slice(2)] = argv[i + 1]; } return o; };
const entryOf = (pub) => { const der = pub.export({ format: 'der', type: 'spki' }).toString('base64'); return { id: keyIdOf(der), public_key: der }; };
const privateKey = (p) => { try { const k = createPrivateKey(readFileSync(p)); if (k.asymmetricKeyType !== 'ed25519') die('the key is not an Ed25519 key'); return k; } catch (e) { die(`the key cannot be read (${e.code ?? 'invalid'})`); } };
const outsideRepo = (p) => { const r = relative(REPO, resolve(p)); return r.startsWith('..') || isAbsolute(r); };

const [cmd, ...rest] = process.argv.slice(2);
const o = args(rest);
if (cmd === 'keygen') {
  if (!o.out) die('keygen needs --out <folder>');
  if (!outsideRepo(o.out)) die('the private key must be written outside the repository');
  const file = join(resolve(o.out), 'conclave-release-key.pem');
  if (existsSync(file)) die('a key file is already there; it was left alone');
  const { privateKey: k, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(resolve(o.out), { recursive: true });
  writeFileSync(file, k.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  process.stdout.write(`Private key written to ${file} (keep it on this PC, with a backup).\nAdd this entry to deploy/client/connector/release-keys.json "keys":\n${JSON.stringify(entryOf(publicKey), null, 2)}\n`);
} else if (cmd === 'rollover') {
  if (!o['old-key'] || !o['new-key']) die('rollover needs --old-key and --new-key');
  const oldK = privateKey(o['old-key']), newK = privateKey(o['new-key']);
  const key = entryOf(createPublicKey(newK));
  const statement = { key, signed_by: entryOf(createPublicKey(oldK)).id, signature: edSign(null, Buffer.from(rolloverText(key)), oldK).toString('base64') };
  const text = JSON.stringify(statement, null, 2) + '\n';
  if (o.out) writeFileSync(o.out, text); else process.stdout.write(text);
} else if (cmd === 'sign') {
  if (!o.key || !o.out) die('sign needs --key and --out');
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length) die('the output folder must be empty');
  const k = privateKey(o.key);
  const me = entryOf(createPublicKey(k));
  const rollover = o.rollover ? JSON.parse(readFileSync(o.rollover, 'utf8')) : null;
  if (rollover && rollover.key?.id !== me.id) die('the rollover statement is for another key');
  const trust = loadTrust(join(REPO, 'deploy', 'client', 'connector', 'release-keys.json'));
  if (!trust.keys.some((x) => x.id === me.id) && !rollover) die('this key is not in release-keys.json; add it, or sign with --rollover from a key that is');
  const n = releaseNames(CONNECTOR_VERSION);
  const bundle = packBundle(releaseFiles(REPO));
  const manifest = { format: MANIFEST_FORMAT, version: CONNECTOR_VERSION, platforms: PLATFORMS, bundle: { name: n.bundle, sha256: sha256(bundle), size: bundle.length }, git: PINNED_GIT, key_id: me.id, rollover, created_at: new Date().toISOString() };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const sig = edSign(null, Buffer.from(text, 'utf8'), k).toString('base64');
  writeFileSync(join(out, n.manifest), text);
  writeFileSync(join(out, n.signature), sig + '\n');
  writeFileSync(join(out, n.bundle), bundle);
  // The installer carries the keys this build trusts (and the new key of a rollover), so it checks the release with no hub.
  const installer = buildInstaller(readFileSync(join(REPO, 'deploy', 'client', 'install.mjs'), 'utf8'), { version: CONNECTOR_VERSION, release_base: trust.release_base, keys: rollover ? [...trust.keys, rollover.key] : trust.keys });
  writeFileSync(join(out, n.installer), installer);
  // Check what was written the way a PC will, from the previous version (0.0.0) with this version approved.
  const v = verifyManifest({ manifestText: text, signature: sig, trust: rollover ? { keys: trust.keys.filter((x) => x.id === rollover.signed_by) } : trust, wanted: CONNECTOR_VERSION, current: '0.0.0', platform: platformId(), approved: [CONNECTOR_VERSION] });
  if (!v.ok) die(`the release does not verify (${v.reason})`);
  if (!unpackBundle(bundle, manifest.bundle).ok) die('the bundle does not unpack');
  process.stdout.write(`Release ${CONNECTOR_VERSION} signed by key ${me.id}.\nUpload to the tag ${n.tag}: ${n.installer}, ${n.manifest}, ${n.signature}, ${n.bundle}\nBundle SHA-256 ${manifest.bundle.sha256}, ${bundle.length} bytes. Installer SHA-256 ${sha256(Buffer.from(installer))}.\nPublish the key id ${me.id} on the release page, for PC users to compare.\n`);
} else if (cmd === 'verify') {
  if (!o.dir) die('verify needs --dir');
  const n = releaseNames(CONNECTOR_VERSION);
  const text = readFileSync(join(o.dir, n.manifest), 'utf8');
  const v = verifyManifest({ manifestText: text, signature: readFileSync(join(o.dir, n.signature), 'utf8').trim(), trust: loadTrust(join(REPO, 'deploy', 'client', 'connector', 'release-keys.json')), wanted: CONNECTOR_VERSION, current: '0.0.0', platform: platformId(), approved: [CONNECTOR_VERSION] });
  if (!v.ok) die(`refused: ${v.reason}`);
  const u = unpackBundle(readFileSync(join(o.dir, n.bundle)), v.manifest.bundle);
  if (!u.ok) die(`refused: ${u.reason}`);
  process.stdout.write(`Release ${CONNECTOR_VERSION} verifies: key ${v.signer}, ${u.files.length} files.\n`);
} else die('usage: keygen --out <folder> | sign --key <pem> --out <folder> [--rollover <file>] | rollover --old-key <pem> --new-key <pem> [--out <file>] | verify --dir <folder>');
