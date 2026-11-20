/**
 * How full each agent's context is (design "the connector delivers work" 3c and 3g; docs/connector.md "Context size").
 *
 * Numbers only leave this module: the tokens in the context now, the model's window, the percent used, the tokens of the
 * last turn, when the transcript last auto-compacted, and the model id (checked against a strict pattern). Never message
 * text, a path or a session id. Nothing read is logged.
 *
 * - **Claude Code** transcripts: each assistant `message.id` is counted once (proof 4: about half the rows repeat an id).
 *   Context now is the last main-thread assistant message's input plus its cache tokens (read and written). A turn starts
 *   at a person's prompt: a user row that is not a tool result, not meta and not a compact summary, so an auto-compact
 *   (`system`/`compact_boundary`) never starts a turn; the next message's smaller context shows it as a drop.
 * - **Codex** session logs: `token_count` events carry the last call's usage and the model's context window; context now
 *   is that last call's total. A turn starts at `task_started` (or a `user_message` event); a turn's tokens are the step of
 *   the cumulative total since then. `compacted` rows mark a compact.
 * - The window comes from the table below, by model id, or from the Codex log; otherwise it is null ("unknown"). It is
 *   never guessed: a context larger than the table's window (a long-context beta, say) also reads unknown.
 *
 * The reader is incremental: its state (byte offset and a few numbers, no text) is a plain object, so the worker keeps it
 * in memory for the runs the connector started, and the silent hook keeps it in a small file for hand-opened chats. One
 * call reads at most READ_BUDGET bytes, so a hook exits quickly even the first time it meets a long transcript.
 */
import { join, resolve, relative, isAbsolute } from 'node:path';
import { openSync, readSync, closeSync, fstatSync, statSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite, pathKey, WIN } from './paths.mjs';
import { MODEL_RE, registeredSessions, usageOptIn, claudeFiles, codexFiles, claudeProjectsDir, codexHomeDir } from './usage.mjs';

/** The connector reads a transcript at most this often, during a turn and at its end (3g review change 3). */
export const CONTEXT_EVERY_MS = 60_000;
/** Bytes read per call at most; the rest is read on the next call. */
export const READ_BUDGET = 8 * 1024 * 1024;
/** Message ids of the current turn kept for counting each id once. */
const TURN_IDS_MAX = 2000;

/**
 * Context windows by model id, taken from Anthropic's model docs. Only ids whose window is known go here; anything else
 * reads unknown. The first match wins, so the 1M rows come before the broader Claude 4 row. Claude Code records the model
 * id without the long-context flag, so a 200k model on a 1M beta reads unknown once it passes 200k (see `windowFor`),
 * never a wrong percentage.
 */
export const MODEL_WINDOWS = [
  [/^claude-(opus-5|opus-5-5|sonnet-5|sonnet-5-5|haiku-5-5|fable-5|fable-5-1|fable-5-2|mythos-5-1|mythos-5-2)$/, 1_000_000],
  [/^claude-(opus-4-[678]|sonnet-4-6)$/, 1_000_000],
  [/^claude-3-(opus|sonnet|haiku)-\d{8}$/, 200_000],
  [/^claude-3-[57]-(sonnet|haiku)-\d{8}$/, 200_000],
  [/^claude-(opus|sonnet)-4(-[0-9]+)?(-\d{8})?$/, 200_000],
  [/^claude-haiku-4-5(-\d{8})?$/, 200_000],
];

/** The window for a model id and the context seen, or null (unknown). */
export function windowFor(model, context = 0, table = MODEL_WINDOWS) {
  if (typeof model !== 'string') return null;
  for (const [re, w] of table) if (re.test(model)) return context > w ? null : w;
  return null;
}

const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const cleanModel = (m) => (typeof m === 'string' && MODEL_RE.test(m) ? m : null);
const sameFolder = (cwd, folder) => typeof cwd === 'string' && pathKey(cwd, WIN).replace(/\/+$/, '') === pathKey(folder, WIN).replace(/\/+$/, '');
const tsOf = (t) => { const d = typeof t === 'string' ? Date.parse(t) : NaN; return Number.isNaN(d) ? null : d; };

