// Story runner plumbing (docs/showcase.md §6): a throwaway hub on 127.0.0.1, the operator's admin client, one MCP
// client per simulated PC, the /onboard client, and the step recorder behind assertions, coverage and pacing.
// Nothing here talks to any host but 127.0.0.1, prints a secret, or reads ~/.config/conclave.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = process.env.CONCLAVE_SERVER_DIR ? resolve(process.env.CONCLAVE_SERVER_DIR) : join(REPO, 'server');
export const VAULT_SRC = join(REPO, 'eval', 'vault');
const req = createRequire(join(SERVER, 'package.json'));
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');

export const sleep = (ms, signal) => new Promise((ok, no) => {
  if (signal?.aborted) return no(signal.reason ?? new Error('aborted'));
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason ?? new Error('aborted')); }, { once: true });
});

/** Refuse anything but 127.0.0.1, in every mode. */
export function assertLocal(base) {
  const u = new URL(base);
  if (u.hostname !== '127.0.0.1') throw new Error(`refusing to talk to ${u.hostname}: the story runs against 127.0.0.1 only`);
  return u.origin;
}

/**
 * A client folder for a hub the story runs against: a copy of the shipped client files (deploy/client), restore template
 * included, so a hub never serves files that change under it. clientSrc is the folder with the shipped files.
 */
export function stageClientDir(clientSrc = join(REPO, 'deploy', 'client')) {
  const dir = mkdtempSync(join(tmpdir(), 'starship-client-'));
  for (const f of ['setup.mjs', 'agent-hub-headers.mjs', 'onboarding-prompt.md', 'restore-prompt.md']) if (existsSync(join(clientSrc, f))) cpSync(join(clientSrc, f), join(dir, f));
  return dir;
}

/**
 * The few variables a spawned hub needs to run (a path, a temp folder, a home folder), and nothing else, so DEMO_MODE,
 * ALLOWED_ORIGINS, DATA_DIR and the like from the caller's shell never reach it.
 */
export const cleanEnv = () => Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'USERNAME', 'USER', 'LANG', 'TZ']
  .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

const freePort = () => new Promise((ok, no) => { const s = createServer(); s.once('error', no); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

/**
 * A throwaway hub: fresh data directory and a fresh copy of eval/vault/. restart() stops it and starts it again on the
 * same data and vault (steps 4.13b–c). stop() ends it and, unless keep, deletes its directory.
 */
export async function startThrowawayHub({ dir, port, log = () => {} } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'early-echo-'));
  const dataDir = join(root, 'data'), vaultDir = join(root, 'vault');
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(vaultDir)) cpSync(VAULT_SRC, vaultDir, { recursive: true });
  const PORT = port ?? await freePort();
  const admin = { username: 'admin', password: randomBytes(18).toString('base64url') };
  const env = {
    ...cleanEnv(), NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(PORT), PUBLIC_URL: `http://127.0.0.1:${PORT}`, TRUST_PROXY: 'false', LOG_LEVEL: 'warn',
    DATA_DIR: dataDir, VAULT_DIR: vaultDir, ADMIN_USERNAME: admin.username, ADMIN_PASSWORD: admin.password, KEY_PEPPER: randomBytes(32).toString('base64url'),
    VAULT_SCAN_SECONDS: '5', VAULT_WATCH: '1', GRAPH_DEBOUNCE_MS: '1000', CLIENT_DIR: stageClientDir(),
  };
  const base = `http://127.0.0.1:${PORT}`;
  let child = null;
  const up = async () => {
    // One process: tsx as a loader inside the hub's own node, not tsx's CLI (which runs the hub in a second process that
    // can outlive a kill on Windows and keep the database and the port).
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: SERVER, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error(`hub exited during start: ${err.trim().split('\n').slice(-5).join(' | ')}`);
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      await sleep(100);
    }
    throw new Error('hub did not become healthy within 30 s');
  };
  const answering = async () => { try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; } };
  /** Stop the hub and wait until it has exited and the port no longer answers, so a restart never talks to the old one. */
  const down = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = new Promise((ok) => child.once('exit', ok));
      child.kill('SIGTERM');
      await Promise.race([done, sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await done; }
    }
    for (let i = 0; i < 100 && await answering(); i++) await sleep(100);
    if (await answering()) throw new Error(`the old hub still answers on ${base} after stopping`);
  };
  await up();
  log(`throwaway hub at ${base}`);
  return {
    base, admin, dataDir, vaultDir, root, throwaway: true,
    restart: async () => { await down(); await up(); },
    // Windows may hold the database files for a moment after the process exits: retry the delete with a short backoff.
    stop: async ({ keep = false } = {}) => { await down(); if (!keep && !dir) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
  };
}

/**
 * Refuse a hub that is not a local dev or story hub. It must accept the dev credentials and say its own public URL is the
 * 127.0.0.1 address and port we reached it on: an SSH tunnel to a real hub reports that hub's URL, and would not accept the
 * generated password anyway. Returns the hub.
 */
export async function assertLocalHub(hub) {
  const admin = new Admin(hub.base);
  let me;
  try { await admin.login(hub.admin.username, hub.admin.password); me = await admin.get('/api/me'); }
  catch (e) { throw new Error(`${hub.base} did not accept the local dev credentials, so it is not the local dev hub (${e.message})`); }
  const own = new URL(hub.base);
  let said = null;
  try { said = new URL(me.public_url); } catch {}
  if (!said || said.hostname !== '127.0.0.1' || said.port !== own.port) throw new Error(`${hub.base} says its public URL is ${me.public_url ?? 'unknown'}: it is not a local dev or story hub, refusing to run the story against it`);
  return hub;
}

