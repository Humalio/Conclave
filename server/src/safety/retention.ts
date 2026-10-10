/** One in-process maintenance scheduler: retention (batched deletes), blob GC, expiry of requests and old counters. */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { VaultStore } from '../vault/store.js';
import type { Access } from '../access/access.js';
import type { Alerts } from './alerts.js';

const DAY = 86400_000;
export const BATCH = 5000;
export interface RetentionConfig { sharesDays: number; channelsDays: number; workItemsDays: number; blobGraceMs: number }
export const DEFAULT_RETENTION: RetentionConfig = { sharesDays: 90, channelsDays: 90, workItemsDays: 30, blobGraceMs: DAY };
export interface RetentionResult { shares: number; channels: number; workItems: number; blobs: number }

export class Maintenance {
  private timer: NodeJS.Timeout | null = null;
  private lastRetention = 0;
  private running = false;
  constructor(private readonly db: Db, private readonly store: VaultStore, private readonly access: Access, private readonly alerts: Alerts, private readonly cfg: RetentionConfig = DEFAULT_RETENTION) {}

  /** Start the single scheduler. Retention runs at most once an hour. */
  start(everyMs = 60_000): void {
    this.timer = setInterval(() => { void this.tick(); }, everyMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.access.expirePending(now);
      this.alerts.cleanup(now);
      if (now - this.lastRetention >= 3600_000) { this.lastRetention = now; await this.run(now); }
    } catch (e) { console.error('maintenance failed', e); }
    finally { this.running = false; }
  }

  /** Settings override the defaults: retention.shares_days, retention.channels_days, retention.work_items_days. */
  private days(key: string, dflt: number): number {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined;
    const n = r ? Number(JSON.parse(r.value)) : NaN;
    return Number.isFinite(n) && n > 0 ? n : dflt;
  }

  async run(now = Date.now()): Promise<RetentionResult> {
    const out: RetentionResult = { shares: 0, channels: 0, workItems: 0, blobs: 0 };
    out.shares = this.deleteShares(now - this.days('retention.shares_days', this.cfg.sharesDays) * DAY);
    out.channels = this.batched("DELETE FROM data_channels WHERE id IN (SELECT id FROM data_channels WHERE status IN ('done','expired','closed','failed') AND COALESCE(finished_at, created_at)<? LIMIT ?)", now - this.days('retention.channels_days', this.cfg.channelsDays) * DAY);
    out.workItems = this.batched('DELETE FROM work_items WHERE id IN (SELECT id FROM work_items WHERE acked_at IS NOT NULL AND acked_at<? LIMIT ?)', now - this.days('retention.work_items_days', this.cfg.workItemsDays) * DAY);
    out.blobs = await this.gcBlobs(now - this.cfg.blobGraceMs);
    return out;
  }

  private batched(sql: string, cutoff: number): number {
    let total = 0;
    for (;;) {
      const n = Number(this.db.prepare(sql).run(cutoff, BATCH).changes);
      total += n;
      if (n < BATCH) return total;
    }
  }

  /** Closed or revoked shares, with their versions, feedback and recipients. */
  private deleteShares(cutoff: number): number {
    let total = 0;
    for (;;) {
      const ids = (this.db.prepare("SELECT id FROM shares WHERE status IN ('closed','revoked') AND updated_at<? LIMIT ?").all(cutoff, BATCH) as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) return total;
      tx(this.db, () => this.deleteShareRows(ids));
      total += ids.length;
      if (ids.length < BATCH) return total;
    }
  }
  deleteShareRows(ids: string[]): void {
    const ph = ids.map(() => '?').join(',');
    for (const t of ['share_feedback', 'share_versions', 'share_recipients']) this.db.prepare(`DELETE FROM ${t} WHERE share_id IN (${ph})`).run(...ids);
    this.db.prepare(`DELETE FROM shares WHERE id IN (${ph})`).run(...ids);
  }

  /** Delete blobs nothing refers to any more (older than the grace period, so in-flight uploads are safe). */
  async gcBlobs(cutoff: number): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = this.db.prepare(`SELECT b.hash FROM blobs b WHERE b.created_at<?
        AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.revision=b.hash OR r.parent_revision=b.hash)
        AND NOT EXISTS (SELECT 1 FROM files f WHERE f.current_revision=b.hash)
        AND NOT EXISTS (SELECT 1 FROM write_intents w WHERE w.base_revision=b.hash OR w.new_revision=b.hash)
        AND NOT EXISTS (SELECT 1 FROM file_conflicts c WHERE instr(c.revisions, b.hash)>0 OR instr(COALESCE(c.resolution,''), b.hash)>0)
        AND NOT EXISTS (SELECT 1 FROM share_versions v, json_each(v.manifest) j WHERE json_extract(j.value,'$.blob_hash')=b.hash)
        LIMIT ?`).all(cutoff, BATCH) as { hash: string }[];
      for (const r of rows) {
        await this.store.deleteBlob(r.hash);
        this.db.prepare('DELETE FROM blobs WHERE hash=?').run(r.hash);
      }
      total += rows.length;
      if (rows.length < BATCH) return total;
    }
  }
}
