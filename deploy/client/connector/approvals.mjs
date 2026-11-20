/**
 * What the PC's user has clicked to allow on the connector's local screen (docs/connector.md, "Isolation levels").
 *
 * - A hand-opened chat's FIRST registration in an agent folder waits for a click, once per folder: registration is
 *   self-asserted, and this is what keeps a process from claiming another agent's folder unseen.
 * - At the standard level a KEY PICKUP waits for a click too, because the platform store opens for any process of the same
 *   user and a pickup hands over a rotated session key.
 *
 * `pending.json` is written by the connector when something waits; `approvals.json` only by the screen's own handlers
 * (approve*), which check that the thing is waiting. Neither file holds a key or a token. Neither level separates two live
 * agents of one OS user: a process that writes approvals.json itself is outside what this file protects, and the docs say so.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { keyFilePath } from './keyfile.mjs';
import { readJson, atomicWrite, pathKey, canonicalFolder, folderIdentity } from './paths.mjs';
import { allBindings, configHash, registryPath } from './registry.mjs';

export const approvalsPath = (home) => join(home, 'approvals.json');
export const pendingPath = (home) => join(home, 'pending.json');
const EMPTY = () => ({ version: 1, folders: {}, pickups: {} });
const load = (path) => { const v = readJson(path, EMPTY()); return v && typeof v === 'object' && !Array.isArray(v) && v.folders && v.pickups ? v : EMPTY(); };
/** A pending request is dropped after a day with no click. */
export const PENDING_MS = 24 * 3600_000;

/** True if this folder, as bound now (same agent, hub and filesystem identity), was allowed by the PC's user. */
export function folderApproved(home, folder, binding) {
  const a = load(approvalsPath(home)).folders[pathKey(folder)];
  return !!a && a.agent === binding.agent && a.hub_id === binding.hub_id && a.identity === (binding.identity ?? null);
}

/** Records that a folder's chat waits for a click. Idempotent. */
export function requestFolder(home, folder, binding) {
  const p = load(pendingPath(home));
  const k = pathKey(folder);
  p.folders[k] = { folder, agent: binding.agent, hub_id: binding.hub_id, identity: binding.identity ?? null, at: p.folders[k]?.at ?? Date.now() };
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
}

/** What waits for a click now: `{folders: [{key, folder, agent, hub_id}], pickups: [{key, hub_key, request, what}]}`. */
export function pendingList(home, now = Date.now()) {
  const p = load(pendingPath(home));
  return {
    folders: Object.entries(p.folders).filter(([, v]) => now - v.at < PENDING_MS).map(([key, v]) => ({ key, folder: v.folder, agent: v.agent, hub_id: v.hub_id })),
    pickups: Object.entries(p.pickups).filter(([, v]) => now - v.at < PENDING_MS).map(([key, v]) => ({ key, hub_key: v.hub_key, request: v.request, what: v.what })),
  };
}

/** The PC user's click on a waiting folder. Returns whether it was waiting (and is now allowed). */
export function approveFolder(home, key) {
  const p = load(pendingPath(home)), w = p.folders[key];
  if (!w) return false;
  const canon = canonicalFolder(w.folder);
  if (!canon || pathKey(canon) !== key || folderIdentity(canon) !== w.identity && w.identity !== null) return false;
  const a = load(approvalsPath(home));
  a.folders[key] = { agent: w.agent, hub_id: w.hub_id, identity: w.identity, approved_at: Date.now() };
  delete p.folders[key];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
  return true;
}

/** The connector's own launcher starts a run it knows (the wake): it allows that folder without a click, because nothing self-asserted is involved. */
export function approveFolderByConnector(home, folder, binding) {
  const a = load(approvalsPath(home));
  a.folders[pathKey(folder)] = { agent: binding.agent, hub_id: binding.hub_id, identity: binding.identity ?? null, approved_at: Date.now() };
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
}


