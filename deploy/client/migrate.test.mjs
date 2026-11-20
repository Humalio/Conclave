/**
 * Tests for moving an old PC to the connector (connector/migrate.mjs, `conclave migrate`), run with `npm run test:helper`.
 * An old PC is built in a temporary CONCLAVE_HOME: keys.env, onboarding/state.json, hub-ca.pem, an old Claude folder (an
 * `agent-hub` entry with the headers helper) and an old Codex folder (the bridge). The hub is a stub on 127.0.0.1 over
 * HTTPS with a throwaway CA made by openssl (those cases skip, saying so, if openssl is not on this PC). Keys are fake.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import https from 'node:https';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discover, plan, migrate, rollback, finish, legacyPieces, replaceCodexTable, stopOldWake, stopOldBridge, migrationState, dryRunRetired } from './connector/migrate.mjs';
import { caFingerprint, readKeyFile } from './connector/keyfile.mjs';
import { resolveFolder } from './connector/registry.mjs';
import { runCheck } from './connector/check.mjs';
import { startBroker } from './connector/broker.mjs';
import { approveFolderByConnector } from './connector/approvals.mjs';
process.env.CONCLAVE_KEY_STORE = 'file';
import { canonicalFolder, WIN } from './connector/paths.mjs';
import { line } from './connector/reasons.mjs';
import { OVERRIDE_MARKER, overrideState } from './connector/role.mjs';
import { agentsOverride } from './codex.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'conclave.mjs');
const APP = 'ah_app_FAKEappKEYforMIGRATIONtest01';
const KEY_A = 'ah_ses_FAKEsessionKEYforMIGRATIONa1';
const KEY_B = 'ah_ses_FAKEsessionKEYforMIGRATIONb2';
const KEY_C = 'ah_ses_FAKEsessionKEYforMIGRATIONc3';
const tmp = [];
const mk = (p = 'conclave-mig-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
// A move's rollback copies: in a folder of its own under migration/backups (one per run).
const hasBackups = (home) => { const d = join(home, 'migration', 'backups'); return existsSync(d) && readdirSync(d).some((r) => readdirSync(join(d, r)).length > 0); };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

function findOpenssl() {
  for (const c of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}
const OPENSSL = findOpenssl();
const tlsOpts = { skip: OPENSSL ? false : 'openssl is not available on this PC' };
function makePki(name) {
  const d = mk('conclave-pki-');
  const o = (...a) => execFileSync(OPENSSL, a, { cwd: d, stdio: 'ignore' });
  o('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  o('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 's.key', '-out', 's.csr', '-subj', '/CN=localhost');
  writeFileSync(join(d, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n');
  o('x509', '-req', '-in', 's.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 's.pem', '-days', '2', '-extfile', 'ext.cnf');
  return { ca: readFileSync(join(d, 'ca.pem'), 'utf8'), cert: readFileSync(join(d, 's.pem'), 'utf8'), key: readFileSync(join(d, 's.key'), 'utf8') };
}
/** A hub that signs in the listed session keys for the fake app key. */
function stubHub(pki, valid = new Set([KEY_A, KEY_B]), id = 'hub-real-1') {
  const hub = { logins: 0, valid, id, retired: new Set(), live: new Set(), cap: Infinity };
  hub.server = https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    if (req.method === 'GET' && req.url === '/connector/v1/hub') {
      if (!hub.id) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ hub_id: hub.id, origin: hub.origin }));
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = JSON.parse(raw);
      const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== `Bearer ${APP}`) return send(401, { error: 'unauthorized' });
      if (req.url.startsWith('/connector/v1/turn-tokens')) {
        if (req.url.endsWith('/turn-tokens') && !hub.valid.has(m.session_key)) return send(401, { error: 'unauthorized' });
        return send(200, { token: 'tok-turn', agent_id: 'agent-1', label: 'A', expires_at: Date.now() + 900_000, ended: true });
      }
      if (m.params?.name === 'session_login') {
        hub.logins++;
        if (hub.retired.has(m.params.arguments.session_key)) return send(200, { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [], structuredContent: { error: 'key_inactive', message: 'This session key is revoked.' } } });
        if (!hub.valid.has(m.params.arguments.session_key)) return send(401, { error: 'unauthorized' });
        if (hub.live.size >= hub.cap) return send(200, { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [], structuredContent: { error: 'rate_limited', message: `this app already has ${hub.live.size} live sessions (limit ${hub.cap})` } } });
        hub.live.add(`tok-${hub.logins}`);
        return send(200, { jsonrpc: '2.0', id: m.id, result: { content: [], structuredContent: { session_token: `tok-${hub.logins}` } } });
      }
      if (m.params?.name === 'session_logout') { hub.live.delete(m.params.arguments.session_token); return send(200, { jsonrpc: '2.0', id: m.id, result: { content: [], structuredContent: { ok: true } } }); }
      send(200, { jsonrpc: '2.0', id: m.id, result: {} });
    });
  });
  return new Promise((res) => hub.server.listen(0, '127.0.0.1', () => { hub.origin = `https://127.0.0.1:${hub.server.address().port}`; hub.close = () => new Promise((r) => hub.server.close(r)); res(hub); }));
}

const snapshot = (dir) => {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { recursive: true }).sort().map((p) => { const st = statSync(join(dir, p)); return `${p}:${st.isFile() ? readFileSync(join(dir, p), 'utf8') : 'dir'}`; }).join('\n');
};

