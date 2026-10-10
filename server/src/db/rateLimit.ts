import type { Db } from './db.js';

const BUCKET_MS = 60_000;

/** Failure counter persisted in usage_counters: 1-minute buckets summed over a sliding window. */
export class RateLimit {
  constructor(private readonly db: Db, private readonly max: number, private readonly windowMs: number) {}

  /** Failures in the window, and the ms until the oldest one leaves it. */
  state(scope: string, metric: string, now = Date.now()): { count: number; retryAfterMs: number } {
    const rows = this.db.prepare('SELECT window_start, count FROM usage_counters WHERE scope=? AND metric=? AND window_start>? ORDER BY window_start')
      .all(scope, metric, now - this.windowMs) as { window_start: number; count: number }[];
    const count = rows.reduce((s, r) => s + r.count, 0);
    return { count, retryAfterMs: rows.length ? Math.max(0, rows[0]!.window_start + this.windowMs - now) : 0 };
  }

  blocked(scope: string, metric: string, now = Date.now()): { blocked: boolean; retryAfterMs: number } {
    const s = this.state(scope, metric, now);
    return { blocked: s.count >= this.max, retryAfterMs: s.retryAfterMs };
  }

  fail(scope: string, metric: string, now = Date.now()): void {
    const ws = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    this.db.prepare(`INSERT INTO usage_counters(scope,metric,window_start,count) VALUES (?,?,?,1)
      ON CONFLICT(scope,metric,window_start) DO UPDATE SET count=count+1`).run(scope, metric, ws);
    this.db.prepare('DELETE FROM usage_counters WHERE metric=? AND window_start<=?').run(metric, now - this.windowMs);
  }
}
