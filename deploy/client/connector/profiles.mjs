/**
 * Account profiles (docs/connector.md "Account profiles"; design 3d, review changes 11 to 13). Several Claude or Codex
 * accounts on one PC: the PC user names local profiles ("work", "personal"); each is its own Claude config folder
 * (CLAUDE_CONFIG_DIR) or Codex home (CODEX_HOME), logged in once by the person. Profiles live in profiles.json in the
 * connector's own folder. An agent folder (or a team) is bound to a profile in registry.json.
 *
 * What the connector does with a profile, and nothing else:
 *   - sets ONE variable for a run it starts (`runEnv`); it never reads a profile's login files;
 *   - at binding, writes folder trust into that profile's own .claude.json (or config.toml for Codex), the only write
 *     into a profile;
 *   - reports the profile's NAME for an agent, unless the PC user hid it. A name passes the leak guard's tests here
 *     too: nothing email-shaped or key-shaped. Never a path, an email or a credential.
 */
import { join, isAbsolute } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { readJson, atomicWrite, canonicalFolder, pathKey, WIN } from './paths.mjs';
import { registryPath, resolveFolder, configHash } from './registry.mjs';
import { grantTrust } from './trust.mjs';

export const profilesPath = (home) => join(home, 'profiles.json');
/** What a name may be: a plain label, at most 40 characters, no @ and no dots, so never an address. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
export const MAX_PROFILES = 20;
/** The one variable each kind sets. */
export const VARIABLE = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

// The leak guard's key shapes (server/src/guard/leakGuard.ts): ah, a kind, 12 and 32 base-32 characters, separators allowed.
const SEP = '[\\s_\\-.:|/\\\\]{0,4}';
const KEY_SHAPE = new RegExp(`ah${SEP}(?:app|ses|set|brg|dsc)${SEP}[a-z2-7]{12}${SEP}[a-z2-7]{32}|ah${SEP}tok${SEP}[a-z2-7]{40}`, 'i');
const KEY_COMPACT = /ah(?:app|ses|set|brg|dsc)[a-z2-7]{44}|ahtok[a-z2-7]{40}/;

/** `{ok: true, name}` or `{ok: false, reason}` with `invalid_name`, `email_shaped` or `key_shaped`. */
export function checkName(raw) {
  const name = String(raw ?? '').trim();
  if (/@/.test(name) || /\b[\w-]+\.[a-z]{2,}\b/i.test(name)) return { ok: false, reason: 'email_shaped' };
  if (KEY_SHAPE.test(name) || KEY_COMPACT.test(name.toLowerCase().replace(/[^a-z0-9]/g, ''))) return { ok: false, reason: 'key_shaped' };
  if (!NAME_RE.test(name)) return { ok: false, reason: 'invalid_name' };
  return { ok: true, name };
}

function loadProfiles(home) {
  const j = readJson(profilesPath(home), null);
  return j && j.version === 1 && j.profiles && typeof j.profiles === 'object' && !Array.isArray(j.profiles) ? j : { version: 1, profiles: {} };
}
const saveProfiles = (home, j) => atomicWrite(profilesPath(home), JSON.stringify(j, null, 2) + '\n');

/** Every profile as `{name, kind, dir, hidden}`. */
export function listProfiles(home) {
  return Object.entries(loadProfiles(home).profiles).map(([name, p]) => ({ name, kind: p.kind, dir: p.dir, hidden: p.hidden === true }));
}
export const getProfile = (home, name) => listProfiles(home).find((p) => p.name === name) ?? null;

/** Adds a profile: `kind` is 'claude' or 'codex', `dir` an absolute folder (created empty if missing; the person logs in there). */
export function addProfile(home, rawName, { kind, dir }) {
  const n = checkName(rawName);
  if (!n.ok) return n;
  if (!Object.hasOwn(VARIABLE, kind)) return { ok: false, reason: 'invalid_kind' };
  if (typeof dir !== 'string' || !isAbsolute(dir)) return { ok: false, reason: 'dir_not_absolute' };
  const j = loadProfiles(home);
  if (j.profiles[n.name]) return { ok: false, reason: 'exists' };
  if (Object.keys(j.profiles).length >= MAX_PROFILES) return { ok: false, reason: 'too_many' };
  try { mkdirSync(dir, { recursive: true }); } catch { return { ok: false, reason: 'dir_unusable' }; }
  const canon = canonicalFolder(dir);
  if (!canon) return { ok: false, reason: 'dir_unusable' };
  const own = canonicalFolder(home);
  if (own && (pathKey(canon) === pathKey(own) || pathKey(canon).startsWith(pathKey(own) + '/'))) return { ok: false, reason: 'dir_is_connector_folder' };
  j.profiles[n.name] = { kind, dir: canon, hidden: false };
  saveProfiles(home, j);
  return { ok: true, profile: getProfile(home, n.name) };
}

/** The PC user's "Profile hidden" switch: while hidden, the hub is not told the name. */
export function setHidden(home, name, hidden) {
  const j = loadProfiles(home);
  if (!j.profiles[name]) return false;
  j.profiles[name].hidden = !!hidden;
  saveProfiles(home, j);
  return true;
}

