/**
 * Usage stats from the connector's own worker sessions (docs/connector.md "Usage and cost"; review-v2 §1 point 14).
 *
 * Off until the PC's user turns it on (`usage_opt_in` in preferences.json). Only sessions the connector registered
 * (sessions.json: client, session id, agent, hub, folder) are read, and inside each file only rows whose recorded
 * working folder is that session's registered folder: a personal chat started in an agent folder has another session
 * id, and a session id reused elsewhere has another folder, so neither is counted. Numbers only leave this module: model
 * name (checked against a strict pattern, else "unknown"), token counts, the UTC day, a session count and a turn count. Never text,
 * paths or session ids. Nothing read is logged.
 *
 * Sources, in order: usage events the connector recorded itself from a client's structured events (usage-events.jsonl,
 * `recordUsageEvent`), and only for a session with none of those, the client's own session file:
 * - Claude Code, <config>/projects/<folder name>/<session id>.jsonl (and <session id>/subagents/*.jsonl): assistant rows
 *   with message.usage, each message.id counted once across all files (a resume copies rows), API error rows skipped,
 *   side-chain rows counted and reported apart, other row types ignored.
 * - Codex, $CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl (and archived_sessions): the session_meta row names the
 *   session and its folder; token_count events carry a cumulative total, so the usage of each event is the step from
 *   the previous total (a repeated total adds nothing). A fork has its own counter and is never added to its parent.
 * A row that is not JSON (a line still being written, say) is skipped and counted. A usage row or event of a layout
 * this reader does not know gives that session no stats at all, reported locally as unknown: never a guess.
 *
 * Liveness is never derived from any of this: whether an agent is working comes only from the connector's own process
 * state, otherwise Unknown.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, statSync, appendFileSync, mkdirSync, createReadStream } from 'node:fs';
import { readJson, atomicWrite, pathKey, WIN } from './paths.mjs';
import { resolveFolder } from './registry.mjs';
import { HUB_ID_RE, SHA_RE } from './keyfile.mjs';

export const CLIENTS = ['claude_code', 'codex'];
export const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/;
/** A longer line (no client writes one) is skipped, so a file is read in bounded memory whatever its size. */
export const MAX_LINE = 16 * 1024 * 1024;

export const sessionsPath = (home) => join(home, 'sessions.json');
export const eventsPath = (home) => join(home, 'usage-events.jsonl');
const prefsPath = (home) => join(home, 'preferences.json');

/** The PC user's switch for usage reports: off unless they turned it on. */
export const usageOptIn = (home) => (readJson(prefsPath(home), {}) ?? {}).usage_opt_in === true;

/** Sets the switch, keeping the user's other choices. Turning it off stops new reports; it deletes nothing on the hub. */
export function setUsageOptIn(home, on) {
  const p = readJson(prefsPath(home), {});
  const prefs = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  atomicWrite(prefsPath(home), JSON.stringify({ ...prefs, usage_opt_in: on === true }, null, 2) + '\n');
}

function loadSessions(home) {
  const j = readJson(sessionsPath(home), { version: 1, sessions: {} });
  return j && j.version === 1 && j.sessions && typeof j.sessions === 'object' && !Array.isArray(j.sessions) ? j : { version: 1, sessions: {} };
}

/**
 * Registers a worker session the connector started, so its usage may be counted. The folder must be a registered
 * agent folder bound to the same hub; the session is kept with that folder's canonical path.
 */
export function registerSession(home, { client, sessionId, agentId, hubId, caSha256, folder }) {
  if (!CLIENTS.includes(client) || !SESSION_RE.test(String(sessionId)) || !AGENT_ID_RE.test(String(agentId))) throw new Error('invalid client, session id or agent id');
  if (!HUB_ID_RE.test(String(hubId)) || !SHA_RE.test(String(caSha256))) throw new Error('invalid hub id or CA fingerprint');
  const r = resolveFolder(home, folder);
  if (!r.ok) throw new Error('the folder is not a registered agent folder');
  if (r.binding.hub_id !== hubId || r.binding.ca_sha256 !== caSha256) throw new Error('the folder is bound to another hub');
  const j = loadSessions(home);
  j.sessions[`${client}:${sessionId}`] = { client, session_id: sessionId, agent_id: agentId, hub_id: hubId, ca_sha256: caSha256, folder: r.folder, registered_at: new Date().toISOString() };
  atomicWrite(sessionsPath(home), JSON.stringify(j, null, 2) + '\n');
}

