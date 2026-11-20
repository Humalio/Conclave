/**
 * Removing what the connector owns, and nothing else (docs/connector.md "Uninstall and disconnect"; review-v2 §1 points 8
 * and 9, proof 12). Two scopes share one engine:
 *   - `{kind: 'hub', hubId, caSha256}`: Disconnect this hub from this PC. Only that hub's traces go: its folders' entries,
 *     their trust flags, their registry records, its token caches and, once the receipt is reported, its key section.
 *     Other hubs, the private git and the connector itself stay.
 *   - `{kind: 'all'}`: local uninstall. The logon service first (so it cannot start the worker again), then every hub's
 *     traces, the private git, the verified builds and the launcher, and last the connector's own files.
 *
 * Rules, each checked at the moment of change:
 *   - Only manifest entries of the fixed kinds, at their fixed places (manifest.mjs validateEntry), in a folder whose
 *     filesystem identity is still the one recorded at registration, on a path that crosses no symbolic link, junction or
 *     reparse point of any kind (paths.mjs reparsePoints). Anything else is KEPT and listed with a reason, as is an entry
 *     whose folder is no longer registered. Only processes the connector recorded starting are ended (processes.mjs).
 *   - A shared setting is undone only while it still holds the value the connector installed; an edited one is kept and
 *     listed. Files are changed entry by entry, merged into their newest content, never written over a file that changed
 *     between the read and the write (a client saving settings meanwhile): the step is decided again on the new content,
 *     and after repeated changes it is left for the next run.
 *   - Repositories, worktrees, chat history (Claude Code's other per-project data in ~/.claude.json, session files) and
 *     the user's own settings are never touched.
 *   - Every step is written to a journal (removal.json) before the next one runs, so an interrupted removal resumes
 *     where it stopped and never leaves a half-state; a finished removal deletes its journal.
 */