/**
 * The upgrade to turn tokens, once per PC: a folder registered BEFORE it, whose settings still hash as they did when it was registered
 * (and whose filesystem identity is unchanged), is allowed without a click, because the PC's user already set it up. A folder whose
 * settings changed or are held, and every folder registered after this runs, still waits for its click. Each grandfathered folder gets
 * one connector.log line (`log`) and one audit entry on its hub (unauditedGrandfathered, markAudited). Returns the folders it allowed.
 */
export function grandfather(home, log = () => {}) {
  // A folder that is not a connector home (removed, or holding only the user's files) is not written to; a real home is marked even before pairing, so a folder registered after this start still waits for its click.
  if (![join(home, 'conclave.mjs'), keyFilePath(home), registryPath(home)].some((p) => existsSync(p))) return [];
  const a = load(approvalsPath(home));
  if (a.grandfathered_at) return [];
  const done = [];
  let bindings;
  try { bindings = allBindings(home); } catch { return []; } // no readable registry: tried again at the next start
  for (const b of bindings) {
    const canon = b.path && canonicalFolder(b.path);
    if (!canon || !b.agent || !b.config_sha256 || b.config_sha256 === 'held') { log(`folder ${b.path ?? '?'} not grandfathered (its settings are held or not recorded); it waits for a click`); continue; }
    if ((b.identity ?? null) !== folderIdentity(canon) || configHash(canon) !== b.config_sha256) { log(`folder ${canon} not grandfathered (changed since it was registered); it waits for a click`); continue; }
    a.folders[pathKey(canon)] = { agent: b.agent, hub_id: b.hub_id, identity: b.identity ?? null, approved_at: Date.now(), by: 'upgrade', audited: false };
    done.push({ folder: canon, agent: b.agent, hub_id: b.hub_id });
    log(`folder ${canon} grandfathered: registered before the upgrade and unchanged since, so it is allowed as ${b.agent} without a click`);
  }
  a.grandfathered_at = Date.now();
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  return done;
}

/** Grandfathered folders of one hub whose audit entry the hub has not yet confirmed: `[{key, agent}]`. */
export function unauditedGrandfathered(home, hubId) {
  return Object.entries(load(approvalsPath(home)).folders).filter(([, v]) => v.by === 'upgrade' && v.audited === false && v.hub_id === hubId).map(([key, v]) => ({ key, agent: v.agent }));
}
export function markAudited(home, keys) {
  const a = load(approvalsPath(home));
  for (const k of keys) if (a.folders[k]?.by === 'upgrade') a.folders[k].audited = true;
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
}

/** Withdraws an allowance (a folder that was unregistered, or an agent moved to another folder). */
export function revokeFolder(home, folder) {
  const a = load(approvalsPath(home)), k = pathKey(folder);
  if (!a.folders[k]) return false;
  delete a.folders[k];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  return true;
}

const pickupKey = (hubKey, requestId) => `${hubKey}|${requestId}`;
/** True once the PC user allowed this key pickup (one request on one hub). */
export const pickupApproved = (home, hubKey, requestId) => !!load(approvalsPath(home)).pickups[pickupKey(hubKey, requestId)];
/** Records that a pickup waits for a click. `what` says in plain words what is being picked up. */
export function requestPickup(home, hubKey, requestId, what) {
  const p = load(pendingPath(home)), k = pickupKey(hubKey, requestId);
  p.pickups[k] = { hub_key: hubKey, request: requestId, what: String(what).slice(0, 120), at: p.pickups[k]?.at ?? Date.now() };
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
}
export function approvePickup(home, key) {
  const p = load(pendingPath(home)), w = p.pickups[key];
  if (!w) return false;
  const a = load(approvalsPath(home));
  a.pickups[key] = { approved_at: Date.now() };
  delete p.pickups[key];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
  atomicWrite(pendingPath(home), JSON.stringify(p, null, 2) + '\n');
  return true;
}
/** One pickup is allowed once: a click is spent when the pickup is made. */
export function spendPickup(home, hubKey, requestId) {
  const a = load(approvalsPath(home)), k = pickupKey(hubKey, requestId);
  if (!a.pickups[k]) return;
  delete a.pickups[k];
  atomicWrite(approvalsPath(home), JSON.stringify(a, null, 2) + '\n');
}
