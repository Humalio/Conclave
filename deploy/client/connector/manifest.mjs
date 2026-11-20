/**
 * The manifest: what the connector created, as entries of FIXED KINDS at FIXED PLACES (docs/connector.md, review-v2 §1
 * point 8). For shared config it keeps the value before and the value the connector installed, so a later removal can
 * undo an entry only while it still holds the installed value, and keep (and list) anything the user edited.
 *
 * `record` refuses an entry whose kind is unknown, whose target is not the kind's fixed file in a registered folder
 * (or in the connector's own folder), or whose path crosses a symbolic link, junction or other reparse point. The removal
 * itself is the uninstall task's; this module gives it the record and the checks.
 */
import { join, relative, sep, isAbsolute } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { readJson, atomicWrite, canonicalFolder, pathKey } from './paths.mjs';
import { SERVER_NAME } from './entries.mjs';

export const manifestPath = (home) => join(home, 'manifest.json');

/** kind → where its target must be: `in` is the root ('folder' = a registered agent folder, 'home' = the connector's folder, 'claude' = ~/.claude.json). */
export const KINDS = {
  mcp_entry: { in: 'folder', file: '.mcp.json', pointer: `mcpServers.${SERVER_NAME}` },
  mcp_approval: { in: 'folder', file: '.claude/settings.json', pointer: 'enabledMcpjsonServers' },
  codex_entry: { in: 'folder', file: '.codex/config.toml', pointer: `mcp_servers.${SERVER_NAME}` },
  hook: { in: 'folder', file: '.claude/settings.json', pointer: 'hooks' },
  git_exclude: { in: 'folder', file: '.git/info/exclude', pointer: null },
  trust_flag: { in: 'claude', file: null, pointer: /^projects\.[^\r\n]+\.hasTrustDialogAccepted$/ },
  key_section: { in: 'home', file: 'keys.json', pointer: /^hubs\.[^\r\n]+$/ },
  registry_entry: { in: 'home', file: 'registry.json', pointer: /^folders\.[^\r\n]+$/ },
  token_cache: { in: 'home', file: 'tokens', pointer: null },
  portable_git: { in: 'home', file: 'git', pointer: null },
  launcher: { in: 'home', file: 'conclave.mjs', pointer: null },
  app_build: { in: 'home', file: 'app', pointer: null },
  // The logon entry: its one place per platform comes from service.mjs (ctx.serviceTargets), never from the entry.
  service_entry: { in: 'service', file: null, pointer: null },
  // Setup (docs/onboarding.md, "Setting up the folders"): the agent's instructions file it wrote, and, with the private
  // git on Windows, the one user environment variable Claude Code reads at start.
  instructions: { in: 'folder', file: 'CLAUDE.md', pointer: null },
  codex_instructions: { in: 'folder', file: 'AGENTS.md', pointer: null },
  // Restore: a Codex agent's role file (role.mjs). `installed` keeps its text as well, so `conclave repair` can write it back.
  codex_role: { in: 'folder', file: 'AGENTS.override.md', pointer: null },
  user_env: { in: 'user_env', file: null, pointer: 'CLAUDE_CODE_GIT_BASH_PATH' },
};
/** The one place a user_env entry may name: the user's own environment in the registry (no admin rights). */
export const USER_ENV_TARGET = 'HKCU\\Environment';

