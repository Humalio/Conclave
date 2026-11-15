/**
 * "via <delegate>" (docs/checkout.md §9.1, contributor mode): the person a delegated agent ran for when it wrote at a
 * given moment, from the delegation's window (the confirm on their PC until it ended). Shown wherever the agent's writes
 * show: Blueprint items, revisions and proposals, and the work feed. An admin delegate is no collaborator and gives none.
 */
import type { Db } from '../db/db.js';

export function delegateAt(db: Db, agentId: string | null | undefined, at: number): string | null {
  if (!agentId) return null;
  const r = db.prepare(`SELECT COALESCE(u.display_name, u.username) who FROM checkouts c JOIN admin_users u ON u.id=c.delegate_user_id
    WHERE c.scope='agent' AND c.agent_id=? AND u.role <> 'admin' AND c.restoring_at IS NOT NULL AND c.restoring_at <= ?
    AND COALESCE(c.released_at, c.ended_at, 9e15) > ? ORDER BY c.restoring_at DESC LIMIT 1`).get(agentId, at, at) as { who: string } | undefined;
  return r?.who ?? null;
}