const OLD_TOML = (folder) => `# Written by Conclave setup.mjs for demo. Local config: never commit it.
# UNVERIFIED
model = "gpt-test"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.agent_hub]
command = "node"
args = ["/old/codex-bridge.mjs", ${JSON.stringify(folder)}, "--keys-file", "/old/keys.env"]
startup_timeout_sec = 20
tool_timeout_sec = 300
`;

/** An old PC: home with keys.env/state.json/hub-ca.pem, one Claude folder and one Codex folder, in paths with spaces. */
function oldPc({ origin, pki = null, ca = true }) {
  const base = mk();
  const home = join(base, 'conclave home');
  mkdirSync(join(home, 'onboarding'), { recursive: true });
  const root = join(base, 'projects root');
  const proj = join(root, 'The Project');
  const fc = join(proj, 'claude-agent'), fx = join(proj, 'codex-agent');
  mkdirSync(fc, { recursive: true }); mkdirSync(fx, { recursive: true });
  const caFile = join(home, 'hub-ca.pem');
  if (pki && ca) writeFileSync(caFile, pki.ca);
  writeFileSync(join(home, 'keys.env'), `# Conclave keys\nAGENT_HUB_APP_KEY=${APP}\nAGENT_HUB_URL=${origin}/mcp\n${pki && ca ? `AGENT_HUB_CA=${caFile.replace(/\\/g, '/')}\n` : ''}CLAUDE_AGENT_KEY=${KEY_A}\nCODEX_AGENT_KEY=${KEY_B}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'onboarding', 'state.json'), JSON.stringify({ version: '1', hub: origin, ca_sha256: pki ? caFingerprint(pki.ca) : undefined, requests: { r1: { root, project: 'The Project', agents: [{ label: 'claude-agent', session_var: 'CLAUDE_AGENT_KEY', folder: 'claude-agent' }, { label: 'codex-agent', session_var: 'CODEX_AGENT_KEY', folder: 'codex-agent' }] } } }));
  writeFileSync(join(fc, '.mcp.json'), JSON.stringify({ mcpServers: { 'agent-hub': { type: 'http', url: `${origin}/mcp`, headersHelper: `node "${home.replace(/\\/g, '/')}/agent-hub-headers.mjs" "${fc.replace(/\\/g, '/')}"` }, mine: { command: 'x', args: [] } } }, null, 2) + '\n');
  writeFileSync(join(fc, '.agent-hub.json'), JSON.stringify({ session_var: 'CLAUDE_AGENT_KEY' }));
  mkdirSync(join(fx, '.codex'));
  writeFileSync(join(fx, '.codex', 'config.toml'), OLD_TOML(fx.replace(/\\/g, '/')));
  writeFileSync(join(fx, '.agent-hub.json'), JSON.stringify({ session_var: 'CODEX_AGENT_KEY' }));
  writeFileSync(join(home, 'conclave.mjs'), ''); // the connector, installed next to the old pieces
  for (const n of ['setup.mjs', 'agent-hub-headers.mjs', 'codex-bridge.mjs', 'codex-wake.mjs']) writeFileSync(join(home, n), `// old ${n}\n`);
  const claudeJson = join(base, 'claude.json');
  writeFileSync(claudeJson, JSON.stringify({ projects: { [fc.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } } }));
  return { base, home, root, fc: canonicalFolder(fc), fx: canonicalFolder(fx), claudeJson, caFile };
}
/** A Codex agent the old setup never recorded: its own keys file, named by --keys-file and by the wake config. */
function addRowan(s, key = KEY_C) {
  const fa = join(s.base, 'Rowan');
  mkdirSync(join(fa, '.codex'), { recursive: true });
  const fx = fa.replace(/\\/g, '/');
  writeFileSync(join(fa, '.codex', 'config.toml'), OLD_TOML(fx).replace('/old/keys.env', `${fx}/../rowan-keys.env`));
  writeFileSync(join(fa, '.agent-hub.json'), JSON.stringify({ session_var: 'ROWAN_KEY' }));
  writeFileSync(join(s.base, 'rowan-keys.env'), `AGENT_HUB_APP_KEY=${APP}\nROWAN_KEY=${key}\n`, { mode: 0o600 });
  writeFileSync(join(s.home, 'codex-wake.json'), JSON.stringify({ agents: [{ name: 'rowan', keys_file: join(s.base, 'rowan-keys.env'), session_var: 'ROWAN_KEY', workspace: fa, codex_session: '019a0000-0000-7000-8000-000000000000', codex_exe: 'C:/codex.exe' }] }));
  return canonicalFolder(fa);
}
/** What the old setup owned, and the user's Claude config as data (its key order and spacing do not matter). */
const oldState = (s) => JSON.stringify({
  files: ['keys.env', 'hub-ca.pem', 'onboarding/state.json', 'setup.mjs', 'agent-hub-headers.mjs', 'codex-bridge.mjs', 'codex-wake.mjs'].map((p) => readFileSync(join(s.home, p), 'utf8')).concat([join(s.fc, '.mcp.json'), join(s.fc, '.agent-hub.json'), join(s.fx, '.codex', 'config.toml'), join(s.fx, '.agent-hub.json')].map((p) => readFileSync(p, 'utf8'))),
  claude: JSON.parse(readFileSync(s.claudeJson, 'utf8')),
});
const tree = (s) => [snapshot(s.home), snapshot(s.fc), snapshot(s.fx), readFileSync(s.claudeJson, 'utf8')].join('\n--\n');

describe('reading an old PC', () => {
  test('discover finds the hub, the agents, their folders and keys; legacyPieces names what each folder holds', tlsOpts, () => {
    const pki = makePki('Disc CA');
    const s = oldPc({ origin: 'https://127.0.0.1:9', pki });
    const d = discover(s.home);
    assert.equal(d.ok, true); assert.equal(d.https, true);
    assert.deepEqual(d.agents.map((a) => a.label), ['claude-agent', 'codex-agent']);
    assert.equal(d.agents[0].key, KEY_A);
    assert.deepEqual(legacyPieces(s.fc), { claude: true, codex: false });
    assert.deepEqual(legacyPieces(s.fx), { claude: false, codex: true });
    assert.deepEqual(discover(mk()), { ok: false, reason: 'nothing_to_migrate' });
  });
  test('a PC with no old layout, and an unreadable one, are told apart', () => {
    const h = mk(); writeFileSync(join(h, 'keys.env'), 'AGENT_HUB_APP_KEY=x\n');
    assert.equal(discover(h).reason, 'legacy_unreadable');
  });
  test('`conclave check` names an old folder first, with the command to run', tlsOpts, async () => {
    const pki = makePki('Check CA');
    const s = oldPc({ origin: 'https://127.0.0.1:9', pki });
    const r = await runCheck(s.home, s.fc, { claudeJson: s.claudeJson });
    assert.equal(r.reason, 'old_layout');
    assert.match(line('old_layout'), /Run: conclave migrate/);
  });
});

describe('the plan', () => {
  test('changes nothing, lists the steps, and blocks an HTTP PC until HTTPS is given', tlsOpts, () => {
    const pki = makePki('Plan CA');
    const s = oldPc({ origin: 'https://127.0.0.1:9', pki });
    const before = tree(s);
    const p = plan(s.home);
    assert.equal(p.ok, true);
    assert.ok(p.steps.some((x) => /copy the hub key and 2 agent/.test(x)));
    assert.equal(tree(s), before);
    const h = oldPc({ origin: 'http://127.0.0.1:9' });
    assert.deepEqual(plan(h.home).problems.includes('http_needs_https'), true);
    assert.equal(plan(h.home).ok, false);
    const bad = plan(h.home, { https: { origin: 'https://127.0.0.1:9', caPem: pki.ca, caSha256: 'a'.repeat(64) } });
    assert.ok(bad.problems.includes('ca_sha_differs_from_given'));
    assert.ok(plan(h.home, { https: { origin: 'http://127.0.0.1:9', caPem: pki.ca, caSha256: caFingerprint(pki.ca) } }).problems.includes('https_origin_invalid'));
  });
  test('a CA file that no longer matches the recorded fingerprint blocks the move', tlsOpts, () => {
    const pki = makePki('Plan CA 2'), other = makePki('Plan CA 3');
    const s = oldPc({ origin: 'https://127.0.0.1:9', pki });
    writeFileSync(s.caFile, other.ca);
    assert.ok(plan(s.home).problems.includes('ca_mismatch'));
  });
  test('a CA file or a given CA with a second certificate blocks the move; one certificate is kept as itself', tlsOpts, () => {
    const pki = makePki('Plan CA 4'), other = makePki('Plan CA 5');
    const s = oldPc({ origin: 'https://127.0.0.1:9', pki });
    writeFileSync(s.caFile, pki.ca + other.ca);
    assert.ok(plan(s.home).problems.includes('ca_bundle'));
    const h = oldPc({ origin: 'http://127.0.0.1:9' });
    const given = plan(h.home, { https: { origin: 'https://127.0.0.1:9', caPem: pki.ca + other.ca, caSha256: caFingerprint(pki.ca) } });
    assert.ok(given.problems.includes('ca_bundle'));
    writeFileSync(s.caFile, `note\n${pki.ca}`);
    const ok = plan(s.home);
    assert.ok(!ok.problems.includes('ca_bundle') && !ok.problems.includes('ca_invalid'), ok.problems.join(', '));
  });
  test('the command line prints the plan and exits 0 or 1', tlsOpts, async () => {
    const pki = makePki('Cli CA');
    const s = oldPc({ origin: 'https://127.0.0.1:9', pki });
    const run = (args) => new Promise((res) => { const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, CONCLAVE_HOME: s.home, CLAUDE_CONFIG_DIR: dirname(s.claudeJson) } }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; }); c.on('close', (code) => res({ code, o })); });
    const r = await run(['migrate']);
    assert.equal(r.code, 0); assert.match(r.o, /PLAN \(nothing changed/);
    assert.ok(!r.o.includes(APP) && !r.o.includes(KEY_A));
    assert.equal((await run(['migrate', '--rollback'])).code, 1);
  }, 30000);
});