import { join, isAbsolute, relative, sep } from 'node:path';
import { readFileSync, rmSync, statSync, existsSync, readdirSync, rmdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { readJson, sha256, atomicWrite, pathKey, folderIdentity, canonicalFolder, trustKeys, reparsePoints, WIN } from './paths.mjs';
import { stopStarted } from './processes.mjs';
import { entries as manifestEntries, manifestPath, validateEntry, noRedirect } from './manifest.mjs';
import { registryPath } from './registry.mjs';
import { readKeyFile, keyFilePath, hubKeyOf, removeHub } from './keyfile.mjs';
import { invalidateHub, invalidateAll } from './tokens.mjs';
import { SERVER_NAME } from './entries.mjs';
import { removeService, serviceTargets } from './service.mjs';
import { userEnv as realUserEnv } from './git.mjs';

export const journalPath = (home) => join(home, 'removal.json');
/** The connector's own files in its folder, removed last by a full uninstall (never anything else in that folder). */
export const OWN_FILES = ['keys.json', 'keys.json.bak', 'keys.json.lock', 'keys.master', 'approvals.json', 'pending.json', 'registry.json', 'registry.json.bak', 'registry.json.lock', 'manifest.json', 'tokens', 'git', 'connector.log', 'preferences.json', 'preferences.json.bak', 'preferences.json.lock', 'processes.json', 'processes.json.bak', 'processes.json.lock', 'conclave.mjs', 'connector', 'app', 'run', 'orders', 'sessions.json', 'usage-events.jsonl'];
/** What belongs to the installation, not to a hub or a folder: undone only by a full uninstall. */
const INSTALL_KINDS = ['service_entry', 'portable_git', 'user_env', 'app_build', 'launcher'];
/** Kinds in the order they are undone: the folders' entries first, the records that say who owns them last. */
/** The logon service goes first, so nothing restarts the worker while the rest is removed; the builds and launcher last. */
const ORDER = ['service_entry', 'mcp_entry', 'mcp_approval', 'codex_entry', 'hook', 'git_exclude', 'instructions', 'codex_instructions', 'codex_role', 'trust_flag', 'registry_entry', 'token_cache', 'user_env', 'portable_git', 'app_build', 'launcher', 'key_section'];
const RETRIES = 3;

const sameScope = (a, b) => a && b && a.kind === b.kind && (a.kind === 'all' || (a.hubId === b.hubId && a.caSha256 === b.caSha256));
// Size, time and content: on Windows two saves within one clock tick can share a size and a time.
const snapshot = (p) => { try { const s = statSync(p, { bigint: true }); return `${s.size}:${s.mtimeNs}:${sha256(readFileSync(p))}`; } catch { return 'none'; } };

/** The folder a manifest entry is about: its own `folder`, or the one named in a registry pointer. */
const folderOf = (e) => e.folder ?? (e.kind === 'registry_entry' && typeof e.pointer === 'string' ? e.pointer.slice('folders.'.length) : null);

/**
 * The plan for a scope: every manifest entry in it, plus the folders it covers with the identity recorded for each
 * (taken from the registry now, so a resumed run still knows them after their records are gone).
 */
export function plan(home, scope) {
  const reg = readJson(registryPath(home), { version: 1, folders: {} }) ?? { folders: {} };
  const bound = Object.values(reg.folders ?? {});
  const inScope = (b) => scope.kind === 'all' || (b.hub_id === scope.hubId && b.ca_sha256 === scope.caSha256);
  const folders = bound.filter(inScope).map((b) => ({ path: b.path, identity: b.identity ?? null }));
  const mine = new Set(folders.map((f) => pathKey(f.path)));
  const hubKey = scope.kind === 'hub' ? hubKeyOf(scope.hubId, scope.caSha256) : null;
  const steps = [];
  for (const e of manifestEntries(home)) {
    if (e.kind === 'key_section') { if (scope.kind === 'all' || e.pointer === `hubs.${hubKey}`) steps.push(e); continue; }
    if (INSTALL_KINDS.includes(e.kind)) { if (scope.kind === 'all') steps.push(e); continue; } // the installation's, not a hub's
    if (e.kind === 'token_cache') { if (scope.kind === 'all') steps.push(e); continue; }
    const f = folderOf(e);
    if (f && mine.has(pathKey(f))) steps.push(e);
    // A full uninstall lists what the manifest names in a folder that is no longer registered: kept, never touched.
    // (Its registry record is already gone, so there is nothing of that kind to list.)
    else if (scope.kind === 'all' && e.kind !== 'registry_entry') steps.push({ ...e, orphan: true });
  }
  // Token caches are per hub; a hub's own folder is dropped even if the manifest never recorded it.
  // Likewise the hub's key section: it is the connector's own file, removed once the receipt is reported.
  if (scope.kind === 'hub') {
    steps.push({ kind: 'token_cache', target: join(home, 'tokens'), folder: null, pointer: null, installed: hubKey });
    if (!steps.some((e) => e.kind === 'key_section')) steps.push({ kind: 'key_section', target: join(home, 'keys.json'), folder: null, pointer: `hubs.${hubKey}`, installed: true });
  }
  steps.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return { version: 1, scope, started_at: new Date().toISOString(), folders, reported: false,
    steps: steps.map((e, i) => ({ n: i + 1, kind: e.kind, target: e.target, folder: e.folder ?? null, pointer: e.pointer ?? null, before: e.before ?? null, installed: e.installed, orphan: e.orphan === true, state: 'pending', reason: null })) };
}

/** The journal of an unfinished removal, or null. */
export const readJournal = (home) => { const j = readJson(journalPath(home)); return j && j.version === 1 && Array.isArray(j.steps) ? j : null; };
const saveJournal = (home, j) => atomicWrite(journalPath(home), JSON.stringify(j, null, 2) + '\n');

// ───── reading and changing one value, merged into the newest content ─────

/** Reads a JSON object file: `{ok, j}`; a missing file is `{}`; not JSON or not an object is `{ok: false}`. */
function readObj(p) {
  let text;
  try { text = readFileSync(p, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { ok: true, j: {}, missing: true } : { ok: false }; }
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? { ok: true, j } : { ok: false }; } catch { return { ok: false }; }
}

/**
 * Changes one JSON file by key. `decide(j)` returns `{verdict, apply?}`: `undo` (then `apply(j)` changes j in place and
 * returns true when the file should be deleted because nothing is left in it), `keep_edited`, `already_gone`.
 * The write happens only if the file is unchanged since the read; otherwise it reads and decides again.
 */
function changeJson(p, decide, hooks) {
  for (let i = 0; i < RETRIES; i++) {
    const before = snapshot(p);
    const r = readObj(p);
    if (!r.ok) return { state: 'kept', reason: 'not_json' };
    if (r.missing) return { state: 'gone', reason: null };
    const d = decide(r.j);
    if (d.verdict === 'already_gone') return { state: 'gone', reason: null };
    if (d.verdict === 'keep_edited') return { state: 'kept', reason: 'edited' };
    const empty = d.apply(r.j);
    hooks?.beforeWrite?.(p);
    if (snapshot(p) !== before) continue; // a client saved meanwhile: decide again on what it wrote
    if (empty) rmSync(p, { force: true }); else atomicWrite(p, JSON.stringify(r.j, null, 2) + '\n');
    return { state: 'done', reason: null };
  }
  return { state: 'pending', reason: 'busy' };
}

/**
 * Changes one text file. `change(text)` returns the new text, `null` when there is nothing of the connector's left in
 * it, or `{keep: reason}`. Written only if the file is unchanged since the read (as changeJson), with the file's own
 * line endings kept; a file left empty is deleted.
 */
function changeText(p, change, hooks) {
  for (let i = 0; i < RETRIES; i++) {
    const before = snapshot(p);
    let text;
    try { text = readFileSync(p, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { state: 'gone', reason: null } : { state: 'kept', reason: 'unreadable' }; }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = change(text.replace(/\r\n/g, '\n'));
    if (next === null) return { state: 'gone', reason: null };
    if (next && typeof next === 'object') return { state: 'kept', reason: next.keep };
    hooks?.beforeWrite?.(p);
    if (snapshot(p) !== before) continue;
    if (next.trim() === '') rmSync(p, { force: true }); else atomicWrite(p, next.replace(/\n/g, eol));
    return { state: 'done', reason: null };
  }
  return { state: 'pending', reason: 'busy' };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Undoes one value at `obj[key]`: back to `before`, or removed when there was none. */
const restore = (obj, key, before) => { if (before === null || before === undefined) delete obj[key]; else obj[key] = before; };

/** An instructions file setup wrote: deleted only while it holds exactly what setup wrote (its hash); an edited one is kept. */
function instructionsFile(s) {
  let text;
  try { text = readFileSync(s.target); } catch { return { state: 'gone' }; }
  const want = s.installed && typeof s.installed === 'object' ? s.installed.sha256 : null;
  if (!want || sha256(text) !== want) return { state: 'kept', reason: 'edited' };
  rmSync(s.target, { force: true });
  return { state: 'done' };
}

const UNDO = {
  instructions: instructionsFile,
  codex_instructions: instructionsFile,
  codex_role: instructionsFile,
  user_env(s, _h, ctx) {
    // Undone only while it holds the value setup set; a value the user changed is theirs and stays.
    const ue = ctx.userEnv, cur = ue.get(s.pointer);
    if (cur === null) return { state: 'gone' };
    if (cur !== s.installed) return { state: 'kept', reason: 'edited' };
    try { if (s.before === null || s.before === undefined) ue.unset(s.pointer); else ue.set(s.pointer, s.before); } catch { return { state: 'kept', reason: 'in_use' }; }
    return { state: 'done' };
  },
  service_entry(s, _h, ctx) {
    const r = removeService(ctx.home, ctx.service);
    return r.removed.length ? { state: 'done' } : { state: 'gone' };
  },
  app_build(s) {
    if (!existsSync(s.target)) return { state: 'gone' };
    rmSync(s.target, { recursive: true, force: true, maxRetries: 2 });
    return existsSync(s.target) ? { state: 'kept', reason: 'in_use' } : { state: 'done' };
  },
  launcher(s) {
    if (!existsSync(s.target)) return { state: 'gone' };
    rmSync(s.target, { force: true });
    return existsSync(s.target) ? { state: 'kept', reason: 'in_use' } : { state: 'done' };
  },
  mcp_entry(s, hooks) {
    return changeJson(s.target, (j) => {
      const cur = isObj(j.mcpServers) ? j.mcpServers[SERVER_NAME] : undefined;
      const v = cur === undefined ? 'already_gone' : isDeepStrictEqual(cur, s.installed) ? 'undo' : 'keep_edited';
      return { verdict: v, apply: (x) => { restore(x.mcpServers, SERVER_NAME, s.before); if (!Object.keys(x.mcpServers).length) delete x.mcpServers; return !Object.keys(x).length; } };
    }, hooks);
  },
  mcp_approval(s, hooks) {
    return changeJson(s.target, (j) => {
      const list = Array.isArray(j.enabledMcpjsonServers) ? j.enabledMcpjsonServers : null;
      if (!list || !list.includes(SERVER_NAME)) return { verdict: 'already_gone' };
      if (s.before === true) return { verdict: 'already_gone' }; // the user had approved it before the connector: theirs
      return { verdict: 'undo', apply: (x) => { x.enabledMcpjsonServers = x.enabledMcpjsonServers.filter((n) => n !== SERVER_NAME); if (!x.enabledMcpjsonServers.length) delete x.enabledMcpjsonServers; return !Object.keys(x).length; } };
    }, hooks);
  },
  hook(s, hooks) {
    return changeJson(s.target, (j) => {
      const cur = j.hooks;
      const v = cur === undefined ? 'already_gone' : isDeepStrictEqual(cur, s.installed) ? 'undo' : 'keep_edited';
      return { verdict: v, apply: (x) => { restore(x, 'hooks', s.before); return !Object.keys(x).length; } };
    }, hooks);
  },
  trust_flag(s, hooks, ctx) {
    // Every key form of the folder (Windows writes two); only the flag goes, the project's other data (chat history) stays.
    const keys = trustKeys(s.folder, ctx.win);
    return changeJson(s.target, (j) => {
      const p = isObj(j.projects) ? j.projects : {};
      const cur = keys.map((k) => (isObj(p[k]) ? p[k].hasTrustDialogAccepted : undefined));
      if (cur.every((v) => v === undefined)) return { verdict: 'already_gone' };
      if (cur.some((v) => v !== undefined && v !== s.installed)) return { verdict: 'keep_edited' }; // the user changed trust: their choice stays
      return { verdict: 'undo', apply: (x) => { for (const k of keys) if (isObj(x.projects?.[k])) restore(x.projects[k], 'hasTrustDialogAccepted', s.before); return false; } };
    }, hooks);
  },
  codex_entry(s, hooks) {
    const block = String(s.installed ?? '').replace(/\r\n/g, '\n');
    return changeText(s.target, (text) => {
      if (block && text.includes(block)) return text.replace(block, '');
      return text.includes(`[mcp_servers.${SERVER_NAME}]`) ? { keep: 'edited' } : null;
    }, hooks);
  },
  git_exclude(s, hooks) {
    const want = String(s.installed ?? '');
    return changeText(s.target, (text) => {
      const lines = text.split('\n');
      if (!want || !lines.includes(want)) return null;
      return lines.filter((l) => l !== want).join('\n');
    }, hooks);
  },
  registry_entry(s, _h, ctx) {
    const reg = readJson(registryPath(ctx.home));
    if (!reg || !isObj(reg.folders)) return { state: 'kept', reason: 'not_json' };
    const k = pathKey(folderOf(s));
    if (!reg.folders[k]) return { state: 'gone' };
    delete reg.folders[k];
    atomicWrite(registryPath(ctx.home), JSON.stringify(reg, null, 2) + '\n');
    return { state: 'done' };
  },
  token_cache(s, _h, ctx) {
    if (ctx.scope.kind === 'hub') invalidateHub(ctx.home, s.installed); else invalidateAll(ctx.home);
    return { state: 'done' };
  },
  portable_git(s, _h, ctx) {
    if (!existsSync(s.target)) return { state: 'gone' };
    rmSync(s.target, { recursive: true, force: true, maxRetries: 2 });
    return existsSync(s.target) ? { state: 'kept', reason: 'in_use' } : { state: 'done' };
  },
  key_section(s, _h, ctx) {
    // Removed only after the receipt was reported (a hub disconnect): until then the app key is how a lost receipt is
    // fetched again. A full local uninstall removes every section.
    if (ctx.scope.kind === 'hub' && !ctx.reported) return { state: 'pending', reason: 'after_receipt' };
    const kf = readKeyFile(ctx.home);
    if (!kf.ok) return { state: 'kept', reason: kf.reason };
    const hubKey = String(s.pointer).slice('hubs.'.length);
    return removeHub(ctx.home, hubKey) ? { state: 'done' } : { state: 'gone' };
  },
};

/** The checks made at the moment of change for an entry about a folder: its place, its identity, no redirect on the way. */
function placeCheck(s, ctx) {
  const f = folderOf(s);
  if (s.orphan) return { ok: false, reason: 'folder_not_registered' };
  if (!reparseFree(s, ctx)) return { ok: false, reason: ctx.reparse ? 'redirected_path' : 'reparse_unknown' };
  if (['token_cache', 'key_section', 'registry_entry'].includes(s.kind)) return { ok: true };
  if (['service_entry', 'app_build', 'launcher', 'user_env'].includes(s.kind)) {
    const v = validateEntry({ kind: s.kind, target: s.target, folder: null, pointer: s.pointer, installed: s.installed }, { home: ctx.home, claudeJson: ctx.claudeJson, folders: [], serviceTargets: ctx.serviceTargets });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason };
  }
  if (s.kind === 'portable_git') return noRedirect(ctx.home, s.target) && pathKey(s.target) === pathKey(join(ctx.home, 'git')) ? { ok: true } : { ok: false, reason: 'redirected_path' };
  const rec = ctx.folders.find((x) => pathKey(x.path) === pathKey(f ?? ''));
  if (s.kind !== 'trust_flag') {
    if (!rec) return { ok: false, reason: 'folder_not_registered' };
    if (!canonicalFolder(rec.path)) return { ok: false, reason: 'folder_missing' };
    if (rec.identity !== null && folderIdentity(rec.path) !== rec.identity) return { ok: false, reason: 'identity_changed' };
  }
  const v = validateEntry({ kind: s.kind, target: s.target, folder: s.folder, pointer: s.pointer, installed: s.installed }, { home: ctx.home, claudeJson: ctx.claudeJson, folders: ctx.folders.map((x) => x.path) });
  return v.ok ? { ok: true } : { ok: false, reason: v.reason };
}

/** The parts of a step's path below its root (the agent folder, or the connector's own folder for its files). */
function pathParts(s, ctx) {
  if (['token_cache', 'key_section', 'registry_entry', 'service_entry', 'user_env'].includes(s.kind)) return [];
  const root = ['portable_git', 'app_build', 'launcher'].includes(s.kind) ? ctx.home : s.kind === 'trust_flag' ? null : folderOf(s);
  if (!root) return [];
  const rel = relative(root, s.target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return [];
  const out = [];
  let cur = root;
  for (const part of rel.split(sep).filter(Boolean)) { cur = join(cur, part); out.push(cur); }
  return out;
}
/** No part of the step's path is a reparse point of any kind (links and junctions are also refused by noRedirect). */
function reparseFree(s, ctx) {
  const parts = pathParts(s, ctx);
  if (!parts.length) return true;
  if (!ctx.reparse) return false; // the check could not run: unsafe
  return !parts.some((p) => ctx.reparse.has(p));
}

/**
 * Runs (or resumes) a removal. `opts`: `claudeJson`, `win`, `service` (passed to service.mjs: `platform`, `exec`, … for tests), `userEnv` (tests), `reported` (a hub disconnect's receipt was reported, so its
 * key section may go), `hooks` (tests: `beforeWrite`, `afterStep(n)` which may throw to simulate an interruption).
 * Returns `{done, removed, kept: [{kind, target, reason}], pending}`; the journal is deleted once nothing is pending.
 */
export function runRemoval(home, scope, opts = {}) {
  let j = readJournal(home);
  if (!j || !sameScope(j.scope, scope)) j = plan(home, scope);
  if (opts.reported) j.reported = true;
  saveJournal(home, j);
  // The connector's own processes in this scope end first, and only those (processes.mjs); then every path part the
  // pending steps go through is checked for reparse points, in one call.
  stopStarted(home, scope.kind === 'all' ? { kind: 'all' } : { kind: 'hub', hubKey: hubKeyOf(scope.hubId, scope.caSha256) }, opts.processes);
  const service = opts.service ?? {};
  const ctx = { home, scope, folders: j.folders, claudeJson: opts.claudeJson, win: opts.win ?? WIN, reported: j.reported, service, serviceTargets: serviceTargets(home, service), userEnv: opts.userEnv ?? realUserEnv };
  const todo = j.steps.filter((s) => s.state === 'pending');
  ctx.reparse = (opts.reparsePoints ?? reparsePoints)([...new Set(todo.flatMap((s) => pathParts(s, ctx)))]);
  for (const s of j.steps) {
    if (s.state === 'done' || s.state === 'kept' || s.state === 'gone') continue;
    const pc = placeCheck(s, ctx);
    const r = !pc.ok ? { state: 'kept', reason: pc.reason } : (UNDO[s.kind]?.(s, opts.hooks, ctx) ?? { state: 'kept', reason: 'unknown_kind' });
    s.state = r.state; s.reason = r.reason ?? null;
    saveJournal(home, j);
    opts.hooks?.afterStep?.(s.n);
  }
  const pending = j.steps.filter((s) => s.state === 'pending');
  const kept = j.steps.filter((s) => s.state === 'kept').map((s) => ({ kind: s.kind, target: s.target, reason: s.reason }));
  const removed = j.steps.filter((s) => s.state === 'done').length;
  const blocking = pending.filter((s) => s.reason !== 'after_receipt');
  if (!pending.length) {
    if (scope.kind === 'all') removeOwnFiles(home);
    rmSync(journalPath(home), { force: true });
  }
  return { done: !blocking.length, removed, kept, pending: pending.map((s) => ({ kind: s.kind, reason: s.reason })), journal: pending.length ? journalPath(home) : null };
}

/** Full uninstall's last step: the connector's own fixed files in its folder, then the folder if nothing else is in it. */
function removeOwnFiles(home) {
  if (!isAbsolute(home)) return;
  for (const n of OWN_FILES) {
    const p = join(home, n);
    if (!noRedirect(home, p)) continue;
    rmSync(p, { recursive: true, force: true, maxRetries: 2 });
  }
  rmSync(journalPath(home), { force: true });
  try { if (!readdirSync(home).length) rmdirSync(home); } catch { /* not empty or already gone: left as it is */ }
}

/** Hubs that still have a section in the key file (for "remove the connector with the last hub"). */
export function hubsLeft(home) {
  const kf = readKeyFile(home);
  return kf.ok ? Object.keys(kf.data.hubs) : [];
}

/** The PC user's local choices (preferences.json, written by the user through the connector's screen). */
export function preferences(home) {
  const p = readJson(join(home, 'preferences.json'), {}) ?? {};
  return { remote_cleanup: p.remote_cleanup !== false, remove_connector_with_last_hub: p.remove_connector_with_last_hub === true, auto_update: p.auto_update !== false };
}

export { manifestPath, keyFilePath };
