/**
 * Tests for codex.mjs and codex-bridge.mjs, run with `npm run test:helper` in server/ (plain node:test). The bridge runs
 * as a child process against a stub hub with a temporary HOME and fake keys; no Codex CLI is involved. The bridge against
 * a real hub is server/test/codex-bridge.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexPermission, tomlString, projectConfig, globalEntry, trustEntry, upsertBlock, agentsOverride, resumeMessage, startLine,
  writeAgentFolder, markTrusted, writeGlobalEntry, handshake, STARTUP_TIMEOUT_SEC, shellQuote, codexConflicts, findDefinition,
} from './codex.mjs';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'codex-bridge.mjs');
const APP_KEY = 'ah_app_FAKEappKEYforTESTSonly0000';
const SES_KEY = 'ah_ses_FAKEsessionKEYforTESTS0000';
const VAR = 'TEST_AGENT_SESSION_KEY';

// ───────────── config writers ─────────────
test('each permission level maps to approval_policy and sandbox_mode, never danger-full-access', () => {
  assert.deepEqual(codexPermission('plan'), { level: 'ask', approval_policy: 'on-request', sandbox_mode: 'read-only' });
  assert.deepEqual(codexPermission('default'), { level: 'standard', approval_policy: 'on-request', sandbox_mode: 'workspace-write' });
  assert.deepEqual(codexPermission('acceptEdits'), { level: 'standard', approval_policy: 'on-request', sandbox_mode: 'workspace-write' });
  assert.deepEqual(codexPermission('bypassPermissions'), { level: 'auto', approval_policy: 'never', sandbox_mode: 'workspace-write' });
  assert.throws(() => codexPermission('yolo'));
});

test('project config.toml for each permission level', () => {
  const base = { folder: '/home/a/agents/dev', keysFile: '/home/a/.config/conclave/keys.env', bridge: '/home/a/.config/conclave/codex-bridge.mjs' };
  const want = { plan: ['on-request', 'read-only'], default: ['on-request', 'workspace-write'], acceptEdits: ['on-request', 'workspace-write'], bypassPermissions: ['never', 'workspace-write'] };
  for (const [perm, [ap, sb]] of Object.entries(want)) {
    const t = projectConfig({ ...base, permissions: perm, model: 'gpt-5-codex' });
    assert.match(t, /^# .*\n# Unverified until the F4 spike/);
    assert.ok(t.includes(`model = "gpt-5-codex"\napproval_policy = "${ap}"\nsandbox_mode = "${sb}"\n`), t);
    assert.ok(t.includes('[mcp_servers.agent_hub]\ncommand = "node"\nargs = ["/home/a/.config/conclave/codex-bridge.mjs", "/home/a/agents/dev", "--keys-file", "/home/a/.config/conclave/keys.env"]\n'), t);
    assert.ok(t.includes(`startup_timeout_sec = ${STARTUP_TIMEOUT_SEC}\n`));
    assert.equal(STARTUP_TIMEOUT_SEC, 60);
    assert.doesNotMatch(t, /danger-full-access/);
  }
  assert.doesNotMatch(projectConfig({ ...base }), /^model =/m); // no model: Codex's own default
  assert.throws(() => projectConfig({ ...base, model: 'x"\n[evil]' }), /invalid model/);
});

test('Windows paths and odd characters are quoted as TOML basic strings', () => {
  assert.equal(tomlString(String.raw`C:\Users\a b\agents\dev`), String.raw`"C:\\Users\\a b\\agents\\dev"`);
  assert.equal(tomlString('say "hi"\n\tthen\x01'), String.raw`"say \"hi\"\n\tthen\u0001"`);
  const t = projectConfig({ folder: String.raw`C:\Agents\it's "dev"`, keysFile: String.raw`C:\Users\a\.config\conclave\keys.env`, bridge: String.raw`C:\Users\a\.config\conclave\codex-bridge.mjs` });
  assert.ok(t.includes(String.raw`args = ["C:\\Users\\a\\.config\\conclave\\codex-bridge.mjs", "C:\\Agents\\it's \"dev\"", "--keys-file", "C:\\Users\\a\\.config\\conclave\\keys.env"]`), t);
  assert.equal(trustEntry(String.raw`C:\Agents\dev`), '[projects."C:\\\\Agents\\\\dev"]\ntrust_level = "trusted"');
});

test('global variant: one entry without a folder argument, kept between markers', () => {
  const g = globalEntry({ keysFile: '/k/keys.env', bridge: '/b/codex-bridge.mjs' });
  assert.ok(g.includes('args = ["/b/codex-bridge.mjs", "--keys-file", "/k/keys.env"]'), g);
  assert.match(g, /Unverified until the F4 spike/);
  const mine = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
  const once = upsertBlock(mine, 'agent_hub', g);
  assert.ok(once.startsWith(mine.trimEnd() + '\n\n# >>> conclave agent_hub >>>\n'), once);
  assert.equal(upsertBlock(once, 'agent_hub', g), once); // idempotent
  const twice = upsertBlock(once, 'agent_hub', g.replace('/k/keys.env', '/k2/keys.env'));
  assert.equal(twice.split('[mcp_servers.agent_hub]').length, 2); // replaced, not added
  assert.match(twice, /\/k2\/keys\.env/);
  assert.throws(() => upsertBlock('[mcp_servers.agent_hub]\nurl = "x"\n', 'agent_hub', g), /outside Conclave's markers/);
  assert.throws(() => upsertBlock('# >>> conclave agent_hub >>>\n', 'agent_hub', g), /markers/);
  assert.equal(upsertBlock('a = 1\r\n', 'x', '[t]\nb = 2'), 'a = 1\r\n\r\n# >>> conclave x >>>\r\n[t]\r\nb = 2\r\n# <<< conclave x <<<\r\n');
});

test('upsertBlock: refuses the same table in any spelling, so config.toml never gets two definitions', () => {
  const g = globalEntry({ keysFile: '/k/keys.env', bridge: '/b/codex-bridge.mjs' });
  for (const hand of [
    '[mcp_servers."agent_hub"]\ncommand = "x"\n',
    "[mcp_servers.'agent_hub']\ncommand = 'x'\n",
    '[ mcp_servers . agent_hub ]\n',
    '[mcp_servers.agent_hub.env]\nX = "1"\n',
    '[mcp_servers]\nagent_hub = { command = "x" }\n',
    'mcp_servers.agent_hub.command = "x"\n',
  ]) assert.throws(() => upsertBlock(hand, 'agent_hub', g, false), /outside Conclave's markers/, hand);
  // Other servers, comments and strings that only mention the name are fine.
  const ok = '# [mcp_servers.agent_hub] was here\n[mcp_servers.agent_hub_old]\ncommand = "agent_hub"\nargs = [\n  "[mcp_servers.agent_hub]",\n]\n';
  assert.match(upsertBlock(ok, 'agent_hub', g, false), /# >>> conclave agent_hub >>>/);
  // Folder trust: Codex may have written the folder with literal quotes, other slashes or (Windows) other case.
  const t = trustEntry('C:\\Agents\\dev');
  for (const hand of [
    "[projects.'C:\\Agents\\dev']\ntrust_level = \"trusted\"\n",
    '[projects."C:/Agents/dev"]\ntrust_level = "trusted"\n',
    '[projects."c:\\\\agents\\\\DEV\\\\"]\ntrust_level = "trusted"\n',
    '[projects]\n"C:/Agents/dev" = { trust_level = "trusted" }\n',
  ]) assert.throws(() => upsertBlock(hand, 'trust C:/Agents/dev', t, true), /outside Conclave's markers/, hand);
  assert.match(upsertBlock('[projects."C:/Agents/dev2"]\ntrust_level = "trusted"\n', 'trust C:/Agents/dev', t, true), /conclave trust/);
  assert.equal(findDefinition('[projects."/a/Dev"]\n', ['projects', '/a/dev'], false), null); // case matters off Windows
  assert.equal(findDefinition('x = """\n[projects."/a"]\n"""\n', ['projects', '/a'], false), null); // inside a multi-line string
});

test('writers: project and global variants on disk, trust in $CODEX_HOME', () => {
  const root = mkdtempSync(join(tmpdir(), 'cdx-'));
  const home = join(root, 'codex-home'), a = join(root, 'dev'), b = join(root, 'rev');
  mkdirSync(a); mkdirSync(b);
  const who = { label: 'dev', role: 'developer', team: 'Signals Lab', playbook: 'Work in small commits.' };
  const pa = writeAgentFolder({ folder: a, keysFile: join(root, 'keys.env'), permissions: 'plan', ...who });
  assert.deepEqual(pa, [join(a, '.codex', 'config.toml'), join(a, 'AGENTS.override.md')]);
  assert.match(readFileSync(pa[0], 'utf8'), /sandbox_mode = "read-only"/);
  const pb = writeAgentFolder({ folder: b, keysFile: join(root, 'keys.env'), variant: 'global', ...who });
  assert.deepEqual(pb, [join(b, 'AGENTS.override.md')]);
  assert.equal(existsSync(join(b, '.codex')), false);
  markTrusted(a, { home }); markTrusted(a, { home }); markTrusted(b, { home });
  writeGlobalEntry({ keysFile: join(root, 'keys.env'), home });
  const cfg = readFileSync(join(home, 'config.toml'), 'utf8');
  assert.equal(cfg.split('trust_level = "trusted"').length, 3); // two folders, once each
  assert.equal(cfg.split('[mcp_servers.agent_hub]').length, 2);
  assert.throws(() => writeAgentFolder({ folder: a, keysFile: 'k', variant: 'both', ...who }), /variant/);
  // Rewriting our own files is fine.
  assert.deepEqual(writeAgentFolder({ folder: a, keysFile: join(root, 'keys.env'), ...who }), pa);
});

test('writers: never clobber a file Conclave did not write, or one git tracks', () => {
  const root = mkdtempSync(join(tmpdir(), 'cdx-'));
  const who = { label: 'dev', role: 'developer', team: 'Signals Lab', playbook: '' };
  const a = join(root, 'own');
  mkdirSync(join(a, '.codex'), { recursive: true });
  writeFileSync(join(a, '.codex', 'config.toml'), 'model = "mine"\n');
  assert.throws(() => writeAgentFolder({ folder: a, keysFile: 'k', ...who }), /refusing to overwrite: .*config\.toml exists and was not written by Conclave/);
  assert.equal(existsSync(join(a, 'AGENTS.override.md')), false); // nothing written
  assert.equal(readFileSync(join(a, '.codex', 'config.toml'), 'utf8'), 'model = "mine"\n');
  assert.deepEqual(codexConflicts(a, 'global'), []); // the global variant leaves .codex/ alone
  let git = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
  if (!git) return;
  const r = join(root, 'repo');
  mkdirSync(r);
  writeFileSync(join(r, 'AGENTS.override.md'), '<!-- Written by Conclave setup.mjs, then committed -->\n');
  const g = (...args) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  g('init', '-q'); g('add', 'AGENTS.override.md'); g('commit', '-qm', 'x');
  assert.deepEqual(codexConflicts(r, 'global').map((c) => c.reason), ['is tracked by git']);
  assert.throws(() => writeAgentFolder({ folder: r, keysFile: 'k', variant: 'global', ...who }), /tracked by git/);
});

test('AGENTS.override.md carries the hub playbook and the header-login rule', () => {
  const t = agentsOverride({ label: 'dev', role: 'developer', team: 'Signals Lab', playbook: 'Line one.\r\nLine two.\n\n' });
  assert.equal(t, [
    '<!-- Written by Conclave setup.mjs from the hub\'s text. Local overlay: never commit it. Unverified until the F4 spike (docs/checkout.md §9 F4). -->',
    '# dev: developer of Signals Lab',
    '',
    'You reach the Conclave hub through the `agent_hub` MCP server. It is logged in for you: do not call `session_login` and leave `session_token` out of every call.',
    '',
    'Line one.\nLine two.',
    '',
  ].join('\n'));
});

test('AGENTS.override.md is the hub text setup.mjs writes as CLAUDE.local.md, the playbook only as a fallback', () => {
  const hub = '# dev, team T\r\n\r\n## Playbook\r\n\r\nPoll.\r\n\r\n## Directives\r\n\r\nRead them first.\r\n\r\n## Connection\r\n\r\nHeaders helper or codex-bridge.mjs.\r\n';
  const t = agentsOverride({ label: 'dev', role: 'developer', team: 'T', instructions: hub, playbook: 'Old playbook.' });
  assert.ok(t.endsWith(hub.replace(/\r\n/g, '\n')));
  assert.ok(!t.includes('Old playbook.'));
  assert.ok(agentsOverride({ label: 'dev', role: 'developer', team: 'T', instructions: '', playbook: 'Old playbook.' }).includes('Old playbook.'));
  const root = mkdtempSync(join(tmpdir(), 'codex-instr-'));
  writeAgentFolder({ folder: root, keysFile: join(root, 'keys.env'), label: 'dev', role: 'developer', team: 'T', instructions: hub });
  assert.equal(readFileSync(join(root, 'AGENTS.override.md'), 'utf8'), t);
});

test('start line: codex -C <dir> "<resume msg>", with -m/-a/-s only for the global variant', () => {
  assert.equal(resumeMessage({ label: 'dev%PATH%', role: 'dev!X!', team: 'T' }).slice(0, 26), 'You are devPATH, devX of T');
  assert.throws(() => shellQuote('100%', true), /cannot quote/);
  assert.throws(() => shellQuote('hi!', true), /cannot quote/);
  assert.equal(shellQuote('100%!', false), "'100%!'");
  const message = resumeMessage({ label: 'dev', role: 'developer', team: 'Signals "Lab" $(id)' });
  assert.equal(message, 'You are dev, developer of Signals Lab (id). Call directives_read {unread: true, ack: true}, then checkout_resume, then session_whoami, team_info, task_list, message_read, team_decisions, bp_read, then continue.');
  assert.equal(startLine({ dir: String.raw`C:\Agents\dev`, message, win: true }), `codex -C "C:/Agents/dev" "${message}"`);
  assert.equal(startLine({ dir: "/home/a/it's", message, win: false }), `codex -C '/home/a/it'\\''s' '${message}'`);
  assert.equal(startLine({ dir: '/a', message: 'm', variant: 'global', model: 'gpt-5-codex', permissions: 'bypassPermissions', win: false }),
    "codex -C '/a' -m gpt-5-codex -a never -s workspace-write 'm'");
  assert.equal(startLine({ dir: '/a', message: 'm', model: 'gpt-5-codex', permissions: 'plan', win: false }), "codex -C '/a' 'm'"); // project config holds them
  assert.throws(() => startLine({ dir: 'C:/a"b', message: 'm', win: true }));
});

// ───────────── the bridge against a stub hub ─────────────
let hub, hubUrl;
const state = { requests: [], tokens: new Set(['tok-good']), next: 'tok-new', ses: SES_KEY };
before(async () => {
  hub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const tok = req.headers['x-agent-hub-session'];
      state.requests.push({ method: msg.method, tool: msg.params?.name, auth: req.headers.authorization, session: tok ?? null, args: msg.params?.arguments });
      if (req.headers.authorization !== `Bearer ${APP_KEY}`) { res.writeHead(401); return res.end(); }
      const send = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (msg.method === 'tools/call' && msg.params.name === 'session_login') {
        if (msg.params.arguments.session_key !== state.ses) return send({ isError: true, content: [{ type: 'text', text: 'denied' }], structuredContent: { error: 'denied' } });
        state.tokens.add(state.next);
        return send({ content: [], structuredContent: { session_token: state.next } });
      }
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (!state.tokens.has(tok)) { res.writeHead(401); return res.end(); }
      if (msg.method === 'initialize') return send({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'agent-hub', version: 't' } });
      if (msg.method === 'tools/list') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'session_whoami' }, { name: 'task_list' }] } })}\n\n`); }
      if (msg.method === 'tools/call' && msg.params.name === 'busy') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'rate_limited', message: 'slow down' })); }
      if (msg.method === 'tools/call' && msg.params.name === 'bad') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'bad params' } })); }
      if (msg.method === 'tools/call' && msg.params.name === 'html') { res.writeHead(502); return res.end('<html>gateway</html>'); }
      if (msg.method === 'tools/call' && msg.params.name === 'session_whoami') return send({ content: [], structuredContent: { agent_id: 'agt_1', label: 'dev' } });
      send({ content: [] });
    });
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${hub.address().port}/mcp`;
});
after(() => hub.close());

function setup({ agentJson = { session_var: VAR }, keys = `AGENT_HUB_APP_KEY=${APP_KEY}\n${VAR}=${SES_KEY}\n`, cached = null, pin = true } = {}) {
  state.requests = []; state.tokens = new Set(['tok-good']); state.next = 'tok-new'; state.ses = SES_KEY;
  const home = mkdtempSync(join(tmpdir(), 'cdxb-'));
  const conf = join(home, '.config', 'conclave');
  mkdirSync(join(conf, 'tokens'), { recursive: true });
  const keysFile = join(conf, 'keys.env');
  if (keys !== null) writeFileSync(keysFile, `${keys}${pin ? `AGENT_HUB_URL=${hubUrl}\n` : ''}`, { mode: 0o600 });
  if (cached) writeFileSync(join(conf, 'tokens', `${VAR}.tok`), cached, { mode: 0o600 });
  const agent = join(home, 'agent');
  mkdirSync(agent);
  if (agentJson) writeFileSync(join(agent, '.agent-hub.json'), JSON.stringify(agentJson));
  return { home, conf, agent, keysFile, env: { ...process.env, HOME: home, USERPROFILE: home } };
}
/** Runs the bridge to completion with `lines` on stdin. */
function runBridge(s, lines, args = [s.agent, '--keys-file', s.keysFile]) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [BRIDGE, ...args], { cwd: s.home, env: s.env });
    let out = '', err = '';
    c.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    c.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    c.on('exit', (code) => res({ code, out, err, msgs: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
    for (const l of lines) c.stdin.write(typeof l === 'string' ? l + '\n' : JSON.stringify(l) + '\n');
    c.stdin.end();
  });
}
const noSecrets = (s, r) => {
  for (const text of [r.out, r.err, existsSync(join(s.conf, 'helper.log')) ? readFileSync(join(s.conf, 'helper.log'), 'utf8') : '']) {
    assert.doesNotMatch(text, /FAKEappKEY|FAKEsessionKEY|tok-good|tok-new/);
  }
};

