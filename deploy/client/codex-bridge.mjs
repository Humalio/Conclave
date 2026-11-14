#!/usr/bin/env node
/**
 * Conclave stdio bridge for Codex (docs/checkout.md §6 step 5, §9 F4): Codex starts it as a stdio MCP server and it
 * relays each JSON-RPC message to the hub's Streamable HTTP endpoint, logged in as one agent outside the model, the way
 * agent-hub-headers.mjs does for Claude Code. The agent never calls session_login and never sees a key or token.
 * Prepared, unverified until the F4 spike: no Codex CLI has run it yet. Node 18 or later, no dependencies.
 *
 * Usage: node codex-bridge.mjs [agent folder] --keys-file <path>
 *   The agent folder holds .agent-hub.json (no secrets): {"session_var": "..."}, and optionally "url", which must match
 *   the pin. Without the folder argument the working folder is used (the global ~/.codex/config.toml variant). That
 *   folder may be an untrusted clone, so it only picks the session variable: the app key is always AGENT_HUB_APP_KEY
 *   and the hub is always the AGENT_HUB_URL pin. The bridge refuses to start without .agent-hub.json, without
 *   --keys-file, or with a keys file that lacks the app key, the session key or AGENT_HUB_URL.
 *   The keys file is the same as the headers helper's: AGENT_HUB_APP_KEY, the session variable, AGENT_HUB_URL (pins the
 *   hub; a folder "url" that differs is refused) and optionally AGENT_HUB_CA (a CA certificate file).
 *
 * stdout carries JSON-RPC only, one message per line. Failures go to stderr as one line, and one line per start and
 * failure goes to ~/.config/conclave/helper.log (folder and outcome; never a key or token). The session token is cached
 * in ~/.config/conclave/tokens/<session_var>.tok, shared with the headers helper. A token the hub refuses (HTTP 401) is
 * replaced by one fresh login and the message is sent again once. Redirects are never followed.
 *
 * task_submit and task_review calls without a request_id get one (docs/mcp.md): a hash of the tool name and its
 * arguments, so when a reply is lost and Codex sends the same call again, the hub returns the first result instead of
 * opening a new round or posting a second review.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';

const LOGIN_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 10 * 60_000; // poll calls wait up to 45 s; tool calls can take longer
const CONF = join(homedir(), '.config', 'conclave');
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const oneLine = (s) => String(s).split(/\s+/).filter(Boolean).join(' ');
const log = (what) => { try { appendFileSync(join(CONF, 'helper.log'), `${new Date().toISOString()} codex-bridge ${oneLine(what)}\n`); } catch { /* best effort */ } };
const fail = (msg) => {
  const line = oneLine(msg);
  log(`fail ${line}`);
  process.stderr.write(`codex-bridge: ${line}\n`);
  process.exit(1);
};

// ───────────── arguments and configuration ─────────────
let folderArg = null, keysFile = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keys-file') { keysFile = argv[++i] ?? null; if (!keysFile) fail('--keys-file needs a path'); }
  else if (a.startsWith('--keys-file=')) keysFile = a.slice('--keys-file='.length);
  else if (a.startsWith('-')) fail(`unknown option ${a}`);
  else if (folderArg === null) folderArg = a;
  else fail('one agent folder at most');
}
const dir = resolve(folderArg ?? '.');
log(`start dir=${dir}`);
if (!keysFile) fail('needs --keys-file <path> (the keys file setup.mjs wrote)');

let cfg;
try { cfg = JSON.parse(readFileSync(join(dir, '.agent-hub.json'), 'utf8')); } catch (e) { fail(`refusing to start: cannot read .agent-hub.json in ${dir}: ${e.code || e.message}`); }
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail('refusing to start: .agent-hub.json must be a JSON object');
const sesVar = cfg.session_var;
if (typeof sesVar !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(sesVar)) fail('refusing to start: .agent-hub.json needs "session_var" (a variable name)');

