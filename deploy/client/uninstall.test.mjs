/**
 * Tests for removing what the connector owns, and nothing else (connector/uninstall.mjs, connector/disconnect.mjs,
 * connector/notices.mjs; docs/connector.md "Uninstall and disconnect"; proof 12). Run with `npm run test:helper` in
 * server/ (plain node:test). Every case uses a temporary CONCLAVE_HOME and Claude config; no hub is called: the
 * disconnect cases use a fake transport. A throwaway CA is made with `openssl` (the cases are skipped, and say so, if it
 * is not on this PC). Keys here are fake.
 *
 * The proof 12 matrix: pre-existing user settings, edited hub-made files, a client saving settings during the removal, a
 * redirected path, an interrupted removal, a second hub still connected, the private git. After each, only what the
 * connector owns is gone.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { putHub, putAgentKey, readKeyFile, caFingerprint } from './connector/keyfile.mjs';
import { writeToken, countTokens } from './connector/tokens.mjs';
import { registerFolder } from './connector/register.mjs';
import { record } from './connector/manifest.mjs';
import { canonicalFolder, trustKeys, reparsePoints, WIN } from './connector/paths.mjs';
import { unbindFolder } from './connector/registry.mjs';
import { recordStarted, stopStarted, processesPath, runningAs, namesScript } from './connector/processes.mjs';
import { runRemoval, readJournal, journalPath, plan } from './connector/uninstall.mjs';
import { runDisconnect } from './connector/disconnect.mjs';
import { notice, left, NOTICES } from './connector/notices.mjs';
import { servicePlace, serviceTargets } from './connector/service.mjs';
import { USER_ENV_TARGET } from './connector/manifest.mjs';
import { createHash } from 'node:crypto';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'conclave.mjs');
const APP = 'ah_app_FAKEappKEYforUNINSTALLtests1';
const SES = 'ah_ses_FAKEsessionKEYforUNINSTALL001';
const RECEIPT = 'ah_dsc_FAKEreceiptFORuninstallTEST01';
const tmp = [];
const mk = (p = 'conclave-un-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

function findOpenssl() {
  for (const c of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}
const OPENSSL = findOpenssl();
const opts = { skip: OPENSSL ? false : 'openssl is not available on this PC' };
const caCache = new Map();
function makeCa(name) {
  if (caCache.has(name)) return caCache.get(name);
  const d = mk('conclave-un-pki-');
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', `/CN=${name}`], { cwd: d, stdio: 'ignore' });
  const pem = readFileSync(join(d, 'ca.pem'), 'utf8');
  caCache.set(name, pem);
  return pem;
}

/** What is left in a folder (empty when it is gone), so a failure names the leftovers. */
const leftIn = (d) => (existsSync(d) ? readdirSync(d) : []);
const rj = (p) => JSON.parse(readFileSync(p, 'utf8'));
const wj = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };

