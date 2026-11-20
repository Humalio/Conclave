/**
 * The connector's own record of each registered agent folder: registry.json (docs/connector.md).
 *
 * Identity comes from here and from nowhere else: `conclave mcp <folder>` asks which hub and agent this folder is
 * bound to, never the folder's .mcp.json, .agent-hub.json or checkout config. A folder is bound by its canonical path
 * and its filesystem identity, so a copy, a clone or a moved folder gets no identity (review-v2 §1 point 3).
 * The record also keeps a hash of the folder's agent settings, so a later change (a tracked hook, an MCP entry, new
 * instructions) is noticed before folder trust is ever re-applied (trust.mjs).
 */
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { canonicalFolder, folderIdentity, pathKey, readState, writeState, withLock, sha256 } from './paths.mjs';
import { HUB_ID_RE, LABEL_RE, SHA_RE, normalizeOrigin } from './keyfile.mjs';

export const registryPath = (home) => join(home, 'registry.json');

/** The files that decide how an agent in the folder behaves; their hash is what "unchanged since registered" means. */
export const CONFIG_FILES = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', 'CLAUDE.md', 'AGENTS.md', 'AGENTS.override.md'];

/** One hash over the folder's agent settings (path and content of each file that exists). The connector's own entries are part of it, so re-record after the connector writes them. */
export function configHash(folder) {
  const parts = [];
  for (const f of CONFIG_FILES) {
    const p = join(folder, f);
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p); } catch { text = Buffer.from('unreadable'); }
    parts.push(`${f}\0${sha256(text)}`);
  }
  return sha256(parts.join('\n'));
}

/** Writes the registry as two flushed copies (paths.mjs `writeState`). Callers hold its lock (`locked`). */
const save = (home, reg) => writeState(registryPath(home), JSON.stringify(reg, null, 2) + '\n');
/** Runs one read-change-write of the registry under its lock. */
const locked = (home, fn) => withLock(registryPath(home), fn);

function load(home) {
  const r = readState(registryPath(home), { version: 1, folders: {} });
  if (!r || r.version !== 1 || typeof r.folders !== 'object' || !r.folders || Array.isArray(r.folders)) throw new Error('the registry file cannot be read');
  return r;
}

const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** A team as the hub gave it, `{id, name?}` with a plain one-line name of at most 80 characters; or null. */
export function teamOf(team) {
  if (!team || typeof team !== 'object' || !TEAM_ID_RE.test(String(team.id ?? ''))) return null;
  const name = typeof team.name === 'string' ? team.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
  return { id: team.id, ...(name ? { name } : {}) };
}

/** Binds a folder to a hub and an agent, recording its identity and its settings hash. Returns the stored binding. */
export function bindFolder(home, folder, opts) { return locked(home, () => bindFolderNow(home, folder, opts)); }
function bindFolderNow(home, folder, { hubId, caSha256, agent, held = false, provider = null, team = null, origin = null }) {
  if (!HUB_ID_RE.test(String(hubId)) || !SHA_RE.test(String(caSha256)) || !LABEL_RE.test(String(agent))) throw new Error('invalid hub id, CA fingerprint or agent label');
  const canon = canonicalFolder(folder);
  if (!canon) throw new Error('the folder does not exist');
  const reg = load(home);
  const old = reg.folders[pathKey(canon)];
  // `provider: 'codex'` marks a Codex agent's folder: its local server offers the commit tool and check looks at its role file.
  const b = { path: canon, identity: folderIdentity(canon), hub_id: hubId, ca_sha256: caSha256, agent, ...(provider === 'codex' ? { provider: 'codex' } : {}), config_sha256: held ? 'held' : configHash(canon), recorded_at: new Date().toISOString() };
  // The team the agent belongs to, as the hub named it at pickup or restore: its id and name, never anything else. The
  // local screen lists these teams to bind one to an account profile (profiles.mjs).
  const t = teamOf(team);
  if (t) { b.team = t.id; if (t.name) b.team_name = t.name; }
  // The hub's origin, so a session pins it from here and never from what the broker answers (docs/connector.md).
  const o = normalizeOrigin(origin) ?? (old && old.hub_id === hubId && old.ca_sha256 === caSha256 ? normalizeOrigin(old.origin) : null);
  if (o) b.origin = o;
  // A profile or team binding (profiles.mjs) survives a re-registration that names no team.
  if (old?.profile) b.profile = old.profile;
  if (!t && old?.team) { b.team = old.team; if (old.team_name) b.team_name = old.team_name; }
  reg.folders[pathKey(canon)] = b;
  save(home, reg);
  return b;
}

/** Records the folder's settings hash again after the connector itself changed them. */
export function rerecord(home, folder) { return locked(home, () => rerecordNow(home, folder)); }
function rerecordNow(home, folder) {
  const canon = canonicalFolder(folder);
  const reg = load(home);
  const b = canon && reg.folders[pathKey(canon)];
  if (!b) return false;
  b.config_sha256 = configHash(canon);
  save(home, reg);
  return true;
}

export function unbindFolder(home, folder) { return locked(home, () => unbindNow(home, folder)); }
function unbindNow(home, folder) {
  const canon = canonicalFolder(folder);
  const reg = load(home);
  if (!canon || !reg.folders[pathKey(canon)]) return false;
  delete reg.folders[pathKey(canon)];
  save(home, reg);
  return true;
}

/** Every folder bound to a hub (disconnect and migration use it to find what to clean). */
/** Every binding in the registry. */
export const allBindings = (home) => Object.values(load(home).folders);

export function foldersOfHub(home, hubId, caSha256) {
  return Object.values(load(home).folders).filter((b) => b.hub_id === hubId && b.ca_sha256 === caSha256);
}

/**
 * The binding of a folder: `{ok: true, binding, folder}`, or `{ok: false, reason}` with `not_registered` (no record for
 * this canonical path: a copy, a clone or a moved folder) or `identity_changed` (the path is recorded but the folder
 * is not the same one any more: deleted and recreated, or replaced).
 */
export function resolveFolder(home, folderArg) {
  const canon = canonicalFolder(folderArg);
  if (!canon) return { ok: false, reason: 'not_registered' };
  let reg;
  try { reg = load(home); } catch { return { ok: false, reason: 'not_registered' }; }
  const b = reg.folders[pathKey(canon)];
  if (!b) return { ok: false, reason: 'not_registered' };
  const now = folderIdentity(canon);
  if (b.identity !== null && now !== b.identity) return { ok: false, reason: 'identity_changed' };
  return { ok: true, binding: b, folder: canon };
}
