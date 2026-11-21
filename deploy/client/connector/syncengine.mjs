/**
 * The mirror engine (docs/vault-sync.md, "The connector side"): one sync's runs. It talks to the hub through an `api` it is
 * given (syncapi.mjs for the real one), writes only inside the sync's folder after syncpath.mjs has looked at the path, and
 * never destroys a byte it did not put there: what leaves the mirror goes to `.conclave-trash/<date>/`.
 *
 *   api.json(method, path, body)       -> {status, json}
 *   api.download(path, destFile)       -> {status, revision, sha256, bytes}   (streams to destFile; no file on a failure)
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { loadManifest, saveManifest, updateSync } from './syncstore.mjs';
import { relRefusal, collisionKey, safeTarget, fsPath } from './syncpath.mjs';

export const FILE_MAX = 64 * 1024 * 1024;
export const CAP_DEFAULT = 5 * 1024 ** 3;
export const TRASH = '.conclave-trash';
export const TRASH_DAYS = 30;
export const RECHECK_MS = 24 * 3600_000;
const PAGE = 500;
const MAX_REFUSED = 50;
const POOL = 4;

export class Revoked extends Error { constructor(m) { super(m); this.revoked = true; } }
export class HubPaused extends Error { constructor(m) { super(m); this.hubPaused = true; } }

const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampOf = (d) => `${dayOf(d)} ${pad(d.getHours())}${pad(d.getMinutes())}`;
const hashOf = (rev) => (typeof rev === 'string' && rev.startsWith('sha256:') ? rev.slice(7) : null);

export async function hashFile(file) {
  const h = createHash('sha256');
  await new Promise((res, rej) => { const s = createReadStream(file); s.on('data', (c) => h.update(c)); s.on('end', res); s.on('error', rej); });
  return h.digest('hex');
}
const lstatOrNull = async (p) => { try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } })); };

/** The engine for one sync record. `os` and `now` are only for tests. */
export function createEngine({ home, rec: rec0, api, log = () => {}, os = process.platform, now = () => new Date() }) {
  const id = rec0.id;
  let rec = rec0;
  const root = rec0.folder;
  const cap = rec0.cap_bytes ?? CAP_DEFAULT;
  const sv = (patch) => { rec = updateSync(home, id, patch) ?? rec; return rec; };

  // ── hub calls ────────────────────────────────────────────────────────────────────────────────────────────────
  const call = async (method, p, body) => {
    const r = await api.json(method, p, body);
    if (r.status === 401) throw new Revoked('the hub no longer accepts this reader');
    if (r.status === 403 && r.json?.error === 'paused') throw new HubPaused('the reader is paused on the hub');
    if (r.status === 426) throw Object.assign(new Error('this hub does not support vault sync version 1'), { fatal: true });
    return r;
  };

  // ── the trash ────────────────────────────────────────────────────────────────────────────────────────────────
  const trashRoot = path.join(root, TRASH);
  async function trashDir() {
    const st = await lstatOrNull(trashRoot);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error('the trash folder is not a plain folder');
    await fs.mkdir(trashRoot, { recursive: true });
    return trashRoot;
  }
  async function freeName(p) {
    if (!(await lstatOrNull(fsPath(p, os)))) return p;
    const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
    for (let n = 2; n < 1000; n++) { const c = `${base} (${n})${ext}`; if (!(await lstatOrNull(fsPath(c, os)))) return c; }
    return `${base} (${randomBytes(3).toString('hex')})${ext}`;
  }
  /** Moves a file of the mirror into today's trash (`name (local <date>).ext` when it is a local edit). Returns the new place. */
  async function toTrash(abs, rel, { edit = false } = {}) {
    await trashDir();
    const d = now(), dir = path.join(trashRoot, dayOf(d), ...rel.split('/').slice(0, -1));
    const base = rel.split('/').at(-1), ext = path.extname(base);
    const name = edit ? `${base.slice(0, base.length - ext.length)} (local ${stampOf(d)})${ext}` : base;
    await fs.mkdir(fsPath(dir, os), { recursive: true });
    const dest = await freeName(path.join(dir, name));
    await fs.rename(fsPath(abs, os), fsPath(dest, os));
    return dest;
  }
  async function dirSize(dir) {
    let n = 0;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += await dirSize(p); else if (e.isFile()) n += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
    }
    return n;
  }
  /** Empties trash older than 30 days, then the oldest days until the trash fits the size cap. */
  async function pruneTrash() {
    const days = (await fs.readdir(trashRoot).catch(() => [])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!days.length) return;
    const t = now(), keepFrom = dayOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() - TRASH_DAYS));
    let left = [];
    for (const d of days) { if (d < keepFrom) await fs.rm(path.join(trashRoot, d), { recursive: true, force: true }); else left.push(d); }
    let total = 0; const sizes = new Map();
    for (const d of left) { const s = await dirSize(path.join(trashRoot, d)); sizes.set(d, s); total += s; }
    while (total > cap && left.length > 1) { const d = left.shift(); await fs.rm(path.join(trashRoot, d), { recursive: true, force: true }); total -= sizes.get(d); }
    if (total > cap && left.length === 1) { await fs.rm(path.join(trashRoot, left[0]), { recursive: true, force: true }); }
    await fs.rm(path.join(trashRoot, '.tmp'), { recursive: true, force: true }).catch(() => {}); // an interrupted download's leftovers
  }

  // ── one run's bookkeeping ────────────────────────────────────────────────────────────────────────────────────
  const refuse = (run, rel, why) => { run.refused++; if (run.refusedList.length < MAX_REFUSED) run.refusedList.push({ path: rel, reason: why }); log(`${rec.name}: ${rel} refused (${why})`); };
  const setEntry = (run, mf, rel, e) => { run.bytesNow += e.size - (mf.files[rel]?.size ?? 0); mf.files[rel] = e; };
  const dropEntry = (run, mf, rel) => { if (mf.files[rel]) { run.bytesNow -= mf.files[rel].size; delete mf.files[rel]; } };
  const totalOf = (mf) => { let files = 0, bytes = 0; for (const f of Object.values(mf.files)) { files++; bytes += f.size; } return { files, bytes }; };

  /** Is the local file at `abs` the version the mirror last wrote? `unknown` when the manifest has no record. */
  async function localState(abs, mfEntry) {
    const st = await lstatOrNull(fsPath(abs, os));
    if (!st) return { exists: false };
    if (!st.isFile()) return { exists: true, odd: true };
    if (mfEntry && mfEntry.size === st.size && mfEntry.mtime === Math.round(st.mtimeMs)) return { exists: true, hash: hashOf(mfEntry.rev), st, cached: true };
    return { exists: true, hash: await hashFile(fsPath(abs, os)), st };
  }

  /** Makes the file `rel` hold the hub's revision. Never throws for a refused path; errors on a download are thrown. */
  async function applyFile(run, mf, rel, revision, size, { held = new Set() } = {}) {
    const why = relRefusal(rel, os);
    if (why) return refuse(run, rel, why);
    if (held.has(rel)) return;
    if (size != null && size > FILE_MAX) return refuse(run, rel, 'larger than the 64 MiB limit');
    const t = await safeTarget(root, rel, os);
    if (!t.ok) return refuse(run, rel, t.reason);
    const abs = t.abs, entry = mf.files[rel];
    const want = hashOf(revision);
    const ls = await localState(abs, entry);
    if (ls.odd) return refuse(run, rel, 'not a plain file');
    if (ls.exists && want && ls.hash === want) {
      setEntry(run, mf, rel, { rev: revision, size: ls.st.size, mtime: Math.round(ls.st.mtimeMs) });
      return;
    }
    const grown = (size ?? 0) - (entry?.size ?? 0);
    if (grown > 0 && run.bytesNow + (run.reserved ?? 0) + grown > cap) { run.capped = true; return refuse(run, rel, 'the size cap of this sync is reached'); }
    const hold = Math.max(grown, 0); run.reserved = (run.reserved ?? 0) + hold;
    await fs.mkdir(path.join(root, TRASH, '.tmp'), { recursive: true });
    const tmp = path.join(root, TRASH, '.tmp', randomBytes(8).toString('hex'));
    let got;
    try {
      got = await api.download(`/vault-sync/v1/files/content?${q({ path: rel, version: 1 })}`, tmp);
      if (got.status === 401) throw new Revoked('the hub no longer accepts this reader');
      if (got.status === 403) return refuse(run, rel, 'the hub no longer lets this reader take it');
      if (got.status === 413) return refuse(run, rel, 'larger than the 64 MiB limit');
      if (got.status === 404) { dropEntry(run, mf, rel); return; }
      if (got.status !== 200) throw new Error(`the hub answered ${got.status} for a file`);
      const ok = got.sha256 && (got.sha256 === want || `sha256:${got.sha256}` === got.revision);
      if (!ok) throw new Error(`a file arrived with the wrong content hash (${rel})`);
      if (got.bytes > FILE_MAX) return refuse(run, rel, 'larger than the 64 MiB limit');
      // A local edit (or a file the mirror did not write) is kept before it is replaced.
      const cur = await localState(abs, entry);
      if (cur.exists && cur.hash !== got.sha256) {
        const mine = entry && hashOf(entry.rev) === cur.hash;
        if (!mine) { await toTrash(abs, rel, { edit: true }); run.kept++; }
      }
      await fs.mkdir(fsPath(path.dirname(abs), os), { recursive: true });
      await fs.rename(fsPath(tmp, os), fsPath(abs, os));
      const st = await fs.stat(fsPath(abs, os));
      setEntry(run, mf, rel, { rev: `sha256:${got.sha256}`, size: st.size, mtime: Math.round(st.mtimeMs) });
      run.files++; run.bytes += st.size;
    } finally { run.reserved -= hold; await fs.rm(tmp, { force: true }).catch(() => {}); }
  }

  /** A file the hub no longer lists for this reader: into the trash, out of the manifest. A file already gone is just forgotten. */
  async function removeFile(run, mf, rel) {
    const entry = mf.files[rel];
    if (!entry) return;
    const t = await safeTarget(root, rel, os);
    if (!t.ok) { dropEntry(run, mf, rel); return refuse(run, rel, t.reason); }
    const st = await lstatOrNull(fsPath(t.abs, os));
    if (st?.isFile()) { await toTrash(t.abs, rel); run.trashed++; }
    dropEntry(run, mf, rel);
    for (let d = path.dirname(t.abs); d.length > root.length && d !== root; d = path.dirname(d)) { try { await fs.rmdir(fsPath(d, os)); } catch { break; } }
  }

  // ── the passes ───────────────────────────────────────────────────────────────────────────────────────────────
  /** A full listing: keep what is there, fetch what differs, trash what is not. */
  async function fullPass(run, mf) {
    const listed = new Map();
    let after = null, cursor = null;
    for (;;) {
      const r = await call('GET', `/vault-sync/v1/files?${q({ limit: PAGE, after, version: 1 })}`);
      if (r.status !== 200 || !Array.isArray(r.json?.files)) throw new Error(`the hub answered ${r.status} to the listing`);
      if (cursor === null && r.json.cursor) cursor = r.json.cursor;
      for (const f of r.json.files) listed.set(f.path, f);
      if (!r.json.next) break;
      after = r.json.next;
    }
    if (!cursor) throw new Error('the hub gave no cursor with the listing');
    // Names that are the same file here: neither is written; an old mirror copy of one stays as it is.
    const byKey = new Map();
    for (const p of listed.keys()) { const k = collisionKey(p, os); const g = byKey.get(k); if (g) g.push(p); else byKey.set(k, [p]); }
    const held = new Set();
    for (const g of byKey.values()) if (g.length > 1) { for (const p of g) { held.add(p); refuse(run, p, `its name collides with ${g.filter((x) => x !== p).join(', ')}`); } }
    const work = [...listed.values()].filter((f) => !held.has(f.path));
    const failed = [];
    await pool(work, POOL, async (f) => { try { await applyFile(run, mf, f.path, f.revision, f.size, { held }); } catch (e) { if (e.revoked || e.hubPaused) throw e; failed.push(f.path); run.errors.push(`${f.path}: ${e.message}`); } });
    // The hub's list is the truth for what a reader may keep: everything else the mirror wrote goes to the trash.
    // (A file that failed or was refused above stays put until the next run.)
    for (const rel of Object.keys(mf.files)) if (!listed.has(rel)) await removeFile(run, mf, rel);
    saveManifest(home, id, mf);
    run.full = true;
    // A file that could not be fetched keeps the next run a full one: the cursor moves only when the listing is whole.
    if (!failed.length) sv({ cursor, last_full_at: now().toISOString() }); else run.needRetry = true;
  }

  /** The changes after the cursor, page by page; a `reset` becomes a full pass. */
  async function followPass(run, mf) {
    for (;;) {
      const r = await call('GET', `/vault-sync/v1/changes?${q({ cursor: rec.cursor, limit: 200, version: 1 })}`);
      if (r.status !== 200 || !Array.isArray(r.json?.changes)) throw new Error(`the hub answered ${r.status} to the changes`);
      if (r.json.reset) { await fullPass(run, mf); return; }
      const failed = [];
      for (const c of r.json.changes) {
        try {
          if (c.kind === 'delete') await removeFile(run, mf, c.path);
          else if (c.kind === 'rename') await renameFile(run, mf, c.from, c.path, c.revision);
          else await putChange(run, mf, c.path, c.revision, c.size);
        } catch (e) { if (e.revoked || e.hubPaused) throw e; failed.push(c.path); run.errors.push(`${c.path}: ${e.message}`); }
      }
      saveManifest(home, id, mf);
      // A change that could not be applied is not skipped over: the cursor stays and the next run lists again.
      if (failed.length) { run.needFull = true; return; }
      sv({ cursor: r.json.cursor });
      if (!r.json.more) return;
    }
  }

  /** One put: refused when another name in the mirror is the same file here. */
  async function putChange(run, mf, rel, revision, size) {
    const k = collisionKey(rel, os);
    const other = Object.keys(mf.files).find((p) => p !== rel && collisionKey(p, os) === k);
    if (other) return refuse(run, rel, `its name collides with ${other}`);
    await applyFile(run, mf, rel, revision, size);
  }

  async function renameFile(run, mf, from, to, revision) {
    const a = mf.files[from];
    const ta = a ? await safeTarget(root, from, os) : null, tb = await safeTarget(root, to, os);
    if (relRefusal(to, os)) return refuse(run, to, relRefusal(to, os));
    if (!tb.ok) return refuse(run, to, tb.reason);
    const k = collisionKey(to, os);
    const other = Object.keys(mf.files).find((p) => p !== from && p !== to && collisionKey(p, os) === k);
    if (other) return refuse(run, to, `its name collides with ${other}`);
    if (a && ta?.ok && !(await lstatOrNull(fsPath(tb.abs, os))) && (await lstatOrNull(fsPath(ta.abs, os)))?.isFile()) {
      await fs.mkdir(fsPath(path.dirname(tb.abs), os), { recursive: true });
      await fs.rename(fsPath(ta.abs, os), fsPath(tb.abs, os));
      mf.files[to] = a; delete mf.files[from];
      for (let d = path.dirname(ta.abs); d.length > root.length && d !== root; d = path.dirname(d)) { try { await fs.rmdir(fsPath(d, os)); } catch { break; } }
      run.renamed++;
    }
    await applyFile(run, mf, to, revision, null); // the content: nothing to fetch when the renamed file already matches
  }

  // ── one run ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** Runs once: a full pass when asked, when there is no cursor, or when one is due; else the changes. Returns a summary. */
  async function runOnce({ full = false } = {}) {
    const run = { bytesNow: 0, files: 0, bytes: 0, trashed: 0, kept: 0, renamed: 0, refused: 0, refusedList: [], errors: [], full: false, capped: false, needFull: false };
    if (rec.state !== 'active') return { ...run, skipped: rec.state };
    try {
      const st = await fs.stat(root).catch(() => null);
      if (!st?.isDirectory()) throw Object.assign(new Error('the sync folder is missing'), { fatal: true });
      const mf = loadManifest(home, id);
      run.bytesNow = totalOf(mf).bytes;
      const due = !rec.last_full_at || now() - new Date(rec.last_full_at) > RECHECK_MS;
      if (full || !rec.cursor || due) await fullPass(run, mf); else await followPass(run, mf);
      if (run.needFull && !run.full) await fullPass(run, mf);
      if (run.needRetry) run.errors.push('some files could not be fetched; the next run lists again');
      const tot = totalOf(mf);
      await pruneTrash().catch((e) => log(`${rec.name}: the trash could not be tidied (${e.message})`));
      const warnings = [];
      if (run.capped) warnings.push(`This sync reached its size cap (${Math.round(cap / 1024 ** 3)} GB); some files are not mirrored.`);
      if (run.refused) warnings.push(`${run.refused} file${run.refused === 1 ? '' : 's'} could not be mirrored; see sync list.`);
      sv({ files: tot.files, bytes: tot.bytes, last_run_at: now().toISOString(), last_error: run.errors.length ? run.errors[0] : null, warnings, refused: run.full ? run.refusedList : [...rec.refused, ...run.refusedList].filter((x, i, a) => a.findIndex((y) => y.path === x.path) === i).slice(0, MAX_REFUSED) });
      if (run.files || run.trashed || run.renamed || run.full || run.kept) {
        const rr = await call('POST', '/vault-sync/v1/runs', { files: tot.files, bytes: tot.bytes, version: 1 }).catch((e) => { if (e.revoked) throw e; return null; });
        if (rr && rr.status === 200) sv({ reported_at: now().toISOString() });
      }
      return { ...run, total: tot };
    } catch (e) {
      if (e.revoked) {
        sv({ state: 'revoked', revoked_at: now().toISOString(), last_error: 'The hub removed this reader or revoked its key, so the sync stopped. The mirror and its trash are still on disk; delete them if you do not want them.' });
        log(`${rec.name}: the hub no longer accepts this reader; the sync stopped and the files stay`);
        return { ...run, revoked: true };
      }
      if (e.hubPaused) { sv({ last_error: 'This reader is paused on the hub.' }); return { ...run, hubPaused: true }; }
      sv({ last_error: String(e.message).slice(0, 300) });
      log(`${rec.name}: a run failed (${e.message})`);
      return { ...run, failed: e.message };
    }
  }

  /** How many mirrored files hold local edits now (size or time changed, then a hash that differs from the hub's). */
  async function countLocalEdits() {
    const mf = loadManifest(home, id);
    let n = 0;
    for (const [rel, e] of Object.entries(mf.files)) {
      const t = await safeTarget(root, rel, os);
      if (!t.ok) continue;
      const st = await lstatOrNull(fsPath(t.abs, os));
      if (!st?.isFile()) continue;
      if (st.size === e.size && Math.round(st.mtimeMs) === e.mtime) continue;
      if ((await hashFile(fsPath(t.abs, os)).catch(() => null)) !== hashOf(e.rev)) n++;
    }
    sv({ local_edits: n });
    return n;
  }

  /**
   * How many files in the mirror folder the mirror did not write and the hub does not have (created here by a person or a tool).
   * They are never uploaded and never touched; the count is for the warning. The trash folder is not looked at. A look only.
   */
  async function countLocalNew() {
    const mf = loadManifest(home, id);
    let n = 0, seen = 0;
    const walk = async (dir, rel) => {
      for (const e of await fs.readdir(fsPath(dir, os), { withFileTypes: true }).catch(() => [])) {
        if (++seen > 50_000) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (!rel && e.name === TRASH) continue;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.isFile() && !mf.files[r]) n++;
      }
    };
    await walk(root, '');
    sv({ local_new: n });
    return n;
  }

  return { runOnce, countLocalEdits, countLocalNew, pruneTrash, get rec() { return rec; } };
}
