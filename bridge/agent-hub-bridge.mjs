#!/usr/bin/env node
// Agent Hub bridge. Single file, no dependencies, Node 24+.
//   node agent-hub-bridge.mjs pair <hub-url> <pairing-code>   one-time pairing
//   node agent-hub-bridge.mjs run                              heartbeat / job loop
// Config: ~/.agent-hub/bridge.json {"hub": "...", "bridge_key": "ah_brg_..."}  (key file is mode 600; AGENT_HUB_HOME overrides the folder)
// The bridge never touches a path outside the folders the hub reports as approved.
import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const VERSION = '0.4.0';
const CONFIG_DIR = process.env.AGENT_HUB_HOME ? path.resolve(process.env.AGENT_HUB_HOME) : path.join(homedir(), '.agent-hub');
const CONFIG_FILE = path.join(CONFIG_DIR, 'bridge.json');

function safeWindowsPath(value) {
  const p = value.replaceAll('/', '\\');
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/i.test(p) || /^\\\\[?.]\\/.test(p)) return false;
  return p.replace(/^[a-z]:/i, '').split('\\').every((part) =>
    part === '.' || part === '..' || !(/[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)));
}

/** Pure check: is `target` inside one of `allowed` (absolute folders)? Lexical, after normalisation. */
export function isPathAllowed(target, allowed, os = platform()) {
  if (typeof target !== 'string' || target === '' || target.includes('\0')) return false;
  const win = os === 'win32';
  const p = win ? path.win32 : path.posix;
  if (!p.isAbsolute(target) || (win && !safeWindowsPath(target))) return false;
  const norm = (s) => { const n = p.resolve(s); return win ? n.toLowerCase() : n; };
  const t = norm(target);
  return (allowed ?? []).some((a) => {
    if (typeof a !== 'string' || !p.isAbsolute(a) || (win && !safeWindowsPath(a))) return false;
    const root = norm(a);
    if (t === root) return true;
    const rel = p.relative(root, t);
    return rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
  });
}

/** Check every existing component below an approved directory, including the target. */
export async function checkPath(target, allowed) {
  const os = platform();
  if (!isPathAllowed(target, allowed, os)) return false;
  const segments = (p) => os === 'win32' ? p.split(/[\\/]/) : p.split('/');
  if (segments(target).includes('..')) return false;
  const resolved = path.resolve(target);
  for (const root of allowed) {
    if (!isPathAllowed(resolved, [root], os) || segments(root).includes('..')) continue;
    let cur = path.resolve(root);
    try {
      if (!(await fs.lstat(cur)).isDirectory()) continue;
      const realRoot = await fs.realpath(cur);
      for (const part of path.relative(cur, resolved).split(path.sep).filter(Boolean)) {
        cur = path.join(cur, part);
        const st = await fs.lstat(cur).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
        if (!st) return true;
        if (st.isSymbolicLink() || !isPathAllowed(await fs.realpath(cur), [realRoot], os)) return false;
      }
      return true;
    } catch { /* fail closed for this root */ }
  }
  return false;
}

