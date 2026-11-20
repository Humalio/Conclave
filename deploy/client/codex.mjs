#!/usr/bin/env node
/**
 * Codex preparation for the restore client (docs/checkout.md §6 steps 5, 6, 7 and 9, §9 F4): the `.codex/config.toml`
 * writers, the AGENTS.override.md overlay, the permission mapping, the start line and the doctor's bridge handshake.
 * The connector's own Codex restore replaced these writers (docs/checkout.md §6 step 5, verified in the second Codex move
 * trial, §9 F4); they stay until `conclave check` shows no folder uses the bridge. Node 18 or later, no dependencies.
 *
 * Variants (`--codex-config=project|global`):
 *   project (primary): <folder>/.codex/config.toml names the stdio bridge with the folder and --keys-file as arguments,
 *     and sets model, approval_policy and sandbox_mode; the folder is marked trusted in $CODEX_HOME/config.toml.
 *   global (fallback): one managed [mcp_servers.agent_hub] entry in $CODEX_HOME/config.toml whose bridge reads
 *     .agent-hub.json from its working folder and refuses to start without it; model and permissions go on the start
 *     line instead. One global entry per agent is rejected (F4): every session would load every agent's server.
 *
 * Commands:
 *   node codex.mjs print <folder> --keys-file <path> [--bridge <path>] [--permissions <mode>] [--model <m>] [--codex-config=project|global]
 *   node codex.mjs doctor <folder> --keys-file <path> [--bridge <path>]     the bridge handshake: initialize, tools/list, session_whoami
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

export const UNVERIFIED = 'Unverified until the F4 spike (docs/checkout.md §9 F4).';
export const SERVER_NAME = 'agent_hub';
export const STARTUP_TIMEOUT_SEC = 60;
// Longer than the bridge's own 10-minute call timeout (codex-bridge.mjs CALL_TIMEOUT_MS), so the bridge's error reaches
// Codex instead of Codex giving up first and the bridge's late reply going unread.
export const TOOL_TIMEOUT_SEC = 660;
export const VARIANTS = ['project', 'global'];
const WIN = platform() === 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BRIDGE = join(homedir(), '.config', 'conclave', 'codex-bridge.mjs');
const fwd = (p) => p.replace(/\\/g, '/');

// ───────────── permissions ─────────────
/**
 * A render's permission level (Claude Code's modes) as Codex settings. Must match codexPermission() in
 * server/src/checkout/fields.ts; server/test/codex-bridge.test.ts checks that. No level maps to danger-full-access.
 */
export function codexPermission(p) {
  switch (p) {
    case 'plan': return { level: 'ask', approval_policy: 'on-request', sandbox_mode: 'read-only' };
    case 'default':
    case 'acceptEdits': return { level: 'standard', approval_policy: 'on-request', sandbox_mode: 'workspace-write' };
    case 'bypassPermissions': return { level: 'auto', approval_policy: 'never', sandbox_mode: 'workspace-write' };
    default: throw new Error(`unknown permission level: ${p}`);
  }
}

// ───────────── TOML ─────────────
/** A TOML basic string: backslashes (Windows paths), quotes and control characters escaped. */
export function tomlString(s) {
  return '"' + String(s).replace(/[\\"\x00-\x1f\x7f]/g, (c) => {
    const named = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' }[c];
    return named ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }) + '"';
}
export const tomlArray = (xs) => `[${xs.map(tomlString).join(', ')}]`;
const validModel = (m) => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/.test(m);

