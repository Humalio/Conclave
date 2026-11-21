/**
 * Why an item has not reached its agent yet, as the operator reads it (design "connector delivers work" §3g and §4; docs/connector.md,
 * "The wake"): "Not delivered: why", "Waiting behind task X" while a woken run of the agent works on another task, and
 * "PC offline since hh:mm" (a PC that stopped checking in is offline, never "asleep", and nothing fails).
 */
import type { Db } from '../db/db.js';
import { ONLINE_MS } from './connector.js';

/** The fixed words for task_turns.delivery_reason. */
export const DELIVERY_WORDS: Record<string, string> = {
  pc_offline: 'Not delivered: waiting for the PC', chat_in_use: 'Not delivered: chat in use', wake_held: 'Not delivered: waking is off for this agent on its PC', agent_unknown: 'Not delivered: this PC has no folder for the agent',
  connector_too_old: 'Not delivered: connector too old',
};

export interface DeliveryWhy { pc_offline_since: number | null; waiting_behind: { id: string; title: string } | null }

/**
 * For one undelivered turn of a task held by an agent: since when the agent's PC is offline (its last check-in, once it is older than
 * ONLINE_MS; null for a PC that never reported, is suspended or is disconnected), and the task its woken run works on when that is
 * another task (the wake runs one turn at a time per folder, so this item waits behind it).
 */
export function deliveryWhy(db: Db, agentId: string, taskId: string | null, now = Date.now()): DeliveryWhy {
  const pc = db.prepare(`SELECT r.last_check_in_at t FROM credentials c JOIN machines m ON m.id=c.bound_machine_id JOIN connector_reports r ON r.machine_id=m.id
    WHERE c.kind='session_key' AND c.agent_id=? AND c.status='active' AND m.status='active'
      AND NOT EXISTS (SELECT 1 FROM pc_actions a WHERE a.machine_id=m.id AND a.kind='disconnect' AND a.ended_at IS NULL)
    ORDER BY c.created_at DESC LIMIT 1`).get(agentId) as { t: number } | undefined;
  const w = db.prepare(`SELECT w.state, w.task_id, w.waiting_on FROM wake_runs w WHERE w.agent_id=? AND w.state IN ('running','waiting')`).get(agentId) as { state: string; task_id: string | null; waiting_on: string | null } | undefined;
  const busy = w ? (w.state === 'waiting' ? w.waiting_on ?? w.task_id : w.task_id) : null;
  const t = busy && busy !== taskId ? db.prepare('SELECT id, title FROM tasks WHERE id=?').get(busy) as { id: string; title: string } | undefined : undefined;
  return { pc_offline_since: pc && now - pc.t >= ONLINE_MS ? pc.t : null, waiting_behind: t ? { id: t.id, title: t.title } : null };
}

/**
 * The one line the operator reads for an undelivered item: waiting behind another task first, then an offline PC, then the reason.
 * Without `at` the offline line leaves the time out, for a reader whose clock the hub does not know (the console adds it, offline_since).
 */
export function deliveryLine(why: DeliveryWhy, reason: string | null, at?: (t: number) => string): string {
  if (why.waiting_behind) return `Waiting behind task ${why.waiting_behind.title}`;
  if (why.pc_offline_since !== null) return `Not delivered: PC offline${at ? ` since ${at(why.pc_offline_since)}` : ''}`;
  return reason ? DELIVERY_WORDS[reason] ?? 'Not delivered yet' : 'Not delivered yet';
}