test('bridge: initialize, tools/list (SSE) and a tool call through the header login', async () => {
  const s = setup();
  const r = await runBridge(s, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_whoami', arguments: {} } },
  ]);
  assert.equal(r.code, 0, r.err);
  const byId = Object.fromEntries(r.msgs.map((m) => [m.id, m]));
  assert.equal(r.msgs.length, 3); // the notification has no reply
  assert.equal(byId[1].result.serverInfo.name, 'agent-hub');
  assert.deepEqual(byId[2].result.tools.map((t) => t.name), ['session_whoami', 'task_list']);
  assert.equal(byId[3].result.structuredContent.agent_id, 'agt_1');
  const relayed = state.requests.filter((q) => q.tool !== 'session_login');
  assert.ok(relayed.every((q) => q.auth === `Bearer ${APP_KEY}` && q.session === 'tok-new'));
  assert.equal(readFileSync(join(s.conf, 'tokens', `${VAR}.tok`), 'utf8'), 'tok-new');
  noSecrets(s, r);
});

test('bridge: reuses a cached token, and logs in again once when the hub refuses it', async () => {
  const s = setup({ cached: 'tok-good' });
  const r1 = await runBridge(s, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
  assert.equal(r1.code, 0, r1.err);
  assert.equal(state.requests.filter((q) => q.tool === 'session_login').length, 0);
  // The token expires while the bridge runs: one fresh login, then the call is sent again.
  const s2 = setup({ cached: 'tok-good' });
  state.next = 'tok-2';
  const c = spawn(process.execPath, [BRIDGE, s2.agent, '--keys-file', s2.keysFile], { cwd: s2.home, env: s2.env });
  let out = '';
  c.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  while (!out.includes('\n')) await new Promise((r) => setTimeout(r, 20));
  state.tokens.delete('tok-good');
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  c.stdin.end();
  await new Promise((r) => c.on('exit', r));
  const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => m.id), [1, 2]);
  assert.ok(msgs.every((m) => m.result?.tools));
  assert.equal(state.requests.filter((q) => q.tool === 'session_login').length, 1);
});