/** Collapse ids in a path to ":id" so routes group by pattern for the coverage report. */
const ROUTE_WORDS = new Set(['directive-reports', 'needs-changes', 'reissue-pickup', 're-enrol', 'end-logins', 'apply-template', 'decision-log', 'plan-request', 'report-request',
  'status-request', 'unreviewed-count', 'review-all', 'priority-folders', 'more-info', 'reset-password']);
// A segment after one of these is always a parameter (a role name, an item key, a setup token, a scanned folder).
const PARAM_AFTER = new Set(['roles', 'items', 'setup', 'scan']);
const LOOKS_LIKE_ID = /^[a-z]+[-_][A-Za-z0-9_-]{6,}$|^\d+$|^[A-Za-z0-9_-]{20,}$/;
export const routePattern = (path) => path.split('?')[0].split('/').map((seg, i, all) => (PARAM_AFTER.has(all[i - 1]) || (!ROUTE_WORDS.has(seg) && LOOKS_LIKE_ID.test(seg)) ? ':id' : seg)).join('/');

export class HubError extends Error {
  constructor(status, code, message) { super(`${status} ${code ?? ''} ${message ?? ''}`.trim()); this.status = status; this.code = code; }
}

/** The operator: cookie session + CSRF on the admin API, every call recorded for coverage. */
export class Admin {
  constructor(base, rec) { this.base = assertLocal(base); this.rec = rec; this.cookie = ''; this.csrf = ''; }
  async login(username, password) {
    const r = await this.raw('POST', '/api/login', { username, password });
    this.csrf = r.json.csrf;
  }
  async raw(method, path, body, refusal = false) {
    const res = await fetch(this.base + path, { method, headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...(method === 'GET' ? {} : { 'x-csrf-token': this.csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    this.rec?.admin(method, path, res.status, refusal);
    return { status: res.status, json, res };
  }
  async call(method, path, body) {
    const r = await this.raw(method, path, body);
    if (r.status >= 400) throw new HubError(r.status, r.json.error, r.json.message);
    return r.json;
  }
  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
  /** Expect a refusal: returns the error code. */
  async refused(method, path, body) {
    const r = await this.raw(method, path, body, true);
    if (r.status < 400) throw new Error(`expected ${method} ${path} to be refused, got ${r.status}`);
    return r.json.error ?? String(r.status);
  }
}

/** The outside lab's client on /onboard (loopback: plain HTTP is allowed). */
export class Onboard {
  constructor(base, rec) { this.base = assertLocal(base); this.rec = rec; }
  async call(method, path, key, body) {
    const res = await fetch(`${this.base}/onboard${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    this.rec?.admin(method, `/onboard${path}`, res.status);
    return { status: res.status, json };
  }
  async ok(method, path, key, body) {
    const r = await this.call(method, path, key, body);
    if (r.status >= 400) throw new HubError(r.status, r.json.error, r.json.message);
    return r.json;
  }
}

/** One MCP connection per simulated PC (its app key); seats log in through it with session_login. */
export class Pc {
  constructor(base, name, appKey, rec) { this.base = assertLocal(base); this.name = name; this.appKey = appKey; this.rec = rec; this.client = null; }
  async connect() {
    this.client = new Client({ name: `story-${this.name}`, version: '1' });
    await this.client.connect(new StreamableHTTPClientTransport(new URL(`${this.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${this.appKey}` } } }));
    return this;
  }
  async close() { try { await this.client?.close(); } catch {} this.client = null; }
  async listTools() { const out = []; let cursor; do { const r = await this.client.listTools(cursor ? { cursor } : {}); out.push(...r.tools); cursor = r.nextCursor; } while (cursor); return out; }
  /** Raw tool call: { ok, code, data, text }. */
  async tool(name, args) {
    let r;
    try { r = await this.client.callTool({ name, arguments: args }); }
    catch (e) { return { ok: false, code: /invalid|validation|-32602/i.test(e.message) ? 'invalid_argument' : 'error', data: {}, text: e.message }; }
    const data = r.structuredContent ?? {};
    const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
    const code = r.isError ? (data.error ?? (/-32602|Input validation/.test(text) ? 'invalid_argument' : /^\s*([a-z_]+):/.exec(text)?.[1] ?? 'error')) : null;
    return { ok: !r.isError, code, data, text };
  }
}

/**
 * The recorder: every MCP call and admin call, by step, for the coverage gate and the outcome log that proves pacing
 * changes nothing.
 */
export class Recorder {
  constructor() { this.calls = []; this.routes = []; this.steps = []; this.rows = new Map(); this.skipped = []; this.current = null; }
  tool(name, outcome) { this.calls.push({ tool: name, step: this.current, outcome }); this.steps.at(-1)?.outcomes.push(`${name}:${outcome}`); }
  admin(method, path, status, refusal = false) {
    this.routes.push({ method, pattern: routePattern(path), step: this.current, status, refusal });
    this.steps.at(-1)?.outcomes.push(`${method} ${routePattern(path)}:${status < 400 ? 'ok' : status}`);
  }
  /** Mark an acceptance row exercised by the current step. Call it after the step's checks have passed. */
  row(id) { if (this.current) { const s = this.rows.get(id) ?? new Set(); s.add(this.current); this.rows.set(id, s); } }
  skip() { this.steps.at(-1).outcomes.push('skipped'); this.skipped.push(this.current); }
  begin(id, title) { this.current = id; this.steps.push({ id, title, outcomes: [] }); }
  /** One line per step: what each call did, sorted within the step (concurrent calls may finish in either order). Identical across paces. */
  outcomeLog() { return this.steps.map((s) => `${s.id} ${[...s.outcomes].sort().join(' ')}`); }
}