/** True if no part of `target` below `root` is a link or reparse point, and `root` is its own real path. */
export function noRedirect(root, target) {
  let real;
  try { real = realpathSync.native(root); } catch { return false; }
  if (pathKey(real) !== pathKey(root)) return false;
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  let cur = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') break; return false; }
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

/**
 * Checks one entry: `{ok: true}` or `{ok: false, reason}`. `ctx` carries `home`, `claudeJson` (the path of
 * ~/.claude.json) and `folders` (canonical paths of registered folders).
 */
export function validateEntry(e, ctx) {
  const k = e && Object.hasOwn(KINDS, e.kind) ? KINDS[e.kind] : null;
  if (!k) return { ok: false, reason: 'unknown_kind' };
  if (k.in === 'user_env') {
    if (e.target !== USER_ENV_TARGET) return { ok: false, reason: 'wrong_place' };
    if (e.pointer !== k.pointer) return { ok: false, reason: 'wrong_pointer' };
    return 'installed' in e ? { ok: true } : { ok: false, reason: 'no_installed_value' };
  }
  if (k.in === 'service') {
    if (typeof e.target !== 'string' || !(ctx.serviceTargets ?? []).includes(e.target)) return { ok: false, reason: 'wrong_place' };
    if ((e.pointer ?? null) !== null) return { ok: false, reason: 'wrong_pointer' };
    return 'installed' in e ? { ok: true } : { ok: false, reason: 'no_installed_value' };
  }
  if (typeof e.target !== 'string' || !isAbsolute(e.target)) return { ok: false, reason: 'target_not_absolute' };
  if (k.in === 'claude') {
    if (pathKey(e.target) !== pathKey(ctx.claudeJson)) return { ok: false, reason: 'wrong_place' };
  } else {
    const root = k.in === 'home' ? ctx.home : (canonicalFolder(e.folder ?? '') ?? null);
    if (!root) return { ok: false, reason: 'folder_missing' };
    if (k.in === 'folder' && !ctx.folders.some((f) => pathKey(f) === pathKey(root))) return { ok: false, reason: 'folder_not_registered' };
    if (pathKey(e.target) !== pathKey(join(root, k.file))) return { ok: false, reason: 'wrong_place' };
    if (!noRedirect(root, e.target)) return { ok: false, reason: 'redirected_path' };
  }
  const p = e.pointer ?? null;
  if (k.pointer instanceof RegExp ? typeof p !== 'string' || !k.pointer.test(p) : p !== k.pointer) return { ok: false, reason: 'wrong_pointer' };
  if (!('installed' in e)) return { ok: false, reason: 'no_installed_value' };
  return { ok: true };
}

/** Records an entry (replacing an earlier one at the same place, but keeping the ORIGINAL value-before). Throws if invalid. */
export function record(home, entry, ctx) {
  const v = validateEntry(entry, { ...ctx, home });
  if (!v.ok) throw new Error(`manifest entry refused: ${v.reason}`);
  const m = readJson(manifestPath(home), { version: 1, entries: [] });
  if (!m || m.version !== 1 || !Array.isArray(m.entries)) throw new Error('the manifest cannot be read');
  const same = (x) => x.kind === entry.kind && pathKey(x.target) === pathKey(entry.target) && (x.pointer ?? null) === (entry.pointer ?? null);
  const old = m.entries.find(same);
  const next = { kind: entry.kind, target: entry.target, folder: entry.folder ?? null, pointer: entry.pointer ?? null, before: old ? old.before : (entry.before ?? null), installed: entry.installed, recorded_at: new Date().toISOString() };
  m.entries = [...m.entries.filter((x) => !same(x)), next];
  atomicWrite(manifestPath(home), JSON.stringify(m, null, 2) + '\n');
  return next;
}

/** Drops the entry of a kind at a place (the service's own remove). Returns whether one was there. */
export function forget(home, kind, target) {
  const m = readJson(manifestPath(home), { version: 1, entries: [] });
  if (!m || !Array.isArray(m.entries)) return false;
  const left = m.entries.filter((x) => !(x.kind === kind && pathKey(x.target) === pathKey(target)));
  if (left.length === m.entries.length) return false;
  atomicWrite(manifestPath(home), JSON.stringify({ ...m, entries: left }, null, 2) + '\n');
  return true;
}

export const entries = (home) => readJson(manifestPath(home), { version: 1, entries: [] })?.entries ?? [];

/** What a later removal may do with an entry, given the value there now (`undefined` if gone): `undo`, `keep_edited` or `already_gone`. */
export function undoDecision(entry, current) {
  if (current === undefined) return 'already_gone';
  return isDeepStrictEqual(current, entry.installed) ? 'undo' : 'keep_edited';
}
