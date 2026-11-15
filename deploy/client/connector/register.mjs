/**
 * Registering a folder with the connector, and repairing it (docs/connector.md). Pairing and setup call `registerFolder`
 * once the PC user has approved the agent folder; `repairFolder` is `conclave repair`. Every change goes through the
 * manifest with its value before and installed, entry by entry.
 */
import { join } from 'node:path';
import { bindFolder, rerecord, resolveFolder, configHash } from './registry.mjs';
import { mcpEntry, nodePath, connectorPath, writeMcpEntry, approveInSettings, writeHookEntries, entryState, SERVER_NAME } from './entries.mjs';
import { grantTrust as grantTrustFlag, applyTrust } from './trust.mjs';
import { record, entries } from './manifest.mjs';
import { canonicalFolder, trustKeys } from './paths.mjs';
import { readKeyFile, findHub } from './keyfile.mjs';

const folderCtx = (home, claudeJson) => ({ claudeJson, folders: [], home });
function ctxWith(home, claudeJson, folder) { return { ...folderCtx(home, claudeJson), folders: [folder] }; }

/**
 * Binds the folder, writes the connector's MCP entry and its approval, grants folder trust (the user approved this
 * folder at setup) and records each change. `hubId` and `caSha256` must name a section that exists in the key file.
 */
export function registerFolder(home, folderArg, { hubId, caSha256, agent, claudeJson, node, connector, win }) {
  const folder = canonicalFolder(folderArg);
  if (!folder) throw new Error('the folder does not exist');
  const kf = readKeyFile(home);
  if (!kf.ok || !findHub(kf.data, hubId, caSha256).ok) throw new Error('no key-file section for that hub and CA yet; pair first');
  const cx = ctxWith(home, claudeJson, folder);
  const entry = mcpEntry({ node: nodePath(node), connector: connectorPath(home, connector), folder });
  const e1 = writeMcpEntry(folder, entry);
  const e2 = approveInSettings(folder);
  // The hook is optional: a path it cannot carry leaves the folder without it, never without its registration.
  let e3 = null;
  try { e3 = writeHookEntries(folder, { node: nodePath(node), connector: connectorPath(home, connector) }); } catch { e3 = null; }
  const target = (f) => join(folder, f);
  // The registry and the manifest are written after the files they describe: the settings hash is of the finished folder.
  const binding = bindFolder(home, folder, { hubId, caSha256, agent });
  record(home, { kind: 'mcp_entry', target: target('.mcp.json'), folder, pointer: `mcpServers.${SERVER_NAME}`, before: e1.before, installed: e1.installed }, cx);
  record(home, { kind: 'mcp_approval', target: target('.claude/settings.json'), folder, pointer: 'enabledMcpjsonServers', before: e2.before, installed: true }, cx);
  if (e3) record(home, { kind: 'hook', target: target('.claude/settings.json'), folder, pointer: 'hooks', before: e3.before, installed: e3.installed }, cx);
  const t = grantTrustFlag(claudeJson, folder, { win });
  record(home, { kind: 'trust_flag', target: claudeJson, folder, pointer: `projects.${trustKeys(folder, win)[0]}.hasTrustDialogAccepted`, before: t.before === 'absent' ? null : t.before === 'true', installed: true }, cx);
  record(home, { kind: 'registry_entry', target: join(home, 'registry.json'), pointer: `folders.${folder}`, before: null, installed: { hub_id: hubId, agent } }, cx);
  return { folder, binding };
}

/**
 * `conclave repair`: rewrites the connector's entry if Node or the connector moved, re-applies a trust entry that
 * disappeared (when applyTrust allows it), and reports what it left alone. It never turns trust back on after the user
 * turned it off, or for a folder whose settings changed, unless the user says so: `grantTrust` (after being asked about
 * trust) and `acceptChanges` (after reviewing the folder's own settings). Returns `{actions, asked}`.
 */
export function repairFolder(home, folderArg, { claudeJson, node, connector, win, grantTrust: grant = false, acceptChanges = false }) {
  const r = resolveFolder(home, folderArg);
  if (!r.ok) return { actions: [], asked: [r.reason] };
  const folder = r.folder, actions = [], asked = [];
  const want = { node: nodePath(node), connector: connectorPath(home, connector), folder };
  const cx = ctxWith(home, claudeJson, folder);
  const st = entryState(folder, want);
  const unchanged = configHash(folder) === r.binding.config_sha256; // only then is the connector's own rewrite the sole change
  if (st === 'stale' || st === 'missing') {
    const e = writeMcpEntry(folder, mcpEntry(want));
    record(home, { kind: 'mcp_entry', target: join(folder, '.mcp.json'), folder, pointer: `mcpServers.${SERVER_NAME}`, before: e.before, installed: e.installed }, cx);
    actions.push(st === 'stale' ? 'entry_rewritten' : 'entry_added');
    if (unchanged) rerecord(home, folder); // the connector's own change is not a change by someone else; any other change stays visible
  } else if (st === 'foreign') asked.push('entry_foreign');
  // The folder hook: put back if it is missing or names a Node or connector that moved. Only ever at its two events.
  try {
    const h = writeHookEntries(folder, { node: want.node, connector: want.connector });
    if (JSON.stringify(h.before) !== JSON.stringify(h.installed)) {
      record(home, { kind: 'hook', target: join(folder, '.claude', 'settings.json'), folder, pointer: 'hooks', before: h.before, installed: h.installed }, cx);
      actions.push('hook_written');
      if (unchanged) rerecord(home, folder);
    }
  } catch { /* the hook is optional */ }
  if (acceptChanges) { rerecord(home, folder); actions.push('settings_accepted'); }
  const fresh = resolveFolder(home, folder);
  const t = applyTrust(claudeJson, folder, fresh.binding, { win });
  if (t.wrote) actions.push('trust_reapplied');
  else if (t.action === 'ask') {
    if (grant && ['trust_withdrawn', 'folder_changed', 'identity_changed'].includes(t.reason)) { grantTrustFlag(claudeJson, folder, { win }); actions.push('trust_granted_by_user'); } else asked.push(t.reason);
  }
  return { actions, asked, manifest: entries(home).length };
}