function readEnv(path) {
  let st;
  try { st = statSync(path); } catch { fail(`refusing to start: keys file not found: ${path}`); }
  if (!st.isFile()) fail(`refusing to start: ${path} is not a file`);
  // Windows reports mode bits that never pass this test; NTFS ACLs on the profile protect the file there.
  if (process.platform !== 'win32' && (st.mode & 0o077)) fail(`refusing to start: ${path} must be readable by you only (chmod 600)`);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { fail(`refusing to start: cannot read ${path}: ${e.code || e.message}`); }
  return parseEnv(text);
}
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const keys = readEnv(resolve(expand(keysFile)));
// The folder may be an untrusted clone: the app key name is fixed, the hub comes only from the pin in the keys file,
// and a folder URL that disagrees is refused.
let appKey = keys.AGENT_HUB_APP_KEY, sesKey = keys[sesVar];
if (!appKey || !sesKey) fail(`refusing to start: the keys file lacks the app key or ${sesVar}`);
const pinned = keys.AGENT_HUB_URL;
if (!pinned) fail('refusing to start: the keys file has no AGENT_HUB_URL (the pinned hub); rerun setup.mjs to write it');
if (cfg.url && String(cfg.url).replace(/\/+$/, '') !== pinned.replace(/\/+$/, '')) fail(`.agent-hub.json url ${cfg.url} differs from AGENT_HUB_URL in the keys file; refusing to send keys there`);
const url = pinned;
if (!/^https?:\/\//.test(url)) fail(`hub URL must be http(s): ${url}`);
let ca;
if (keys.AGENT_HUB_CA) { try { ca = readFileSync(resolve(expand(keys.AGENT_HUB_CA))); } catch (e) { fail(`cannot read AGENT_HUB_CA ${keys.AGENT_HUB_CA}: ${e.code || e.message}`); } }

// ───────────── HTTP to the hub ─────────────
/** One POST of a JSON-RPC body. Resolves {status, messages} (the JSON-RPC replies, JSON or SSE) or rejects on transport errors. */
function post(body, headers, timeoutMs) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((res, rej) => {
    const req = mod.request(u, { method: 'POST', timeout: timeoutMs, ...(ca ? { ca } : {}),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...headers } }, (r) => {
      // Never follow a redirect: it would send the app key to another address.
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return rej(new Error(`the hub answered a redirect (${r.statusCode}); not following it`)); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; });
      r.on('error', (e) => rej(e));
      r.on('end', () => {
        if (r.statusCode !== 200) {
          // Keep the hub's own answer (a JSON-RPC error, or {error, message} such as rate_limited) for the relay to pass on.
          let body = null;
          try { body = /^\s*[[{]/.test(raw) ? JSON.parse(raw) : null; } catch { body = null; }
          return res({ status: r.statusCode, messages: [], sessionId: null, body });
        }
        const messages = [];
        try {
          if (raw.trim() === '') { /* nothing */ } else if (/^\s*[[{]/.test(raw)) { const j = JSON.parse(raw); messages.push(...(Array.isArray(j) ? j : [j])); } else {
            for (const ev of raw.split(/\r?\n\r?\n/)) {
              const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (data) messages.push(JSON.parse(data));
            }
          }
        } catch { return rej(new Error(`the hub sent a reply that is not JSON (HTTP ${r.statusCode})`)); }
        res({ status: 200, messages, sessionId: r.headers['mcp-session-id'] ?? null });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${url} within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', (e) => rej(e));
    req.end(body);
  });
}
let auth = { Authorization: `Bearer ${appKey}` };
async function tool(name, args, headers) {
  const r = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), headers, LOGIN_TIMEOUT_MS);
  const data = r.messages[0]?.result?.structuredContent;
  return { status: r.status, data: data && typeof data === 'object' ? data : {} };
}

// ───────────── login (outside the model) ─────────────
const cacheDir = join(CONF, 'tokens');
const cache = join(cacheDir, `${sesVar}.tok`);
let token = null;
async function login(fresh) {
  if (!fresh) {
    try { token = readFileSync(cache, 'utf8').trim() || null; } catch { token = null; }
    if (token) {
      const r = await tool('session_whoami', {}, { ...auth, 'X-Agent-Hub-Session': token });
      if (r.status === 200 && !r.data.error) return token;
    }
  }
  let r = await tool('session_login', { session_key: sesKey }, auth);
  let t = typeof r.data.session_token === 'string' ? r.data.session_token : null;
  // A revoked key is not retried in a loop: the keys file is read again once, and a different key is tried once.
  if ((r.status !== 200 || !t) && rereadKeys()) {
    r = await tool('session_login', { session_key: sesKey }, auth);
    t = typeof r.data.session_token === 'string' ? r.data.session_token : null;
  }
  if (r.status !== 200 || !t) throw new Error(`login refused (${r.status}): ${r.data.error || 'no token'} ${r.data.message || ''}`);
  token = t;
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(cache, token, { mode: 0o600 });
    chmodSync(cache, 0o600);
  } catch (e) { process.stderr.write(`codex-bridge: cannot cache the session token: ${oneLine(e.code || e.message)}\n`); }
  return token;
}
/**
 * After a login the hub refused, reads the keys file once more: the Codex wake may have collected a rotated key into it
 * (docs/codex-wake.md, "Collecting a rotated key"). Returns true only if the session key is a different one now.
 * The hub, the app key's name and the session variable stay as they were at start; only the two key values are taken.
 */
function rereadKeys() {
  let fresh;
  try { fresh = parseEnv(readFileSync(resolve(expand(keysFile)), 'utf8')); } catch { return false; }
  const ses = fresh[sesVar], app = fresh.AGENT_HUB_APP_KEY;
  if (!ses || !app || ses === sesKey) return false;
  if (fresh.AGENT_HUB_URL && fresh.AGENT_HUB_URL.replace(/\/+$/, '') !== pinned.replace(/\/+$/, '')) return false;
  sesKey = ses; appKey = app; auth = { Authorization: `Bearer ${appKey}` };
  log('login refused; the keys file holds a different session key now, trying it once');
  return true;
}
let relogin = null;
/** One fresh login shared by every message that hit a 401 at the same time. */
const refresh = (stale) => {
  if (token !== stale) return Promise.resolve(token);
  relogin ??= login(true).finally(() => { relogin = null; });
  return relogin;
};

try { await login(false); } catch (e) { fail(e.message || String(e)); }
log(`ok dir=${dir}`);

// ───────────── the relay ─────────────
let protocolVersion = null, sessionId = null;
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rpcError = (id, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message: `codex-bridge: ${oneLine(message)}` } }); };