/** A connector home with one hub and one registered folder; `pre` writes the user's own settings before registration. */
function setup({ hubId = 'hub-one', label = 'dev-1', pre } = {}) {
  const base = mk();
  const home = join(base, 'conclave home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'conclave.mjs'), '');
  const claudeJson = join(base, '.claude.json'); // CLAUDE_CONFIG_DIR=base points the CLI at it
  const s = { base, home, claudeJson, hubs: [] };
  addHub(s, { hubId, label, pre });
  return s;
}
/** Adds a hub section with one registered folder of its own. */
function addHub(s, { hubId, label = 'dev-1', pre }) {
  const caPem = makeCa(`${hubId} CA`);
  const hubKey = putHub(s.home, { hubId, origin: 'https://127.0.0.1:9', caPem, appKey: APP });
  putAgentKey(s.home, hubKey, label, SES);
  writeToken(s.home, hubKey, label, SES, `tok-${hubId}`);
  const folder = join(s.base, `${hubId} folder`);
  mkdirSync(folder);
  pre?.(folder, s);
  const ca = caFingerprint(caPem);
  registerFolder(s.home, folder, { hubId, caSha256: ca, agent: label, claudeJson: s.claudeJson, win: WIN });
  const h = { hubId, ca, hubKey, folder: canonicalFolder(folder) };
  s.hubs.push(h);
  return h;
}
const trust = (s, folder) => { const p = rj(s.claudeJson).projects ?? {}; return trustKeys(folder, WIN).map((k) => p[k]); };
const connectorGone = (folder) => {
  const m = existsSync(join(folder, '.mcp.json')) ? rj(join(folder, '.mcp.json')) : {};
  const st = existsSync(join(folder, '.claude', 'settings.json')) ? rj(join(folder, '.claude', 'settings.json')) : {};
  return !m.mcpServers?.conclave && !(st.enabledMcpjsonServers ?? []).includes('conclave');
};

describe('proof 12: only what the connector owns is removed', { concurrency: false }, () => {
  test("pre-existing user settings, other servers and the project's chat history stay", opts, () => {
    const s = setup({ pre: (f, st) => {
      wj(join(f, '.mcp.json'), { mcpServers: { mine: { command: 'my-server' } } });
      wj(join(f, '.claude', 'settings.json'), { model: 'opus', enabledMcpjsonServers: ['mine'] });
      wj(st.claudeJson, { theme: 'dark', projects: { [trustKeys(canonicalFolder(f), WIN)[0]]: { history: ['hello'] } } });
    } });
    const f = s.hubs[0].folder;
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.equal(r.done, true);
    assert.deepEqual(r.kept, []);
    assert.deepEqual(rj(join(f, '.mcp.json')), { mcpServers: { mine: { command: 'my-server' } } });
    assert.deepEqual(rj(join(f, '.claude', 'settings.json')), { model: 'opus', enabledMcpjsonServers: ['mine'] });
    const cj = rj(s.claudeJson);
    assert.equal(cj.theme, 'dark');
    assert.deepEqual(cj.projects[trustKeys(f, WIN)[0]].history, ['hello'], 'chat history stays');
    assert.ok(trust(s, f).every((p) => p === undefined || p.hasTrustDialogAccepted === undefined), 'the trust flag the connector set is gone');
    assert.deepEqual(leftIn(s.home), [], "the connector's own folder is gone");
  });

  test('a full uninstall removes the logon service first, then the verified builds and the launcher', opts, () => {
    const s = setup();
    const calls = [];
    const service = { platform: 'darwin', userHome: s.base, uid: 501, exec: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; } };
    const place = servicePlace(s.home, service);
    wj(place.target, { plist: true });
    mkdirSync(join(s.home, 'app', '1.0.0'), { recursive: true });
    writeFileSync(join(s.home, 'app', 'builds.json'), '{}');
    mkdirSync(join(s.home, 'run'), { recursive: true });
    writeFileSync(join(s.home, 'run', 'service.json'), '{}');
    const cx = { home: s.home, claudeJson: s.claudeJson, folders: [], serviceTargets: serviceTargets(s.home, service) };
    record(s.home, { kind: 'service_entry', target: place.target, pointer: null, before: null, installed: { kind: place.kind, name: place.name } }, cx);
    record(s.home, { kind: 'launcher', target: join(s.home, 'conclave.mjs'), pointer: null, before: null, installed: 'launcher' }, cx);
    record(s.home, { kind: 'app_build', target: join(s.home, 'app'), pointer: null, before: null, installed: 'builds' }, cx);
    const steps = plan(s.home, { kind: 'all' }).steps.map((x) => x.kind);
    assert.equal(steps[0], 'service_entry', 'nothing can start the worker again while the rest is removed');
    assert.ok(steps.indexOf('app_build') > steps.indexOf('portable_git') || !steps.includes('portable_git'));
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson, service });
    assert.equal(r.done, true);
    assert.deepEqual(r.kept, []);
    assert.ok(calls.some((c) => c.startsWith('launchctl bootout')), 'the service is stopped');
    assert.equal(existsSync(place.target), false, 'the logon entry is gone');
    assert.deepEqual(leftIn(s.home), [], 'builds, launcher and run files are gone with the folder');
  });

  test("setup's instructions file goes only while unchanged; the Git Bash variable is undone only while it holds setup's value", opts, () => {
    const s = setup({ hubId: 'hub-one' });
    const h2 = addHub(s, { hubId: 'hub-two' });
    const [a, b] = [s.hubs[0].folder, h2.folder];
    const text = 'You are the developer.\n';
    const hash = createHash('sha256').update(text).digest('hex');
    for (const f of [a, b]) {
      writeFileSync(join(f, 'CLAUDE.md'), text);
      record(s.home, { kind: 'instructions', target: join(f, 'CLAUDE.md'), folder: f, pointer: null, before: null, installed: { sha256: hash } }, { home: s.home, claudeJson: s.claudeJson, folders: [f] });
    }
    writeFileSync(join(b, 'CLAUDE.md'), text + 'My own note.\n'); // the user edited one
    const bash = join(s.home, 'git', 'usr', 'bin', 'bash.exe');
    record(s.home, { kind: 'user_env', target: USER_ENV_TARGET, pointer: 'CLAUDE_CODE_GIT_BASH_PATH', before: null, installed: bash }, { home: s.home, claudeJson: s.claudeJson, folders: [] });
    const env = new Map([['CLAUDE_CODE_GIT_BASH_PATH', bash]]);
    const userEnv = { get: (n) => env.get(n) ?? null, set: (n, v) => env.set(n, v), unset: (n) => env.delete(n) };
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson, userEnv });
    assert.equal(r.done, true);
    assert.equal(existsSync(join(a, 'CLAUDE.md')), false, 'the untouched file setup wrote is gone');
    assert.equal(readFileSync(join(b, 'CLAUDE.md'), 'utf8'), text + 'My own note.\n', 'the edited one stays');
    assert.deepEqual(r.kept.map((k) => [k.kind, k.reason]), [['instructions', 'edited']]);
    assert.equal(env.has('CLAUDE_CODE_GIT_BASH_PATH'), false, 'the variable setup added is removed');

    const t = setup();
    record(t.home, { kind: 'user_env', target: USER_ENV_TARGET, pointer: 'CLAUDE_CODE_GIT_BASH_PATH', before: 'C:\\mine\\bash.exe', installed: bash }, { home: t.home, claudeJson: t.claudeJson, folders: [] });
    const env2 = new Map([['CLAUDE_CODE_GIT_BASH_PATH', bash]]);
    runRemoval(t.home, { kind: 'all' }, { claudeJson: t.claudeJson, userEnv: { get: (n) => env2.get(n) ?? null, set: (n, v) => env2.set(n, v), unset: (n) => env2.delete(n) } });
    assert.equal(env2.get('CLAUDE_CODE_GIT_BASH_PATH'), 'C:\\mine\\bash.exe', 'the value from before setup comes back');

    const u = setup();
    record(u.home, { kind: 'user_env', target: USER_ENV_TARGET, pointer: 'CLAUDE_CODE_GIT_BASH_PATH', before: null, installed: bash }, { home: u.home, claudeJson: u.claudeJson, folders: [] });
    const env3 = new Map([['CLAUDE_CODE_GIT_BASH_PATH', 'D:\\theirs\\bash.exe']]);
    const r3 = runRemoval(u.home, { kind: 'all' }, { claudeJson: u.claudeJson, userEnv: { get: (n) => env3.get(n) ?? null, set: (n, v) => env3.set(n, v), unset: (n) => env3.delete(n) } });
    assert.equal(env3.get('CLAUDE_CODE_GIT_BASH_PATH'), 'D:\\theirs\\bash.exe', 'a value the user changed stays');
    assert.deepEqual(r3.kept.map((k) => [k.kind, k.reason]), [['user_env', 'edited']]);
  });

  test('Disconnect this hub from this PC never touches the logon service', opts, () => {
    const s = setup();
    const calls = [];
    const service = { platform: 'darwin', userHome: s.base, uid: 501, exec: (cmd, args) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' }; } };
    const place = servicePlace(s.home, service);
    wj(place.target, { plist: true });
    record(s.home, { kind: 'service_entry', target: place.target, pointer: null, before: null, installed: { kind: place.kind, name: place.name } }, { home: s.home, claudeJson: s.claudeJson, folders: [], serviceTargets: serviceTargets(s.home, service) });
    const h = s.hubs[0];
    const r = runRemoval(s.home, { kind: 'hub', hubId: h.hubId, caSha256: h.ca }, { claudeJson: s.claudeJson, reported: true, service });
    assert.equal(r.done, true);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(place.target), true);
  });

  test('a file the connector made and nobody touched is deleted; a hub-made entry the user edited is kept and listed', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    const m = rj(join(f, '.mcp.json'));
    m.mcpServers.conclave.env = { EXTRA: '1' }; // the user edited the connector's entry
    wj(join(f, '.mcp.json'), m);
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.equal(r.done, true);
    assert.deepEqual(r.kept.map((k) => [k.kind, k.reason]), [['mcp_entry', 'edited']]);
    assert.ok(rj(join(f, '.mcp.json')).mcpServers.conclave.env, 'the edited entry is still there');
    assert.equal(existsSync(join(f, '.claude', 'settings.json')), false, 'the approval file the connector made alone is gone');
    assert.match(left(r.kept)[0], /^An MCP entry in an agent folder was kept\. You changed it/);
    assert.ok(!left(r.kept).join(' ').includes(f), 'the hub sentences never carry a path');
  });

  test('a client saving settings during the removal keeps what it saved', opts, () => {
    const s = setup({ pre: (f) => wj(join(f, '.claude', 'settings.json'), { model: 'opus' }) });
    const f = s.hubs[0].folder;
    const target = join(f, '.claude', 'settings.json');
    let saved = 0;
    const hooks = { beforeWrite: (p) => { if (p === target && !saved++) { const j = rj(p); j.saved_by_client = true; wj(p, j); } } };
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson, hooks });
    assert.equal(r.done, true);
    assert.ok(saved >= 1);
    assert.deepEqual(rj(target), { model: 'opus', saved_by_client: true }, "the client's save stays and the approval is gone");
  });

  test('a client that keeps saving leaves the step for the next run, never a half-written file', opts, () => {
    const s = setup({ pre: (f) => wj(join(f, '.claude', 'settings.json'), { model: 'opus' }) });
    const target = join(s.hubs[0].folder, '.claude', 'settings.json');
    let n = 0;
    const busy = { beforeWrite: (p) => { if (p === target) { const j = rj(p); j.n = ++n; wj(p, j); } } };
    const r1 = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson, hooks: busy });
    assert.equal(r1.done, false);
    assert.deepEqual(r1.pending, [{ kind: 'mcp_approval', reason: 'busy' }, { kind: 'hook', reason: 'busy' }]);
    assert.ok(existsSync(journalPath(s.home)));
    assert.ok(rj(target).enabledMcpjsonServers.includes('conclave'), 'untouched until a write can be made safely');
    const r2 = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.equal(r2.done, true);
    assert.deepEqual(rj(target), { model: 'opus', n: 6 });
  });

  test('a path through a junction or link is not followed; what is behind it is unchanged', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    const elsewhere = mk('conclave-un-elsewhere-');
    wj(join(elsewhere, 'settings.json'), { enabledMcpjsonServers: ['conclave'], theirs: true });
    rmSync(join(f, '.claude'), { recursive: true, force: true });
    try { symlinkSync(elsewhere, join(f, '.claude'), 'junction'); } catch { return; /* this account may not create links */ }
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.deepEqual(r.kept.map((k) => [k.kind, k.reason]), [['mcp_approval', 'redirected_path'], ['hook', 'redirected_path']]);
    assert.deepEqual(rj(join(elsewhere, 'settings.json')), { enabledMcpjsonServers: ['conclave'], theirs: true });
    assert.equal(existsSync(join(f, '.mcp.json')), false, 'the entry file the connector made alone is gone');
  });

  test('a replaced folder is not touched', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    renameSync(f, f + ' old');
    mkdirSync(f);
    wj(join(f, '.mcp.json'), { mcpServers: { conclave: { command: 'someone else' } } });
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.ok(r.kept.some((k) => k.kind === 'mcp_entry' && k.reason === 'identity_changed'));
    assert.deepEqual(rj(join(f, '.mcp.json')), { mcpServers: { conclave: { command: 'someone else' } } });
  });

  test('an interrupted removal resumes from its journal and finishes', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    const stop = { afterStep: (n) => { if (n === 2) throw new Error('power cut'); } };
    assert.throws(() => runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson, hooks: stop }), /power cut/);
    const j = readJournal(s.home);
    assert.ok(j, 'the journal survives the interruption');
    assert.deepEqual(j.steps.slice(0, 2).map((x) => x.state), ['done', 'done']);
    assert.ok(j.steps.slice(2).every((x) => x.state === 'pending'));
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.equal(r.done, true);
    assert.ok(connectorGone(f));
    assert.deepEqual(leftIn(s.home), []);
  });

  test("disconnecting one hub leaves a second hub's folder, keys and tokens, and the private git", opts, () => {
    const s = setup();
    const two = addHub(s, { hubId: 'hub-two' });
    const one = s.hubs[0];
    mkdirSync(join(s.home, 'git'));
    writeFileSync(join(s.home, 'git', 'git.exe'), '');
    record(s.home, { kind: 'portable_git', target: join(s.home, 'git'), folder: null, pointer: null, before: null, installed: true }, { home: s.home, claudeJson: s.claudeJson, folders: [] });
    const scope = { kind: 'hub', hubId: one.hubId, caSha256: one.ca };
    assert.ok(!plan(s.home, scope).steps.some((x) => x.kind === 'portable_git'), 'the private git is not a hub trace');
    const r = runRemoval(s.home, scope, { claudeJson: s.claudeJson, reported: true });
    assert.equal(r.done, true);
    assert.ok(connectorGone(one.folder));
    assert.equal(countTokens(s.home, one.hubKey), 0);
    assert.ok(rj(join(two.folder, '.mcp.json')).mcpServers.conclave, "the second hub's entry stays");
    assert.ok(trust(s, two.folder).some((p) => p?.hasTrustDialogAccepted === true));
    assert.equal(countTokens(s.home, two.hubKey), 1);
    assert.deepEqual(Object.keys(readKeyFile(s.home).data.hubs), [two.hubKey]);
    assert.ok(existsSync(join(s.home, 'git', 'git.exe')));
    // the full uninstall then takes the private git too
    const all = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.equal(all.done, true);
    assert.deepEqual(leftIn(s.home), []);
  });

  test("a hub's key section waits for the receipt to be reported", opts, () => {
    const s = setup();
    const h = s.hubs[0];
    const scope = { kind: 'hub', hubId: h.hubId, caSha256: h.ca };
    const r = runRemoval(s.home, scope, { claudeJson: s.claudeJson });
    assert.equal(r.done, true);
    assert.deepEqual(r.pending, [{ kind: 'key_section', reason: 'after_receipt' }]);
    assert.ok(readKeyFile(s.home).data.hubs[h.hubKey], 'the app key stays so a lost receipt can be fetched again');
    runRemoval(s.home, scope, { claudeJson: s.claudeJson, reported: true });
    assert.equal(readKeyFile(s.home).data.hubs[h.hubKey], undefined);
    assert.equal(readJournal(s.home), null);
  });
});

