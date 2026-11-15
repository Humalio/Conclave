/**
 * `conclave check`: a local, read-only report that names ONE fixed reason (docs/connector.md).
 *
 * It reads the key file, the registry, the folder's own entry and ~/.claude.json, and changes nothing. It looks in the
 * fixed ORDER of reasons.mjs and stops at the first problem, so the answer is always one line. With `probe` it also
 * asks the hub once whether the agent can sign in, WITHOUT caching a token or changing anything; that is the only
 * network step, and it only runs when asked.
 */
import { join } from 'node:path';
import { resolveContext } from './context.mjs';
import { entryState } from './entries.mjs';
import { nodePath, connectorPath, isApproved } from './entries.mjs';
import { trustStatus } from './trust.mjs';
import { callTool } from './hubclient.mjs';
import { line } from './reasons.mjs';
import { hasLegacyEntry } from './migrate.mjs';
import { canonicalFolder } from './paths.mjs';

/** `{ok, reason, line, steps}`: `steps` lists each check and whether it passed, in the order run. */
export async function runCheck(home, folderArg, { claudeJson, node, connector, probe = false, win } = {}) {
  const steps = [];
  const stop = (reason) => { steps.push({ step: reason, ok: false }); return { ok: false, reason, line: line(reason), steps }; };
  const cf = canonicalFolder(folderArg); if (cf && hasLegacyEntry(cf)) return stop('old_layout');
  const ctx = resolveContext(home, folderArg);
  if (!ctx.ok) return stop(ctx.reason);
  steps.push({ step: 'registered, hub key and agent key found, hub pinned over https', ok: true });
  const want = { node: nodePath(node), connector: connectorPath(home, connector), folder: ctx.folder };
  const es = entryState(ctx.folder, want);
  if (es === 'stale' || es === 'missing') return stop('entry_stale');
  steps.push({ step: es === 'foreign' ? 'the folder has its own entry named conclave (left alone)' : 'the folder entry names this Node and this connector by absolute path', ok: true });
  steps.push({ step: isApproved(ctx.folder) ? 'the folder settings approve the server' : 'the folder settings do not approve the server yet (the client will ask once)', ok: true });
  const t = trustStatus(claudeJson, ctx.folder, ctx.binding, { win });
  if (t.action === 'ask' && ['trust_withdrawn', 'folder_changed', 'identity_changed'].includes(t.reason)) return stop(t.reason === 'identity_changed' ? 'identity_changed' : t.reason);
  steps.push({ step: t.action === 'none' ? 'folder trust is set' : 'folder trust entry is missing and repair can restore it', ok: true });
  if (probe) {
    try {
      const r = await callTool(ctx.hub, 'session_login', { session_key: ctx.sessionKey }, { Authorization: `Bearer ${ctx.appKey}` }, 10_000);
      if (r.status !== 200 || typeof r.data.session_token !== 'string') return stop('login_refused');
      steps.push({ step: 'the hub accepted this agent (nothing cached)', ok: true });
    } catch (e) { return stop(e.reason ?? 'hub_unreachable'); }
  }
  return { ok: true, reason: null, line: 'Conclave is set up for this folder.', steps };
}