test('bridge: after a revoked login it reads the keys file once and signs in with the key the Codex wake collected', async () => {
  const s = setup({ cached: 'tok-good' });
  const c = spawn(process.execPath, [BRIDGE, s.agent, '--keys-file', s.keysFile], { cwd: s.home, env: s.env });
  let out = '';
  c.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  while (!out.includes('\n')) await new Promise((r) => setTimeout(r, 20));
  // The key is rotated: the hub revokes the old one and the token, and the wake writes the new key into the keys file.
  state.ses = 'ah_ses_FAKEcollectedKEYforTESTS00';
  state.tokens.delete('tok-good');
  state.next = 'tok-collected';
  writeFileSync(s.keysFile, `AGENT_HUB_APP_KEY=${APP_KEY}\n${VAR}=${state.ses}\nAGENT_HUB_URL=${hubUrl}\n`, { mode: 0o600 });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  c.stdin.end();
  await new Promise((r) => c.on('exit', r));
  const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => m.id), [1, 2]);
  assert.ok(msgs.every((m) => m.result?.tools), JSON.stringify(msgs));
  const logins = state.requests.filter((q) => q.tool === 'session_login');
  assert.equal(logins.length, 2, 'the old key once, then the collected key once');
  assert.equal(logins[1].args.session_key, state.ses);
  const log = readFileSync(join(s.conf, 'helper.log'), 'utf8');
  assert.match(log, /login refused; the keys file holds a different session key now, trying it once/);
  assert.doesNotMatch(log, /FAKEcollectedKEY|FAKEsessionKEY|FAKEappKEY|tok-/);
});

