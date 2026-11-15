/**
 * Folder trust that stays within what the PC user approved (docs/connector.md, review-v2 §1 point 11, proof 9).
 *
 * Claude Code keeps one flag per folder in ~/.claude.json: projects["<folder>"].hasTrustDialogAccepted. A Claude Code
 * session can rewrite that file and drop entries it does not know. The connector re-applies the flag ONLY when
 *   - the folder is registered, and its identity and agent settings are unchanged since they were recorded, and
 *   - the entry has DISAPPEARED (absent), never when it is false (the user's choice wins).
 * Otherwise the answer is "ask": the session and the PC page show Repair connection, which asks the user. The flag is
 * changed by key, merged into the newest content of the file, and never written over a file that changed meanwhile.
 * Both key forms are written on Windows (forward slashes and native; the build tested showed only the forward form
 * is matched, and setup already writes both).
 */
import { statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { atomicWrite, trustKeys, folderIdentity } from './paths.mjs';
import { configHash } from './registry.mjs';

/** 'true' | 'false' | 'absent' for one key. Anything but a boolean is treated as absent. */
const stateOf = (j, k) => { const v = j?.projects?.[k]?.hasTrustDialogAccepted; return v === true ? 'true' : v === false ? 'false' : 'absent'; };

/**
 * Pure decision. `claudeJson` is the parsed file, `binding` the registry record, `now` the folder's current
 * `{identity, config_sha256}`. Returns `{action: 'none' | 'reapply' | 'ask', reason, missing}`.
 */
export function decide(claudeJson, folder, binding, now, win) {
  const keys = trustKeys(folder, win);
  const states = keys.map((k) => stateOf(claudeJson, k));
  if (states.includes('false')) return { action: 'ask', reason: 'trust_withdrawn', missing: [] };
  const missing = keys.filter((k, i) => states[i] === 'absent');
  if (!missing.length) return { action: 'none', reason: null, missing: [] };
  if (!binding) return { action: 'ask', reason: 'not_registered', missing };
  if (binding.identity !== null && now.identity !== binding.identity) return { action: 'ask', reason: 'identity_changed', missing };
  if (now.config_sha256 !== binding.config_sha256) return { action: 'ask', reason: 'folder_changed', missing };
  return { action: 'reapply', reason: null, missing };
}

const snapshot = (path) => { try { const s = statSync(path, { bigint: true }); return `${s.size}:${s.mtimeNs}`; } catch { return 'none'; } };

/**
 * Reads the file, decides, and when the decision is `reapply` writes only the missing keys. A file that is not valid JSON
 * is never touched. If the file changes between the read and the write, the decision is made again once on the new
 * content; a second change leaves it alone (`busy`). Returns the decision plus `{wrote: boolean}`.
 */
export function applyTrust(claudeJsonPath, folder, binding, { win } = {}) {
  const now = { identity: folderIdentity(folder), config_sha256: configHash(folder) };
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = snapshot(claudeJsonPath);
    let j = {};
    if (before !== 'none') {
      try { j = JSON.parse(readFileSync(claudeJsonPath, 'utf8')); } catch { return { action: 'ask', reason: 'claude_json_unreadable', missing: [], wrote: false }; }
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { action: 'ask', reason: 'claude_json_unreadable', missing: [], wrote: false };
    }
    const d = decide(j, folder, binding, now, win);
    if (d.action !== 'reapply') return { ...d, wrote: false };
    j.projects = j.projects && typeof j.projects === 'object' && !Array.isArray(j.projects) ? j.projects : {};
    for (const k of d.missing) j.projects[k] = { ...(typeof j.projects[k] === 'object' && j.projects[k] && !Array.isArray(j.projects[k]) ? j.projects[k] : {}), hasTrustDialogAccepted: true };
    if (snapshot(claudeJsonPath) !== before) continue; // someone wrote meanwhile: decide again on the new content
    atomicWrite(claudeJsonPath, JSON.stringify(j, null, 2) + '\n', false);
    return { ...d, wrote: true };
  }
  return { action: 'reapply', reason: 'busy', missing: [], wrote: false };
}

/** Read-only status for `conclave check`: the decision without writing anything. */
export function trustStatus(claudeJsonPath, folder, binding, { win } = {}) {
  let j = {};
  try { j = JSON.parse(readFileSync(claudeJsonPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return { action: 'ask', reason: 'claude_json_unreadable', missing: [] }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { action: 'ask', reason: 'claude_json_unreadable', missing: [] };
  return decide(j, folder, binding, { identity: folderIdentity(folder), config_sha256: configHash(folder) }, win);
}

/**
 * Setup's first grant, made with the PC user's approval at the time (the user is at the screen): sets the flag for every key
 * form of a folder, merged into the newest content of the file. Also what `conclave repair --grant-trust` does after the
 * user was asked. Returns `{wrote, before}` where `before` is 'absent' | 'false' | 'true' for the first key.
 */
export function grantTrust(claudeJsonPath, folder, { win } = {}) {
  let j = {};
  if (snapshot(claudeJsonPath) !== 'none') {
    try { j = JSON.parse(readFileSync(claudeJsonPath, 'utf8')); } catch { throw new Error(`${claudeJsonPath} is not valid JSON; not touching it`); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${claudeJsonPath} is not a JSON object; not touching it`);
  }
  const keys = trustKeys(folder, win);
  const before = stateOf(j, keys[0]);
  if (keys.every((k) => stateOf(j, k) === 'true')) return { wrote: false, before };
  j.projects = j.projects && typeof j.projects === 'object' && !Array.isArray(j.projects) ? j.projects : {};
  for (const k of keys) j.projects[k] = { ...(typeof j.projects[k] === 'object' && j.projects[k] && !Array.isArray(j.projects[k]) ? j.projects[k] : {}), hasTrustDialogAccepted: true };
  atomicWrite(claudeJsonPath, JSON.stringify(j, null, 2) + '\n', false);
  return { wrote: true, before };
}