/**
 * A non-200 answer for message `id`: a JSON-RPC error with the same id is relayed as is; otherwise the hub's `error`
 * code and `message` (or a JSON-RPC error's message) go into the bridge's error, so Codex sees why, not just the status.
 */
function hubError(id, r) {
  const b = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : null;
  if (b && b.jsonrpc === '2.0' && b.error && typeof b.error === 'object' && b.id === id && id !== undefined && id !== null) return write(b);
  const code = typeof b?.error === 'string' ? b.error : null;
  const message = typeof b?.message === 'string' ? b.message : typeof b?.error?.message === 'string' ? b.error.message : null;
  const why = [code, message].filter(Boolean).join(': ').slice(0, 500);
  rpcError(id, `the hub answered HTTP ${r.status}${why ? `: ${why}` : ''}`);
}

/** The tools whose retry must not record twice; the hub keeps their request id about 24 hours. */
const ONCE_TOOLS = new Set(['task_submit', 'task_review']);
/** The same call (tool and arguments) always gets the same request id; the JSON keys are sorted so their order does not matter. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
function withRequestId(msg) {
  const p = msg && !Array.isArray(msg) && msg.method === 'tools/call' ? msg.params : null;
  if (!p || !ONCE_TOOLS.has(p.name) || !p.arguments || typeof p.arguments !== 'object' || p.arguments.request_id !== undefined) return msg;
  const rid = 'cb-' + createHash('sha256').update(JSON.stringify([p.name, sorted(p.arguments)])).digest('hex').slice(0, 32);
  return { ...msg, params: { ...p, arguments: { ...p.arguments, request_id: rid } } };
}

async function relay(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'codex-bridge: not JSON' } }); }
  msg = withRequestId(msg);
  const id = Array.isArray(msg) ? null : msg?.id;
  const body = JSON.stringify(msg);
  const headers = () => ({ ...auth, 'X-Agent-Hub-Session': token, ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) });
  try {
    const sent = token;
    let r = await post(body, headers(), CALL_TIMEOUT_MS);
    if (r.status === 401) { await refresh(sent); r = await post(body, headers(), CALL_TIMEOUT_MS); }
    if (r.status === 202 || r.status === 204) return; // a notification or a response: nothing comes back
    if (r.status !== 200) return hubError(id, r);
    if (r.sessionId) sessionId = r.sessionId;
    for (const m of r.messages) {
      if (msg?.method === 'initialize' && m?.id === id && typeof m?.result?.protocolVersion === 'string') protocolVersion = m.result.protocolVersion;
      write(m);
    }
  } catch (e) {
    log(`fail ${e.message || e}`);
    rpcError(id, e.message || String(e));
  }
}

const pending = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const p = relay(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exit(0); });
