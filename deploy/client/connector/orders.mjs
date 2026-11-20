/**
 * PC actions as the connector receives them (docs/connector.md "PC actions on the pinned poll", review-v2 §1 point 2).
 *
 * The hub may ask only for the fixed list, each with exactly its typed fields. An order with any other kind, a missing or
 * extra field, or any value that looks like a path or a command is invalid AS A WHOLE: nothing in it runs. An order id is
 * handled once: the ids already handled are kept per hub, so a replay does nothing.
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite } from './paths.mjs';
import { VERSION_RE } from './release.mjs';

const ID_RE = /^pca_[A-Za-z0-9_-]{1,80}$/;
const CHECKOUT_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** A restore destination the PC's user approved, by id (the hub's DESTINATION_RE); never a path. */
const DESTINATION_RE = /^dst_[a-z0-9]{6,32}$/;
/** kind → its fields and each field's form. */
export const ORDER_KINDS = {
  check: {},
  restore: { checkout_id: CHECKOUT_RE, destination_id: DESTINATION_RE },
  update: { version: VERSION_RE },
  disconnect: {},
  // The hub's own order: items wait on one agent of this PC (ids and fixed words only; its payload is checked on its own below).
  deliver: null,
};
const AGENT_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** Why a `deliver` order was sent: a fixed list, never free text (spec review step 3, change 16). None given means item. */
export const DELIVER_REASONS = ['item', 'team_start', 'write_handout', 'resume', 'reset', 'stop'];
const NOTICES = ['task_assigned', 'changes_requested', 'review_requested', 'decision', 'task_accepted', 'team_resumed', 'message', 'plan_request', 'task_approved', 'task_blocked', 'decision_asked'];
function validDeliver(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (Object.keys(p).some((k) => !['agent_id', 'items', 'agent_msg', 'reason'].includes(k))) return false;
  if (p.reason !== undefined && !DELIVER_REASONS.includes(p.reason)) return false;
  if (typeof p.agent_id !== 'string' || !AGENT_RE.test(p.agent_id) || (p.agent_msg !== undefined && typeof p.agent_msg !== 'boolean')) return false;
  // Only an item order carries items; every other reason (Start team, the handout, resume, reset, stop) is about the agent, not a task.
  if (!Array.isArray(p.items) || p.items.length < (p.reason === undefined || p.reason === 'item' ? 1 : 0) || p.items.length > 20) return false;
  if (p.reason !== undefined && p.reason !== 'item' && p.items.length > 0) return false;
  return p.items.every((i) => i && typeof i === 'object' && !Array.isArray(i) && Object.keys(i).every((k) => k === 'notice' || k === 'task')
    && NOTICES.includes(i.notice) && (i.task === undefined || (typeof i.task === 'string' && AGENT_RE.test(i.task))));
}
/** What makes a value a path or a command: a slash or backslash, a home or parent reference, a drive, a shell character. */
const PATHISH = /[\\/~`$;|&<>\n\r\0]|\.\.|^[A-Za-z]:/;

/** `{ok: true, order: {id, kind, payload}}` or `{ok: false, reason}`. */
export function validateOrder(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, reason: 'invalid_order' };
  const extra = Object.keys(o).filter((k) => !['id', 'kind', 'payload'].includes(k));
  if (extra.length || typeof o.id !== 'string' || !ID_RE.test(o.id)) return { ok: false, reason: 'invalid_order' };
  if (!Object.hasOwn(ORDER_KINDS, o.kind)) return { ok: false, reason: 'unknown_kind' };
  if (o.kind === 'deliver') return validDeliver(o.payload) ? { ok: true, order: { id: o.id, kind: 'deliver', payload: { agent_id: o.payload.agent_id, items: o.payload.items.map((i) => ({ ...i })), ...(o.payload.reason ? { reason: o.payload.reason } : {}), ...(o.payload.agent_msg ? { agent_msg: true } : {}) } } } : { ok: false, reason: 'invalid_order' };
  const spec = ORDER_KINDS[o.kind];
  const p = o.payload ?? {};
  if (typeof p !== 'object' || Array.isArray(p) || p === null) return { ok: false, reason: 'invalid_order' };
  const keys = Object.keys(p);
  if (keys.some((k) => !Object.hasOwn(spec, k)) || Object.keys(spec).some((k) => !(k in p))) return { ok: false, reason: 'invalid_order' };
  for (const k of keys) {
    const v = p[k];
    if (typeof v !== 'string') return { ok: false, reason: 'invalid_order' };
    if (PATHISH.test(v)) return { ok: false, reason: 'path_or_command' };
    if (!spec[k].test(v)) return { ok: false, reason: 'invalid_order' };
  }
  return { ok: true, order: { id: o.id, kind: o.kind, payload: { ...p } } };
}

const seenPath = (home, hubKey) => join(home, 'orders', `${createHash('sha256').update(hubKey).digest('hex').slice(0, 24)}.json`);
/**
 * An order is HANDLED once it has run (its result queued in the outbox, a restore begun, a delivery handed to the wake): `wasHandled` / `markHandled`.
 * The hub hands an order out again until its result arrives, so one lost in a crash runs on the next fetch and a handled one is skipped.
 */
export function wasHandled(home, hubKey, id) { return (readJson(seenPath(home, hubKey), { ids: [] })?.ids ?? []).includes(id); }
export function markHandled(home, hubKey, id) {
  const p = seenPath(home, hubKey), seen = readJson(p, { ids: [] })?.ids ?? [];
  if (!seen.includes(id)) atomicWrite(p, JSON.stringify({ ids: [...seen, id].slice(-500) }) + '\n');
}
/** True the first time an order id is seen for that hub, false on any replay. Keeps the last 500 ids. (Marks at once; the worker uses wasHandled and markHandled.) */
export function firstTime(home, hubKey, id) {
  const p = seenPath(home, hubKey);
  const seen = readJson(p, { ids: [] })?.ids ?? [];
  if (seen.includes(id)) return false;
  atomicWrite(p, JSON.stringify({ ids: [...seen, id].slice(-500) }) + '\n');
  return true;
}

/** The fixed sentences a failed order reports (at most 200 characters; never text from the order). */
export const ORDER_REASONS = {
  invalid_order: 'The order was refused: it is not one of the fixed PC actions with its typed fields.',
  unknown_kind: 'The order was refused: this kind of PC action is not on the fixed list.',
  path_or_command: 'The order was refused: it carries a path or a command, which no PC action may.',
  auto_update_off: 'Updates are turned off on this PC by its user.',
  measure_only: 'The order was refused: this compute machine only measures itself, so it takes Update and Disconnect and nothing else.',
  agent_unknown: 'Not delivered: this PC has no folder for that agent.',
  chat_in_use: 'Not delivered: the agent chat is in use.',
  wake_held: 'Not delivered: waking a session is held on this platform; the item shows on the connector screen and at the next prompt.',
  no_run: 'Nothing to stop: no run of this agent is going.',
  team_paused: 'Not started: the team was paused, so the work that waited for this agent was dropped.',
  disconnect_elsewhere: 'A disconnect is fetched with its receipt credential, not on this poll.',
};