function loadRegistry(home) {
  const r = readJson(registryPath(home), { version: 1, folders: {} });
  if (!r || r.version !== 1 || typeof r.folders !== 'object' || !r.folders || Array.isArray(r.folders)) throw new Error('the registry file cannot be read');
  return r;
}
const saveRegistry = (home, r) => atomicWrite(registryPath(home), JSON.stringify(r, null, 2) + '\n');

/** Removes a profile and every binding to it (the profile's folder itself is never touched). */
export function removeProfile(home, name) {
  const j = loadProfiles(home);
  if (!j.profiles[name]) return false;
  delete j.profiles[name];
  saveProfiles(home, j);
  try {
    const r = loadRegistry(home);
    for (const b of Object.values(r.folders)) if (b.profile === name) delete b.profile;
    for (const t of Object.values(r.teams ?? {})) if (t.profile === name) delete t.profile;
    saveRegistry(home, r);
  } catch { /* no registry yet */ }
  return true;
}

const tomlKey = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// A `[projects.<key>]` header in any form TOML allows: Codex itself writes a literal string ('C:\Workspace\x') on Windows,
// this file writes a basic one ("C:\\Workspace\\x"). Returns the folder the header names, or null.
const PROJECT_HEADER = /^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/;
const unescapeBasic = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => (e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[e] ?? e)));
export function projectHeaderFolder(line) {
  const m = PROJECT_HEADER.exec(line);
  return m ? (m[1] !== undefined ? unescapeBasic(m[1]) : m[2]) : null;
}
/**
 * Codex trust in a CODEX_HOME's config.toml: `[projects."<folder>"]` with `trust_level = "trusted"`. A table for the folder
 * that Codex wrote itself (any quoting, on Windows any case or slash direction) is the same table: never a second one,
 * which would make the file invalid TOML. A table that already has a trust_level is left alone (the user's choice wins); a
 * missing one is added. Returns `{wrote}`.
 */
