/**
 * The folder's MCP entry for the connector, called by absolute paths (docs/connector.md, review-v2 §1 point 16).
 *
 * The entry names Node and the connector program by absolute path, with the folder as a separate argument (never one
 * shell string), so installing Node never needs an app restart, a path with a space needs no quoting, and `conclave
 * check` can tell when a path has moved. The same module finds git by absolute path: the connector's own portable
 * git (design v4) when it is installed, else the one the user has, never one found by a relative name.
 * Entries are changed one at a time (`.mcp.json` mcpServers.conclave, the folder's `.claude/settings.json`
 * enabledMcpjsonServers), keeping every other entry as it was.
 */
import { join, isAbsolute, delimiter, sep, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite, readJson, WIN } from './paths.mjs';

export const SERVER_NAME = 'conclave';
export const STARTUP_TIMEOUT_SEC = 60;
// Longer than the relay's own 10-minute call timeout (mcpserver.mjs), so its error reaches Codex first.
export const TOOL_TIMEOUT_SEC = 660;

/** Node by absolute path: the one running this program, unless another absolute path is given. */
export const nodePath = (override) => (override && isAbsolute(override) ? override : process.execPath);

/** The connector's program by absolute path: the connector's own folder, unless told otherwise. */
export const connectorPath = (home, override) => (override && isAbsolute(override) ? override : join(home, 'conclave.mjs'));

/** Git by absolute path: the connector's portable git first, then one on PATH. Returns null when there is none. */
export function gitPath(home, env = process.env, win = WIN) {
  const own = win ? [join(home, 'git', 'cmd', 'git.exe'), join(home, 'git', 'bin', 'git.exe')] : [join(home, 'git', 'bin', 'git')];
  for (const p of own) if (existsSync(p)) return p;
  for (const d of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!d || !isAbsolute(d)) continue; // a relative PATH entry is never trusted
    for (const n of win ? ['git.exe'] : ['git']) { const p = join(d, n); if (existsSync(p)) return p; }
  }
  return null;
}

/**
 * The program a woken run starts, by absolute path and never from the agent's folder (a program planted in a clone must not run:
 * on Windows a bare name is looked for in the working folder before PATH). Searches the absolute PATH entries that are not inside
 * `folder`, then the clients' own install folders. A native program is returned as `{file, prefix: []}`; an npm `.cmd` shim
 * is replaced by Node running the package's script beside it (a shim cannot be started without a shell). Returns null when none.
 */