describe('apply, rollback and finish', { concurrency: false }, () => {
  test('moves keys, entries and bindings; the old pieces are removed; every agent signs in; check passes', tlsOpts, async () => {
    const pki = makePki('Apply CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const keysEnv = readFileSync(join(s.home, 'keys.env'), 'utf8');
      writeFileSync(join(s.fx, 'AGENTS.override.md'), agentsOverride({ label: 'codex-agent', role: 'developer', team: 'T', instructions: 'The old playbook.' }));
      assert.equal(overrideState(s.fx), 'old');
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN });
      assert.equal(r.ok, true, r.lines.join('\n'));
      const kf = readKeyFile(s.home).data;
      const [hubKey] = Object.keys(kf.hubs);
      assert.equal(kf.hubs[hubKey].hub_id, 'hub-real-1', "the section is named by the hub's own id");
      assert.match(hubKey, /^hub-real-1@[0-9a-f]{64}$/, 'and keyed by the CA fingerprint too');
      assert.deepEqual(Object.keys(kf.hubs[hubKey].agents).sort(), ['claude-agent', 'codex-agent']);
      const mcp = JSON.parse(readFileSync(join(s.fc, '.mcp.json'), 'utf8')).mcpServers;
      assert.deepEqual(Object.keys(mcp).sort(), ['conclave', 'mine'], 'the agent-hub entry is replaced, other servers stay');
      assert.deepEqual(mcp.conclave.args.slice(1), ['mcp', s.fc]);
      const toml = readFileSync(join(s.fx, '.codex', 'config.toml'), 'utf8');
      assert.match(toml, /\[mcp_servers\.conclave\]/); assert.doesNotMatch(toml, /agent_hub|codex-bridge/); assert.match(toml, /model = "gpt-test"/);
      const role = readFileSync(join(s.fx, 'AGENTS.override.md'), 'utf8');
      assert.equal(role.split('\n')[0], OVERRIDE_MARKER, 'the old override from codex.mjs is replaced by the marked one');
      assert.match(role, /\nThe old playbook\.\n$/, 'with its playbook kept');
      assert.equal(resolveFolder(s.home, s.fx).binding.provider, 'codex');
      for (const p of [join(s.home, 'keys.env'), join(s.home, 'agent-hub-headers.mjs'), join(s.home, 'codex-bridge.mjs'), join(s.home, 'setup.mjs'), join(s.home, 'onboarding', 'state.json'), join(s.fc, '.agent-hub.json'), join(s.fx, '.agent-hub.json')]) assert.equal(existsSync(p), false, `${p} is removed`);
      assert.ok(hasBackups(s.home), 'each removed file is saved for the rollback');
      assert.match(r.lines.join('\n'), /removed the old pieces: .*keys\.env/);
      assert.ok(!r.lines.join('\n').includes(keysEnv.split('\n')[1]), 'no key in the output');
      assert.equal(resolveFolder(s.home, s.fc).ok, true); assert.equal(resolveFolder(s.home, s.fx).ok, true);
      assert.equal(migrationState(s.home).status, 'applied');
      approveFolderByConnector(s.home, s.fc, resolveFolder(s.home, s.fc).binding); // the probe goes through the connector's broker
      const brk = await startBroker({ home: s.home, deps: { renewMs: 3_600_000 } });
      try { assert.equal((await runCheck(s.home, s.fc, { claudeJson: s.claudeJson, win: WIN, probe: true })).ok, true); } finally { await brk.close(); }
      assert.equal(plan(s.home).problems[0], 'nothing_to_migrate');
      assert.ok(!r.lines.join('\n').includes(KEY_A) && !r.lines.join('\n').includes(APP));
    } finally { await hub.close(); }
  }, 60000);
  test('a hub that refuses the first agent changes nothing', tlsOpts, async () => {
    const pki = makePki('Refuse CA'), hub = await stubHub(pki, new Set());
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const before = tree(s);
      const r = await migrate(s.home, { claudeJson: s.claudeJson });
      assert.deepEqual([r.ok, r.rolledBack, r.reason], [false, false, 'login_refused']);
      assert.equal(tree(s), before);
    } finally { await hub.close(); }
  }, 30000);
  test('if an agent cannot sign in after the move, the whole move is rolled back, byte for byte', tlsOpts, async () => {
    const pki = makePki('Rollback CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const before = tree(s), was = oldState(s);
      let n = 0;
      const probe = async () => ++n <= 2; // the two probes before any change (one per agent) pass, every later one fails
      const r = await migrate(s.home, { claudeJson: s.claudeJson, probe });
      assert.deepEqual([r.ok, r.rolledBack, r.reason], [false, true, 'login_refused']);
      const after = tree(s);
      assert.equal(readKeyFile(s.home).data.hubs && Object.keys(readKeyFile(s.home).data.hubs).length, 0);
      assert.equal(resolveFolder(s.home, s.fc).ok, false);
      assert.equal(readFileSync(join(s.fx, '.codex', 'config.toml'), 'utf8'), OLD_TOML(s.fx.replace(/\\/g, '/')));
      assert.equal(JSON.parse(readFileSync(join(s.fc, '.mcp.json'), 'utf8')).mcpServers['agent-hub'].type, 'http');
      assert.equal(existsSync(join(s.fc, '.claude', 'settings.json')), false, 'a settings file the move created is removed again');
      assert.equal(oldState(s), was, 'every file the old setup owned, and ~/.claude.json, is exactly as it was');
      assert.notEqual(after, before, 'only the connector\'s own empty records are left behind');
    } finally { await hub.close(); }
  }, 60000);
  test('an agent the hub reports as retired is skipped and left untouched; the others move', tlsOpts, async () => {
    const pki = makePki('Retired CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      hub.retired.add(KEY_B);
      const fxBefore = [join(s.fx, '.codex', 'config.toml'), join(s.fx, '.agent-hub.json')].map((p) => readFileSync(p, 'utf8'));
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN });
      assert.equal(r.ok, true, r.lines.join('\n'));
      assert.deepEqual(r.skipped, [{ label: 'codex-agent', folder: s.fx }]);
      assert.match(r.lines.join('\n'), /skipped retired agent codex-agent/);
      assert.deepEqual(Object.keys(readKeyFile(s.home).data.hubs[Object.keys(readKeyFile(s.home).data.hubs)[0]].agents), ['claude-agent'], 'only the live agent is in the key file');
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.fc, '.mcp.json'), 'utf8')).mcpServers).sort(), ['conclave', 'mine']);
      assert.deepEqual([join(s.fx, '.codex', 'config.toml'), join(s.fx, '.agent-hub.json')].map((p) => readFileSync(p, 'utf8')), fxBefore, 'the retired agent\'s folder is exactly as it was');
      for (const n of ['keys.env', 'agent-hub-headers.mjs']) assert.equal(existsSync(join(s.home, n)), false, `${n} goes once every live agent has moved: a retired agent does not keep it`);
      assert.ok(!r.lines.join('\n').includes(KEY_B) && !r.lines.join('\n').includes(KEY_A));
      assert.equal(migrationState(s.home).skipped[0].label, 'codex-agent');
    } finally { await hub.close(); }
  }, 60000);
  test('the dry run lists a retired agent by label and folder, and a hub that cannot be asked does not block it', tlsOpts, async () => {
    const pki = makePki('Dry CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      hub.retired.add(KEY_B);
      const before = tree(s);
      const out = (await dryRunRetired(s.home, plan(s.home))).join('\n');
      assert.match(out, /Retired: will be skipped \(1\): codex-agent \(/);
      assert.ok(out.includes(s.fx));
      assert.equal(tree(s), before, 'the dry run changes nothing');
      hub.retired.clear();
      assert.match((await dryRunRetired(s.home, plan(s.home))).join('\n'), /Retired: none/);
      assert.match((await dryRunRetired(s.home, plan(s.home), { probe: async () => { throw Object.assign(new Error('x'), { reason: 'hub_unreachable' }); } })).join('\n'), /could not ask the hub/);
    } finally { await hub.close(); }
  }, 60000);
  test('if every agent is retired nothing changes; a refusal for any other reason changes nothing either', tlsOpts, async () => {
    const pki = makePki('AllRet CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const before = tree(s);
      hub.retired.add(KEY_A); hub.retired.add(KEY_B);
      const r = await migrate(s.home, { claudeJson: s.claudeJson });
      assert.deepEqual([r.ok, r.rolledBack, r.reason], [false, false, 'all_retired']);
      hub.retired.clear(); hub.valid.delete(KEY_B); // an unknown key answered 401, not a retirement
      const r2 = await migrate(s.home, { claudeJson: s.claudeJson });
      assert.deepEqual([r2.ok, r2.rolledBack, r2.reason], [false, false, 'login_refused']);
      assert.equal(tree(s), before);
    } finally { await hub.close(); }
  }, 60000);
  test('the checks end their own sessions: a PC key that allows only one live sign-in is enough', tlsOpts, async () => {
    const pki = makePki('Live CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      hub.cap = 1;
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN });
      assert.equal(r.ok, true, r.lines.join('\n'));
      assert.ok(hub.logins >= 4, 'every agent was asked before and after the move');
      assert.equal(hub.live.size, 0, 'no session is left live');
    } finally { await hub.close(); }
  }, 60000);
  test('a hub at the key\'s live sign-in limit is reported as that, with the limit and what to change, and nothing changes', tlsOpts, async () => {
    const pki = makePki('Limit CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const before = tree(s);
      hub.cap = 0;
      const r = await migrate(s.home, { claudeJson: s.claudeJson });
      assert.deepEqual([r.ok, r.rolledBack, r.reason], [false, false, 'rate_limited']);
      const text = r.lines.join('\n');
      assert.match(text, /limit of live sign-ins \(0 live, at most 0\)/);
      assert.match(text, /raise "Login limit"/);
      assert.doesNotMatch(text, /other than retirement/);
      assert.equal(tree(s), before);
      assert.match((await dryRunRetired(s.home, plan(s.home))).join('\n'), /limit of live sign-ins/);
      // After the move, a limit that appears makes the whole move roll back, and says why.
      hub.cap = Infinity; let n = 0;
      const probe = async () => (++n <= 2 ? 'ok' : { verdict: 'rate_limited', live: 100, limit: 100 });
      const r2 = await migrate(s.home, { claudeJson: s.claudeJson, probe });
      assert.deepEqual([r2.ok, r2.rolledBack, r2.reason], [false, true, 'rate_limited']);
      assert.match(r2.lines.join('\n'), /100 live, at most 100.*rolled back/);
    } finally { await hub.close(); }
  }, 60000);
  test('a Codex agent with its own keys file is found, moved with the others, and its wake files are left alone', tlsOpts, async () => {
    const pki = makePki('Rowan CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      hub.valid.add(KEY_C);
      const fa = addRowan(s);
      const p = plan(s.home);
      assert.equal(p.ok, true, p.problems.join());
      assert.match(p.steps.join('\n'), /rowan \(a Codex agent with its own keys file rowan-keys\.env/);
      assert.match(p.steps.join('\n'), /old Codex wake keeps running/);
      assert.ok(!p.steps.join(' ').includes(KEY_C), 'the printed plan never holds the key text');
      const calls = [];
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN, run: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 1, stdout: '', stderr: '' }; } });
      assert.equal(r.ok, true, r.lines.join('\n'));
      const kf = readKeyFile(s.home).data; const sec = kf.hubs[Object.keys(kf.hubs)[0]];
      assert.deepEqual(Object.keys(sec.agents).sort(), ['claude-agent', 'codex-agent', 'rowan']);
      assert.match(readFileSync(join(fa, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.conclave\]/);
      for (const n of ['rowan-keys.env']) assert.equal(existsSync(join(s.base, n)), true, `${n} stays`);
      for (const n of ['codex-wake.json', 'codex-wake.mjs', 'codex-bridge.mjs']) assert.equal(existsSync(join(s.home, n)), true, `${n} stays for the wake`);
      assert.equal(existsSync(join(fa, '.agent-hub.json')), true, 'the wake still reads the folder\'s .agent-hub.json');
      for (const n of ['keys.env', 'agent-hub-headers.mjs', 'setup.mjs']) assert.equal(existsSync(join(s.home, n)), false, `${n} is removed`);
      assert.ok(!r.lines.join('\n').includes(KEY_C));
      assert.ok(!calls.some((c) => /kill|taskkill|codex-wake/.test(c)), 'no process of the wake is touched');
    } finally { await hub.close(); }
  }, 60000);
  test('on a PC that already moved, only the folder still on the old layout is moved; a rollback undoes just that', tlsOpts, async () => {
    const pki = makePki('Rowan2 CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson, win: WIN })).ok, true);
      assert.equal(finish(s.home, { userEnv: { get: () => null, unset() {} } }).ok, true, 'the first move is final');
      hub.valid.add(KEY_C);
      const fa = addRowan(s);
      const mcpBefore = readFileSync(join(s.fc, '.mcp.json'), 'utf8');
      const p = plan(s.home);
      assert.equal(p.ok, true, p.problems.join());
      assert.deepEqual(p.agents.map((a) => a.label), ['rowan'], 'the dry run lists Rowan and only Rowan');
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN });
      assert.equal(r.ok, true, r.lines.join('\n'));
      const kf = readKeyFile(s.home).data; const sec = kf.hubs[Object.keys(kf.hubs)[0]];
      assert.deepEqual(Object.keys(sec.agents).sort(), ['claude-agent', 'codex-agent', 'rowan']);
      assert.equal(readFileSync(join(s.fc, '.mcp.json'), 'utf8'), mcpBefore, 'the folders that had moved are left alone');
      assert.equal(existsSync(join(s.home, 'codex-wake.json')), true);
      assert.equal(migrationState(s.home).status, 'applied');
      assert.equal(rollback(s.home).ok, true);
      const after = readKeyFile(s.home).data; const sec2 = after.hubs[Object.keys(after.hubs)[0]];
      assert.deepEqual(Object.keys(sec2.agents).sort(), ['claude-agent', 'codex-agent'], 'the rollback removes only Rowan\'s key, not the hub or the others');
      assert.match(readFileSync(join(fa, '.codex', 'config.toml'), 'utf8'), /agent_hub/);
      assert.equal(readFileSync(join(s.fc, '.mcp.json'), 'utf8'), mcpBefore);
      assert.equal(plan(s.home).ok, true, 'and Rowan can be moved again');
    } finally { await hub.close(); }
  }, 90000);
  test('a second move before --finish is refused, and the first move can still be rolled back', tlsOpts, async () => {
    const pki = makePki('Unfinished CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const before = oldState(s);
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson, win: WIN })).ok, true);
      hub.valid.add(KEY_C);
      addRowan(s);
      const p = plan(s.home);
      assert.equal(p.ok, false);
      assert.ok(p.problems.includes('finish_first'));
      const snap = tree(s);
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN });
      assert.deepEqual([r.ok, r.rolledBack, r.reason], [false, false, 'finish_first']);
      assert.match(r.lines.join(' '), /conclave migrate --finish/);
      assert.equal(tree(s), snap, 'nothing changed');
      assert.equal(rollback(s.home).ok, true);
      assert.equal(oldState(s), before, 'the first move is still restored byte for byte');
    } finally { await hub.close(); }
  }, 90000);
  test('a move a crash interrupted is rolled back first on the rerun; the first run copies stay intact', tlsOpts, async () => {
    const pki = makePki('Crash CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const before = oldState(s);
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson, win: WIN })).ok, true);
      // a crash after the changes but before the journal said `applied`
      const jf = join(s.home, 'migration', 'state.json');
      const j = JSON.parse(readFileSync(jf, 'utf8')); j.status = 'applying'; writeFileSync(jf, JSON.stringify(j));
      const dir = join(s.home, 'migration', 'backups');
      const copies = () => Object.fromEntries(readdirSync(dir).flatMap((r) => readdirSync(join(dir, r)).map((b) => [`${r}/${b}`, readFileSync(join(dir, r, b), 'utf8')])));
      const first = copies();
      assert.ok(Object.keys(first).length > 0);
      assert.match(plan(s.home).steps.join('\n'), /an earlier move was interrupted/);
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN });
      assert.equal(r.ok, true, r.lines.join('\n'));
      assert.match(r.lines[0], /an earlier move was interrupted; it was rolled back first/);
      const now = copies();
      for (const [k, v] of Object.entries(first)) assert.equal(now[k], v, `${k} is kept as the first run saved it`);
      assert.equal(readdirSync(dir).length, 2, 'the rerun keeps its copies in a folder of its own');
      assert.equal(rollback(s.home).ok, true);
      assert.equal(oldState(s), before, 'rolling back the rerun gives the PC as it was before both runs');
    } finally { await hub.close(); }
  }, 90000);
  test('a wake config that lists a workspace keeps the wake and its files even when no listed folder is moved now', tlsOpts, async () => {
    const pki = makePki('WakeKeep CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      writeFileSync(join(s.home, 'codex-wake.json'), JSON.stringify({ agents: [{ name: 'rowan', keys_file: join(s.base, 'rowan-keys.env'), session_var: 'ROWAN_KEY', workspace: join(s.base, 'Rowan-already-moved'), codex_session: 'x', codex_exe: 'x' }] }));
      assert.match(plan(s.home).steps.join(' '), /old Codex wake keeps running/);
      const calls = [];
      const r = await migrate(s.home, { claudeJson: s.claudeJson, win: WIN, run: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 1, stdout: '', stderr: '' }; } });
      assert.equal(r.ok, true, r.lines.join(' '));
      for (const n of ['codex-wake.json', 'codex-wake.mjs', 'codex-bridge.mjs']) assert.equal(existsSync(join(s.home, n)), true, `${n} stays`);
      assert.ok(!calls.some((c) => /kill|taskkill|codex-wake/.test(c)));
    } finally { await hub.close(); }
  }, 60000);
  test('--finish refuses while a skipped agent is still on the PC, names it, and goes ahead once its folder is gone', tlsOpts, async () => {
    const pki = makePki('Finish CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      hub.retired.add(KEY_B);
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson, win: WIN })).ok, true);
      const r = finish(s.home, { userEnv: { get: () => null, unset() {} } });
      assert.deepEqual([r.ok, r.reason], [false, 'retired_agents_remain']);
      assert.match(r.lines.join('\n'), /codex-agent/);
      assert.equal(migrationState(s.home).status, 'applied', 'the move can still be undone');
      assert.ok(hasBackups(s.home));
      rmSync(s.fx, { recursive: true, force: true });
      assert.equal(finish(s.home, { userEnv: { get: () => null, unset() {} } }).ok, true);
    } finally { await hub.close(); }
  }, 60000);
  test('--rollback after a good move puts the old entries back, and keeps a file edited since', tlsOpts, async () => {
    const pki = makePki('Rollback2 CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const oldMcp = readFileSync(join(s.fc, '.mcp.json'), 'utf8'), oldToml = readFileSync(join(s.fx, '.codex', 'config.toml'), 'utf8');
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson })).ok, true);
      writeFileSync(join(s.fx, '.codex', 'config.toml'), readFileSync(join(s.fx, '.codex', 'config.toml'), 'utf8') + '\n# edited by the user\n');
      const r = rollback(s.home);
      assert.equal(r.ok, true);
      assert.equal(readFileSync(join(s.fc, '.mcp.json'), 'utf8'), oldMcp);
      for (const p of [join(s.home, 'keys.env'), join(s.home, 'agent-hub-headers.mjs'), join(s.home, 'setup.mjs'), join(s.fc, '.agent-hub.json')]) assert.ok(existsSync(p), `${p} is restored`);
      assert.match(readFileSync(join(s.fx, '.codex', 'config.toml'), 'utf8'), /edited by the user/, 'an edited file is kept');
      assert.ok(r.lines.some((l) => /kept .*config\.toml: it was edited/.test(l)));
      assert.equal(Object.keys(readKeyFile(s.home).data.hubs).length, 0);
      assert.equal(migrationState(s.home).status, 'rolled_back');
      assert.equal(rollback(s.home).ok, false, 'nothing to roll back twice');
      assert.notEqual(oldToml, null);
    } finally { await hub.close(); }
  }, 60000);
  test('an HTTP PC moves only to the HTTPS address and CA the user gave; the connector keeps no plain HTTP', tlsOpts, async () => {
    const pki = makePki('Http CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: 'http://127.0.0.1:9' });
      const https = { origin: hub.origin, caPem: pki.ca, caSha256: caFingerprint(pki.ca) };
      const r = await migrate(s.home, { claudeJson: s.claudeJson, https });
      assert.equal(r.ok, true, r.lines.join('\n'));
      const sec = Object.values(readKeyFile(s.home).data.hubs)[0];
      assert.equal(sec.origin, hub.origin); assert.match(sec.origin, /^https:/);
      assert.equal((await migrate(oldPc({ origin: 'http://127.0.0.1:9' }).home, {})).reason, 'http_needs_https');
    } finally { await hub.close(); }
  }, 60000);
  test('--finish forgets the rollback copies, and removes the CA environment setting only with evidence and consent', tlsOpts, async () => {
    const pki = makePki('Finish CA'), hub = await stubHub(pki);
    try {
      const mkEnv = (val) => { const e = { val, unset: 0 }; return { e, env: { get: () => e.val, unset: () => { e.unset++; e.val = null; } } }; };
      const s = oldPc({ origin: hub.origin, pki });
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson })).ok, true);
      assert.ok(hasBackups(s.home));
      const a = mkEnv('C:\\somewhere\\else.pem');
      const f1 = finish(s.home, { removeLegacyCa: true, userEnv: a.env });
      assert.equal(f1.ok, true); assert.equal(a.e.unset, 0, 'another file is not ours to remove');
      assert.equal(hasBackups(s.home), false);
      assert.equal(rollback(s.home).ok, false, 'after finish there is no rollback');
      // the same variable pointing at the old hub-ca.pem, no consent: left; with consent: removed
      const s2 = oldPc({ origin: hub.origin, pki });
      assert.equal((await migrate(s2.home, { claudeJson: s2.claudeJson })).ok, true);
      const b = mkEnv(join(s2.home, 'hub-ca.pem'));
      finish(s2.home, { userEnv: b.env });
      assert.equal(b.e.unset, 0, 'no consent, left');
      const s3 = oldPc({ origin: hub.origin, pki });
      assert.equal((await migrate(s3.home, { claudeJson: s3.claudeJson })).ok, true);
      const c = mkEnv(join(s3.home, 'hub-ca.pem'));
      const f3 = finish(s3.home, { removeLegacyCa: true, userEnv: c.env });
      assert.equal(c.e.unset, 1); assert.ok(f3.lines.some((l) => /removed NODE_EXTRA_CA_CERTS/.test(l)));
    } finally { await hub.close(); }
  }, 120000);
});