export function grantCodexTrust(configToml, folder, { win = WIN } = {}) {
  let text = '';
  try { text = readFileSync(configToml, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const header = `[projects.${tomlKey(folder)}]`;
  const lines = text.split(/\r?\n/);
  const want = pathKey(folder, win);
  const at = lines.findIndex((l) => { const f = projectHeaderFolder(l); return f !== null && pathKey(f, win) === want; });
  if (at === -1) {
    atomicWrite(configToml, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${header}\ntrust_level = "trusted"\n`, false);
    return { wrote: true };
  }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break; }
  if (lines.slice(at + 1, end).some((l) => /^\s*trust_level\s*=/.test(l))) return { wrote: false };
  lines.splice(at + 1, 0, 'trust_level = "trusted"');
  atomicWrite(configToml, lines.join('\n'), false);
  return { wrote: true };
}

/** Writes folder trust for one agent folder into the profile's own file, and nowhere else. */
export function writeProfileTrust(profile, folder, { win = WIN } = {}) {
  if (profile.kind === 'codex') return grantCodexTrust(join(profile.dir, 'config.toml'), folder, { win });
  return grantTrust(join(profile.dir, '.claude.json'), folder, { win });
}

function needProfile(home, name, binding) {
  const p = getProfile(home, name);
  if (!p) return { ok: false, reason: 'no_such_profile' };
  const folderKind = binding?.provider === 'codex' ? 'codex' : 'claude';
  if (p.kind !== folderKind) return { ok: false, reason: 'wrong_kind' };
  return { ok: true, profile: p };
}

/** Trust is written only for a folder whose agent settings are unchanged since they were recorded (docs/connector.md, Folder trust). */
const unchanged = (b, folder) => b.config_sha256 === configHash(folder);

const entryOf = (r, folder) => Object.values(r.folders).find((x) => pathKey(x.path) === pathKey(folder));

/** Binds a registered agent folder to a profile (or `null` to unbind), and writes folder trust into that profile. */
export function bindAgent(home, folderArg, profileName, { win = WIN } = {}) {
  const f = resolveFolder(home, folderArg);
  if (!f.ok) return { ok: false, reason: f.reason };
  const r = loadRegistry(home);
  const b = entryOf(r, f.folder);
  if (profileName === null) { delete b.profile; saveRegistry(home, r); return { ok: true, profile: null }; }
  const p = needProfile(home, profileName, b);
  if (!p.ok) return p;
  if (!unchanged(b, f.folder)) return { ok: false, reason: 'config_changed' };
  const t = writeProfileTrust(p.profile, f.folder, { win });
  b.profile = profileName;
  saveRegistry(home, r);
  return { ok: true, profile: profileName, trust_written: t.wrote };
}

/** Binds a team to a profile: the registered folders given are its agents (each gets trust in the profile). */
export function bindTeam(home, teamId, profileName, folderArgs, { win = WIN } = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(teamId))) return { ok: false, reason: 'invalid_team' };
  const r = loadRegistry(home);
  const p = getProfile(home, profileName);
  if (!p) return { ok: false, reason: 'no_such_profile' };
  const bs = [];
  for (const fa of folderArgs) {
    const f = resolveFolder(home, fa);
    if (!f.ok) return { ok: false, reason: f.reason };
    const b = entryOf(r, f.folder);
    if (!needProfile(home, profileName, b).ok) return { ok: false, reason: 'wrong_kind' };
    if (!unchanged(b, f.folder)) return { ok: false, reason: 'config_changed' };
    bs.push([b, f.folder]);
  }
  for (const [b, folder] of bs) { writeProfileTrust(p, folder, { win }); b.team = teamId; }
  r.teams = { ...(r.teams ?? {}), [teamId]: { profile: profileName } };
  saveRegistry(home, r);
  return { ok: true, folders: bs.length };
}

/**
 * The teams of the folders registered on this PC, from the registry (the team id and name were recorded at pickup or
 * restore): `[{id, name, profile, folders: [{path, agent, kind}]}]`, by name. `bindings` limits it to those folders (one hub's, say).
 */
export function listTeams(home, bindings = null) {
  let r; try { r = loadRegistry(home); } catch { return []; }
  const teams = new Map();
  for (const b of bindings ?? Object.values(r.folders)) {
    if (!b?.team) continue;
    const t = teams.get(b.team) ?? { id: b.team, name: null, profile: r.teams?.[b.team]?.profile ?? null, folders: [] };
    t.name ??= b.team_name ?? null;
    t.folders.push({ path: b.path, agent: b.agent, kind: b.provider === 'codex' ? 'codex' : 'claude' });
    teams.set(b.team, t);
  }
  return [...teams.values()].sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
}

/**
 * The screen's "Bind team": binds every registered folder of the team that runs the profile's program (a Claude profile
 * cannot log a Codex agent in, so those keep their own binding or the default account and are counted in `skipped`).
 * The same changed-folder check as one agent: one changed folder refuses the whole bind with `config_changed` and writes
 * nothing. `null` unbinds the team. An agent's own binding still wins over the team's.
 */
export function bindRegisteredTeam(home, teamId, profileName, { win = WIN } = {}) {
  const t = listTeams(home).find((x) => x.id === teamId);
  if (!t) return { ok: false, reason: 'no_such_team' };
  if (profileName === null) {
    const r = loadRegistry(home);
    if (r.teams?.[teamId]) { delete r.teams[teamId]; saveRegistry(home, r); }
    return { ok: true, profile: null, team: t.name ?? t.id };
  }
  const p = getProfile(home, profileName);
  if (!p) return { ok: false, reason: 'no_such_profile' };
  const mine = t.folders.filter((f) => f.kind === p.kind);
  if (!mine.length) return { ok: false, reason: 'wrong_kind' };
  const res = bindTeam(home, teamId, profileName, mine.map((f) => f.path), { win });
  return res.ok ? { ...res, profile: profileName, team: t.name ?? t.id, skipped: t.folders.length - mine.length } : res;
}

/**
 * The profile an agent's binding uses: its own, else its team's; or null (the default account). A team's profile for the
 * other program (a Claude profile on a Codex agent's folder) does not apply.
 */
export function profileOf(home, binding) {
  if (!binding) return null;
  if (binding.profile) return getProfile(home, binding.profile);
  if (!binding.team) return null;
  let name = null;
  try { name = loadRegistry(home).teams?.[binding.team]?.profile ?? null; } catch { name = null; }
  const p = name ? getProfile(home, name) : null;
  return p && p.kind === (binding.provider === 'codex' ? 'codex' : 'claude') ? p : null;
}

/**
 * The environment to start a run for an agent folder: the profile's one variable, nothing else. An agent with no profile
 * gets `{}`, so the run uses the account the app is logged into, as a chat opened by hand does. The wake calls this.
 */
export function runEnv(home, folderArg) {
  const f = resolveFolder(home, folderArg);
  if (!f.ok) return {};
  const p = profileOf(home, f.binding);
  return p ? { [VARIABLE[p.kind]]: p.dir } : {};
}

/**
 * What the hub is told about the account a running relay uses: `{name}`, `{hidden: true}` while the PC user hides the name,
 * or null. Only for a run whose account variable (`account`, as markRunning recorded it) is the bound profile's folder: a
 * chat opened by hand on the default account reports nothing, even for a bound agent.
 */
export function runProfile(home, binding, account) {
  const p = profileOf(home, binding);
  const used = p && typeof account?.[p.kind] === 'string' ? account[p.kind] : null;
  if (!used || pathKey(canonicalFolder(used) ?? used) !== pathKey(p.dir)) return null;
  return p.hidden ? { hidden: true } : { name: p.name };
}

/** The name the hub may see for a binding: the profile's name, or null when none is bound or the PC user hid it. */
export function reportedProfile(home, binding) {
  const p = profileOf(home, binding);
  return p && !p.hidden ? p.name : null;
}