/** Forgets a session (it is no longer counted). */
export function forgetSession(home, client, sessionId) {
  const j = loadSessions(home);
  if (!j.sessions[`${client}:${sessionId}`]) return false;
  delete j.sessions[`${client}:${sessionId}`];
  atomicWrite(sessionsPath(home), JSON.stringify(j, null, 2) + '\n');
  return true;
}

export const registeredSessions = (home) => Object.values(loadSessions(home).sessions);

/**
 * Records one usage event from a client's structured events (for example Codex's app server), for a registered
 * session. Numbers only: anything else in `u` is dropped here.
 */
export function recordUsageEvent(home, { client, sessionId, model, at = new Date().toISOString(), input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const ev = { client, session_id: String(sessionId), model: cleanModel(model), at: dayOf(at) ? at : new Date().toISOString(), input: n(input), output: n(output), cache_read: n(cacheRead), cache_write: n(cacheWrite) };
  if (!CLIENTS.includes(client) || !SESSION_RE.test(ev.session_id) || [ev.input, ev.output, ev.cache_read, ev.cache_write].includes(null)) throw new Error('invalid usage event');
  mkdirSync(home, { recursive: true });
  appendFileSync(eventsPath(home), JSON.stringify(ev) + '\n');
}

const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const cleanModel = (m) => (typeof m === 'string' && MODEL_RE.test(m) ? m : 'unknown');
const dayOf = (t) => { if (typeof t !== 'string') return null; const d = new Date(t); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const sameFolder = (cwd, folder) => typeof cwd === 'string' && pathKey(cwd, WIN).replace(/\/+$/, '') === pathKey(folder, WIN).replace(/\/+$/, '');
const mtimeDay = (p) => { try { return statSync(p).mtime.toISOString().slice(0, 10); } catch { return new Date().toISOString().slice(0, 10); } };

/**
 * Streams a JSONL file and calls `onRow` with each line that is a JSON object; returns `{skipped}` (lines that are not,
 * or are longer than `maxLine`), or null when the file cannot be read. It never holds more than one line in memory.
 * `open` is there for tests (to count the files opened, or to read in small chunks).
 */
export async function eachRow(path, onRow, { open = (q) => createReadStream(q), maxLine = MAX_LINE } = {}) {
  try { if (!statSync(path).isFile()) return null; } catch { return null; }
  let skipped = 0, parts = [], len = 0, over = false;
  const line = (buf) => {
    const t = buf.toString('utf8');
    if (!t.trim()) return;
    let r;
    try { r = JSON.parse(t); } catch { skipped++; return; }
    if (r && typeof r === 'object' && !Array.isArray(r)) onRow(r); else skipped++;
  };
  try {
    for await (const chunk of open(path)) {
      let start = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, i);
        if (over || len + piece.length > maxLine) skipped++;
        else line(len ? Buffer.concat([...parts, piece]) : piece);
        over = false; parts = []; len = 0; start = i + 1;
      }
      const rest = chunk.subarray(start);
      if (over || !rest.length) continue;
      if (len + rest.length > maxLine) { over = true; parts = []; len = 0; } else { parts.push(Buffer.from(rest)); len += rest.length; }
    }
  } catch { return null; }
  if (over) skipped++; else if (len) line(Buffer.concat(parts));
  return { skipped };
}

const list = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

export const claudeProjectsDir = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
export const codexHomeDir = (env = process.env) => env.CODEX_HOME || join(homedir(), '.codex');

/** The files that may hold a Claude Code session's rows: its own file in any project folder, and its subagents' files. */
export function claudeFiles(projects, sessionId) {
  const out = [];
  for (const d of list(projects)) {
    if (!d.isDirectory()) continue;
    const dir = join(projects, d.name);
    for (const f of list(dir)) if (f.isFile() && f.name === `${sessionId}.jsonl`) out.push(join(dir, f.name));
    for (const f of list(join(dir, sessionId, 'subagents'))) if (f.isFile() && f.name.endsWith('.jsonl')) out.push(join(dir, sessionId, 'subagents', f.name));
  }
  return out;
}

/** The rollout files of a Codex session: under sessions/YYYY/MM/DD and archived_sessions, named …<id>.jsonl. */
export function codexFiles(codexHome, sessionId) {
  const out = [], named = (f) => f.isFile() && f.name.startsWith('rollout-') && f.name.endsWith(`${sessionId}.jsonl`);
  const walk = (dir, depth) => { for (const d of list(dir)) { if (d.isDirectory() && depth < 3 && /^\d{2,4}$/.test(d.name)) walk(join(dir, d.name), depth + 1); else if (named(d)) out.push(join(dir, d.name)); } };
  walk(join(codexHome, 'sessions'), 0);
  for (const f of list(join(codexHome, 'archived_sessions'))) if (named(f)) out.push(join(codexHome, 'archived_sessions', f.name));
  return out;
}