test('bridge: a revoked key that the keys file still holds is tried once, never in a loop', async () => {
  const s = setup();
  state.ses = 'ah_ses_FAKEcollectedKEYforTESTS00'; // the hub no longer accepts the key in the file
  const r = await runBridge(s, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /login refused/);
  assert.equal(state.requests.filter((q) => q.tool === 'session_login').length, 1);
  noSecrets(s, r);
});

test('bridge: refuses to start without .agent-hub.json', async () => {
  const s = setup({ agentJson: null });
  const r = await runBridge(s, []);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^codex-bridge: refusing to start: cannot read \.agent-hub\.json/);
  assert.equal(state.requests.length, 0);
});

test('bridge: refuses to start without --keys-file, without the file, or with a file lacking the keys', async () => {
  const s = setup();
  let r = await runBridge(s, [], [s.agent]);
  assert.equal(r.code, 1); assert.match(r.err, /needs --keys-file/);
  r = await runBridge(s, [], [s.agent, '--keys-file', join(s.home, 'nope.env')]);
  assert.equal(r.code, 1); assert.match(r.err, /keys file not found/);
  const s2 = setup({ keys: `AGENT_HUB_APP_KEY=${APP_KEY}\n` });
  r = await runBridge(s2, []);
  assert.equal(r.code, 1); assert.match(r.err, new RegExp(`lacks the app key or ${VAR}`));
  const s3 = setup({ keys: `AGENT_HUB_APP_KEY=${APP_KEY}\n${VAR}=ah_ses_WRONG\n` });
  r = await runBridge(s3, []);
  assert.equal(r.code, 1); assert.match(r.err, /login refused/);
  assert.equal(r.out, '');
  assert.equal(state.requests.filter((q) => q.tool !== 'session_login').length, 0); // nothing relayed
});

