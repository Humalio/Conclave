/**
 * Tests for agent-hub-headers.mjs, run with `npm run test:helper` in server/ (plain node:test, works on Windows).
 * Each case runs the helper as a child process against a stub hub, with a temporary HOME and fake keys: the real
 * keys file and token cache are never touched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'agent-hub-headers.mjs');
const APP_KEY = 'ah_app_FAKEappKEYforTESTSonly0000';
const SES_KEY = 'ah_ses_FAKEsessionKEYforTESTS0000';
const VAR = 'TEST_AGENT_SESSION_KEY';

/** Stub hub: answers whoami and login as each test sets; records every request. */
let hub, hubUrl, other, otherUrl;
const state = { requests: [], whoami: (tok) => (tok === 'tok-good' ? { status: 200, data: { agent_id: 'agent-1' } } : { status: 401 }), login: () => ({ status: 200, data: { session_token: 'tok-new' } }), raw: null, redirect: null };
const otherHits = [];

function reply(res, status, data) {
  if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: data } }));
}

before(async () => {
  hub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      state.requests.push({ tool: msg.params.name, args: msg.params.arguments, auth: req.headers.authorization, session: req.headers['x-agent-hub-session'],
        folder: req.headers['x-agent-hub-folder'], sessionVar: req.headers['x-agent-hub-session-var'] });
      if (state.redirect) { res.writeHead(307, { location: state.redirect }); return res.end(); }
      if (state.raw) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(state.raw); }
      const r = msg.params.name === 'session_whoami' ? state.whoami(req.headers['x-agent-hub-session']) : state.login(msg.params.arguments);
      reply(res, r.status, r.data);
    });
  });
  other = createServer((req, res) => { otherHits.push(req.headers.authorization ?? null); res.end('{}'); });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${hub.address().port}/mcp`;
  otherUrl = `http://127.0.0.1:${other.address().port}/mcp`;
});
after(() => { hub.close(); other.close(); });