/** A fake hub for the disconnect order: records reports; `fail` makes the next report fail. */
function fakeHub({ order = { id: 'dsc_1' }, fail = 0 } = {}) {
  const t = { reports: [], fail, receipts: 0 };
  t.transport = {
    receipt: async () => { t.receipts++; return t.done ? null : RECEIPT; },
    order: async (r) => (r === RECEIPT ? order : null),
    report: async (r, state, l) => { if (t.fail > 0) { t.fail--; return false; } t.reports.push({ r, state, left: l }); t.done = true; return true; },
  };
  return t;
}

describe('Disconnect this hub from this PC', { concurrency: false }, () => {
  test('stops the hub work first, removes its traces, reports once, then drops its key section', opts, async () => {
    const s = setup();
    const h = s.hubs[0];
    const hub = fakeHub();
    const order = [];
    const r = await runDisconnect(s.home, { hubId: h.hubId, caSha256: h.ca }, { claudeJson: s.claudeJson, transport: hub.transport,
      stopHubWork: async (k) => { order.push(['stop', k, connectorGone(h.folder)]); } });
    assert.deepEqual(order, [['stop', h.hubKey, false]], 'the work stops before anything is removed');
    assert.equal(r.state, 'removed');
    assert.equal(r.reported, true);
    assert.deepEqual(hub.reports.map((x) => [x.state, x.left]), [['removed', []]]);
    assert.ok(connectorGone(h.folder));
    assert.equal(readKeyFile(s.home).data.hubs[h.hubKey], undefined);
    assert.equal(r.notice, NOTICES.disconnect_done);
    assert.ok(existsSync(s.home), 'the connector stays unless its user chose otherwise');
  });

  test('with remote cleanup off on the PC, only cleanup_off is reported and nothing on disk changes', opts, async () => {
    const s = setup();
    const h = s.hubs[0];
    wj(join(s.home, 'preferences.json'), { remote_cleanup: false });
    const before = readFileSync(join(h.folder, '.mcp.json'), 'utf8');
    const hub = fakeHub();
    let stopped = false;
    const r = await runDisconnect(s.home, { hubId: h.hubId, caSha256: h.ca }, { claudeJson: s.claudeJson, transport: hub.transport, stopHubWork: () => { stopped = true; } });
    assert.equal(r.state, 'cleanup_off');
    assert.deepEqual(hub.reports.map((x) => x.state), ['cleanup_off']);
    assert.equal(readFileSync(join(h.folder, '.mcp.json'), 'utf8'), before);
    assert.equal(stopped, false);
    assert.equal(readJournal(s.home), null);
    assert.equal(r.notice, NOTICES.cleanup_off);
  });

  test('a failed report keeps the journal and the key; the next run reports and finishes', opts, async () => {
    const s = setup();
    const h = s.hubs[0];
    const hub = fakeHub({ fail: 1 });
    const id = { hubId: h.hubId, caSha256: h.ca };
    const r1 = await runDisconnect(s.home, id, { claudeJson: s.claudeJson, transport: hub.transport });
    assert.equal(r1.state, 'resume_later');
    assert.equal(r1.notice, NOTICES.disconnect_waiting);
    assert.ok(readJournal(s.home));
    assert.ok(readKeyFile(s.home).data.hubs[h.hubKey]);
    const r2 = await runDisconnect(s.home, id, { claudeJson: s.claudeJson, transport: hub.transport });
    assert.equal(r2.state, 'removed');
    assert.equal(hub.reports.length, 1, 'reported once');
    assert.equal(readJournal(s.home), null);
    assert.equal(readKeyFile(s.home).data.hubs[h.hubKey], undefined);
  });

  test('an unreachable hub changes nothing and says it will finish later', opts, async () => {
    const s = setup();
    const h = s.hubs[0];
    const t = { receipt: async () => { throw new Error('hub_unreachable'); } };
    const r = await runDisconnect(s.home, { hubId: h.hubId, caSha256: h.ca }, { claudeJson: s.claudeJson, transport: t });
    assert.equal(r.state, 'resume_later');
    assert.ok(!connectorGone(h.folder));
  });

  test('a hub that did not disconnect this PC gives no receipt, and nothing changes', opts, async () => {
    const s = setup();
    const h = s.hubs[0];
    const t = { receipt: async () => null };
    const r = await runDisconnect(s.home, { hubId: h.hubId, caSha256: h.ca }, { claudeJson: s.claudeJson, transport: t });
    assert.equal(r.state, 'no_order');
    assert.ok(!connectorGone(h.folder));
    assert.ok(readKeyFile(s.home).data.hubs[h.hubKey]);
  });

  test('edited items are kept and reported in fixed sentences without paths', opts, async () => {
    const s = setup();
    const h = s.hubs[0];
    const m = rj(join(h.folder, '.mcp.json'));
    m.mcpServers.conclave.args.push('--mine');
    wj(join(h.folder, '.mcp.json'), m);
    const hub = fakeHub();
    const r = await runDisconnect(s.home, { hubId: h.hubId, caSha256: h.ca }, { claudeJson: s.claudeJson, transport: hub.transport });
    assert.equal(r.state, 'needs_attention');
    assert.equal(hub.reports[0].state, 'needs_attention');
    assert.equal(hub.reports[0].left.length, 1);
    assert.ok(!hub.reports[0].left[0].includes(h.folder) && !hub.reports[0].left[0].includes('\\'));
    assert.equal(r.notice, notice('disconnect_kept', { count: 1 }));
  });

  test('the connector goes with the last hub only when its user chose that', opts, async () => {
    const s = setup();
    addHub(s, { hubId: 'hub-two' });
    wj(join(s.home, 'preferences.json'), { remove_connector_with_last_hub: true });
    const [one, two] = s.hubs;
    await runDisconnect(s.home, { hubId: one.hubId, caSha256: one.ca }, { claudeJson: s.claudeJson, transport: fakeHub().transport });
    assert.ok(existsSync(join(s.home, 'keys.json')), 'a hub is left, so the connector stays');
    await runDisconnect(s.home, { hubId: two.hubId, caSha256: two.ca }, { claudeJson: s.claudeJson, transport: fakeHub().transport });
    assert.deepEqual(leftIn(s.home), [], 'the last hub went and the user chose to remove the connector with it');
  });
});

