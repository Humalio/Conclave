/**
 * One temp folder per test run (vitest's global setup and the client helper tests). Tests create throwaway hubs, keys and
 * folders with mkdtemp under os.tmpdir(); pointing TMPDIR, TEMP and TMP at one run folder keeps all of it in one place, and
 * the run deletes that folder when it ends, also after a failure. A run that was killed leaves its folder: the next run
 * deletes run folders older than a day whose process is gone. Nothing else in the temp folder is ever touched.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TMP_KEYS = ['TMPDIR', 'TMP', 'TEMP'];
export const RUN_RE = /^conclave-test-(\d+)-(\d+)$/;
export const STALE_MS = 24 * 60 * 60_000;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
};
const remove = (p) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; } catch { return false; } };

/** Deletes run folders in `base` older than `staleMs` whose process is gone. Returns the names it removed. */
export function sweepOldRuns(base = tmpdir(), { now = Date.now(), staleMs = STALE_MS, isAlive = alive } = {}) {
  let names = [];
  try { names = readdirSync(base); } catch { return []; }
  const removed = [];
  for (const n of names) {
    const m = RUN_RE.exec(n);
    if (!m) continue;
    const pid = Number(m[1]), at = Number(m[2]);
    if (now - at < staleMs || isAlive(pid)) continue;
    try { if (!statSync(join(base, n)).isDirectory()) continue; } catch { continue; }
    if (remove(join(base, n))) removed.push(n);
  }
  return removed;
}

/**
 * Starts a run: sweeps old runs, makes `conclave-test-<pid>-<time>` in the real temp folder and points the temp variables of
 * this process (and so of every worker or child started after this) at it. `end()` restores the variables and deletes it.
 */
export function startRun({ base = tmpdir(), env = process.env, pid = process.pid, now = Date.now() } = {}) {
  sweepOldRuns(base, { now });
  const root = join(base, `conclave-test-${pid}-${now}`);
  mkdirSync(root, { recursive: true });
  const saved = Object.fromEntries(TMP_KEYS.map((k) => [k, env[k]]));
  for (const k of TMP_KEYS) env[k] = root;
  let ended = false;
  return {
    root,
    end() {
      if (ended) return;
      ended = true;
      for (const k of TMP_KEYS) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; }
      remove(root);
    },
  };
}