/** A fresh reader state for one transcript. `client` is claude_code or codex; `sessionId` and `folder` select its rows. */
export const newState = (client, sessionId, folder) => ({
  v: 1, client, session_id: sessionId, folder, offset: 0, skip: false, ino: null,
  model: null, context: null, window: null, turn_tokens: 0, turn_ids: [], turn_base: null, last_total: null,
  compacted_at: null, compacts: 0, at: null, ours: client === 'claude_code' ? true : null, unknown: false,
});

function isPrompt(row) {
  if (row.type !== 'user' || row.isMeta === true || row.isCompactSummary === true || row.isSidechain === true) return false;
  const c = row.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b && b.type !== 'tool_result');
}

function claudeRow(s, row) {
  if (row.sessionId !== s.session_id || !sameFolder(row.cwd, s.folder)) return;
  if (row.type === 'system' && row.subtype === 'compact_boundary') { s.compacts++; s.compacted_at = tsOf(row.timestamp) ?? Date.now(); return; }
  if (isPrompt(row)) { s.turn_tokens = 0; s.turn_ids = []; return; }
  if (row.type !== 'assistant' || row.isApiErrorMessage === true || row.isSidechain === true) return;
  const m = row.message, u = m && m.usage;
  if (!m || typeof m.id !== 'string' || !u || typeof u !== 'object') return;
  const c = { input: n(u.input_tokens), output: n(u.output_tokens), read: n(u.cache_read_input_tokens ?? 0), write: n(u.cache_creation_input_tokens ?? 0) };
  if (Object.values(c).includes(null)) { s.unknown = true; return; }
  if (s.turn_ids.includes(m.id)) return; // the same message again (proof 4): counted once
  s.turn_ids.push(m.id); if (s.turn_ids.length > TURN_IDS_MAX) s.turn_ids.splice(0, s.turn_ids.length - TURN_IDS_MAX);
  s.unknown = false;
  s.context = c.input + c.read + c.write;
  s.turn_tokens += c.input + c.read + c.write + c.output;
  s.model = cleanModel(m.model) ?? s.model;
  s.at = tsOf(row.timestamp) ?? Date.now();
}

function codexRow(s, row) {
  const pl = row.payload;
  if (s.ours === false) return;
  if (s.ours === null) {
    if (row.type !== 'session_meta' || !pl || typeof pl !== 'object') return;
    s.ours = pl.id === s.session_id && sameFolder(pl.cwd, s.folder);
    return;
  }
  if (row.type === 'compacted') { s.compacts++; s.compacted_at = tsOf(row.timestamp) ?? Date.now(); return; }
  if (!pl || typeof pl !== 'object') return;
  if (row.type === 'turn_context') { s.model = cleanModel(pl.model) ?? s.model; return; }
  if (row.type !== 'event_msg') return;
  if (pl.type === 'task_started' || pl.type === 'user_message') {
    if (pl.type === 'task_started' && n(pl.model_context_window)) s.window = pl.model_context_window;
    s.turn_base = s.last_total ?? 0; s.turn_tokens = 0; return;
  }
  if (pl.type !== 'token_count' || pl.info == null) return;
  const last = pl.info.last_token_usage, total = pl.info.total_token_usage;
  const lt = last && typeof last === 'object' ? (n(last.total_tokens) ?? (n(last.input_tokens) !== null && n(last.output_tokens) !== null ? last.input_tokens + last.output_tokens : null)) : null;
  const tt = total && typeof total === 'object' ? n(total.total_tokens) : null;
  if (lt === null || tt === null) { s.unknown = true; return; }
  s.unknown = false;
  if (n(pl.info.model_context_window)) s.window = pl.info.model_context_window;
  s.context = lt;
  if (s.turn_base === null || tt < s.turn_base) s.turn_base = 0; // no turn start seen yet, or a counter that started again
  s.last_total = tt;
  s.turn_tokens = tt - s.turn_base;
  s.at = tsOf(row.timestamp) ?? Date.now();
}