/** The bridge's arguments: the folder (project variant only) and the keys file. */
export function bridgeArgs({ bridge = DEFAULT_BRIDGE, folder = null, keysFile }) {
  if (!keysFile) throw new Error('keysFile is required');
  return [bridge, ...(folder ? [folder] : []), '--keys-file', keysFile];
}
function serverTable({ node = 'node', bridge, folder, keysFile }) {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(node)}`,
    `args = ${tomlArray(bridgeArgs({ bridge, folder, keysFile }))}`,
    `startup_timeout_sec = ${STARTUP_TIMEOUT_SEC}`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
  ];
}

/** <folder>/.codex/config.toml (project variant): this agent's bridge, model and permission level. */
export function projectConfig({ folder, keysFile, bridge = DEFAULT_BRIDGE, node = 'node', model = null, permissions = 'default', label = null }) {
  if (!folder) throw new Error('folder is required');
  if (model !== null && !validModel(model)) throw new Error(`invalid model: ${model}`);
  const p = codexPermission(permissions);
  return [
    `# Written by Conclave setup.mjs${label ? ` for ${String(label).replace(/[\r\n]+/g, ' ')}` : ''}. Local config: never commit it.`,
    `# ${UNVERIFIED}`,
    ...(model ? [`model = ${tomlString(model)}`] : []),
    `approval_policy = ${tomlString(p.approval_policy)}`,
    `sandbox_mode = ${tomlString(p.sandbox_mode)}`,
    '',
    ...serverTable({ node, bridge, folder, keysFile }),
    '',
  ].join('\n');
}

/** The global variant's one managed entry: no folder argument, so the bridge reads .agent-hub.json from its working folder. */
export function globalEntry({ keysFile, bridge = DEFAULT_BRIDGE, node = 'node' }) {
  return [`# ${UNVERIFIED}`, ...serverTable({ node, bridge, folder: null, keysFile })].join('\n');
}
/** Marks a folder trusted, so Codex reads its project config (to verify in the spike). */
export function trustEntry(folder) {
  return [`[projects.${tomlString(folder)}]`, 'trust_level = "trusted"'].join('\n');
}

const begin = (id) => `# >>> conclave ${id} >>>`;
const end = (id) => `# <<< conclave ${id} <<<`;

/**
 * Reads a TOML dotted key at the start of `s` (bare, "basic" and 'literal' parts). Returns {parts, rest} or null.
 * Enough to find which table a line defines; it is not a full TOML parser.
 */
