/**
 * `conclave mcp <folder>`: the local stdio MCP server of one registered agent folder (docs/connector.md).
 *
 * Claude Code and Codex start it from the folder's own MCP entry. It signs the agent in outside the model, over pinned
 * HTTPS only, and relays each JSON-RPC message to the hub. The agent never calls session_login and never sees a key or
 * a token. When the folder cannot sign in, the process still answers `initialize` itself, so the session gets the fixed
 * reason and what to run (as the server's instructions and as the one tool `conclave_status`) instead of a bare
 * "connection closed". stdout carries JSON-RPC only, one message per line; one line per start and failure goes to
 * connector.log (folder and a reason code, never a key or token).
 *
 * task_submit and task_review calls without a request_id get one (docs/mcp.md), so a retried call after a lost reply
 * returns the first result instead of recording twice.
 */
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { post } from './hubclient.mjs';
import { resolveContext, signInWithReread } from './context.mjs';
import { line as reasonLine } from './reasons.mjs';
import { oneLine } from './paths.mjs';
import { markRunning } from './run.mjs';
import { lineFor } from './hook.mjs';

export const VERSION = '1';
const CALL_TIMEOUT_MS = 10 * 60_000; // poll calls wait up to 45 s; tool calls can take longer
const STATUS_TOOL = 'conclave_status';
const ONCE_TOOLS = new Set(['task_submit', 'task_review']);
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

/** The same call (tool and arguments) always gets the same request id; key order does not matter. */
export function withRequestId(msg) {
  const p = msg && !Array.isArray(msg) && msg.method === 'tools/call' ? msg.params : null;
  if (!p || !ONCE_TOOLS.has(p.name) || !p.arguments || typeof p.arguments !== 'object' || p.arguments.request_id !== undefined) return msg;
  const rid = 'cb-' + createHash('sha256').update(JSON.stringify([p.name, sorted(p.arguments)])).digest('hex').slice(0, 32);
  return { ...msg, params: { ...p, arguments: { ...p.arguments, request_id: rid } } };
}

/** The local answers of a folder that cannot sign in: initialize, tools/list, the one status tool, ping. */
export function speakUp(msg, reason) {
  const text = `Conclave: ${reasonLine(reason)}`;
  const id = msg?.id;
  if (id === undefined || id === null) return null; // a notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'conclave', version: VERSION }, instructions: text });
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: [{ name: STATUS_TOOL, description: 'Why this folder is not connected to its Conclave hub, and what to run. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text }], structuredContent: { connected: false, reason, message: text }, isError: true });
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: text } };
  }
}

export async function runMcp(folderArg, { home, input = process.stdin, output = process.stdout, err = process.stderr } = {}) {
  const logLine = (what) => { try { mkdirSync(home, { recursive: true }); appendFileSync(join(home, 'connector.log'), `${new Date().toISOString()} mcp ${oneLine(what)}\n`); } catch { /* logging is best effort */ } };
  const write = (m) => output.write(JSON.stringify(m) + '\n');
  const rpcError = (id, text) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message: `conclave: ${oneLine(text)}` } }); };

  let ctx = resolveContext(home, folderArg);
  let token = null, mode = 'speak', reason = ctx.ok ? null : ctx.reason;
  const start = (async () => {
    if (!ctx.ok) return;
    const r = await signInWithReread(home, ctx);
    ctx = r.ctx;
    if (r.ok) {
      token = r.token; mode = 'relay';
      const unmark = markRunning(home, ctx.hubKey, ctx.binding.agent, r.agentId);
      process.once('exit', unmark);
    } else reason = r.reason;
  })();
  start.then(() => logLine(`${mode === 'relay' ? 'ok' : 'speaking-up ' + reason} folder=${ctx.ok ? ctx.folder : folderArg}`));

  let protocolVersion = null, sessionId = null, relogin = null;
  // Codex gets the one reminder line at the start of each woken turn (docs/connector.md): a woken turn is a new process,
  // so the first tool result of this process carries it. Claude Code has the folder hook instead.
  let codexClient = false, lineDone = false;
  const refresh = (stale) => {
    if (token !== stale) return Promise.resolve({ ok: true });
    relogin ??= signInWithReread(home, ctx, true).then((r) => { ctx = r.ctx; if (r.ok) token = r.token; return r; }).finally(() => { relogin = null; });
    return relogin;
  };
  const headers = () => ({ Authorization: `Bearer ${ctx.appKey}`, 'X-Agent-Hub-Session': token, ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) });

  async function relay(msg) {
    const id = Array.isArray(msg) ? null : msg?.id;
    const body = JSON.stringify(withRequestId(msg));
    try {
      const sent = token;
      let r = await post(ctx.hub, body, headers(), CALL_TIMEOUT_MS);
      if (r.status === 401) {
        const f = await refresh(sent);
        if (f.ok === false) { mode = 'speak'; reason = f.reason; logLine(`speaking-up ${reason} folder=${ctx.folder}`); return rpcError(id, reasonLine(reason)); }
        r = await post(ctx.hub, body, headers(), CALL_TIMEOUT_MS);
        if (r.status === 401) { mode = 'speak'; reason = 'login_refused'; logLine(`speaking-up ${reason} folder=${ctx.folder}`); return rpcError(id, reasonLine(reason)); }
      }
      if (r.status === 202 || r.status === 204) return; // a notification or a response: nothing comes back
      if (r.status !== 200) {
        const b = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : null;
        if (b && b.jsonrpc === '2.0' && b.error && typeof b.error === 'object' && b.id === id && id !== undefined && id !== null) return write(b);
        const code = typeof b?.error === 'string' ? b.error : null;
        const message = typeof b?.message === 'string' ? b.message : typeof b?.error?.message === 'string' ? b.error.message : null;
        return rpcError(id, `the hub answered HTTP ${r.status}${[code, message].filter(Boolean).length ? `: ${[code, message].filter(Boolean).join(': ').slice(0, 500)}` : ''}`);
      }
      if (r.sessionId) sessionId = r.sessionId;
      for (const m of r.messages) {
        if (msg?.method === 'initialize' && m?.id === id && typeof m?.result?.protocolVersion === 'string') protocolVersion = m.result.protocolVersion;
        if (msg?.method === 'initialize') codexClient = /codex/i.test(String(msg?.params?.clientInfo?.name ?? ''));
        if (codexClient && !lineDone && msg?.method === 'tools/call' && m?.id === id && Array.isArray(m?.result?.content) && !m.result.isError) {
          lineDone = true;
          const l = await lineFor(home, ctx.folder, { timeoutMs: 3000 });
          if (l) m.result.content = [...m.result.content, { type: 'text', text: l }];
        }
        write(m);
      }
    } catch (e) {
      logLine(`fail ${e.reason ?? 'hub_unreachable'} folder=${ctx.folder}`);
      rpcError(id, reasonLine(e.reason ?? 'hub_unreachable'));
    }
  }

  const pending = new Set();
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (text) => {
    if (!text.trim()) return;
    const p = (async () => {
      let msg;
      try { msg = JSON.parse(text); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'conclave: not JSON' } }); }
      await start;
      if (mode === 'relay') return relay(msg);
      const a = Array.isArray(msg) ? msg.map((m) => speakUp(m, reason)).filter(Boolean) : speakUp(msg, reason);
      if (a && (!Array.isArray(a) || a.length)) write(a);
    })().finally(() => pending.delete(p));
    pending.add(p);
  });
  await new Promise((res) => rl.on('close', res));
  await Promise.allSettled([...pending]);
  void err;
}