const blank = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0 });
function add(byKey, day, model, u) {
  const k = `${day}\n${model}`;
  const t = byKey.get(k) ?? { day, model, ...blank() };
  t.input += u.input; t.output += u.output; t.cache_read += u.cache_read; t.cache_write += u.cache_write; t.turns += 1;
  byKey.set(k, t);
}

/**
 * Reads one registered Claude Code session from its files. `seen` holds the message ids already counted (shared across
 * sessions, so a resume's copied rows count once). Returns `{usage: [{day, model, input, …, turns}] | null, …counts}`.
 */
export async function readClaudeSession(session, files, seen = new Set(), io = {}) {
  const out = { files: 0, skipped_rows: 0, other_rows: 0, sidechain_messages: 0, unknown_rows: 0, versions: [] };
  const byKey = new Map(), versions = new Set();
  for (const p of files) {
    const fallback = mtimeDay(p);
    const r = await eachRow(p, (row) => {
      if (row.sessionId !== session.session_id || !sameFolder(row.cwd, session.folder)) { out.other_rows++; return; }
      if (row.type !== 'assistant' || row.isApiErrorMessage === true) return;
      const m = row.message, u = m && m.usage;
      if (!m || typeof m.id !== 'string' || !u || typeof u !== 'object') return;
      const c = { input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens ?? 0), cache_write: n(u.cache_creation_input_tokens ?? 0) };
      if (Object.values(c).includes(null)) { out.unknown_rows++; return; }
      if (seen.has(m.id)) return;
      seen.add(m.id);
      if (typeof row.version === 'string' && row.version.length <= 40) versions.add(row.version);
      if (row.isSidechain === true) out.sidechain_messages++;
      add(byKey, dayOf(row.timestamp) ?? fallback, cleanModel(m.model), c);
    }, io);
    if (!r) continue;
    out.files++; out.skipped_rows += r.skipped;
  }
  out.versions = [...versions];
  out.usage = out.unknown_rows ? null : [...byKey.values()];
  return out;
}

/** Reads one registered Codex session from its rollout file(s). The session_meta row comes first; rows before it are ignored. */
export async function readCodexSession(session, files, io = {}) {
  const out = { files: 0, skipped_rows: 0, other_rows: 0, unknown_events: 0, versions: [], forked_from: false, total_tokens: null };
  const byKey = new Map(), versions = new Set();
  for (const p of files) {
    let state = 'before', fallback = null, model = 'unknown', prev = null;
    const r = await eachRow(p, (row) => {
      const pl = row.payload;
      if (state === 'other') { out.other_rows++; return; }
      if (state === 'before') {
        if (row.type !== 'session_meta' || !pl || typeof pl !== 'object') return;
        if (pl.id !== session.session_id || !sameFolder(pl.cwd, session.folder)) { state = 'other'; out.other_rows++; return; }
        state = 'ours';
        if (typeof pl.cli_version === 'string' && pl.cli_version.length <= 40) versions.add(pl.cli_version);
        if (pl.forked_from_id) out.forked_from = true;
        fallback = dayOf(pl.timestamp) ?? dayOf(row.timestamp) ?? mtimeDay(p);
        return;
      }
      if (!pl || typeof pl !== 'object') return;
      if (row.type === 'turn_context') { model = cleanModel(pl.model); return; }
      if (row.type !== 'event_msg' || pl.type !== 'token_count' || pl.info == null) return;
      const t = pl.info.total_token_usage;
      const cur = t && typeof t === 'object' ? { input: n(t.input_tokens), cached: n(t.cached_input_tokens ?? 0), write: n(t.cache_write_input_tokens ?? 0), output: n(t.output_tokens), total: n(t.total_tokens ?? 0) } : null;
      if (!cur || Object.values(cur).includes(null)) { out.unknown_events++; return; }
      const step = prev && cur.input >= prev.input && cur.cached >= prev.cached && cur.write >= prev.write && cur.output >= prev.output
        ? { input: cur.input - prev.input, cached: cur.cached - prev.cached, write: cur.write - prev.write, output: cur.output - prev.output }
        : { input: cur.input, cached: cur.cached, write: cur.write, output: cur.output }; // the first total, or a counter that started again
      prev = cur;
      out.total_tokens = cur.total;
      if (!step.input && !step.cached && !step.write && !step.output) return; // the same total again
      add(byKey, dayOf(row.timestamp) ?? fallback, model, { input: Math.max(0, step.input - step.cached - step.write), output: step.output, cache_read: step.cached, cache_write: step.write });
    }, io);
    if (!r) continue;
    out.files++; out.skipped_rows += r.skipped;
  }
  out.versions = [...versions];
  if (out.unknown_events) { out.usage = null; out.total_tokens = null; } else out.usage = [...byKey.values()];
  return out;
}

