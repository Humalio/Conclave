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
import { join, isAbsolute, delimiter } from 'node:path';
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

/** The `.mcp.json` entry for a registered folder (Claude Code, structured arguments). */
export const mcpEntry = ({ node, connector, folder }) => ({ command: node, args: [connector, 'mcp', folder] });

/** The `[mcp_servers.conclave]` table for a Codex project config (`.codex/config.toml`). */
export function codexToml({ node, connector, folder }) {
  const q = (s) => JSON.stringify(String(s).replace(/\\/g, '/')); // TOML basic string; forward slashes work on every platform
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${q(node)}\nargs = [${[connector, 'mcp', folder].map(q).join(', ')}]\nstartup_timeout_sec = ${STARTUP_TIMEOUT_SEC}\ntool_timeout_sec = ${TOOL_TIMEOUT_SEC}\n`;
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

/** The events the connector's hook is registered for. Never Stop: printed context at Stop makes Claude Code continue the turn. */
export const HOOK_EVENTS = ['UserPromptSubmit', 'SessionStart'];
export const HOOK_TIMEOUT_SEC = 5;
const HOOK_MARK = ' hook --folder ';

/**
 * The hook's command line: Node and the connector by absolute path, the folder as its own argument. Claude Code runs it
 * through a shell, so each path is double-quoted with forward slashes (they work on every platform, and a Windows
 * backslash would be eaten by Git Bash). A path with a quote, `$`, a backtick or a line break is refused, never escaped.
 */
export function hookCommand({ node, connector, folder }) {
  const q = (s) => {
    const t = String(s).replace(/\\/g, '/');
    if (/["$`\r\n%]/.test(t)) throw new Error('a path with a quote, $, backtick, % or line break cannot go in a hook command');
    return `"${t}"`;
  };
  return `${q(node)} ${q(connector)}${HOOK_MARK}${q(folder)}`;
}

const isOurs = (h) => h && typeof h === 'object' && h.type === 'command' && typeof h.command === 'string' && h.command.includes(`conclave.mjs"${HOOK_MARK}`);

/**
 * Sets the connector's hook at the events above in the folder's own `.claude/settings.json`, one entry at a time: any
 * other hook, setting and entry stays as it was, and an earlier entry of ours is replaced in place. Never the user's own
 * settings. Returns `{before, installed}` (the `hooks` value before and after) for the manifest.
 */
export function writeHookEntries(folder, { node, connector }) {
  const p = join(folder, '.claude', 'settings.json');
  const j = readJson(p, {});
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('.claude/settings.json is not a JSON object; not touching it');
  const before = j.hooks ?? null;
  if (before !== null && (typeof before !== 'object' || Array.isArray(before))) throw new Error('hooks in .claude/settings.json is not an object; not touching it');
  const command = hookCommand({ node, connector, folder });
  const ours = { type: 'command', command, timeout: HOOK_TIMEOUT_SEC };
  const hooks = { ...(before ?? {}) };
  for (const ev of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev].map((g) => ({ ...g, hooks: Array.isArray(g?.hooks) ? [...g.hooks] : g?.hooks })) : [];
    let done = false;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const i = g.hooks.findIndex(isOurs);
      if (i >= 0) { g.hooks[i] = ours; done = true; }
    }
    if (!done) groups.push({ hooks: [ours] });
    hooks[ev] = groups;
  }
  if (JSON.stringify(hooks) !== JSON.stringify(before)) atomicWrite(p, JSON.stringify({ ...j, hooks }, null, 2) + '\n');
  return { before, installed: hooks };
}

/** True if the folder's settings hold the connector's hook at every event it needs. */
export function hasHookEntries(folder) {
  try {
    const j = JSON.parse(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8'));
    return HOOK_EVENTS.every((ev) => Array.isArray(j.hooks?.[ev]) && j.hooks[ev].some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs)));
  } catch { return false; }
}

/** True if the folder's settings register ANY hook of ours at an event outside HOOK_EVENTS (the build gate's check). */
export function hasStrayHook(folder) {
  try {
    const j = JSON.parse(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8'));
    return Object.entries(j.hooks ?? {}).some(([ev, gs]) => !HOOK_EVENTS.includes(ev) && Array.isArray(gs) && gs.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOurs)));
  } catch { return false; }
}

/** True if the folder's settings approve the server. */
export function isApproved(folder) {
  try { const j = JSON.parse(readFileSync(join(folder, '.claude', 'settings.json'), 'utf8')); return Array.isArray(j.enabledMcpjsonServers) && j.enabledMcpjsonServers.includes(SERVER_NAME); } catch { return false; }
}
