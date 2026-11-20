/**
 * The service's side of vault sync (docs/vault-sync.md, "The connector side"): one loop per sync that is active on a hub the
 * worker is checking in with. A loop runs at once, again on a `vault_changed` hint, and on a 60 s timer as the safety net
 * when the stream is down or a hint was lost. A failing run backs off; a revoked reader ends its loop.
 */
import { findSync, listSyncs } from './syncstore.mjs';
import { createEngine } from './syncengine.mjs';
import { makeApi } from './syncapi.mjs';
import { authFor } from './syncops.mjs';

export const POLL_MS = 60_000;
export const BACKOFF_MAX_MS = 10 * 60_000;

export function createSyncHost({ home, log = () => {}, pollMs = POLL_MS, makeApiFn = makeApi, os = process.platform }) {
  const loops = new Map(); // sync id -> { ac, nudge, hubKey }

  async function loop(id, hub, ac) {
    const sig = ac.signal;
    let fails = 0, wake = null, nudged = false;
    const entry = loops.get(id);
    entry.nudge = () => { nudged = true; wake?.(); }; // a hint during a run is kept for the next turn of the loop
    const wait = (ms) => new Promise((res) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); wake = null; sig.removeEventListener('abort', done); res(); }
      wake = done; sig.addEventListener('abort', done, { once: true });
    });
    while (!sig.aborted) {
      const rec = findSync(home, id);
      if (!rec || rec.state === 'revoked') break;
      if (rec.state === 'active') {
        const auth = authFor(home, rec);
        if (!auth) { log(`sync ${rec.name}: its key is not in the key file; stopped`); break; }
        const r = await createEngine({ home, rec, api: makeApiFn(hub, auth, { signal: sig }), log: (m) => log(`sync ${m}`), os }).runOnce();
        if (r.revoked) break;
        fails = r.failed || r.hubPaused || r.errors?.length ? Math.min(fails + 1, 8) : 0;
      }
      if (!nudged) await wait(fails ? Math.min(BACKOFF_MAX_MS, pollMs * 2 ** (fails - 1)) : pollMs);
      nudged = false;
    }
    if (loops.get(id) === entry) loops.delete(id);
  }

  return {
    /** Starts a loop for each active (or paused: it idles) sync of this hub that has none. Called at every check-in. */
    ensure(section, hub, signal) {
      for (const rec of listSyncs(home)) {
        if (rec.hub_id !== section.hub_id || rec.ca_sha256 !== section.ca_sha256 || rec.state === 'revoked' || loops.has(rec.id)) continue;
        const ac = new AbortController();
        signal?.addEventListener('abort', () => ac.abort(), { once: true });
        loops.set(rec.id, { ac, nudge: null });
        loop(rec.id, hub, ac).catch((e) => { log(`sync ${rec.name}: stopped (${e.message})`); if (loops.get(rec.id)?.ac === ac) loops.delete(rec.id); });
      }
    },
    /** `vault_changed` on this hub's stream: the reader named runs now. */
    hint(readerId) {
      for (const rec of listSyncs(home)) if (rec.reader_id === readerId) loops.get(rec.id)?.nudge?.();
    },
    stop() { for (const l of loops.values()) l.ac.abort(); loops.clear(); },
    running: () => [...loops.keys()],
  };
}

