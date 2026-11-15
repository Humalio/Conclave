/**
 * From a folder to everything the relay needs, or one fixed reason why not (docs/connector.md).
 * The only inputs are the connector's own files: the key file and the registry. The folder's own .mcp.json,
 * .agent-hub.json or config never says which hub or agent it is.
 */
import { readKeyFile, findHub, agentKey } from './keyfile.mjs';
import { resolveFolder } from './registry.mjs';
import { connect } from './hubclient.mjs';
import { readToken, writeToken, invalidate } from './tokens.mjs';
import { callTool } from './hubclient.mjs';

/** `{ok: true, folder, binding, hubKey, hub, appKey, sessionKey}`, or `{ok: false, reason}`. */
export function resolveContext(home, folderArg) {
  const kf = readKeyFile(home);
  if (!kf.ok) return { ok: false, reason: kf.reason };
  const r = resolveFolder(home, folderArg);
  if (!r.ok) return r;
  const h = findHub(kf.data, r.binding.hub_id, r.binding.ca_sha256);
  if (!h.ok) return h;
  const sessionKey = agentKey(h.section, r.binding.agent);
  if (!sessionKey) return { ok: false, reason: 'key_missing' };
  const c = connect(h.section);
  if (!c.ok) return c;
  return { ok: true, folder: r.folder, binding: r.binding, hubKey: h.hubKey, hub: c.hub, appKey: h.section.app_key, sessionKey };
}

/**
 * Signs the agent in outside the model: the cached token if the hub still accepts it, else one login. `fresh` skips the cache.
 * Resolves `{ok: true, token}` or `{ok: false, reason}`.
 */
export async function signIn(home, ctx, fresh = false) {
  const auth = { Authorization: `Bearer ${ctx.appKey}` };
  const label = ctx.binding.agent;
  try {
    if (!fresh) {
      const t = readToken(home, ctx.hubKey, label, ctx.sessionKey);
      if (t) {
        const r = await callTool(ctx.hub, 'session_whoami', {}, { ...auth, 'X-Agent-Hub-Session': t });
        if (r.status === 200 && !r.data.error) return { ok: true, token: t, agentId: typeof r.data.agent_id === 'string' ? r.data.agent_id : null };
        invalidate(home, ctx.hubKey, label);
      }
    }
    const r = await callTool(ctx.hub, 'session_login', { session_key: ctx.sessionKey }, auth);
    const token = typeof r.data.session_token === 'string' ? r.data.session_token : null;
    if (r.status !== 200 || !token) return { ok: false, reason: 'login_refused' };
    try { writeToken(home, ctx.hubKey, label, ctx.sessionKey, token); } catch { /* usable this time without the cache */ }
    return { ok: true, token, agentId: typeof r.data.agent_id === 'string' ? r.data.agent_id : null };
  } catch (e) {
    return { ok: false, reason: e.reason ?? 'hub_unreachable' };
  }
}

/**
 * Sign-in that reads the key file once more after a refusal: the wake may have collected a rotated key meanwhile
 * (docs/connector.md). Only a different session key for the same hub and agent is tried, once.
 */
export async function signInWithReread(home, ctx, fresh = false) {
  const first = await signIn(home, ctx, fresh);
  if (first.ok || first.reason !== 'login_refused') return { ...first, ctx };
  const again = resolveContext(home, ctx.folder);
  if (!again.ok || again.hubKey !== ctx.hubKey || again.sessionKey === ctx.sessionKey) return { ...first, ctx };
  invalidate(home, ctx.hubKey, ctx.binding.agent);
  const second = await signIn(home, again, true);
  return { ...second, ctx: again };
}