describe('fixed words', () => {
  test('notices are fixed sentences; only a count varies; an unknown code has a fixed fallback', () => {
    assert.equal(notice('disconnect_kept', { count: 2 }), NOTICES.disconnect_kept.replace('{count}', '2'));
    assert.equal(notice('disconnect_kept', { count: 'C:\\x' }), NOTICES.disconnect_kept.replace('{count}', '0'));
    assert.match(notice('anything from a hub'), /^Conclave has something for you on this PC/);
    for (const t of Object.values(NOTICES)) assert.ok(!/[\\/]/.test(t.replace('(Disconnect this hub from this PC)', '')), 'no path in a notice');
  });
});

describe('conclave uninstall', { concurrency: false }, () => {
  test('removes everything the connector owns, lists what it kept, and points to the console for the hub side', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    const m = rj(join(f, '.mcp.json'));
    m.mcpServers.conclave.env = { MINE: '1' };
    wj(join(f, '.mcp.json'), m);
    const env = { ...process.env, CONCLAVE_HOME: s.home, CLAUDE_CONFIG_DIR: s.base };
    const c = spawnSync(process.execPath, [CLI, 'uninstall'], { env, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /Conclave was removed from this PC, except 1 item/);
    assert.match(c.stdout, /kept: .*\.mcp\.json \(You changed it/);
    assert.match(c.stdout, /Disconnect this hub from this PC/);
    assert.ok(!c.stdout.includes(APP) && !c.stdout.includes(SES), 'no key in the output');
    assert.deepEqual(leftIn(s.home), []);
  });
});


describe('only what the connector started, guarded text files, unregistered entries, every reparse point', { concurrency: false }, () => {
  const CRLF = String.fromCharCode(13, 10);
  const ctxOf = (s, folder) => ({ home: s.home, claudeJson: s.claudeJson, folders: [folder] });

  test("only processes the connector recorded are ended, a hub's own only, and never a recycled pid", opts, () => {
    const s = setup();
    const [one] = s.hubs;
    recordStarted(s.home, { pid: 101, image: 'node.exe', hubKey: one.hubKey, what: 'worker' });
    recordStarted(s.home, { pid: 102, image: 'node.exe', hubKey: 'other-hub', what: 'worker' });
    recordStarted(s.home, { pid: 103, image: 'codex.exe', hubKey: one.hubKey, what: 'turn' });
    const killed = [];
    const deps = { runningAs: (pid) => pid !== 103, killTree: (pid) => killed.push(pid) }; // 103's pid now runs something else
    const r = stopStarted(s.home, { kind: 'hub', hubKey: one.hubKey }, deps);
    assert.deepEqual(killed, [101]);
    assert.deepEqual(r, { ended: [101], gone: [103] });
    assert.deepEqual(rj(processesPath(s.home)).processes.map((p) => p.pid), [102], "another hub's process is left running");
    stopStarted(s.home, { kind: 'all' }, deps);
    assert.deepEqual(killed, [101, 102]);
  });

  test('uninstall ends a process the connector started and leaves one it did not', opts, async () => {
    const s = setup();
    const keep = ['-e', 'setTimeout(() => {}, 60000)'];
    const ours = spawn(process.execPath, keep, { stdio: 'ignore', windowsHide: true });
    const theirs = spawn(process.execPath, keep, { stdio: 'ignore', windowsHide: true });
    try {
      recordStarted(s.home, { pid: ours.pid, image: process.execPath, hubKey: s.hubs[0].hubKey, what: 'worker' });
      const exited = new Promise((res) => ours.once('exit', res));
      runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
      await exited;
      assert.equal(runningAs(ours.pid, process.execPath), false);
      assert.equal(runningAs(theirs.pid, process.execPath), true, 'a process the connector did not start keeps running');
    } finally { ours.kill(); theirs.kill(); }
  }, 30000);

  test("a reused pid that now runs the user's own Node script is left alone; the connector's own script is ended", opts, async () => {
    const s = setup();
    const dir = mkdtempSync(join(tmpdir(), 'conclave scripts '));
    const ourScript = join(dir, 'conclave.mjs'), userScript = join(dir, 'conclave.mjs.old');
    for (const f of [ourScript, userScript]) writeFileSync(f, 'setInterval(() => {}, 1000);\n');
    const ours = spawn(process.execPath, [ourScript, 'service', 'worker'], { stdio: 'ignore', windowsHide: true });
    const theirs = spawn(process.execPath, [userScript], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(runningAs(ours.pid, process.execPath, ourScript), true, 'the recorded program with the recorded script');
      assert.equal(runningAs(theirs.pid, process.execPath), true, 'the same program...');
      assert.equal(runningAs(theirs.pid, process.execPath, ourScript), false, '...with another script is not ours');
      recordStarted(s.home, { pid: ours.pid, image: process.execPath, script: ourScript, what: 'service worker' });
      // As if the connector's worker had ended and its pid had been given to the user's own node.
      recordStarted(s.home, { pid: theirs.pid, image: process.execPath, script: ourScript, what: 'service worker' });
      const exited = new Promise((res) => ours.once('exit', res));
      runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
      await exited;
      assert.equal(runningAs(theirs.pid, process.execPath, userScript), true, "the user's own process keeps running");
    } finally { ours.kill(); theirs.kill(); }
  }, 60000);

  test('a command line names the script only as a whole argument, bare or quoted', () => {
    const w = 'C:\\Users\\Ann Lee\\.conclave\\conclave.mjs';
    assert.equal(namesScript(`"C:\\Program Files\\nodejs\\node.exe" "${w}" service worker`, w, true), true);
    assert.equal(namesScript(`node.exe "${w.toUpperCase()}" service worker`, w, true), true, 'case is ignored on Windows');
    assert.equal(namesScript(`node.exe "${w}.old"`, w, true), false);
    assert.equal(namesScript(`node.exe "C:\\x${w}"`, w, true), false);
    assert.equal(namesScript(null, w, true), false, 'an unreadable command line is not ours');
    assert.equal(namesScript('/usr/bin/node /home/ann/.conclave/conclave.mjs service worker', '/home/ann/.conclave/conclave.mjs', false), true);
    assert.equal(namesScript('/usr/bin/node /home/ann/.conclave/CONCLAVE.mjs', '/home/ann/.conclave/conclave.mjs', false), false, 'case counts elsewhere');
  });

  test('the Codex config and git exclude steps keep CRLF and never overwrite a save made meanwhile', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    const block = ['[mcp_servers.conclave]', 'command = "node"', ''].join(String.fromCharCode(10));
    const toml = join(f, '.codex', 'config.toml');
    mkdirSync(dirname(toml), { recursive: true });
    writeFileSync(toml, ['model = "gpt"', '', ...block.split(String.fromCharCode(10))].join(CRLF));
    record(s.home, { kind: 'codex_entry', target: toml, folder: f, pointer: 'mcp_servers.conclave', before: null, installed: block }, ctxOf(s, f));
    const excl = join(f, '.git', 'info', 'exclude');
    mkdirSync(dirname(excl), { recursive: true });
    writeFileSync(excl, ['# mine', '.mcp.json', 'build/', ''].join(CRLF));
    record(s.home, { kind: 'git_exclude', target: excl, folder: f, pointer: null, before: null, installed: '.mcp.json' }, ctxOf(s, f));
    const saved = new Set();
    const hooks = { beforeWrite: (p) => { if ((p === toml || p === excl) && !saved.has(p)) { saved.add(p); writeFileSync(p, readFileSync(p, 'utf8') + '# saved' + CRLF); } } };
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson, hooks });
    assert.equal(r.done, true);
    assert.equal(saved.size, 2, 'both steps saw a save between their read and their write');
    assert.equal(readFileSync(toml, 'utf8'), ['model = "gpt"', '', '# saved', ''].join(CRLF));
    assert.equal(readFileSync(excl, 'utf8'), ['# mine', 'build/', '# saved', ''].join(CRLF));
  });

  test('a manifest entry whose folder is no longer registered is listed and left alone', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    unbindFolder(s.home, f);
    const before = readFileSync(join(f, '.mcp.json'), 'utf8');
    const r = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson });
    assert.equal(r.done, true);
    const orphans = r.kept.filter((k) => k.reason === 'folder_not_registered').map((k) => k.kind).sort();
    assert.deepEqual(orphans, ['hook', 'mcp_approval', 'mcp_entry', 'trust_flag']);
    assert.equal(readFileSync(join(f, '.mcp.json'), 'utf8'), before);
    assert.match(left(r.kept).join(' '), /Its folder is not registered with Conclave\./);
  });

  test('any reparse point on the way is refused, and a check that cannot run touches nothing', opts, () => {
    const s = setup();
    const f = s.hubs[0].folder;
    const before = readFileSync(join(f, '.claude', 'settings.json'), 'utf8');
    const r1 = runRemoval(s.home, { kind: 'all' }, { claudeJson: s.claudeJson, reparsePoints: (paths) => new Set(paths.filter((p) => p === join(f, '.claude'))) });
    assert.deepEqual(r1.kept.map((k) => [k.kind, k.reason]), [['mcp_approval', 'redirected_path'], ['hook', 'redirected_path']]);
    assert.equal(readFileSync(join(f, '.claude', 'settings.json'), 'utf8'), before);

    const t = setup();
    const g = t.hubs[0].folder;
    const mcp = readFileSync(join(g, '.mcp.json'), 'utf8');
    const r2 = runRemoval(t.home, { kind: 'all' }, { claudeJson: t.claudeJson, reparsePoints: () => null });
    assert.deepEqual(r2.kept.map((k) => k.reason).filter((x) => x === 'reparse_unknown').length, 3);
    assert.equal(readFileSync(join(g, '.mcp.json'), 'utf8'), mcp);
  });

  test('the Windows check names every reparse point, junctions included, and not plain folders', { skip: WIN ? false : 'reparse points are a Windows matter' }, () => {
    const d = mk('conclave-un-rp-');
    mkdirSync(join(d, 'plain'));
    mkdirSync(join(d, 'odd %x% & é'));
    try { symlinkSync(join(d, 'plain'), join(d, 'jn'), 'junction'); } catch { return; }
    const r = reparsePoints([join(d, 'plain'), join(d, 'jn'), join(d, 'missing'), join(d, 'odd %x% & é')]);
    assert.deepEqual([...r], [join(d, 'jn')]);
  });
});