export function readKey(s) {
  const parts = [];
  let i = 0;
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return null;
      const raw = s.slice(i, j + 1);
      try { parts.push(JSON.parse(raw)); } catch { parts.push(raw.slice(1, -1)); }
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j === -1) return null;
      parts.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] !== '.') return { parts, rest: s.slice(i) };
    i++;
  }
}
/** The key path a line defines: a [table] or [[array]] header, or a `dotted.key = value` inside the current table. */
function lineKey(line, table) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  if (t.startsWith('[')) {
    const k = readKey(t.slice(t.startsWith('[[') ? 2 : 1));
    return k && k.rest.startsWith(']') ? { header: true, path: k.parts } : null;
  }
  const k = readKey(t);
  return k && k.rest.startsWith('=') ? { header: false, path: [...table, ...k.parts] } : null;
}
/** One key part for comparison: a [projects.<folder>] folder compares with either slash and, on Windows, any case. */
const normPart = (part, index, path, win) => {
  if (index !== 1 || path[0] !== 'projects') return part;
  const f = fwd(part).replace(/\/+$/, '');
  return win ? f.toLowerCase() : f;
};
const samePrefix = (path, key, win) => path.length >= key.length && key.every((k, i) => normPart(k, i, key, win) === normPart(path[i], i, path, win));
/** The first line of `text` that defines `key` or anything inside it (a header, a sub-table, an inline table or a dotted key). */
export function findDefinition(text, key, win = WIN) {
  let table = [], multi = false;
  for (const line of text.split(/\r?\n/)) {
    const quotes = (line.match(/"""|'''/g) ?? []).length;
    if (multi) { if (quotes % 2) multi = false; continue; }
    if (quotes % 2) multi = true;
    const k = lineKey(line, table);
    if (!k) continue;
    if (k.header) table = k.path;
    if (samePrefix(k.path, key, win)) return line.trim();
  }
  return null;
}
/**
 * Puts `body` into `text` between this id's markers, replacing an earlier copy. Refuses when the same table is already
 * defined outside the markers, in any spelling (other quoting or slashes, a sub-table, an inline table or a dotted key):
 * it was written by hand or by Codex, and two definitions make the file invalid TOML, which can stop Codex starting.
 */
export function upsertBlock(text, id, body, win = WIN) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const b = lines.indexOf(begin(id)), e = lines.indexOf(end(id));
  let kept = lines;
  if (b !== -1 && e > b) kept = [...lines.slice(0, b), ...lines.slice(e + 1)];
  else if (b !== -1 || e !== -1) throw new Error(`the conclave ${id} markers in config.toml are broken; fix the file by hand`);
  const header = body.split('\n').map((l) => lineKey(l, [])).find((k) => k?.header);
  const clash = header && findDefinition(kept.join('\n'), header.path, win);
  if (clash) throw new Error(`config.toml already defines ${clash} outside Conclave's markers; remove it by hand first`);
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const block = [begin(id), ...body.split('\n'), end(id)];
  return [...kept, ...(kept.length ? [''] : []), ...block, ''].join(nl);
}

export const codexHome = (env = process.env) => (env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), '.codex'));
function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.conclave-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
function editGlobal(home, id, body) {
  const p = join(home, 'config.toml');
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const next = upsertBlock(cur, id, body);
  if (next !== cur) atomicWrite(p, next);
  return p;
}
/** Folder trust in $CODEX_HOME/config.toml. setup.mjs calls it only for folders the config scan cleared (§6 step 4). */
export function markTrusted(folder, { home = codexHome() } = {}) {
  return editGlobal(home, `trust ${fwd(folder)}`, trustEntry(folder));
}
/** The global variant's entry in $CODEX_HOME/config.toml (one for every agent on this OS user). */
export function writeGlobalEntry({ keysFile, bridge = DEFAULT_BRIDGE, node = 'node', home = codexHome() }) {
  return editGlobal(home, SERVER_NAME, globalEntry({ keysFile, bridge, node }));
}

// ───────────── role overlay and start line ─────────────
/** Hub text in a command line: no characters a shell would read (quotes, $, backticks, backslashes, cmd's % and !), one line. */
const plain = (s) => String(s ?? '').replace(/["'`$\\%!]/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
/** The first call of every start line, Claude Code's (setup.mjs) and Codex's alike: read and confirm the directives first. */
export const FIRST_CALL = 'directives_read {unread: true, ack: true}';
/** The resume message (§6 step 9). */
export function resumeMessage({ label, role, team }) {
  return `You are ${plain(label)}, ${plain(role)} of ${plain(team)}. Call ${FIRST_CALL}, then checkout_resume, then session_whoami, team_info, task_list, message_read, team_decisions, bp_read, then continue.`;
}
/**
 * AGENTS.override.md (§6 step 6): the hub's text as an untracked overlay. A tracked AGENTS.md is left untouched.
 * `instructions` is the same hub text setup.mjs writes as CLAUDE.local.md for Claude Code (the playbook, then the
 * Directives, Writing for the operator, Feedback and Connection sections), so the two files cannot drift. `playbook`
 * alone is the fallback for a hub that sends no instructions.
 */
export function agentsOverride({ label, role, team, instructions, playbook }) {
  const body = String(instructions || playbook || '').replace(/\r\n/g, '\n').trimEnd();
  return [
    `<!-- Written by Conclave setup.mjs from the hub's text. Local overlay: never commit it. ${UNVERIFIED} -->`,
    `# ${plain(label)}: ${plain(role)} of ${plain(team)}`,
    '',
    'You reach the Conclave hub through the `agent_hub` MCP server. It is logged in for you: do not call `session_login` and leave `session_token` out of every call.',
    '',
    ...(body ? [body, ''] : []),
  ].join('\n');
}
/**
 * One shell word: POSIX single quotes; Windows double quotes (cmd and PowerShell), refusing a value they cannot hold:
 * `"`, PowerShell's backtick and `$`, and cmd's `%VAR%` and `!VAR!`, which cmd expands even inside double quotes.
 */
export function shellQuote(s, win = WIN) {
  if (win) { if (/["`$%!]/.test(s)) throw new Error(`cannot quote for Windows: ${s}`); return `"${s}"`; }
  return `'${s.replaceAll("'", "'\\''")}'`;
}
/**
 * The operator's start line (§6 step 9): `codex -C <dir> "<resume msg>"`. The global variant has no per-folder config,
 * so model and permissions go on the line as -m, -a and -s.
 */
export function startLine({ dir, message, variant = 'project', model = null, permissions = null, win = WIN }) {
  const flags = [];
  if (variant === 'global') {
    if (model) { if (!validModel(model)) throw new Error(`invalid model: ${model}`); flags.push('-m', model); }
    if (permissions) { const p = codexPermission(permissions); flags.push('-a', p.approval_policy, '-s', p.sandbox_mode); }
  }
  return ['codex', '-C', shellQuote(win ? fwd(dir) : dir, win), ...flags, shellQuote(message, win)].join(' ');
}

/** The repo-relative files writeAgentFolder writes; P1's narrow .git/info/exclude lists them for a clone (§6 step 3). */
export const CODEX_EXCLUDES = ['.codex/', 'AGENTS.override.md'];
const OURS = /^(# |<!-- )Written by Conclave /;
/** True when git tracks `path` in the repo around `folder`. No git, or no repo, counts as untracked. */
function tracked(folder, path) {
  const r = spawnSync('git', ['-C', folder, 'ls-files', '--error-unmatch', '--', path], { stdio: 'ignore', timeout: 15_000 });
  return r.status === 0;
}
/**
 * The files writeAgentFolder would clobber (§6 step 4, for the config scan): a target that exists and was not written by
 * Conclave, or one git tracks (a change there, keys-file path included, could be committed). [] when it is safe to write.
 */
export function codexConflicts(folder, variant = 'project') {
  const targets = [...(variant === 'project' ? [join(folder, '.codex', 'config.toml')] : []), join(folder, 'AGENTS.override.md')];
  const out = [];
  for (const p of targets) {
    if (existsSync(p) && !OURS.test(readFileSync(p, 'utf8'))) out.push({ path: p, reason: 'exists and was not written by Conclave' });
    else if (existsSync(folder) && tracked(folder, p)) out.push({ path: p, reason: 'is tracked by git' });
  }
  return out;
}

/**
 * Writes one agent's Codex files (§6 steps 5 and 6): the project variant's .codex/config.toml and AGENTS.override.md;
 * for the global variant only the overlay (call writeGlobalEntry once). Trust is separate (markTrusted), so the config
 * scan decides it. Refuses, writing nothing, when codexConflicts() finds a file it would clobber. Returns the paths written.
 */
export function writeAgentFolder({ folder, keysFile, variant = 'project', bridge = DEFAULT_BRIDGE, node = 'node', model = null, permissions = 'default', label, role, team, instructions, playbook }) {
  if (!VARIANTS.includes(variant)) throw new Error(`variant: ${VARIANTS.join(' or ')}`);
  const clash = codexConflicts(folder, variant);
  if (clash.length) throw new Error(`refusing to overwrite: ${clash.map((c) => `${c.path} ${c.reason}`).join('; ')}`);
  const written = [];
  if (variant === 'project') {
    const p = join(folder, '.codex', 'config.toml');
    atomicWrite(p, projectConfig({ folder, keysFile, bridge, node, model, permissions, label }));
    written.push(p);
  }
  const o = join(folder, 'AGENTS.override.md');
  atomicWrite(o, agentsOverride({ label, role, team, instructions, playbook }));
  written.push(o);
  return written;
}

// ───────────── doctor: the bridge handshake ─────────────
/**
 * Starts the bridge the way Codex will and checks initialize, tools/list and a session_whoami call. Resolves
 * {ok, server, tools, agent} or {ok: false, error}. The bridge's stderr is returned as `error` (one line, no secrets).
 */
export function handshake({ folder, keysFile, bridge = join(HERE, 'codex-bridge.mjs'), env = process.env, timeoutMs = 30_000, global = false }) {
  return new Promise((res) => {
    const args = global ? [bridge, '--keys-file', keysFile] : [bridge, folder, '--keys-file', keysFile];
    const child = spawn(process.execPath, args, { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', errText = '', done = false;
    const waiting = new Map();
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); child.kill(); res(r); };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer from the bridge within ${timeoutMs / 1000} s` }), timeoutMs);
    child.stderr.setEncoding('utf8').on('data', (c) => { errText += c; });
    child.on('exit', (code) => finish({ ok: false, error: (errText.split(/\r?\n/).find(Boolean) ?? `the bridge exited (${code})`).replace(/^codex-bridge:\s*/, '') }));
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { return finish({ ok: false, error: 'the bridge wrote something that is not JSON-RPC on stdout' }); }
        if (m.method !== undefined) continue; // a request or notification from the server, not a reply to ours
        waiting.get(m.id)?.(m); waiting.delete(m.id);
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((ok) => { const id = ++n; waiting.set(id, ok); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    (async () => {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conclave-doctor', version: '1' } });
      if (init.error || !init.result) return finish({ ok: false, error: `initialize: ${init.error?.message ?? 'no result'}` });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await rpc('tools/list', {});
      const tools = list.result?.tools;
      if (!Array.isArray(tools) || !tools.length) return finish({ ok: false, error: `tools/list: ${list.error?.message ?? 'no tools'}` });
      const who = await rpc('tools/call', { name: 'session_whoami', arguments: {} });
      const agent = who.result?.structuredContent;
      if (who.error || who.result?.isError || !agent) return finish({ ok: false, error: `session_whoami: ${who.error?.message ?? who.result?.content?.[0]?.text ?? 'no answer'}` });
      finish({ ok: true, server: init.result.serverInfo?.name ?? null, protocolVersion: init.result.protocolVersion, tools: tools.length, agent: agent.agent_id ?? agent.agent?.id ?? null, label: agent.label ?? agent.agent?.label ?? null });
    })().catch((e) => finish({ ok: false, error: e.message }));
  });
}

// ───────────── command line ─────────────
function parse(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { f._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) f[a.slice(2, eq)] = a.slice(eq + 1);
    else f[a.slice(2)] = argv[++i];
  }
  return f;
}
async function main(argv) {
  const f = parse(argv);
  const [cmd, folderArg] = f._;
  if (!['print', 'doctor'].includes(cmd) || !folderArg || !f['keys-file']) {
    process.stdout.write('usage: node codex.mjs print|doctor <folder> --keys-file <path> [--bridge <path>] [--permissions <mode>] [--model <m>] [--codex-config=project|global]\n');
    return 2;
  }
  const folder = resolve(folderArg), keysFile = resolve(f['keys-file']), variant = f['codex-config'] ?? 'project';
  if (!VARIANTS.includes(variant)) { process.stdout.write(`--codex-config: ${VARIANTS.join(' or ')}\n`); return 2; }
  if (cmd === 'print') {
    const bridge = f.bridge ? resolve(f.bridge) : DEFAULT_BRIDGE;
    process.stdout.write(variant === 'project'
      ? `# ${join(folder, '.codex', 'config.toml')}\n${projectConfig({ folder, keysFile, bridge, model: f.model ?? null, permissions: f.permissions ?? 'default' })}`
      : `# ${join(codexHome(), 'config.toml')} (managed block)\n${globalEntry({ keysFile, bridge })}\n`);
    return 0;
  }
  const r = await handshake({ folder, keysFile, global: variant === 'global', ...(f.bridge ? { bridge: resolve(f.bridge) } : {}) });
  process.stdout.write(r.ok ? `ok   bridge handshake: ${r.tools} tools, agent ${r.label ?? r.agent ?? '?'} (${UNVERIFIED})\n` : `fail bridge handshake: ${r.error}\n`);
  return r.ok ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`codex: ${e.message}\n`); process.exit(1); });
}