/** Is absolute `target` at or below absolute `root`? Case-insensitive on Windows and macOS, whose usual file systems are. */
export function isInside(target, root, os = platform()) {
  const p = os === 'win32' ? path.win32 : path.posix;
  const fold = os === 'win32' || os === 'darwin';
  const norm = (s) => { const n = p.resolve(s); return fold ? n.normalize('NFC').toLowerCase() : n; };
  const rel = p.relative(norm(root), norm(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** Real path of `p`; for a path that does not exist yet, the real path of its deepest existing parent plus the rest. */
async function realOrParent(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest); } catch (e) {
      const up = path.dirname(cur);
      if (!['ENOENT', 'ENOTDIR'].includes(e?.code) || up === cur) throw e;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

let configReal; // realpath of CONFIG_DIR, resolved once
/** Does `target` reach the bridge configuration folder under any spelling (8.3 short name, case variant, link)? */
export async function inConfigDir(target) {
  if (isInside(target, CONFIG_DIR)) return true;
  configReal ??= realOrParent(CONFIG_DIR);
  return isInside(await realOrParent(target), await configReal);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms, signal) => delay(ms, undefined, { signal });

function hubUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('hub URL must be HTTP(S) without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

async function readConfig() {
  const cfg = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  if (!/^ah_brg_[a-z2-7]{12}_[a-z2-7]{32}$/.test(cfg?.bridge_key)) throw new Error('invalid bridge key in local configuration');
  return { hub: hubUrl(cfg.hub), bridge_key: cfg.bridge_key };
}

async function pair(hub, code) {
  if (!hub || !code) throw new Error('usage: pair <hub-url> <pairing-code>');
  hub = hubUrl(hub);
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(CONFIG_DIR, `bridge-${randomUUID()}.tmp`);
  const file = await fs.open(tmp, 'wx', 0o600);
  try {
    const res = await fetch(`${hub}/bridge/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ pairing_code: code, os: platform(), version: VERSION }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !/^ah_brg_[a-z2-7]{12}_[a-z2-7]{32}$/.test(data.bridge_key)) throw new Error(`pairing failed (HTTP ${res.status})`);
    await file.writeFile(JSON.stringify({ hub, bridge_key: data.bridge_key }, null, 2));
    await file.sync();
    await file.close();
    await fs.rename(tmp, CONFIG_FILE);
    log(`paired successfully. Configuration: ${CONFIG_FILE}`);
  } finally {
    await file.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}

// ───────────────────────── transfers ─────────────────────────
// Stream format "AHT1" (shared with the hub): entries of [u32be header length][JSON {"p": path, "s": size}][bytes], ended by a zero length.
const BLOCK = 1024 * 1024;
const MAX_HEADER = 4096;
const MAX_ENTRIES = 100_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const THROTTLE_MS = Number(process.env.AGENT_HUB_THROTTLE_MS ?? 0);
// Floor between long polls. The hub holds empty polls (25 s) and reads (20 s), but an instant answer
// (a proxy, an older hub, a job this bridge rejects and the hub keeps offering) must not spin.
const MIN_POLL_MS = 1000;
const pollFloor = (since) => Math.max(0, MIN_POLL_MS - (Date.now() - since));
class Fatal extends Error {}   // report to the hub; the channel fails
class Gone extends Error {}    // the hub says the channel is over; stop quietly
class Unavailable extends Error {} // key or PC unavailable; preserve resumable state
class Restart extends Error {} // resume from the hub's offset

export function frameHeader(p, s) {
  const h = Buffer.from(JSON.stringify({ p, s }), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
  return Buffer.concat([len, h]);
}
const FRAME_END = Buffer.alloc(4);

/** .gitignore patterns of one folder -> matcher(relPathFromThatFolder, isDir) -> true / false / null (no match). */
export function parseIgnore(text) {
  const rules = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    let re = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '*' && line[i + 1] === '*') {
        if (line[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    rules.push({ neg, dirOnly, re: new RegExp(anchored ? `^${re}(?:/.*)?$` : `(?:^|.*/)${re}(?:/.*)?$`) });
  }
  return (rel, isDir) => {
    let res = null;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) res = !r.neg;
    }
    return res;
  };
}

const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);
const isEnvFile = (n) => /^\.env(?:\.|$)/i.test(n);

export async function requirePath(target, allowed) {
  // Compare real paths: a lexical check misses C:\Users\X\AGENT-~1 or ~/.AGENT-HUB and would expose the bridge key.
  // An error while resolving counts as inside (fail closed).
  if (await inConfigDir(target).catch(() => true) || !(await checkPath(target, allowed()))) {
    throw new Fatal('path outside the allowed folders or inside bridge configuration');
  }
}

async function openRegular(file, flags, mode = 0o600) {
  const before = await fs.lstat(file).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (before && (!before.isFile() || (flags & constants.O_APPEND && before.nlink !== 1))) {
    throw new Fatal('unsafe local file');
  }
  const handle = await fs.open(file, flags | NO_FOLLOW | (!before && flags & constants.O_CREAT ? constants.O_EXCL : 0), mode);
  try {
    const current = await fs.lstat(file);
    const opened = await handle.stat();
    if (!current.isFile() || !opened.isFile() || current.dev !== opened.dev || current.ino !== opened.ino ||
        (before && (before.dev !== opened.dev || before.ino !== opened.ino)) ||
        (flags & constants.O_APPEND && opened.nlink !== 1)) throw new Fatal('local file changed while opening');
    return handle;
  } catch (e) {
    await handle.close();
    throw e;
  }
}

function safeEntry(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    !/[\\\x00-\x1f]/.test(value) && !/^[a-z]:/i.test(value) &&
    value.split('/').every((p) => p && p !== '.' && p !== '..') &&
    (platform() !== 'win32' || safeWindowsPath(`C:\\${value}`));
}

function addEntry(out, entry) {
  if (out.length >= MAX_ENTRIES || !safeEntry(entry.rel)) throw new Fatal('unsafe path or too many files in stream');
  out.push(entry);
}

async function walk(dir, prefix, out, chain, check) {
  await check(dir);
  let ig = null;
  const ignore = path.join(dir, '.gitignore');
  const ruleFile = await fs.lstat(ignore).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (ruleFile?.isFile()) {
    await check(ignore);
    if (ruleFile.size > BLOCK) throw new Fatal('.gitignore exceeds 1 MiB');
    const fh = await openRegular(ignore, constants.O_RDONLY);
    try { ig = parseIgnore(await fh.readFile('utf8')); } finally { await fh.close(); }
  }
  const here = ig ? [...chain, { dir, ig }] : chain;
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const d of entries) {
    if (d.isSymbolicLink()) continue;
    const abs = path.join(dir, d.name);
    const isDir = d.isDirectory();
    if (ALWAYS_SKIP_DIRS.has(d.name.toLowerCase())) continue;
    if (!isDir && isEnvFile(d.name)) continue;
    if (!isDir && !d.isFile()) continue;
    let ignored = false;
    for (const c of here) {
      const r = c.ig(path.relative(c.dir, abs).split(path.sep).join('/'), isDir);
      if (r !== null) ignored = r;
    }
    if (ignored) continue;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (isDir) await walk(abs, rel, out, here, check);
    else {
      await check(abs);
      const stat = await fs.lstat(abs);
      if (!stat.isFile()) throw new Fatal('source changed while planning transfer');
      addEntry(out, { abs, rel, size: stat.size, stat });
    }
  }
}

/** The files of a send job: a single file, a folder (relative to it) or several paths (each under its own name). */
export async function buildPlan(paths, raw, check = async () => {}) {
  const entries = [];
  const wholeFolder = paths.length === 1;
  for (const p of paths) {
    await check(p);
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) throw new Fatal('symbolic links are not sent');
    if (st.isFile()) {
      if (isEnvFile(path.basename(p)) || path.resolve(p).split(path.sep).some((part) => ALWAYS_SKIP_DIRS.has(part.toLowerCase()))) {
        throw new Fatal('excluded file or directory');
      }
      addEntry(entries, { abs: p, rel: path.basename(p), size: st.size, stat: st });
    }
    else if (st.isDirectory()) {
      if (raw) throw new Fatal('this transfer carries one file, not a folder');
      if (path.resolve(p).split(path.sep).some((part) => ALWAYS_SKIP_DIRS.has(part.toLowerCase()))) throw new Fatal('excluded directory');
      await walk(p, wholeFolder ? '' : path.basename(p), entries, [], check);
    } else throw new Fatal('not a regular file or folder');
  }
  if (raw && entries.length !== 1) throw new Fatal('this transfer carries exactly one file');
  if (new Set(entries.map((e) => e.rel)).size !== entries.length) throw new Fatal('duplicate entry paths');
  const total = raw ? entries[0].size : entries.reduce((n, e) => n + frameHeader(e.rel, e.size).length + e.size, 0) + 4;
  return { entries, total, raw };
}

/** The bytes of a plan, in order, as Buffers of at most 256 KB. */
export async function* planBytes(plan, check = async () => {}) {
  const buf = Buffer.alloc(256 * 1024);
  for (const e of plan.entries) {
    if (!plan.raw) yield frameHeader(e.rel, e.size);
    await check(e.abs);
    const fh = await openRegular(e.abs, constants.O_RDONLY);
    try {
      const unchanged = (st) => st.nlink === 1 && st.dev === e.stat.dev && st.ino === e.stat.ino && st.size === e.size &&
        st.mtimeMs === e.stat.mtimeMs && st.ctimeMs === e.stat.ctimeMs;
      if (!unchanged(await fh.stat())) throw new Fatal('source changed while preparing transfer');
      let left = e.size;
      while (left > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), null);
        if (bytesRead === 0) throw new Fatal(`${e.rel} changed while it was being sent`);
        left -= bytesRead;
        yield Buffer.from(buf.subarray(0, bytesRead));
      }
      if (!unchanged(await fh.stat())) throw new Fatal('source changed while sending');
    } finally { await fh.close(); }
  }
  if (!plan.raw) yield FRAME_END;
}

function makeApi(cfg, signal) {
  const auth = { authorization: `Bearer ${cfg.bridge_key}` };
  return (method, p, { body, headers, timeout = 60_000 } = {}) =>
    fetch(`${cfg.hub}${p}`, { method, headers: { ...auth, ...headers }, body, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
}
const jsonOf = async (res) => res.json().catch(() => ({}));
const JSON_HDR = { 'content-type': 'application/json' };
function checkJobResponse(res) {
  if (res.status === 401) throw new Unavailable();
  if ([403, 404, 410].includes(res.status)) throw new Gone();
  if ([400, 413, 422].includes(res.status)) throw new Fatal(`hub rejected transfer request (HTTP ${res.status})`);
}

async function sendJob(job, ctx) {
  const { api, allowed, log, signal } = ctx;
  const paths = job.local_paths ?? [job.local_path];
  const raw = job.framing === 'raw';
  const st0 = await api('GET', `/bridge/channels/${job.channel_id}?role=send`);
  const st = await jsonOf(st0);
  checkJobResponse(st0);
  if (!st0.ok) throw new Error(`state answered ${st0.status}`);
  if (st.status !== 'open' || st.sender_done) throw new Gone();
  const check = (p) => requirePath(p, allowed);
  const plan = await buildPlan(paths, raw, check);
  const resume = st.received_offset ?? 0;
  if (!Number.isSafeInteger(resume) || resume < 0 || resume > plan.total) throw new Fatal('invalid resume offset or source changed');
  const sha = createHash('sha256');
  let pos = 0, block = [], blockLen = 0, blockStart = resume;
  const put = async (body, offset) => {
    for (;;) {
      const res = await api('PUT', `/bridge/channels/${job.channel_id}/chunk?offset=${offset}`, { body, headers: { 'content-type': 'application/octet-stream', 'x-ah-total': String(plan.total) } });
      if (res.ok) { await res.arrayBuffer(); return; }
      const j = await jsonOf(res);
      if (res.status === 409) throw new Restart(`hub expects offset ${j.expected}`);
      if (res.status === 429) { await sleep(Math.min(5000, Math.max(100, Number(j.retry_after_ms) || 300)), signal); continue; }
      checkJobResponse(res);
      throw new Error(`upload answered ${res.status}`);
    }
  };
  const sendBlock = async (body) => { await put(body, blockStart); blockStart += body.length; if (THROTTLE_MS) await sleep(THROTTLE_MS, signal); };
  for await (let chunk of planBytes(plan, check)) {
    signal.throwIfAborted();
    sha.update(chunk);
    const start = pos; pos += chunk.length;
    if (pos <= resume) continue;
    if (start < resume) chunk = chunk.subarray(resume - start);
    block.push(chunk); blockLen += chunk.length;
    if (blockLen >= BLOCK) {
      const all = Buffer.concat(block, blockLen);
      let at = 0;
      while (all.length - at >= BLOCK) { await sendBlock(all.subarray(at, at + BLOCK)); at += BLOCK; }
      block = at < all.length ? [all.subarray(at)] : []; blockLen = all.length - at;
    }
  }
  if (pos !== plan.total) throw new Fatal('the source changed while it was being read');
  if (blockLen > 0) await sendBlock(Buffer.concat(block, blockLen));
  else if (plan.total === 0) await put(Buffer.alloc(0), 0);
  const res = await api('POST', `/bridge/channels/${job.channel_id}/done`, { body: JSON.stringify({ sha256: sha.digest('hex'), role: 'send' }), headers: JSON_HDR });
  const j = await jsonOf(res);
  checkJobResponse(res);
  if (res.status === 409) throw new Restart('incomplete');
  if (!res.ok) throw new Error(`done answered ${res.status}`);
  log(`sent ${job.channel_id} (${plan.total} bytes): ${j.status}`);
}

async function receiveJob(job, ctx) {
  const { api, allowed, log, signal } = ctx;
  const raw = job.framing === 'raw';
  const target = job.save_to;
  const check = (p) => requirePath(p, allowed);
  await check(target);
  const dir = raw ? path.dirname(target) : target;
  const part = raw ? `${target}.ah-${job.channel_id}.part` : path.join(target, `.ah-${job.channel_id}.part`);
  await check(part);
  await fs.mkdir(dir, { recursive: true });
  await check(part);
  const sha = createHash('sha256');
  let offset = 0;
  const wf = await openRegular(part, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT);
  let total = null;
  try {
    const b = Buffer.alloc(BLOCK);
    const size = (await wf.stat()).size;
    while (offset < size) {
      signal.throwIfAborted();
      const { bytesRead } = await wf.read(b, 0, Math.min(b.length, size - offset), offset);
      if (!bytesRead) throw new Fatal('partial download changed on disk');
      sha.update(b.subarray(0, bytesRead));
      offset += bytesRead;
    }
    for (;;) {
      await check(part);
      const asked = Date.now();
      const res = await api('GET', `/bridge/channels/${job.channel_id}/chunk?offset=${offset}&role=receive`, { timeout: 45_000 });
      if (res.status === 204) { await res.arrayBuffer(); await sleep(pollFloor(asked), signal); continue; }
      if ([401, 403, 404, 410].includes(res.status)) { await res.body?.cancel(); checkJobResponse(res); }
      if (res.status === 409) {
        const { available } = await jsonOf(res);
        if (!Number.isSafeInteger(available) || available < 0 || available >= offset) throw new Fatal('invalid download resume offset');
        // A restarted hub can rewind to the last offset it confirmed.
        await check(part);
        await wf.truncate(available);
        throw new Restart('hub rewound the download');
      }
      if (!res.ok) throw new Error(`download answered ${res.status}`);
      const expected = res.headers.get('x-ah-total');
      const size = Number(expected);
      if (expected === null || !Number.isSafeInteger(size) || size < offset || (total !== null && total !== size)) {
        await res.body?.cancel();
        throw new Fatal('invalid download size');
      }
      total = size;
      const data = await readChunk(res, Math.min(BLOCK, total - offset));
      const eof = res.headers.get('x-ah-eof') === '1';
      if (!data.length && !eof) throw new Fatal('empty download chunk before end of stream');
      if (data.length > 0) {
        await check(part);
        await writeAll(wf, data);
        await wf.datasync();
        sha.update(data);
        offset += data.length;
        if (THROTTLE_MS) await sleep(THROTTLE_MS, signal);
      }
      if (eof) break;
    }
  } finally { await wf.close(); }
  if (offset !== total) throw new Fatal('the stream ended at the wrong size');
  const dres = await api('POST', `/bridge/channels/${job.channel_id}/done`, { body: JSON.stringify({ sha256: sha.digest('hex'), role: 'receive' }), headers: JSON_HDR });
  let state = await jsonOf(dres);
  checkJobResponse(dres);
  if (!dres.ok) throw new Error(`done answered ${dres.status}`);
  while (state.status === 'open' && !state.verified) {
    await sleep(500, signal);
    const res = await api('GET', `/bridge/channels/${job.channel_id}?role=receive`);
    state = await jsonOf(res);
    checkJobResponse(res);
    if (!res.ok) throw new Error(`state answered ${res.status}`);
  }
  if (!(state.status === 'open' && state.verified)) throw new Gone();
  await check(part);
  if (raw) {
    const fh = await openRegular(part, constants.O_RDONLY);
    try { await publishFile(fh, 0, offset, target, check, signal); } finally { await fh.close(); }
  } else {
    const n = await extract(part, target, allowed, signal);
    log(`received ${job.channel_id}: ${n} files`);
  }
  const cres = await api('POST', `/bridge/channels/${job.channel_id}/done`, { body: JSON.stringify({ role: 'receive', committed: true }), headers: JSON_HDR });
  const committed = await jsonOf(cres);
  checkJobResponse(cres);
  if (!cres.ok) throw new Error(`commit answered ${cres.status}`);
  if (committed.status !== 'done') throw new Gone();
  await cleanupPart(job, allowed);
}

async function readChunk(response, max) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > max) throw new Fatal('download chunk exceeds its advertised size');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function writeAll(file, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Fatal('local write made no progress');
    offset += bytesWritten;
  }
}

async function publishFile(source, start, size, out, check, signal) {
  await check(out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmp = path.join(path.dirname(out), `.ah-write-${randomUUID()}.tmp`);
  await check(tmp);
  const wf = await fs.open(tmp, 'wx', 0o600);
  try {
    const b = Buffer.alloc(Math.min(256 * 1024, size));
    for (let pos = 0; pos < size;) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(b, 0, Math.min(b.length, size - pos), start + pos);
      if (!bytesRead) throw new Fatal('truncated stream');
      await writeAll(wf, b.subarray(0, bytesRead));
      pos += bytesRead;
    }
    await wf.sync();
    await wf.close();
    signal?.throwIfAborted();
    await check(out);
    await check(tmp);
    await fs.rename(tmp, out);
  } finally {
    await wf.close().catch(() => {});
    try { await check(tmp); await fs.unlink(tmp); } catch { /* unsafe or already removed */ }
  }
}

/** Validate the complete manifest before publishing any entry. */
export async function extract(file, dest, allowed, signal) {
  const roots = typeof allowed === 'function' ? allowed : () => allowed;
  const check = (p) => requirePath(p, roots);
  await check(file);
  await check(dest);
  const fh = await openRegular(file, constants.O_RDONLY);
  const entries = [];
  const files = new Set();
  const dirs = new Set();
  try {
    const size = (await fh.stat()).size;
    let pos = 0;
    const lb = Buffer.alloc(4);
    for (;;) {
      signal?.throwIfAborted();
      if (pos + 4 > size || (await fh.read(lb, 0, 4, pos)).bytesRead !== 4) throw new Fatal('truncated stream');
      pos += 4;
      const hl = lb.readUInt32BE(0);
      if (hl === 0) {
        if (pos !== size) throw new Fatal('unexpected bytes after stream terminator');
        break;
      }
      if (hl > MAX_HEADER || pos + hl > size || entries.length >= MAX_ENTRIES) throw new Fatal('invalid entry header or too many entries');
      const hb = Buffer.alloc(hl);
      if ((await fh.read(hb, 0, hl, pos)).bytesRead !== hl) throw new Fatal('truncated entry header');
      pos += hl;
      let h;
      try { h = JSON.parse(hb.toString('utf8')); } catch { throw new Fatal('invalid entry header'); }
      if (!safeEntry(h?.p) || !Number.isSafeInteger(h.s) || h.s < 0 || h.s > size - pos) throw new Fatal('invalid stream entry');
      const parts = h.p.split('/');
      if (parts.some((p) => /^\.ah-/i.test(p))) throw new Fatal('reserved transfer path');
      const key = platform() === 'linux' ? h.p : h.p.normalize('NFC').toLowerCase();
      if (files.has(key) || dirs.has(key)) throw new Fatal('duplicate or conflicting entry path');
      files.add(key);
      const keyParts = key.split('/');
      for (let i = 1; i < keyParts.length; i++) {
        const parent = keyParts.slice(0, i).join('/');
        if (files.has(parent)) throw new Fatal('conflicting entry paths');
        dirs.add(parent);
        if (dirs.size > MAX_ENTRIES) throw new Fatal('too many directories in stream');
      }
      const out = path.join(dest, ...parts);
      await check(out);
      entries.push({ out, start: pos, size: h.s });
      pos += h.s;
    }
    for (const entry of entries) await publishFile(fh, entry.start, entry.size, entry.out, check, signal);
  } finally { await fh.close(); }
  return entries.length;
}

async function cleanupPart(job, allowed) {
  if (job.kind !== 'receive') return;
  const part = job.framing === 'raw' ? `${job.save_to}.ah-${job.channel_id}.part` : path.join(job.save_to, `.ah-${job.channel_id}.part`);
  try { await requirePath(part, allowed); await fs.unlink(part); } catch { /* unsafe or already removed */ }
}

/** Run one job to the end, retrying network trouble with backoff; resume comes from the hub's and the disk's state. */
async function runJob(job, ctx) {
  const { api, log, signal, allowed } = ctx;
  let failures = 0;
  while (!signal.aborted) {
    try {
      if (job.kind === 'send') await sendJob(job, ctx);
      else if (job.kind === 'receive') await receiveJob(job, ctx);
      else log(`job ${job.id}: unsupported kind ${job.kind}`);
      return;
    } catch (e) {
      if (signal.aborted || e instanceof Unavailable) return;
      if (e instanceof Gone) { await cleanupPart(job, allowed); return; }
      if (e instanceof Fatal || ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EROFS'].includes(e?.code)) {
        const reason = e instanceof Fatal ? e.message : `local filesystem error (${e.code})`;
        log(`job ${job.id} failed: ${reason}`);
        try {
          const res = await api('POST', `/bridge/channels/${job.channel_id}/done`, { body: JSON.stringify({ error: reason, role: job.kind }), headers: JSON_HDR });
          await res.body?.cancel();
          if (res.ok) await cleanupPart(job, allowed);
        } catch { /* retain staging if failure could not be reported */ }
        return;
      }
      failures++;
      const wait = e instanceof Restart ? 300 : Math.min(10_000, 300 * 2 ** Math.min(failures, 5));
      log(`job ${job.id}: ${e.message}; retry in ${wait} ms`);
      await sleep(wait, signal);
    }
  }
}

function validJob(job) {
  return typeof job?.channel_id === 'string' && /^chn_[a-zA-Z0-9_-]{1,80}$/.test(job.channel_id) &&
    ['send', 'receive'].includes(job.kind) && job.id === `${job.channel_id}:${job.kind}` &&
    ['raw', 'tar'].includes(job.framing) &&
    (job.kind === 'receive' ? typeof job.save_to === 'string' :
      Array.isArray(job.local_paths) ? job.local_paths.length > 0 && job.local_paths.every((p) => typeof p === 'string') : typeof job.local_path === 'string');
}

async function run(signal) {
  const cfg = await readConfig().catch((e) => {
    if (e.code === 'ENOENT') throw new Error(`not paired: run "pair <hub-url> <code>" first (${CONFIG_FILE})`);
    throw e;
  });
  let allowed = [];
  let failures = 0;
  const running = new Map();
  const api = makeApi(cfg, signal);
  log(`bridge ${VERSION} running against ${cfg.hub}`);
  try {
    while (!signal.aborted) {
      try {
        const asked = Date.now();
        const res = await api('POST', '/bridge/poll', {
          headers: JSON_HDR, timeout: 40_000,
          body: JSON.stringify({ version: VERSION, home: homedir(), os: platform(), running: [...running.keys()] }),
        });
        if (!res.ok) {
          await res.body?.cancel();
          if (res.status === 401) {
            allowed = [];
            log('hub rejected the bridge key (PC suspended or key revoked); retrying in 60 s');
            await sleep(60_000, signal);
            continue;
          }
          throw new Error(`poll answered ${res.status}`);
        }
        const data = await res.json();
        allowed = Array.isArray(data.allowed_folders) ? data.allowed_folders : [];
        failures = 0;
        for (const job of data.jobs ?? []) {
          if (running.size >= 4) break;
          if (!validJob(job) || running.has(job.id)) continue;
          const work = runJob(job, { api, allowed: () => allowed, log, signal })
            .catch((e) => { if (!signal.aborted) log(`job ${job.id} crashed: ${e.message}`); })
            .finally(() => running.delete(job.id));
          running.set(job.id, work);
        }
        const wait = Math.min(25_000, Math.max(pollFloor(asked), running.size >= 4 ? 1000 : 0, Number(data.poll_after_ms) || 0));
        if (wait) await sleep(wait, signal);
      } catch (e) {
        if (signal.aborted) break;
        failures++;
        const wait = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        log(`poll failed (${e.message}); retry in ${wait / 1000} s`);
        await sleep(wait, signal).catch((e) => { if (!signal.aborted) throw e; });
      }
    }
  } finally { await Promise.allSettled(running.values()); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, ...args] = process.argv.slice(2);
  const stop = new AbortController();
  if (cmd === 'run') for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stop.abort());
  const main = cmd === 'pair' ? pair(args[0], args[1]) : cmd === 'run' ? run(stop.signal) : Promise.reject(new Error('usage: pair <hub-url> <code> | run'));
  main.catch((e) => { console.error(e.message); process.exitCode = 1; });
}