describe('the hub id and file transfers', { concurrency: false }, () => {
  test('a hub that cannot say its id, or names another address, is refused with nothing changed', tlsOpts, async () => {
    const pki = makePki('Id CA'), hub = await stubHub(pki, undefined, null);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const before = tree(s);
      const r = await migrate(s.home, { claudeJson: s.claudeJson });
      assert.deepEqual([r.ok, r.rolledBack, r.reason], [false, false, 'hub_id_unavailable']);
      assert.equal(tree(s), before);
      hub.id = 'hub-real-2'; const orig = hub.origin; hub.origin = 'https://127.0.0.1:1';
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson })).reason, 'hub_id_unavailable', 'an id that names another address is not believed');
      hub.origin = orig;
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson })).ok, true);
      assert.match(Object.keys(readKeyFile(s.home).data.hubs)[0], /^hub-real-2@[0-9a-f]{64}$/);
    } finally { await hub.close(); }
  }, 60000);
  test('a rollback restores a file the move left half-changed, and keeps only a removed file that was recreated', tlsOpts, async () => {
    const pki = makePki('Rollback3 CA'), hub = await stubHub(pki);
    try {
      const s = oldPc({ origin: hub.origin, pki });
      const oldMcp = readFileSync(join(s.fc, '.mcp.json'), 'utf8');
      assert.equal((await migrate(s.home, { claudeJson: s.claudeJson })).ok, true);
      const sf = join(s.home, 'migration', 'state.json'), data = JSON.parse(readFileSync(sf, 'utf8'));
      const mcpRec = data.files.find((x) => x.path === join(s.fc, '.mcp.json'));
      assert.ok(mcpRec && mcpRec.backup && !mcpRec.removed, 'the entry file is a changed file, not a removed one');
      mcpRec.after_sha = null; // as if the move failed after changing it, before it could record the result
      writeFileSync(sf, JSON.stringify(data));
      writeFileSync(join(s.home, 'keys.env'), 'a new file, put there after the move\n');
      const r = rollback(s.home);
      assert.equal(r.ok, true);
      assert.equal(readFileSync(join(s.fc, '.mcp.json'), 'utf8'), oldMcp, 'the half-changed file is restored');
      assert.equal(readFileSync(join(s.home, 'keys.env'), 'utf8'), 'a new file, put there after the move\n', 'a recreated removed file is kept');
      assert.ok(r.lines.some((l) => /kept .*keys\.env: a new file/.test(l)));
    } finally { await hub.close(); }
  }, 60000);

  test('the old stand-alone transfer bridge is stopped, only if it really runs agent-hub-bridge.mjs run', () => {
    const killed = [];
    const ps = WIN ? '1111 node C:\\x\\agent-hub-bridge.mjs run\n2222 node other.mjs\n3333 node C:\\x\\agent-hub-bridge.mjs pair hub code' : '  1111 node /x/agent-hub-bridge.mjs run\n  2222 node other.mjs\n  3333 node /x/agent-hub-bridge.mjs pair hub code';
    const pids = stopOldBridge((c, a) => { if (c === 'taskkill') killed.push(a[1]); return { stdout: ps }; }, 99);
    assert.deepEqual(pids, [1111]);
    if (WIN) assert.deepEqual(killed, ['1111']);
    assert.deepEqual(stopOldBridge(() => ({ stdout: '' }), 99), []);
  });
});

