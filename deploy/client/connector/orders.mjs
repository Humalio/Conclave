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
};
/** What makes a value a path or a command: a slash or backslash, a home or parent reference, a drive, a shell character. */
const PATHISH = /[\\/~`$;|&<>\n\r\0]|\.\.|^[A-Za-z]:/;

/** `{ok: true, order: {id, kind, payload}}` or `{ok: false, reason}`. */
export function validateOrder(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, reason: 'invalid_order' };
  const extra = Object.keys(o).filter((k) => !['id', 'kind', 'payload'].includes(k));
  if (extra.length || typeof o.id !== 'string' || !ID_RE.test(o.id)) return { ok: false, reason: 'invalid_order' };
  const spec = Object.hasOwn(ORDER_KINDS, o.kind) ? ORDER_KINDS[o.kind] : null;
  if (!spec) return { ok: false, reason: 'unknown_kind' };
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
/** True the first time an order id is seen for that hub, false on any replay. Keeps the last 500 ids. */
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
  restore_not_built: 'Restore is not in this connector version yet.',
  disconnect_elsewhere: 'A disconnect is fetched with its receipt credential, not on this poll.',
};
