// Shared helpers: paths, ledger, MCP client, admin client.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const SERVER = join(REPO, 'server');
export const WORK = resolve(process.env.EVAL_WORK ?? join(tmpdir(), 'agent-hub-eval'));
export const FIXTURE = join(WORK, 'fixture');
export const PORT = 18090;
export const BASE = `http://127.0.0.1:${PORT}`;
export const RESULTS = join(WORK, 'results');
mkdirSync(WORK, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const readJson = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
export const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1));
export const tok = (s) => Math.ceil(Buffer.byteLength(typeof s === 'string' ? s : JSON.stringify(s)) / 4);
export function ensureFixture(required = 'manifest.json') {
  if (!existsSync(join(FIXTURE, required))) {
    execFileSync(process.execPath, [join(REPO, 'bench', 'tools', 'build.js')], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
export const tasksOf = (name) => {
  const file = join('tasks', `${name}.json`);
  ensureFixture(file);
  return JSON.parse(readFileSync(join(FIXTURE, file), 'utf8')).tasks;
};

// ───── spend ledger (global cap) ─────
export const GLOBAL_CAP = Number(process.env.EVAL_CAP_USD ?? 15);
const LEDGER = join(WORK, 'ledger.jsonl');
export const ledgerAdd = (e) => appendFileSync(LEDGER, JSON.stringify({ t: Date.now(), ...e }) + '\n');
export const ledger = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const spent = () => ledger().reduce((s, e) => s + (e.cost ?? 0), 0);

// ───── MCP client (SDK from server/node_modules) ─────
const sdk = async (p) => import(pathToFileURL(join(SERVER, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href);
/** Logs in with a session key; call(name, args) injects the token. Returns {text, data, isError, bytes}. */
export async function mcpSession(appKey, sessionKey) {
  const { Client } = await sdk('client/index.js');
  const { StreamableHTTPClientTransport } = await sdk('client/streamableHttp.js');
  const c = new Client({ name: 'eval', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const wrap = (r) => { const text = (r.content ?? []).map((x) => x.text ?? '').join('\n'); return { text, data: r.structuredContent ?? null, isError: !!r.isError, bytes: Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(r.structuredContent ?? '')) }; };
  const login = wrap(await c.callTool({ name: 'session_login', arguments: { session_key: sessionKey } }));
  const token = login.data?.session_token;
  if (!token) throw new Error('login failed');
  return { agentId: login.data.agent_id, call: async (name, args = {}) => wrap(await c.callTool({ name, arguments: { session_token: token, ...args } })), close: () => c.close() };
}

// ───── admin client ─────
export class Admin {
  constructor(user, pass) { this.user = user; this.pass = pass; }
  async login() {
    const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: this.user, password: this.pass }) });
    if (!r.ok) throw new Error(`admin login ${r.status}`);
    this.cookie = r.headers.get('set-cookie').split(';')[0];
    this.csrf = (await r.json()).csrf;
    return this;
  }
  async req(method, path, body) {
    const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-csrf-token': this.csrf }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  }
  get = (p) => this.req('GET', p);
  post = (p, b = {}) => this.req('POST', p, b);
  put = (p, b) => this.req('PUT', p, b);
}
