/**
 * Reset on the PC (design "the connector delivers work" 3c; spec review step 3 change 10). The hub's `deliver` order with
 * reason `reset` asks to start an agent's context fresh. A reset never happens in the middle of a turn: it waits here until
 * the turn ends.
 *
 * - **A session the connector started** (the wake, one session per task, 3b): at the end of the current turn the wake
 *   closes that session and the next item starts a fresh one, with the task's state from the hub. The wake calls
 *   `resetIfIdle` before it starts a turn and when a turn ends; nothing here starts or stops a process.
 * - **A chat a person opened by hand**: the connector cannot clear it. The order is answered `reset_by_hand`, the console
 *   shows the person the steps (`/clear`, or a new session), and the agent's next prompt carries one fixed line asking it
 *   to record its progress with `task_progress` first.
 *
 * Until the wake ships, every session is opened by hand, so `onResetOrder` answers `reset_by_hand` at once. The wake
 * replaces `wakeOwnsSession` (the seam): when it returns true the order stays open until `resetIfIdle` reports it done.
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite } from './paths.mjs';

const pathOf = (home, hubKey) => join(home, 'resets', `${createHash('sha256').update(hubKey).digest('hex').slice(0, 24)}.json`);
const AGENT_RE = /^[A-Za-z0-9_-]{1,100}$/;
const load = (home, hubKey) => { const d = readJson(pathOf(home, hubKey), { agents: {} }); return d && typeof d.agents === 'object' && d.agents ? d : { agents: {} }; };
const save = (home, hubKey, d) => atomicWrite(pathOf(home, hubKey), JSON.stringify(d) + '\n');

/** The fixed sentence a reset of a hand-opened chat reports (at most 200 characters). */
export const RESET_BY_HAND = 'Not reset: a person opened this chat, so the connector cannot clear it. In that chat type /clear, or start a new session.';
/** The fixed line the agent sees at its next prompt in a hand-opened chat. */
export const resetLine = () => 'Conclave: a reset of this session was asked. Record where your work stands with `task_progress` now; the person will then clear this chat.';

/** Remembers a reset asked for an agent (the latest order wins). */
export function recordReset(home, hubKey, agentId, orderId, now = Date.now()) {
  if (!AGENT_RE.test(String(agentId))) return false;
  const d = load(home, hubKey);
  d.agents[agentId] = { order: orderId, at: now, notice_shown: false };
  save(home, hubKey, d);
  return true;
}

/** The reset waiting for an agent: `{order, at, notice_shown}`, or null. */
export const pendingReset = (home, hubKey, agentId) => load(home, hubKey).agents[agentId] ?? null;

/**
 * Whether the wake started and holds this agent's current session. The seam for the wake (Developer 1): until it ships,
 * no session is the connector's, so this is always false.
 */
export let wakeOwnsSession = (_home, _hubKey, _agentId) => false;
/** For the wake and for tests: replaces the check above. */
export function setWakeOwnsSession(fn) { wakeOwnsSession = typeof fn === 'function' ? fn : () => false; }

/**
 * What the worker does with a `deliver` order whose reason is `reset`: it records the reset, then either answers now
 * (`{state: 'failed', code: 'reset_by_hand', reason}`: a hand-opened chat) or leaves the order open for the wake
 * (`{state: 'waiting'}`), which reports it done through `resetIfIdle` when the turn ends.
 */
export function onResetOrder(home, hubKey, order) {
  const agentId = order.payload.agent_id;
  recordReset(home, hubKey, agentId, order.id);
  if (wakeOwnsSession(home, hubKey, agentId)) return { state: 'waiting' };
  return { state: 'failed', code: 'reset_by_hand', reason: RESET_BY_HAND };
}

/**
 * The wake's call, before it starts a turn for the agent and when a turn ends. Never in the middle of a turn:
 * - no reset waits: `{state: 'none'}`;
 * - a turn is running (`turnRunning()` is true): `{state: 'waiting'}`, and nothing is closed;
 * - otherwise `closeSession()` ends the agent's current session (the next item starts fresh), the reset is cleared, and
 *   `{state: 'done', order}` tells the worker which order to report done.
 */
export async function resetIfIdle(home, hubKey, agentId, { turnRunning, closeSession }) {
  const p = pendingReset(home, hubKey, agentId);
  if (!p) return { state: 'none' };
  if (await turnRunning()) return { state: 'waiting' };
  await closeSession();
  const d = load(home, hubKey);
  if (d.agents[agentId]?.order === p.order) { delete d.agents[agentId]; save(home, hubKey, d); }
  return { state: 'done', order: p.order };
}

/**
 * For the prompt hook in a hand-opened chat: true once per reset (the line is shown at the next prompt), then false.
 * The reset itself stays recorded until a new session's context replaces it.
 */
export function takeResetNotice(home, hubKey, agentId) {
  const d = load(home, hubKey), p = d.agents[agentId];
  if (!p || p.notice_shown) return false;
  p.notice_shown = true;
  save(home, hubKey, d);
  return true;
}
