#!/usr/bin/env node
/**
 * Claude Code headersHelper for Conclave, in Node: the recommended helper on Windows, where Python is often missing.
 * Same contract as agent-hub-headers.py (which stays the default on Linux and macOS): it logs in outside the model and
 * prints {"Authorization": "Bearer <app key>", "X-Agent-Hub-Session": "<session token>"}, so the agent never calls
 * session_login and neither the key nor the token appears in its transcript.
 *
 * Usage: node agent-hub-headers.mjs [agent folder]
 *   The agent folder holds .agent-hub.json. Pass it as the argument: Claude Code does not always run the helper in the
 *   folder that declares the server. Without it, the working folder is used.
 *
 * Configuration, all outside the model:
 *   .agent-hub.json (no secrets): {"session_var": "CONCLAVE_DEVELOPER_SESSION_KEY", "url": "https://hub:8443/mcp"}
 *     optional "keys_file" (default ~/.config/conclave/keys.env) and "app_var" (default AGENT_HUB_APP_KEY)
 *   keys file (readable by you only): AGENT_HUB_APP_KEY=…, the session key variable named above, and optionally
 *     AGENT_HUB_URL=…  pins the hub: it wins over the folder's "url", which must then match or be left out, so a cloned
 *                      folder cannot send your keys elsewhere;
 *     AGENT_HUB_CA=…   a CA certificate file for a hub with an internal certificate (HTTPS on a LAN).
 * A cached token (~/.config/conclave/tokens/<var>.tok) is reused while the hub accepts it; otherwise the helper logs in
 * once and caches the new token. Each start and each failure adds one line to ~/.config/conclave/helper.log (folder,
 * outcome; never a key or token).
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';
import http from 'node:http';

const TIMEOUT_MS = 4000; // Claude Code gives the helper 10 s in total
const CONF = join(homedir(), '.config', 'conclave');
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const oneLine = (s) => String(s).split(/\s+/).filter(Boolean).join(' ');
const log = (what) => { try { appendFileSync(join(CONF, 'helper.log'), `${new Date().toISOString()} ${oneLine(what)}\n`); } catch { /* logging is best effort */ } };
const fail = (msg) => {
  const line = oneLine(msg);
  log(`fail ${line}`);
  process.stderr.write(`agent-hub-headers: ${line}\n`); // always one line
  process.exit(1);
};

function readEnv(path) {
  let st;
  try { st = statSync(path); } catch { fail(`keys file not found: ${path}`); }
  // Windows reports mode bits that never pass this test; NTFS ACLs on the profile protect the file there.
  if (process.platform !== 'win32' && (st.mode & 0o077)) fail(`${path} must be readable by you only (chmod 600)`);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { fail(`cannot read ${path}: ${e.code || e.message}`); }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function call(url, headers, name, args, ca) {
  const u = new URL(url);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((res) => {
    const req = mod.request(u, { method: 'POST', timeout: TIMEOUT_MS, ...(ca ? { ca } : {}),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...headers } }, (r) => {
      // Never follow a redirect: it would send the app key to another address.
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); fail(`${name}: the hub answered a redirect (${r.statusCode}); not following it`); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; });
      r.on('error', (e) => fail(`${name}: request to ${url} failed: ${e.code || e.message}`));
      r.on('end', () => {
        if (r.statusCode !== 200) return res({ status: r.statusCode, data: {} });
        let msg;
        try {
          if (raw.trimStart().startsWith('{')) msg = JSON.parse(raw);
          else {
            const events = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
            if (!events.length) fail(`${name}: the hub sent an empty reply (HTTP ${r.statusCode})`);
            msg = JSON.parse(events.pop().slice(5));
          }
        } catch { fail(`${name}: the hub sent a reply that is not JSON (HTTP ${r.statusCode})`); }
        const data = msg?.result?.structuredContent;
        res({ status: 200, data: data && typeof data === 'object' ? data : {} });
      });
    });
    req.on('timeout', () => { req.destroy(); fail(`${name}: no answer from ${url} within ${TIMEOUT_MS / 1000} s`); });
    req.on('error', (e) => fail(`${name}: request to ${url} failed: ${e.code || e.message}`));
    req.end(body);
  });
}

const dir = resolve(process.argv[2] || '.');
log(`start dir=${dir} cwd=${process.cwd()}`);
let cfg;
try { cfg = JSON.parse(readFileSync(join(dir, '.agent-hub.json'), 'utf8')); } catch (e) { fail(`cannot read .agent-hub.json in ${dir}: ${e.code || e.message}`); }
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail('.agent-hub.json must be a JSON object');
const sesVar = cfg.session_var;
if (!sesVar) fail('.agent-hub.json needs "session_var"');
const keys = readEnv(expand(cfg.keys_file || join(CONF, 'keys.env')));
// The folder may be an untrusted clone: a hub URL pinned in the keys file wins, and a folder URL that disagrees with
// it is refused rather than silently ignored.
let url = cfg.url;
const pinned = keys.AGENT_HUB_URL;
if (pinned) {
  if (url && url.replace(/\/+$/, '') !== pinned.replace(/\/+$/, '')) fail(`.agent-hub.json url ${url} differs from AGENT_HUB_URL in the keys file; refusing to send keys there`);
  url = pinned;
}
if (!url) fail('.agent-hub.json needs "url" (or set AGENT_HUB_URL in the keys file)');
if (!/^https?:\/\//.test(url)) fail(`hub URL must be http(s): ${url}`);
const appKey = keys[cfg.app_var || 'AGENT_HUB_APP_KEY'], sesKey = keys[sesVar];
if (!appKey || !sesKey) fail(`the keys file lacks the app key or ${sesVar}`);
let ca;
if (keys.AGENT_HUB_CA) { try { ca = readFileSync(resolve(expand(keys.AGENT_HUB_CA))); } catch (e) { fail(`cannot read AGENT_HUB_CA ${keys.AGENT_HUB_CA}: ${e.code || e.message}`); } }
// The folder and the variable name (never a key) go with the helper's own calls, so an alert about a refused key can say
// which folder to fix.
const auth = { Authorization: `Bearer ${appKey}`, 'X-Agent-Hub-Folder': encodeURIComponent(dir), 'X-Agent-Hub-Session-Var': sesVar };
const cacheDir = join(CONF, 'tokens');
const cache = join(cacheDir, `${sesVar}.tok`);
let token = null;
try { token = readFileSync(cache, 'utf8').trim() || null; } catch { /* no cached token yet */ }
// Reuse the cached token while the hub still accepts it; a refused one means a fresh login.
if (token) {
  const r = await call(url, { ...auth, 'X-Agent-Hub-Session': token }, 'session_whoami', {}, ca);
  if (r.status !== 200 || r.data.error) token = null;
}
if (!token) {
  const r = await call(url, auth, 'session_login', { session_key: sesKey }, ca);
  token = typeof r.data.session_token === 'string' ? r.data.session_token : null;
  if (r.status !== 200 || !token) fail(`login refused (${r.status}): ${r.data.error || 'no token'} ${r.data.message || ''}`);
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(cache, token, { mode: 0o600 });
    chmodSync(cache, 0o600);
  } catch (e) { process.stderr.write(`agent-hub-headers: cannot cache the session token: ${oneLine(e.code || e.message)}\n`); } // still usable this time
}
log(`ok dir=${dir}`);
process.stdout.write(JSON.stringify({ Authorization: `Bearer ${appKey}`, 'X-Agent-Hub-Session': token }) + '\n');