/**
 * Reads what was added to `file` since `s.offset` (at most `budget` bytes) and updates `s` in place. A file that got
 * shorter, or is another file now, is read again from the start. Returns false when the file cannot be read.
 */
export function readMore(s, file, { budget = READ_BUDGET } = {}) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return false; }
  try {
    const st = fstatSync(fd);
    const ino = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
    if (st.size < s.offset || (s.ino !== null && s.ino !== ino)) Object.assign(s, newState(s.client, s.session_id, s.folder));
    s.ino = ino;
    const len = Math.min(budget, st.size - s.offset);
    if (len <= 0) return true;
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, s.offset);
    const lastNl = buf.lastIndexOf(10, got - 1);
    if (lastNl < 0) { if (got === budget) { s.offset += got; s.skip = true; } return true; } // a line longer than the budget is skipped
    let start = 0;
    for (let i = buf.indexOf(10, 0); i !== -1 && i <= lastNl; i = buf.indexOf(10, start)) {
      const piece = buf.subarray(start, i); start = i + 1;
      if (s.skip) { s.skip = false; continue; }
      const t = piece.toString('utf8');
      if (!t.trim()) continue;
      let row; try { row = JSON.parse(t); } catch { continue; } // a line still being written, or not JSON
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if (s.client === 'claude_code') claudeRow(s, row); else codexRow(s, row);
    }
    s.offset += lastNl + 1;
    return true;
  } catch { return false; } finally { try { closeSync(fd); } catch { /* closed */ } }
}

/** The numbers a state stands for, or null when it has none yet. Only numbers, the model id and times. */
export function numbersOf(s) {
  if (!s || s.unknown || s.context === null || s.ours === false) return null;
  const window = s.client === 'codex' ? (s.window && s.context <= s.window ? s.window : null) : windowFor(s.model, s.context);
  return {
    client: s.client, model: s.model ?? 'unknown', context_tokens: s.context, window, percent: window ? Math.round((s.context / window) * 100) : null,
    turn_tokens: s.turn_tokens, compacted_at: s.compacted_at, compacts: s.compacts, at: s.at,
  };
}

// ───── hand-opened chats: the silent hook's own file ─────

const hubHash = (hubKey) => createHash('sha256').update(hubKey).digest('hex').slice(0, 24);
const chatDir = (home, hubKey) => join(home, 'context', hubHash(hubKey));
const LABEL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * True if `p` is a transcript file under Claude Code's projects folder: the hook reads nothing else, whatever its input
 * names.
 */
