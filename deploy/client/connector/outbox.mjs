/**
 * The outbox of order results (docs/connector.md, "Delivery orders"): a result is written here BEFORE it is sent and removed once
 * the hub has it, so a crash, a dropped connection or a hub that is down never loses one. Every check-in sends what is left.
 * `not_found` (404) means the hub has the result already (or the order is not this PC's), so the entry is dropped; so is any other
 * answer that a resend cannot change (a 4xx other than 401, 403, 408, 429). Per hub, at most 200 entries (the oldest go first).
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite } from './paths.mjs';
import { request as defaultRequest } from './hubclient.mjs';

const MAX = 200;
const file = (home, hubKey) => join(home, 'orders', `${createHash('sha256').update(hubKey).digest('hex').slice(0, 24)}.outbox.json`);
const load = (home, hubKey) => { const j = readJson(file(home, hubKey), { results: [] }); return Array.isArray(j?.results) ? j.results : []; };
const save = (home, hubKey, results) => atomicWrite(file(home, hubKey), JSON.stringify({ results: results.slice(-MAX) }) + '\n');

/** The results not yet reported, oldest first. */
export const pendingResults = (home, hubKey) => load(home, hubKey);

/** Keeps a result for this hub (a newer one for the same order replaces the older). */
export function queueResult(home, hubKey, id, state, result) {
  save(home, hubKey, [...load(home, hubKey).filter((r) => r.id !== id), { id, state, result: result ?? null }]);
}
export function dropResult(home, hubKey, id) {
  const all = load(home, hubKey), rest = all.filter((r) => r.id !== id);
  if (rest.length !== all.length) save(home, hubKey, rest);
}

/** True when the hub's answer ends the entry: it has the result, or no resend would be accepted. */
const settled = (status) => status === 200 || (status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status));

/** Sends one result: kept first, dropped once the hub answers. ctx: {home, hubKey, hub, auth, request?, log?}. Returns true when settled. */
export async function sendResult(ctx, id, state, result) {
  const { home, hubKey, hub, auth } = ctx, req = ctx.request ?? defaultRequest;
  queueResult(home, hubKey, id, state, result);
  const r = await req(hub, 'POST', `/connector/v1/orders/${id}/result`, { body: { state, result: result ?? null }, headers: auth }).catch((e) => ({ status: 0, reason: e?.reason }));
  if (settled(r.status)) { dropResult(home, hubKey, id); return true; }
  ctx.log?.(`order ${id}: the result could not be sent (${r.status || r.reason || 'no answer'}); it is kept and sent again`);
  return false;
}

/** Sends every kept result again (each check-in and at start). Stops at the first that cannot be sent: the hub is not reachable. */
export async function flushOutbox(ctx) {
  let sent = 0;
  for (const r of pendingResults(ctx.home, ctx.hubKey)) {
    const req = ctx.request ?? defaultRequest;
    const a = await req(ctx.hub, 'POST', `/connector/v1/orders/${r.id}/result`, { body: { state: r.state, result: r.result ?? null }, headers: ctx.auth }).catch((e) => ({ status: 0, reason: e?.reason }));
    if (!settled(a.status)) { ctx.log?.(`results: ${r.id} could not be sent (${a.status || a.reason || 'no answer'}); the rest wait`); break; }
    dropResult(ctx.home, ctx.hubKey, r.id); sent++;
  }
  return sent;
}
