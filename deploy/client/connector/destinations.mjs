/**
 * Restore destinations (docs/connector.md "Restore destinations"): the folders on this PC the PC's user approved for a
 * restored team. The user adds one with `conclave destinations add <folder>` (or on the local screen); the hub sees only an id
 * and a plain label, never the path, and a restore order names a destination by that id. Stored in destinations.json.
 */
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, atomicWrite, canonicalFolder, oneLine } from './paths.mjs';

export const DESTINATION_RE = /^dst_[a-z0-9]{6,32}$/;
export const MAX_DESTINATIONS = 20;
export const destinationsPath = (home) => join(home, 'destinations.json');

/** Every valid destination as {id, label, path}. */
export function listDestinations(home) {
  const j = readJson(destinationsPath(home), null);
  const list = Array.isArray(j?.destinations) ? j.destinations : [];
  return list.filter((d) => d && DESTINATION_RE.test(String(d.id)) && typeof d.path === 'string' && d.path && typeof d.label === 'string');
}

/** What a check-in reports: an id and a label each, never the path. */
export const reportDestinations = (home) => listDestinations(home).map((d) => ({ id: d.id, label: d.label }));

/** The destination an order names, or null. */
export const resolveDestination = (home, id) => listDestinations(home).find((d) => d.id === id) ?? null;

/** Approves a folder (it must exist) as a destination. `{ok, destination}` or `{ok: false, reason}`. */
export function addDestination(home, folderArg, label) {
  const folder = canonicalFolder(folderArg);
  if (!folder) return { ok: false, reason: 'the folder does not exist' };
  const list = listDestinations(home);
  const have = list.find((d) => d.path === folder);
  if (have) return { ok: true, destination: have, existed: true };
  if (list.length >= MAX_DESTINATIONS) return { ok: false, reason: `at most ${MAX_DESTINATIONS} destinations` };
  const d = { id: `dst_${randomBytes(6).toString('hex')}`, label: oneLine(label || basename(folder) || folder).slice(0, 80) || 'Destination', path: folder };
  atomicWrite(destinationsPath(home), JSON.stringify({ version: 1, destinations: [...list, d] }, null, 2) + '\n');
  return { ok: true, destination: d };
}

export function removeDestination(home, id) {
  const list = listDestinations(home);
  if (!list.some((d) => d.id === id)) return false;
  atomicWrite(destinationsPath(home), JSON.stringify({ version: 1, destinations: list.filter((d) => d.id !== id) }, null, 2) + '\n');
  return true;
}
