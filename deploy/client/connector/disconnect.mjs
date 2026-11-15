/**
 * Disconnect this hub from this PC, the connector's side (docs/connector.md "Disconnect this hub from this PC"; review-v2
 * §1 point 9). The hub has already revoked the PC's access. The connector:
 *   1. gets the order's narrow receipt credential: the hub answers the PC's own (now refused) app key with it;
 *   2. fetches the one disconnect order with that credential (it can do nothing else);
 *   3. if the PC's user turned remote cleanup off, only reports `cleanup_off`: nothing on disk changes;
 *   4. otherwise stops that hub's work first (the service's worker and transfers, through `stopHubWork`), then removes
 *      only that hub's traces through the journalled removal (uninstall.mjs);
 *   5. reports the outcome once, in fixed sentences without paths; then retires what is left of the hub (its key
 *      section, so the receipt can no longer be fetched again);
 *   6. removes the connector itself only when no hub remains AND the PC's user chose "remove the connector when the
 *      last hub disconnects".
 * An interruption anywhere resumes from the journal; a lost receipt is fetched again with the app key while the order
 * is open. The receipt is held in memory only, never written to disk or a log.
 */
import https from 'node:https';
import { readKeyFile, hubKeyOf } from './keyfile.mjs';
import { connect } from './hubclient.mjs';
import { runRemoval, readJournal, hubsLeft, preferences } from './uninstall.mjs';
import { left as leftSentences, notice } from './notices.mjs';

/** One HTTPS call to the pinned hub with a bearer credential: `{status, body}`. Fixed reason on a transport error. */
export function hubCall(section, method, path, bearer, body) {
  const c = connect(section);
  if (!c.ok) return Promise.reject(Object.assign(new Error(c.reason), { reason: c.reason }));
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((res, rej) => {
    const req = https.request(`${c.hub.origin}${path}`, { method, agent: c.hub.agent, timeout: 15_000, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${bearer}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return rej(Object.assign(new Error('redirect not followed'), { reason: 'hub_unreachable' })); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (x) => { raw += x; });
      r.on('end', () => { let b = null; try { b = raw ? JSON.parse(raw) : null; } catch { b = null; } res({ status: r.statusCode, body: b }); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', () => rej(Object.assign(new Error('hub_unreachable'), { reason: 'hub_unreachable' })));
    req.end(data ?? undefined);
  });
}

/** The default transport: the hub's connector routes over the pinned section. Tests pass their own. */
export function httpTransport(section) {
  return {
    async receipt() {
      // Any app-key route answers a disconnected PC with the receipt; the approved-versions list is read-only, so asking
      // a hub that did not disconnect this PC changes nothing there.
      const r = await hubCall(section, 'GET', '/connector/v1/versions/approved', section.app_key);
      return r.status === 401 && r.body?.error === 'disconnected' && typeof r.body.receipt === 'string' ? r.body.receipt : null;
    },
    async order(receipt) { const r = await hubCall(section, 'GET', '/connector/v1/disconnect', receipt); return r.status === 200 ? r.body?.order ?? null : null; },
    async report(receipt, state, left) { const r = await hubCall(section, 'POST', '/connector/v1/disconnect/result', receipt, { state, left }); return r.status === 200; },
  };
}

/**
 * Runs (or resumes) the disconnect of one hub. `opts`: `claudeJson`, `win`, `transport` (default: HTTPS), `stopHubWork`
 * (the service's stop for that hub's worker and transfers), `hooks` (tests). Returns
 * `{state: 'removed' | 'needs_attention' | 'cleanup_off' | 'no_order' | 'resume_later', reported, kept, notice}`.
 */
export async function runDisconnect(home, { hubId, caSha256 }, opts = {}) {
  const hubKey = hubKeyOf(hubId, caSha256);
  const kf = readKeyFile(home);
  const section = kf.ok ? kf.data.hubs[hubKey] : null;
  const scope = { kind: 'hub', hubId, caSha256 };
  const journal = readJournal(home);
  const resuming = journal && journal.scope?.kind === 'hub' && journal.scope.hubId === hubId && journal.scope.caSha256 === caSha256;
  if (!section) {
    // The key section is removed only after the receipt was reported, so its absence means this disconnect is over.
    if (resuming) runRemoval(home, scope, { ...opts, reported: true });
    return { state: 'no_order', reported: false, kept: [], notice: null };
  }
  const t = opts.transport ?? httpTransport(section);
  let receipt;
  try { receipt = await t.receipt(); } catch { return { state: 'resume_later', reported: false, kept: [], notice: notice('disconnect_waiting') }; }
  if (!receipt) {
    // No receipt while a removal of this hub is under way: the order already has its result (or expired). Its keys are
    // dead either way, so the rest is finished locally.
    if (resuming) runRemoval(home, scope, { ...opts, reported: true });
    return { state: 'no_order', reported: false, kept: [], notice: null };
  }
  let order;
  try { order = await t.order(receipt); } catch { return { state: 'resume_later', reported: false, kept: [], notice: notice('disconnect_waiting') }; }
  if (!order) return { state: 'no_order', reported: false, kept: [], notice: null };

  // The PC user's local switch wins over the hub: access is already revoked, nothing on disk changes.
  if (!preferences(home).remote_cleanup && !resuming) {
    const ok = await t.report(receipt, 'cleanup_off', []).catch(() => false);
    return { state: 'cleanup_off', reported: ok, kept: [], notice: notice('cleanup_off') };
  }

  await opts.stopHubWork?.(hubKey); // that hub's worker and transfers stop before anything is removed
  const r = runRemoval(home, scope, opts);
  if (!r.done) return { state: 'resume_later', reported: false, kept: r.kept, notice: notice('disconnect_waiting') };
  const state = r.kept.length ? 'needs_attention' : 'removed';
  const ok = await t.report(receipt, state, leftSentences(r.kept)).catch(() => false);
  if (!ok) return { state: 'resume_later', reported: false, kept: r.kept, notice: notice('disconnect_waiting') }; // the journal stays; the next run reports again
  // Reported: the hub's key section goes now, which also ends any way to fetch the receipt again.
  runRemoval(home, scope, { ...opts, reported: true });
  if (!hubsLeft(home).length && preferences(home).remove_connector_with_last_hub) runRemoval(home, { kind: 'all' }, opts);
  return { state, reported: true, kept: r.kept, notice: notice(state === 'removed' ? 'disconnect_done' : 'disconnect_kept', { count: r.kept.length }) };
}
