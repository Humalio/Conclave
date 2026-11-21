// Shared helpers for the vault stress cases. Nothing here names a host or holds a key: everything comes from the environment.
//   STRESS_MCP_URL       the hub's MCP address, e.g. http://hub.example:8081/mcp (a demo or test hub, NEVER a live one)
//   STRESS_SECRETS       path of the JSON file written by setup.mjs (agent session keys and the app key); default ./stress-secrets.json
//   STRESS_CONSOLE_URL   the console origin, for the cases that use the console API (c5, c6, setup)
//   STRESS_ADMIN_USER / STRESS_ADMIN_PASSWORD   console sign-in for those cases
//   STRESS_OUT           folder for the result files (default ./stress-out)
//   STRESS_RESTART_CMD   shell command that restarts the hub (case 4e is skipped without it)
//   STRESS_HOST_SHELL    command prefix that runs a shell command on the hub host, e.g. "ssh user@host" (case c5 is skipped without it)
//   STRESS_VAULT_DIR     the vault folder on the hub host (for c5's external edits)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const env = process.env;
export const cfg = {
  mcp: env.STRESS_MCP_URL, secrets: env.STRESS_SECRETS || './stress-secrets.json', console: env.STRESS_CONSOLE_URL,
  user: env.STRESS_ADMIN_USER, password: env.STRESS_ADMIN_PASSWORD, outDir: env.STRESS_OUT || './stress-out',
  restartCmd: env.STRESS_RESTART_CMD, hostShell: env.STRESS_HOST_SHELL, vaultDir: env.STRESS_VAULT_DIR,
};
if (cfg.console && cfg.console.startsWith('https://') && env.STRESS_INSECURE_TLS === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/** One folder per run (Stress/<RUN>/...), so a rerun on the same hub never meets the files of the last one. */
export const RUN = env.STRESS_RUN || 'r' + Date.now().toString(36);
export const MCP = cfg.mcp;
const secretsFile = () => JSON.parse(fs.readFileSync(cfg.secrets, 'utf8'));
let S = null;
const secrets = () => (S ??= secretsFile());
export const APP = (() => { try { return secrets().app; } catch { return undefined; } })();

export function out(name, results) {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.outDir, name), JSON.stringify(results, null, 1));
  const fail = results.filter((r) => !r.pass).length;
  console.log(`== ${name}: ${results.length} cases, ${fail} fail`);
}

export const restartHub = cfg.restartCmd ? () => { execSync(cfg.restartCmd, { stdio: 'ignore' }); } : null;
export const hubShell = (c) => execSync(`${cfg.hostShell} ${JSON.stringify(c)}`, { encoding: 'utf8' });

let rid = 1;
export async function rpc(method, params, app = APP) {
  if (!MCP) throw new Error('Set STRESS_MCP_URL');
  const t0 = performance.now();
  const r = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + app }, body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method, params }) });
  let t = await r.text();
  if (t.startsWith('event:') || t.includes('\ndata:') || t.startsWith('data:')) t = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200), status: r.status }; }
  j._ms = performance.now() - t0; j._status = r.status; return j;
}

/** One agent on its own session: login with its session key, then call tools. */
export class Agent {
  constructor(name) { this.name = name; this.key = secrets().agents[name].secret; this.tok = null; }
  async login() {
    const r = await rpc('tools/call', { name: 'session_login', arguments: { session_key: this.key } });
    const sc = r.result?.structuredContent || {};
    this.tok = sc.session_token || sc.token || null;
    if (!this.tok) { const tx = (r.result?.content || []).map((c) => c.text).join(''); const m = tx.match(/ah_tok_[A-Za-z0-9_]+|session_token[":\s]+([A-Za-z0-9_\-.]+)/); this.tok = m && (m[1] || m[0]); }
    return r;
  }
  async call(name, args = {}) {
    const r = await rpc('tools/call', { name, arguments: { session_token: this.tok, ...args } });
    const res = r.result || {};
    const text = (res.content || []).map((c) => c.text).join(' ');
    return { err: !!res.isError || !!r.error || r._status >= 400, text, data: res.structuredContent || null, ms: r._ms, raw: r.error || (r._status >= 400 ? r : null) };
  }
}

// Console API: signs in once with the admin credentials and keeps the cookie and CSRF token.
let session = null;
async function consoleSession() {
  if (session) return session;
  if (!cfg.console || !cfg.user || !cfg.password) throw new Error('Set STRESS_CONSOLE_URL, STRESS_ADMIN_USER and STRESS_ADMIN_PASSWORD');
  const r = await fetch(cfg.console + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: cfg.user, password: cfg.password }) });
  const j = await r.json();
  if (!r.ok) throw new Error('console login failed: ' + r.status);
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  session = { cookie, csrf: j.csrf };
  return session;
}
export async function api(method, p, body) {
  const s = await consoleSession();
  const r = await fetch(cfg.console + p, { method, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: r.status, j };
}