const PACKAGE_SCRIPT = { claude: ['@anthropic-ai', 'claude-code', 'cli.js'], codex: ['@openai', 'codex', 'bin', 'codex.js'] };
export function clientProgram(provider, { env = process.env, win = WIN, folder = null, home = homedir(), exists = existsSync } = {}) {
  const name = provider === 'codex' ? 'codex' : 'claude';
  const inside = (d) => { if (!folder) return false; const f = resolve(folder).toLowerCase() + sep, x = resolve(d).toLowerCase() + sep; return x === f || x.startsWith(f); };
  const dirs = [];
  for (const d of String(env.PATH ?? env.Path ?? '').split(delimiter)) if (d && isAbsolute(d)) dirs.push(d);
  dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'));
  if (win && env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
  for (const d of dirs) {
    if (inside(d)) continue;
    for (const n of win ? [name + '.exe', name + '.cmd'] : [name]) {
      const p = join(d, n);
      if (!exists(p)) continue;
      if (!n.endsWith('.cmd')) return { file: p, prefix: [] };
      const script = join(d, 'node_modules', ...PACKAGE_SCRIPT[name]);
      if (exists(script)) return { file: process.execPath, prefix: [script] };
    }
  }
  return null;
}

/** The `.mcp.json` entry for a registered folder (Claude Code, structured arguments). */
export const mcpEntry = ({ node, connector, folder }) => ({ command: node, args: [connector, 'mcp', folder] });

/**
 * The Codex permission table (docs/checkout.md §6): a Claude Code permission mode → ask, standard or auto. A copy of
 * codexPermission in the hub (server/src/checkout/fields.ts); a test keeps them equal.
 */
export function codexPermission(p) {
  switch (p) {
    case 'plan': return { level: 'ask', approval_policy: 'on-request', sandbox_mode: 'read-only' };
    case 'default': case 'acceptEdits': return { level: 'standard', approval_policy: 'on-request', sandbox_mode: 'workspace-write' };
    case 'bypassPermissions': return { level: 'auto', approval_policy: 'never', sandbox_mode: 'workspace-write' };
    default: return null;
  }
}

/**
 * The [mcp_servers.conclave] table for a Codex project config (.codex/config.toml). With approveTools (the auto
 * level, approval policy never) the server's tools are approved up front: default_tools_approval_mode = "approve".
 */
export function codexToml({ node, connector, folder, approveTools = false }) {
  const q = (s) => JSON.stringify(String(s).replace(/\\/g, '/')); // TOML basic string; forward slashes work on every platform
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${q(node)}\nargs = [${[connector, 'mcp', folder].map(q).join(', ')}]\nstartup_timeout_sec = ${STARTUP_TIMEOUT_SEC}\ntool_timeout_sec = ${TOOL_TIMEOUT_SEC}\n${approveTools ? 'default_tools_approval_mode = "approve"\n' : ''}`;
}

/**
 * What the folder's `.mcp.json` says about the connector's entry: `ok`, `missing`, `foreign` (an entry of that name
 * that is not ours: left alone), or `stale` (ours, but Node or the connector file it names does not exist any more, or
 * the folder argument is not this folder).
 */
export function entryState(folder, { node, connector }) {
  const j = readJson(join(folder, '.mcp.json'), {});
  if (!j || typeof j !== 'object') return 'foreign';
  const e = j.mcpServers?.[SERVER_NAME];
  if (!e) return 'missing';
  if (!Array.isArray(e.args) || e.args.length !== 3 || e.args[1] !== 'mcp' || typeof e.command !== 'string') return 'foreign';
  if (!isAbsolute(e.command) || !isAbsolute(String(e.args[0]))) return 'stale';
  if (!existsSync(e.command) || !existsSync(e.args[0])) return 'stale';
  if (e.command !== node || e.args[0] !== connector || e.args[2] !== folder) return 'stale';
  return 'ok';
}

/** Sets the connector's entry in `.mcp.json`, keeping every other server. Returns `{before, installed}` for the manifest. */
export function writeMcpEntry(folder, entry) {
  const p = join(folder, '.mcp.json');
  let j = readJson(p, {});
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('.mcp.json is not a JSON object; not touching it');
  const before = j.mcpServers?.[SERVER_NAME] ?? null;
  j.mcpServers = { ...(j.mcpServers ?? {}), [SERVER_NAME]: entry };
  atomicWrite(p, JSON.stringify(j, null, 2) + '\n');
  return { before, installed: entry };
}

/** Approves the server in the folder's own `.claude/settings.json`, without a prompt. One entry in the list; the rest stays. */
export function approveInSettings(folder) {
  const p = join(folder, '.claude', 'settings.json');
  const j = readJson(p, {});
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('.claude/settings.json is not a JSON object; not touching it');
  const list = Array.isArray(j.enabledMcpjsonServers) ? j.enabledMcpjsonServers : [];
  const before = list.includes(SERVER_NAME);
  if (!before) atomicWrite(p, JSON.stringify({ ...j, enabledMcpjsonServers: [...list, SERVER_NAME] }, null, 2) + '\n');
  return { before, installed: true };
}

/** The events the connector's prompt hook is registered for. Never Stop: printed context at Stop makes Claude Code continue the turn (proof 1). */
export const HOOK_EVENTS = ['UserPromptSubmit', 'SessionStart'];
/**
 * The events of the silent context hook (`conclave context-hook`, design 3c and 3g review change 3): it reads a
 * hand-opened chat's context numbers and prints nothing, ever, so it may run at Stop.
 */
export const CONTEXT_HOOK_EVENTS = ['Stop', 'PostToolUse'];
export const HOOK_TIMEOUT_SEC = 5;
const HOOK_MARK = ' hook --folder ';
const CONTEXT_MARK = ' context-hook --folder ';

/**
 * The hook's command line: Node and the connector by absolute path, the folder as its own argument. Claude Code runs it
 * through a shell, so each path is double-quoted with forward slashes (they work on every platform, and a Windows
 * backslash would be eaten by Git Bash). A path with a quote, `$`, a backtick or a line break is refused, never escaped.
 */
const quoted = (s) => {
  const t = String(s).replace(/\\/g, '/');
  if (/["$`\r\n%]/.test(t)) throw new Error('a path with a quote, $, backtick, % or line break cannot go in a hook command');
  return `"${t}"`;
};
export function hookCommand({ node, connector, folder }) {
  return `${quoted(node)} ${quoted(connector)}${HOOK_MARK}${quoted(folder)}`;
}
/** The silent context hook's command line, built the same way. */
export function contextHookCommand({ node, connector, folder }) {
  return `${quoted(node)} ${quoted(connector)}${CONTEXT_MARK}${quoted(folder)}`;
}

