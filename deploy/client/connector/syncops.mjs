/**
 * `conclave sync add | list | pause | resume | remove` (docs/vault-sync.md, "The connector side"). Each returns data and never
 * prints; a key is never returned. The code is passed in by the caller (read from standard input, never an argument).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readKeyFile, findHub, hubKeyOf, putAgentKey, removeAgentKey, normalizeOrigin, agentKey } from './keyfile.mjs';
import { connect } from './hubclient.mjs';
import { canonicalFolder } from './paths.mjs';
import { allBindings } from './registry.mjs';
import { folderRefusal } from './syncpath.mjs';
import { addSync, findSync, listSyncs, removeSync, updateSync, labelOf } from './syncstore.mjs';
import { makeApi } from './syncapi.mjs';
import { createEngine } from './syncengine.mjs';

export const CODE_RE = /^cnv_vsync_[a-z2-7]{26}$/;
const MSG = {
  401: 'That pairing code is not valid, or was already used. Ask the operator for a new one.',
  429: 'Too many tries from this PC. Wait a while and try again.',
  426: 'This hub does not support vault sync version 1.',
};

/** The paired hub section a `<hub>` argument names (an id or an https origin), or a reason. */
export function hubOf(home, arg) {
  const kf = readKeyFile(home);
  if (!kf.ok) return { ok: false, reason: `the key file cannot be read (${kf.reason})` };
  const origin = normalizeOrigin(arg);
  const hits = Object.entries(kf.data.hubs).filter(([, s]) => s.hub_id === arg || (origin && normalizeOrigin(s.origin) === origin));
  if (hits.length === 0) return { ok: false, reason: 'this PC is not paired with that hub; pair it first' };
  if (hits.length > 1) return { ok: false, reason: 'more than one hub matches; use the hub id' };
  const [hubKey, section] = hits[0];
  if (section.disconnected_at) return { ok: false, reason: 'this PC was disconnected from that hub' };
  const f = findHub(kf.data, section.hub_id, section.ca_sha256);
  if (!f.ok) return { ok: false, reason: `the hub's record is not usable (${f.reason})` };
  return { ok: true, hubKey, section };
}

export async function syncAdd(home, { hub: hubArg, folder, name, code }, { os = process.platform, makeApiFn = makeApi, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!CODE_RE.test(String(code ?? '').trim())) return fail('that is not a vault sync pairing code (it starts with cnv_vsync_)');
  code = String(code).trim();
  const h = hubOf(home, hubArg);
  if (!h.ok) return fail(h.reason);
  if (typeof folder !== 'string' || !path.isAbsolute(path.resolve(folder))) return fail('give the folder as a path');
  const abs = path.resolve(folder);
  if (!canonicalFolder(abs)) { try { mkdirSync(abs, { recursive: true }); } catch { return fail('the folder could not be created'); } }
  const canon = canonicalFolder(abs);
  if (!canon) return fail('the folder does not exist');
  const others = [{ path: home, what: "the connector's own folder" }, ...allBindings(home).map((b) => ({ path: b.path, what: `the folder of agent ${b.agent}` })), ...listSyncs(home).map((s) => ({ path: s.folder, what: `the sync "${s.name}"` }))];
  const why = folderRefusal(canon, others, os);
  if (why) return fail(why);
  const label = String(name ?? path.basename(canon) ?? 'sync').trim().replace(/[\x00-\x1f]/g, ' ').slice(0, 60) || 'sync';
  if (findSync(home, label)) return fail(`a sync named "${label}" already exists; choose another with --name`);
  const c = connect(h.section);
  if (!c.ok) return fail(`the hub cannot be reached safely (${c.reason})`);
  const api = makeApiFn(c.hub, null);
  const nonce = randomBytes(16).toString('hex');
  let r;
  try { r = await api.json('POST', '/vault-sync/v1/pair', { code, nonce, version: 1 }); } catch (e) { return fail(`the hub could not be reached (${e.reason ?? e.message})`); }
  if (r.status !== 200 || typeof r.json?.key !== 'string') return fail(MSG[r.status] ?? `the hub refused the code (${r.status})`);
  const id = randomBytes(4).toString('hex'), key = r.json.key, readerId = r.json.reader?.id ?? null;
  try { putAgentKey(home, h.hubKey, labelOf(id), key); } catch (e) { return fail(`the key could not be stored (${e.message})`); }
  let rec;
  try { rec = addSync(home, { id, name: label, hub_id: h.section.hub_id, ca_sha256: h.section.ca_sha256, folder: canon, label: labelOf(id), reader_id: readerId }); } catch (e) { try { removeAgentKey(home, h.hubKey, labelOf(id)); } catch { /* nothing stored */ } return fail(e.reason === 'name_taken' ? `a sync named "${label}" already exists` : `the sync could not be recorded (${e.message})`); }
  // Confirming ends the code. A lost answer is retried: the hub accepts the same nonce again.
  let confirmed = false;
  for (let i = 0; i < 3 && !confirmed; i++) {
    try { const k = await api.json('POST', '/vault-sync/v1/pair/confirm', { nonce }); confirmed = k.status === 200; } catch { /* try again */ }
    if (!confirmed) await sleep(500);
  }
  return { ok: true, id, name: rec.name, folder: canon, confirmed };
}

/** Every sync with what a person wants to know; local edits are counted now (a look at the files, never a change). */
export async function syncList(home, { edits = true } = {}) {
  const out = [];
  for (const s of listSyncs(home)) {
    let local_edits = s.local_edits;
    let local_new = s.local_new ?? 0;
    if (edits) { try { const eng = createEngine({ home, rec: s, api: null }); local_edits = await eng.countLocalEdits(); local_new = await eng.countLocalNew(); } catch { /* the folder is gone: the counts stay */ } }
    out.push({ id: s.id, name: s.name, hub_id: s.hub_id, folder: s.folder, state: s.state, last_run_at: s.last_run_at, files: s.files, bytes: s.bytes, local_edits, local_new, warnings: s.warnings, refused: s.refused, last_error: s.last_error });
  }
  return out;
}

export function syncSet(home, nameOrId, state) {
  const s = findSync(home, nameOrId);
  if (!s) return { ok: false, reason: `no sync called "${nameOrId}"` };
  if (s.state === 'revoked') return { ok: false, reason: 'the hub removed this reader; remove the sync here and add it again with a new code' };
  const r = updateSync(home, s.id, { state });
  return { ok: true, name: r.name, state: r.state };
}

/** Forgets a sync here: its key leaves the key file, its record goes. The folder and its trash stay. The hub keeps the reader until the operator removes it. */
export function syncRemove(home, nameOrId) {
  const s = findSync(home, nameOrId);
  if (!s) return { ok: false, reason: `no sync called "${nameOrId}"` };
  try { removeAgentKey(home, hubKeyOf(s.hub_id, s.ca_sha256), s.label); } catch { /* the key was not there */ }
  removeSync(home, s.id);
  return { ok: true, name: s.name, folder: s.folder, reader_id: s.reader_id };
}

/** `Bearer <key>` (or its placeholder at the hardened level) for a sync, or null. */
export function authFor(home, rec) {
  const kf = readKeyFile(home);
  if (!kf.ok) return null;
  const f = findHub(kf.data, rec.hub_id, rec.ca_sha256);
  if (!f.ok) return null;
  const k = agentKey(f.section, rec.label);
  return k ? `Bearer ${k}` : null;
}