export function isClaudeTranscript(p, env = process.env) {
  if (typeof p !== 'string' || !isAbsolute(p) || !p.endsWith('.jsonl')) return false;
  const rel = relative(resolve(claudeProjectsDir(env)), resolve(p));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The silent hook's work (Stop and PostToolUse in a hand-opened chat): reads the transcript Claude Code named, at most
 * once a minute unless `force` (Stop), and keeps the numbers in the connector's own file for the next check-in. Prints
 * nothing, sends nothing; resolves `{state}` for tests: `read`, `throttled`, `connector_run` (a run the connector started,
 * which it reads itself), `opted_out`, `skipped`.
 */
export function recordChatContext(home, { hubKey, label, folder, sessionId, transcript, agentId = null, force = false, now = Date.now(), env = process.env }) {
  if (!usageOptIn(home)) return { state: 'opted_out' }; // nothing is read while the PC's user has not opted in
  if (!LABEL_FILE_RE.test(String(label)) || typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) return { state: 'skipped' };
  if (registeredSessions(home).some((s) => s.client === 'claude_code' && s.session_id === sessionId)) return { state: 'connector_run' };
  if (!isClaudeTranscript(transcript, env)) return { state: 'skipped' };
  const p = join(chatDir(home, hubKey), `${label}.json`);
  const prev = readJson(p, null);
  let s = prev?.state && prev.state.v === 1 && prev.state.session_id === sessionId && prev.state.client === 'claude_code' ? prev.state : null;
  if (!force && s && typeof prev.read_at === 'number' && now - prev.read_at < CONTEXT_EVERY_MS) return { state: 'throttled' };
  if (!s) s = newState('claude_code', sessionId, folder);
  if (!readMore(s, transcript)) return { state: 'skipped' };
  atomicWrite(p, JSON.stringify({ label, agent_id: agentId ?? prev?.agent_id ?? null, read_at: now, state: s, numbers: numbersOf(s) }) + '\n');
  return { state: 'read' };
}

/** What the silent hook recorded for this hub: `[{label, agent_id, numbers}]`. */
export function chatContexts(home, hubKey) {
  let names = [];
  try { names = readdirSync(chatDir(home, hubKey)).filter((x) => x.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of names) {
    const j = readJson(join(chatDir(home, hubKey), f), null);
    if (j && j.numbers && typeof j.label === 'string') out.push({ label: j.label, agent_id: typeof j.agent_id === 'string' ? j.agent_id : null, numbers: j.numbers });
  }
  return out;
}

/** Forgets what the hook recorded for one agent (after a reset, the next chat starts from nothing). */
export function forgetChatContext(home, hubKey, label) { if (LABEL_FILE_RE.test(String(label))) rmSync(join(chatDir(home, hubKey), `${label}.json`), { force: true }); }

// ───── runs the connector started: read by the worker itself ─────

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/**
 * The context of the runs the connector started for one hub, read by the connector itself at most once a minute per
 * session (`cache` is the worker's memory: session key → {state, file, read_at}). For each agent, the session whose
 * transcript was written last. Returns `[{agent_id, numbers}]`.
 */
export function connectorContexts(home, section, cache, { now = Date.now(), env = process.env } = {}) {
  const best = new Map();
  for (const s of registeredSessions(home)) {
    if (s.hub_id !== section.hub_id || s.ca_sha256 !== section.ca_sha256) continue;
    const key = `${s.client}:${s.session_id}`;
    let c = cache.get(key);
    if (!c) {
      const files = s.client === 'claude_code' ? claudeFiles(claudeProjectsDir(env), s.session_id).filter((f) => !/[\\/]subagents[\\/]/.test(f)) : codexFiles(codexHomeDir(env), s.session_id);
      if (!files.length) continue;
      c = { state: newState(s.client, s.session_id, s.folder), file: files.sort((a, b) => mtime(b) - mtime(a))[0], read_at: 0 };
      cache.set(key, c);
    }
    if (now - c.read_at >= CONTEXT_EVERY_MS) { readMore(c.state, c.file); c.read_at = now; }
    const num = numbersOf(c.state);
    if (!num) continue;
    const had = best.get(s.agent_id);
    if (!had || (num.at ?? 0) > (had.at ?? 0)) best.set(s.agent_id, num);
  }
  return [...best].map(([agent_id, numbers]) => ({ agent_id, numbers }));
}

/**
 * The check-in's `context` field (docs/connector.md "The connector's report"): one row per agent, numbers only, from the
 * connector's own runs (`source: 'connector'`) or a hand-opened chat's hook (`source: 'chat'`), the newer of the two.
 * Undefined while the PC's user has not opted in to usage reports: then nothing is read and the field is left out.
 * `labelToId` maps a folder's agent label to its id (hook files written before the relay signed in carry none).
 */
export function contextReport(home, hubKey, section, cache, { now = Date.now(), env = process.env, labelToId = () => null } = {}) {
  if (!usageOptIn(home)) return undefined;
  const rows = new Map();
  const put = (agent_id, numbers, source) => {
    if (typeof agent_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(agent_id)) return;
    const had = rows.get(agent_id);
    if (!had || (numbers.at ?? 0) > (had.at ?? 0)) rows.set(agent_id, { agent_id, source, ...numbers });
  };
  if (section) for (const r of connectorContexts(home, section, cache, { now, env })) put(r.agent_id, r.numbers, 'connector');
  for (const r of chatContexts(home, hubKey)) put(r.agent_id ?? labelToId(r.label), r.numbers, 'chat');
  return [...rows.values()].slice(0, 100);
}
