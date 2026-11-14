/**
 * A checkout's current step in one sentence (docs/dashboard-ux.md, team page "Checkout"): taken from the checkout's own
 * state, with the one action the operator can take now, or who acts next by agent label. The team page's Checkout card and
 * the checkout's Needs you rows read the same text, so the two never differ.
 */
import type { CheckoutStatus } from './checkout.js';

export interface CheckoutStepIn {
  status: CheckoutStatus;
  /** Each member's handout: its agent and status, and how many leftovers wait for the operator (merged handouts only). */
  handouts: { agent_id: string; status: string; waiting?: number }[];
  /** A new PC that enrolled and waits for the operator's approval (rendered checkouts only). */
  approvePc?: { name: string | null } | null;
  /** An agent's label, never its id when a label is known. */
  label: (agentId: string) => string;
}
export interface CheckoutStep {
  /** 1 to 5 (collecting, ready, rendered, restoring, restored); 0 for a cancelled or expired checkout. */
  n: number; of: 5;
  /** One sentence: where the checkout stands. */
  text: string;
  /** The one thing the operator can do now, as a button label; null when the next move is an agent's. */
  action: string | null;
  /** Who acts after this, by label ("Then …" / "Next: …"); null when nobody does. */
  next: string | null;
}

const STEP: Record<CheckoutStatus, number> = { collecting: 1, ready: 2, rendered: 3, restoring: 4, restored: 5, cancelled: 0, expired: 0 };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** "A", "A and B", "A, B and 2 more". */
export function names(L: string[]): string {
  if (L.length <= 2) return L.join(' and ');
  return `${L.slice(0, 2).join(', ')} and ${L.length - 2} more`;
}
const written = (s: string) => s === 'written' || s === 'consumed';

export function checkoutStep(c: CheckoutStepIn): CheckoutStep {
  const n = STEP[c.status] ?? 0, H = c.handouts, m = H.length, out = (text: string, action: string | null, next: string | null): CheckoutStep => ({ n, of: 5, text: n ? `Step ${n} of 5. ${text}` : text, action, next });
  switch (c.status) {
    case 'collecting': {
      const W = H.filter((h) => (h.waiting ?? 0) > 0), k = W.reduce((s, h) => s + (h.waiting ?? 0), 0), who = names(W.map((h) => c.label(h.agent_id)));
      if (W.length) return out(`${who} merged ${W.length === 1 ? 'its' : 'their'} work and left ${plural(k, 'leftover')} that ${k === 1 ? 'waits' : 'wait'} for your review.`, 'Review the leftovers', `Then ${who} ${W.length === 1 ? 'writes its handout' : 'write their handouts'}.`);
      const todo = H.filter((h) => !written(h.status)).map((h) => c.label(h.agent_id));
      return out(`The members are stopping at a good point and writing their handouts: ${m - todo.length} of ${m} written.`, null, todo.length ? `Next: ${names(todo)} ${todo.length === 1 ? 'writes its handout' : 'write their handouts'}.` : null);
    }
    case 'ready': return out(`All ${plural(m, 'handout')} are written, and the team stays paused until you choose where it moves.`, 'Choose the target and keys', null);
    case 'rendered':
      if (c.approvePc) return out(`The new PC${c.approvePc.name ? ` ${c.approvePc.name}` : ''} has enrolled and waits for your approval before its keys are released.`, 'Approve the new PC', 'Then each member resumes on the target.');
      return out('The restore prompt is made and waits to be run on the target PC.', 'Run the restore prompt', 'Then each member resumes on the target.');
    case 'restoring': {
      const todo = H.filter((h) => h.status !== 'consumed').map((h) => c.label(h.agent_id));
      return out(`The members are resuming on the target: ${m - todo.length} of ${m} resumed.`, null, todo.length ? `Next: ${names(todo)} ${todo.length === 1 ? 'resumes' : 'resume'} on the target.` : null);
    }
    case 'restored': return out('Every member resumed on the target, and the checkout is done.', null, null);
    default: return out(c.status === 'cancelled' ? 'The checkout was cancelled.' : 'The checkout expired before it finished.', null, null);
  }
}