describe('small parts', () => {
  test('the Codex table is replaced only in a config setup wrote, keeping every other line', () => {
    const out = replaceCodexTable(OLD_TOML('/w/x'), '[mcp_servers.conclave]\ncommand = "n"\n');
    assert.match(out, /model = "gpt-test"/); assert.match(out, /\[mcp_servers\.conclave\]\ncommand = "n"/); assert.doesNotMatch(out, /agent_hub/);
    assert.equal(replaceCodexTable('model = "x"\n[mcp_servers.agent_hub]\ncommand = "n"\n', 'x'), null, 'a hand-written config is not touched');
    assert.equal(replaceCodexTable('# Written by Conclave setup.mjs\nmodel = "x"\n', 'x'), null);
  });
  test('the old wake is stopped only if its lock names a process that runs codex-wake.mjs', () => {
    const home = mk();
    assert.deepEqual(stopOldWake(home), { stopped: false, pid: 0 });
    mkdirSync(join(home, 'codex-wake'));
    writeFileSync(join(home, 'codex-wake', 'lock'), '2999999');
    assert.equal(stopOldWake(home, () => ({ stdout: 'node something-else.mjs' })).stopped, false);
    const calls = [];
    const r = stopOldWake(home, (c, a) => { calls.push(c); return { stdout: 'node C:\\x\\codex-wake.mjs run' }; });
    assert.equal(r.stopped, true);
    if (WIN) assert.ok(calls.includes('taskkill'));
  });
});