test('bridge: a folder url that differs from the pinned hub is refused', async () => {
  const s = setup({ agentJson: { session_var: VAR, url: 'http://127.0.0.1:1/mcp' } });
  const r = await runBridge(s, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /differs from AGENT_HUB_URL/);
  assert.equal(state.requests.length, 0);
});

test('bridge: refuses to start without the AGENT_HUB_URL pin, even when the folder names a url', async () => {
  const s = setup({ pin: false, agentJson: { session_var: VAR, url: hubUrl } });
  const r = await runBridge(s, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /no AGENT_HUB_URL/);
  assert.equal(state.requests.length, 0);
});

test('bridge: the folder cannot pick the app key (app_var is ignored)', async () => {
  const s = setup({ agentJson: { session_var: VAR, app_var: 'OTHER_KEY' }, keys: `OTHER_KEY=${APP_KEY}\n${VAR}=${SES_KEY}\n` });
  const r = await runBridge(s, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /lacks the app key/);
  assert.equal(state.requests.length, 0);
});

test('bridge: a line that is not JSON gets a JSON-RPC parse error and the next message still goes through', async () => {
  const s = setup();
  const r = await runBridge(s, ['not json', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'task_list', arguments: {} } }]);
  assert.equal(r.code, 0);
  assert.equal(r.msgs.find((m) => m.id === null).error.code, -32700);
  assert.ok(r.msgs.find((m) => m.id === 9).result);
});

test("bridge: a hub error reaches Codex with the hub's own code and message", async () => {
  const s = setup();
  const call = (id, name) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  const r = await runBridge(s, [call(1, 'busy'), call(2, 'bad'), call(3, 'html')]);
  assert.equal(r.code, 0, r.err);
  const byId = Object.fromEntries(r.msgs.map((m) => [m.id, m]));
  assert.equal(byId[1].error.message, 'codex-bridge: the hub answered HTTP 429: rate_limited: slow down');
  assert.deepEqual(byId[2].error, { code: -32602, message: 'bad params' }); // relayed as is
  assert.equal(byId[3].error.message, 'codex-bridge: the hub answered HTTP 502');
  noSecrets(s, r);
});

test('doctor handshake drives the bridge as Codex would', async () => {
  const s = setup();
  const r = await handshake({ folder: s.agent, keysFile: s.keysFile, env: s.env });
  assert.deepEqual({ ok: r.ok, tools: r.tools, agent: r.agent, label: r.label }, { ok: true, tools: 2, agent: 'agt_1', label: 'dev' });
  const bad = setup({ agentJson: null });
  const r2 = await handshake({ folder: bad.agent, keysFile: bad.keysFile, env: bad.env });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /refusing to start/);
});
