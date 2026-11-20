/**
 * The leak guard's end-of-turn scan (docs/connector.md, "Isolation levels"): when a run ends, the connector reads its
 * transcript for a long-lived key. A session never holds one, so any hit is a key that reached the transcript some other
 * way (a file the agent read, a command it ran). It reports where, never what.
 *
 * Two things are looked for: any text shaped like a Conclave key (session, app, bridge or receipt key), and the exact keys
 * of the agent this run belonged to, in case they were written in some other shape.
 */
import { readFileSync, statSync } from 'node:fs';

const KEY_SHAPE = /\bah_(?:ses|app|brg|dsc|set|key)_[a-z2-7]{12}_[a-z2-7]{16,}/;
/** At most this much of a transcript is read, from its start: a long turn's file can be large, and the scan must not stall the connector. */
export const SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** `{ok: true, found: false}`, `{ok: true, found: true, kind}` for a hit, or `{ok: false}` when the file could not be read. */
export function scanTranscript(path, secrets = []) {
  if (typeof path !== 'string' || !path) return { ok: false };
  let text;
  try { if (statSync(path).size > SCAN_MAX_BYTES) return { ok: false }; text = readFileSync(path, 'utf8'); } catch { return { ok: false }; }
  if (KEY_SHAPE.test(text)) return { ok: true, found: true, kind: 'key_shape' };
  for (const s of secrets) if (typeof s === 'string' && s.length >= 16 && text.includes(s)) return { ok: true, found: true, kind: 'exact' };
  return { ok: true, found: false };
}