async function eventUsage(home, io) {
  const by = new Map();
  await eachRow(eventsPath(home), (e) => {
    const c = { input: n(e.input), output: n(e.output), cache_read: n(e.cache_read), cache_write: n(e.cache_write) };
    const day = dayOf(e.at);
    if (!CLIENTS.includes(e.client) || typeof e.session_id !== 'string' || !day || Object.values(c).includes(null)) return;
    const k = `${e.client}:${e.session_id}`;
    if (!by.has(k)) by.set(k, new Map());
    add(by.get(k), day, cleanModel(e.model), c);
  }, io);
  return by;
}

/**
 * Reads every registered session and returns `{opted_in, sessions, hubs}`:
 * - `sessions`: per session, the local summary (source, files, row counts, versions, unknown) for `conclave usage`;
 * - `hubs`: per hub, per day, the rows in the hub's shape (`POST /connector/v1/usage`): agent_id, client, model, the
 *   four token counts, the number of sessions and of turns.
 * While the PC's user has not opted in, nothing is read at all, not even the list of files: `{opted_in: false, sessions:
 * [], hubs: []}`. `io` passes `open` and `maxLine` to the reader (tests).
 * Session ids, folders and file paths stay in `sessions` and never reach `hubs`.
 */
export async function collectUsage(home, { env = process.env, days = null, io = {} } = {}) {
  if (!usageOptIn(home)) return { opted_in: false, sessions: [], hubs: [] };
  const projects = claudeProjectsDir(env), codexHome = codexHomeDir(env);
  const events = await eventUsage(home, io), seen = new Set();
  const since = days ? new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10) : null;
  const sessions = [], perHub = new Map();
  for (const s of registeredSessions(home)) {
    let r, source;
    const ev = events.get(`${s.client}:${s.session_id}`);
    if (ev) { r = { usage: [...ev.values()] }; source = 'client_events'; }
    else if (s.client === 'claude_code') { r = await readClaudeSession(s, claudeFiles(projects, s.session_id), seen, io); source = 'session_file'; }
    else { r = await readCodexSession(s, codexFiles(codexHome, s.session_id), io); source = 'session_file'; }
    const usage = r.usage === null ? null : r.usage.filter((u) => !since || u.day >= since);
    sessions.push({ client: s.client, session_id: s.session_id, agent_id: s.agent_id, source, ...r, usage, unknown: usage === null });
    if (!usage || !usage.length) continue;
    const hk = `${s.hub_id}\n${s.ca_sha256}`;
    if (!perHub.has(hk)) perHub.set(hk, { hub_id: s.hub_id, ca_sha256: s.ca_sha256, days: new Map() });
    const hub = perHub.get(hk);
    for (const u of usage) {
      if (!hub.days.has(u.day)) hub.days.set(u.day, new Map());
      const rows = hub.days.get(u.day), k = `${s.agent_id}\n${s.client}\n${u.model}`;
      const row = rows.get(k) ?? { agent_id: s.agent_id, client: s.client, model: u.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 0, turns: 0, _s: new Set() };
      row.input_tokens += u.input; row.output_tokens += u.output; row.cache_read_tokens += u.cache_read; row.cache_write_tokens += u.cache_write; row.turns += u.turns;
      row._s.add(`${s.client}:${s.session_id}`); row.sessions = row._s.size;
      rows.set(k, row);
    }
  }
  const hubs = [...perHub.values()].map((h) => ({
    hub_id: h.hub_id, ca_sha256: h.ca_sha256,
    days: [...h.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, rows]) => ({ day, rows: [...rows.values()].map(({ _s, ...row }) => row) })),
  }));
  return { opted_in: true, sessions, hubs };
}

/**
 * Sends one hub's days (`POST /connector/v1/usage`, one call per day; a repeated day replaces that day on the hub).
 * `post(path, body)` is the caller's signed-in call to that hub with the PC's app key. Nothing is sent while the user
 * has not opted in. Returns the days sent.
 */
export async function sendUsage(home, hub, post) {
  if (!usageOptIn(home)) return [];
  const sent = [];
  for (const d of hub.days) {
    // The hub takes at most 500 rows a day and a repeated day replaces the day, so a day is never split over two calls.
    if (d.rows.length > 500) throw new Error(`more than 500 usage rows for ${d.day}`);
    await post('/connector/v1/usage', { day: d.day, rows: d.rows });
    sent.push(d.day);
  }
  return sent;
}