const isCmd = (h, mark) => h && typeof h === 'object' && h.type === 'command' && typeof h.command === 'string' && h.command.includes(`conclave.mjs"${mark}`);
const isOurs = (h) => isCmd(h, HOOK_MARK);
const isOurContext = (h) => isCmd(h, CONTEXT_MARK);

function setAt(hooks, events, ours, mine) {
  for (const ev of events) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev].map((g) => ({ ...g, hooks: Array.isArray(g?.hooks) ? [...g.hooks] : g?.hooks })) : [];
    let done = false;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const i = g.hooks.findIndex(mine);
      if (i >= 0) { g.hooks[i] = ours; done = true; }
    }
    if (!done) groups.push({ hooks: [ours] });
    hooks[ev] = groups;
  }
}

/**
 * Sets the connector's hooks in the folder's own `.claude/settings.json`, one entry at a time: the prompt hook at
 * HOOK_EVENTS and the silent context hook at CONTEXT_HOOK_EVENTS. Any other hook, setting and entry stays as it was, and
 * an earlier entry of ours is replaced in place. Never the user's own settings. Returns `{before, installed}` (the `hooks`
 * value before and after) for the manifest.
 */
export function writeHookEntries(folder, { node, connector }) {
  const p = join(folder, '.claude', 'settings.json');
  const j = readJson(p, {});
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('.claude/settings.json is not a JSON object; not touching it');
  const before = j.hooks ?? null;
  if (before !== null && (typeof before !== 'object' || Array.isArray(before))) throw new Error('hooks in .claude/settings.json is not an object; not touching it');
  const hooks = { ...(before ?? {}) };
  setAt(hooks, HOOK_EVENTS, { type: 'command', command: hookCommand({ node, connector, folder }), timeout: HOOK_TIMEOUT_SEC }, isOurs);
  setAt(hooks, CONTEXT_HOOK_EVENTS, { type: 'command', command: contextHookCommand({ node, connector, folder }), timeout: HOOK_TIMEOUT_SEC }, isOurContext);
  if (JSON.stringify(hooks) !== JSON.stringify(before)) atomicWrite(p, JSON.stringify({ ...j, hooks }, null, 2) + '\n');
  return { before, installed: hooks };
}

const hooksOf = (folder) => JSON.parse(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8')).hooks;
const hasAt = (hooks, events, mine) => events.every((ev) => Array.isArray(hooks?.[ev]) && hooks[ev].some((g) => Array.isArray(g?.hooks) && g.hooks.some(mine)));

/** True if the folder's settings hold the connector's prompt hook at every event it needs (the context hook is checked apart). */
export function hasHookEntries(folder) {
  try { return hasAt(hooksOf(folder), HOOK_EVENTS, isOurs); } catch { return false; }
}

/** True if the folder's settings hold the silent context hook at both its events. */
export function hasContextHookEntries(folder) {
  try { return hasAt(hooksOf(folder), CONTEXT_HOOK_EVENTS, isOurContext); } catch { return false; }
}

/**
 * Gate G1 (proofs.md, proof 1): true if the folder's settings register a hook of ours where it could print into a turn:
 * the prompt hook (which prints context) at any event outside HOOK_EVENTS, above all Stop, or the silent context hook at
 * any event outside CONTEXT_HOOK_EVENTS. The context hook itself prints nothing; a test runs it to prove that.
 */
export function hasStrayHook(folder) {
  try {
    return Object.entries(hooksOf(folder) ?? {}).some(([ev, gs]) => Array.isArray(gs) && gs.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) =>
      (isOurs(h) && !HOOK_EVENTS.includes(ev)) || (isOurContext(h) && !CONTEXT_HOOK_EVENTS.includes(ev)))));
  } catch { return false; }
}

/** True if the folder's settings approve the server. */
export function isApproved(folder) {
  try { const j = JSON.parse(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8')); return Array.isArray(j.enabledMcpjsonServers) && j.enabledMcpjsonServers.includes(SERVER_NAME); } catch { return false; }
}
