/**
 * Full once, then short (docs/mcp.md, "Replies and notices"): in a compact login, a task's long texts (the brief, its
 * "in short", the submission, the review comments, a block reason) go out in full the first time the login receives
 * them. A later reply that carries the same text leaves it out and names it in `unchanged`, next to the task's id and
 * version, so the agent knows it already has it. What a login was sent is kept per login (session token hash), so a
 * new session_login starts over; it lives in memory, so a hub restart also starts over (the safe direction: one more
 * full copy). task_list with a task_id always sends the task in full, for an agent whose context lost it.
 */
import { createHash } from 'node:crypto';

/** The texts a task view or a work item may repeat. A review's summary is the task's submission, so it shares its key. */
const TASK_TEXTS = ['description', 'short_summary', 'short_summary_hub', 'summary', 'review_comments', 'blocked_reason'] as const;
const REVIEW_TEXTS: Record<string, string> = { summary: 'summary', comments: 'review_comments' };
/** Bounds: logins remembered, and texts per login. The oldest login is forgotten first (it gets full copies again). */
const MAX_LOGINS = 500, MAX_TEXTS = 1000;

const digest = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 22);
const isTask = (o: Record<string, unknown>) => typeof o.id === 'string' && o.id.startsWith('task_') && typeof o.version === 'number';

export class SentTexts {
  private logins = new Map<string, Map<string, string>>();

  /** Forget what a login was sent (logout); a new login has a new token and starts empty anyway. */
  forget(tokenHash: string): void { this.logins.delete(tokenHash); }

  /**
   * Leave out of `data` (a copy) every task text this login already has, and remember the rest as sent. `full`: task ids
   * sent in full whatever this login had (task_list with a task_id); they are still remembered as sent.
   */
  trim<T>(tokenHash: string, data: T, full: ReadonlySet<string> = new Set()): T {
    let seen = this.logins.get(tokenHash);
    if (seen) this.logins.delete(tokenHash);
    else seen = new Map();
    this.logins.set(tokenHash, seen); // most recently used last
    if (this.logins.size > MAX_LOGINS) this.logins.delete(this.logins.keys().next().value!);
    const copy = structuredClone(data);
    const once = (taskId: string, key: string, text: string): boolean => {
      const k = `${taskId}:${key}`, h = digest(text);
      if (seen.get(k) === h && !full.has(taskId)) return true;
      seen.delete(k); seen.set(k, h);
      if (seen.size > MAX_TEXTS) seen.delete(seen.keys().next().value!);
      return false;
    };
    const walk = (v: unknown, depth: number): void => {
      if (depth > 6 || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      const o = v as Record<string, unknown>;
      if (isTask(o)) {
        const left: string[] = [];
        for (const f of TASK_TEXTS) if (typeof o[f] === 'string' && o[f] && once(o.id as string, f, o[f] as string)) { delete o[f]; left.push(f); }
        if (left.length) o.unchanged = left;
      }
      for (const [k, x] of Object.entries(o)) if (k !== 'review') walk(x, depth + 1);
      // A work item: { task, review: { summary, comments } }. The review's texts are the task's own, which went out just
      // above (or earlier), so they are left out here and named in review.unchanged.
      const t = o.task as Record<string, unknown> | undefined, r = o.review as Record<string, unknown> | undefined;
      if (t && r && typeof r === 'object' && typeof t.id === 'string' && t.id.startsWith('task_')) {
        const left: string[] = [];
        for (const [f, key] of Object.entries(REVIEW_TEXTS)) if (typeof r[f] === 'string' && r[f] && once(t.id, key, r[f] as string)) { delete r[f]; left.push(f); }
        if (left.length) r.unchanged = left;
      }
    };
    walk(copy, 0);
    return copy;
  }
}

/** One memory per hub (per database): MCP servers are built per request, the memory outlives them. */
const memories = new WeakMap<object, SentTexts>();
export const sentTexts = (hub: object): SentTexts => {
  let m = memories.get(hub);
  if (!m) memories.set(hub, (m = new SentTexts()));
  return m;
};