/** A fresh HOME with a keys file and an agent folder. */
function setup({ folderUrl = hubUrl, pinned = null, cachedToken = null, extraCfg = {} } = {}) {
  state.requests = []; state.raw = null; state.redirect = null;
  state.whoami = (tok) => (tok === 'tok-good' ? { status: 200, data: { agent_id: 'agent-1' } } : { status: 401 });
  state.login = () => ({ status: 200, data: { session_token: 'tok-new' } });
  const home = mkdtempSync(join(tmpdir(), 'ahh-'));
  const conf = join(home, '.config', 'conclave');
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(conf, 'keys.env'), `# fake keys\nAGENT_HUB_APP_KEY=${APP_KEY}\n${VAR}=${SES_KEY}\n${pinned ? `AGENT_HUB_URL=${pinned}\n` : ''}`, { mode: 0o600 });
  if (cachedToken) { mkdirSync(join(conf, 'tokens'), { recursive: true }); writeFileSync(join(conf, 'tokens', `${VAR}.tok`), cachedToken, { mode: 0o600 }); }
  const agent = join(home, 'agent');
  mkdirSync(agent);
  writeFileSync(join(agent, '.agent-hub.json'), JSON.stringify({ session_var: VAR, ...(folderUrl ? { url: folderUrl } : {}), ...extraCfg }));
  return { home, conf, agent, cache: join(conf, 'tokens', `${VAR}.tok`), log: join(conf, 'helper.log') };
}
function run(s, { args = [s.agent], cwd = s.home } = {}) {
  return new Promise((res) => {
    execFile(process.execPath, [HELPER, ...args], { cwd, timeout: 15_000, env: { ...process.env, HOME: s.home, USERPROFILE: s.home } }, (err, stdout, stderr) => {
      res({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}
/** A failure: exit 1, exactly one stderr line, nothing on stdout, no key anywhere in output or the log. */
function assertFailure(s, r, pattern) {
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^agent-hub-headers: /);
  assert.match(lines[0], pattern);
  const log = existsSync(s.log) ? readFileSync(s.log, 'utf8') : '';
  for (const text of [r.stderr, log]) { assert.ok(!text.includes(APP_KEY)); assert.ok(!text.includes(SES_KEY)); }
  assert.match(log, / fail /);
}
const headers = (r) => JSON.parse(r.stdout);

test('logs in once, prints both headers, caches the token and logs start and ok', async () => {
  const s = setup();
  const r = await run(s);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(headers(r), { Authorization: `Bearer ${APP_KEY}`, 'X-Agent-Hub-Session': 'tok-new' });
  assert.deepEqual(state.requests.map((q) => q.tool), ['session_login']);
  assert.equal(state.requests[0].args.session_key, SES_KEY);
  assert.equal(readFileSync(s.cache, 'utf8'), 'tok-new');
  const log = readFileSync(s.log, 'utf8');
  assert.match(log, / start dir=/);
  assert.match(log, / ok dir=/);
  assert.ok(!log.includes(APP_KEY) && !log.includes(SES_KEY) && !log.includes('tok-new'));
});

test('tells the hub the folder and the variable name with its own calls, never in the printed headers', async () => {
  const s = setup();
  const r = await run(s);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(decodeURIComponent(state.requests[0].folder), resolve(s.agent));
  assert.equal(state.requests[0].sessionVar, VAR);
  assert.deepEqual(Object.keys(headers(r)), ['Authorization', 'X-Agent-Hub-Session']);
});

test('reuses a cached token the hub still accepts, without logging in', async () => {
  const s = setup({ cachedToken: 'tok-good' });
  const r = await run(s);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(headers(r)['X-Agent-Hub-Session'], 'tok-good');
  assert.deepEqual(state.requests.map((q) => q.tool), ['session_whoami']);
  assert.equal(state.requests[0].session, 'tok-good');
});

test('logs in again when the hub answers 401 for the cached token', async () => {
  const s = setup({ cachedToken: 'tok-old' });
  const r = await run(s);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(headers(r)['X-Agent-Hub-Session'], 'tok-new');
  assert.deepEqual(state.requests.map((q) => q.tool), ['session_whoami', 'session_login']);
  assert.equal(readFileSync(s.cache, 'utf8'), 'tok-new');
});

test('logs in again when the cached token is expired (a tool error on whoami)', async () => {
  const s = setup({ cachedToken: 'tok-expired' });
  state.whoami = () => ({ status: 200, data: { error: 'login_required', message: 'expired' } });
  const r = await run(s);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(headers(r)['X-Agent-Hub-Session'], 'tok-new');
  assert.deepEqual(state.requests.map((q) => q.tool), ['session_whoami', 'session_login']);
});

test('a refused login is one line and exit 1', async () => {
  const s = setup();
  state.login = () => ({ status: 200, data: { error: 'denied', message: 'Key suspended.' } });
  assertFailure(s, await run(s), /login refused \(200\): denied Key suspended\./);
});

test('refuses a folder url that differs from the pinned AGENT_HUB_URL, before sending anything', async () => {
  const s = setup({ folderUrl: otherUrl, pinned: hubUrl });
  const hitsBefore = otherHits.length;
  assertFailure(s, await run(s), /differs from AGENT_HUB_URL/);
  assert.equal(state.requests.length, 0);
  assert.equal(otherHits.length, hitsBefore);
});

test('the pinned AGENT_HUB_URL wins when the folder names no url, and a matching one is accepted', async () => {
  const s = setup({ folderUrl: null, pinned: hubUrl });
  assert.equal((await run(s)).code, 0);
  const s2 = setup({ folderUrl: `${hubUrl}/`, pinned: hubUrl });
  assert.equal((await run(s2)).code, 0);
});

test('never follows a redirect: the other address gets no request and no key', async () => {
  const s = setup();
  state.redirect = otherUrl;
  const hitsBefore = otherHits.length;
  assertFailure(s, await run(s), /redirect \(307\); not following it/);
  assert.equal(otherHits.length, hitsBefore);
});

test('an unreachable hub is one line and exit 1', async () => {
  const closed = createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const s = setup({ folderUrl: `http://127.0.0.1:${port}/mcp` });
  assertFailure(s, await run(s), /session_login: request to .* failed: ECONNREFUSED/);
});

test('an unreadable or empty reply is one line and exit 1', async () => {
  const s = setup();
  state.raw = 'data: {not json\n\n';
  assertFailure(s, await run(s), /not JSON/);
  const s2 = setup();
  state.raw = 'event: ping\n\n';
  assertFailure(s2, await run(s2), /empty reply/);
});

test('takes the agent folder as its argument, wherever it runs; without one it uses the working folder', async () => {
  const s = setup();
  assert.equal((await run(s, { args: [s.agent], cwd: s.home })).code, 0);
  assert.equal((await run(s, { args: [], cwd: s.agent })).code, 0);
  assertFailure(s, await run(s, { args: [], cwd: s.home }), /cannot read \.agent-hub\.json in /);
});

test('refuses a keys file others can read (not on Windows, where mode bits mean nothing)', { skip: process.platform === 'win32' }, async () => {
  const s = setup();
  chmodSync(join(s.conf, 'keys.env'), 0o644); // writeFileSync's mode applies only when it creates the file
  assertFailure(s, await run(s), /must be readable by you only/);
});

test('a missing session key variable names the variable, never a key', async () => {
  const s = setup({ extraCfg: { session_var: 'MISSING_VAR' } });
  assertFailure(s, await run(s), /lacks the app key or MISSING_VAR/);
  rmSync(s.home, { recursive: true, force: true });
});
