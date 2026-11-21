/**
 * What the connector remembers about each vault sync (docs/vault-sync.md, "The connector side"): the list of syncs
 * (`syncs.json`) and, for each, a manifest of what the mirror holds (`sync/<id>.manifest.json`). Both live in the connector's
 * own folder, never in the mirror. No key is stored here: a reader's key is in the key file under the label `vsync-<id>`.
 */
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { atomicWrite, readState, writeState, withLock } from './paths.mjs';

export const syncsPath = (home) => join(home, 'syncs.json');
export const manifestPath = (home, id) => join(home, 'sync', `${id}.manifest.json`);
export const labelOf = (id) => `vsync-${id}`;
export const STATES = ['active', 'paused', 'revoked'];

const load = (home) => {
  const d = readState(syncsPath(home), { version: 1, syncs: {} });
  if (!d || typeof d !== 'object' || d.version !== 1 || !d.syncs || typeof d.syncs !== 'object') throw Object.assign(new Error('syncs.json is not readable'), { reason: 'syncs_unreadable' });
  return d;
};
const locked = (home, fn) => withLock(syncsPath(home), fn);

export function listSyncs(home) { return Object.values(load(home).syncs); }

/** A sync by id or by name (names compare without case). */
export function findSync(home, idOrName) {
  const s = Object.values(load(home).syncs);
  const q = String(idOrName).toLowerCase();
  return s.find((x) => x.id === idOrName) ?? s.find((x) => x.name.toLowerCase() === q) ?? null;
}

export function addSync(home, rec) {
  return locked(home, () => {
    const d = load(home);
    if (Object.values(d.syncs).some((x) => x.name.toLowerCase() === rec.name.toLowerCase())) throw Object.assign(new Error(`a sync named "${rec.name}" exists`), { reason: 'name_taken' });
    const id = rec.id ?? randomBytes(4).toString('hex');
    const full = { id, state: 'active', created_at: new Date().toISOString(), cursor: null, last_full_at: null, last_run_at: null, files: 0, bytes: 0, local_edits: 0, local_new: 0, warnings: [], refused: [], last_error: null, ...rec };
    d.syncs[id] = full;
    writeState(syncsPath(home), JSON.stringify(d, null, 2));
    return full;
  });
}

/** Changes fields of one sync; returns the new record, or null when it is gone. */
export function updateSync(home, id, patch) {
  return locked(home, () => {
    const d = load(home);
    if (!d.syncs[id]) return null;
    d.syncs[id] = { ...d.syncs[id], ...(typeof patch === 'function' ? patch(d.syncs[id]) : patch) };
    writeState(syncsPath(home), JSON.stringify(d, null, 2));
    return d.syncs[id];
  });
}

export function removeSync(home, id) {
  return locked(home, () => {
    const d = load(home);
    if (!d.syncs[id]) return false;
    delete d.syncs[id];
    writeState(syncsPath(home), JSON.stringify(d, null, 2));
    rmSync(manifestPath(home, id), { force: true });
    rmSync(`${manifestPath(home, id)}.bak`, { force: true });
    return true;
  });
}

/** What the mirror holds: `{files: {rel: {rev, size, mtime}}}`. A missing manifest is an empty mirror. */
export function loadManifest(home, id) {
  const m = readState(manifestPath(home, id), { version: 1, files: {} });
  if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object') return { version: 1, files: {} };
  return m;
}
export function saveManifest(home, id, m) { writeState(manifestPath(home, id), JSON.stringify(m)); }

export { atomicWrite };
