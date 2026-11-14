/**
 * A checkout's current step in one sentence (docs/dashboard-ux.md, team page "Checkout"): from the checkout's own state,
 * with the one action the operator can take now, or who acts next by agent label.
 */
import { describe, it, expect } from 'vitest';
import { checkoutStep, names, type CheckoutStepIn } from '../src/checkout/step.js';

const L: Record<string, string> = { a1: 'Biraz Coordinator', a2: 'Biraz Developer 1', a3: 'Biraz Developer 2', a4: 'Biraz Reviewer' };
const step = (status: CheckoutStepIn['status'], handouts: CheckoutStepIn['handouts'], approvePc: CheckoutStepIn['approvePc'] = null) =>
  checkoutStep({ status, handouts, approvePc, label: (id) => L[id] ?? id });
const h = (agent_id: string, status: string, waiting = 0) => ({ agent_id, status, waiting });

describe('checkoutStep', () => {
  it('names up to two, then counts the rest', () => {
    expect(names(['A'])).toBe('A');
    expect(names(['A', 'B'])).toBe('A and B');
    expect(names(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
  });
  it('collecting: progress of the handouts and who writes next, by label', () => {
    const s = step('collecting', [h('a1', 'written'), h('a2', 'requested')]);
    expect(s).toEqual({ n: 1, of: 5, text: 'Step 1 of 5. The members are stopping at a good point and writing their handouts: 1 of 2 written.', action: null, next: 'Next: Biraz Developer 1 writes its handout.' });
    expect(step('collecting', [h('a1', 'requested'), h('a2', 'requested'), h('a3', 'requested')]).next).toBe('Next: Biraz Coordinator, Biraz Developer 1 and 1 more write their handouts.');
  });
  it('collecting with leftovers that wait: the operator reviews them first', () => {
    const s = step('collecting', [h('a2', 'merged', 1), h('a3', 'merged', 2), h('a1', 'requested')]);
    expect(s.text).toBe('Step 1 of 5. Biraz Developer 1 and Biraz Developer 2 merged their work and left 3 leftovers that wait for your review.');
    expect(s.action).toBe('Review the leftovers');
    expect(s.next).toBe('Then Biraz Developer 1 and Biraz Developer 2 write their handouts.');
    expect(step('collecting', [h('a2', 'merged', 1)]).text).toContain('merged its work and left 1 leftover that waits');
  });
  it('ready, rendered and restoring: one action for the operator, or who resumes next', () => {
    expect(step('ready', [h('a1', 'written'), h('a2', 'written')])).toMatchObject({ n: 2, action: 'Choose the target and keys', next: null, text: 'Step 2 of 5. All 2 handouts are written, and the team stays paused until you choose where it moves.' });
    expect(step('rendered', [h('a1', 'written')])).toMatchObject({ n: 3, action: 'Run the restore prompt', next: 'Then each member resumes on the target.' });
    expect(step('rendered', [h('a1', 'written')], { name: 'Studio PC' })).toMatchObject({ action: 'Approve the new PC', text: 'Step 3 of 5. The new PC Studio PC has enrolled and waits for your approval before its keys are released.' });
    expect(step('restoring', [h('a1', 'consumed'), h('a4', 'written')])).toMatchObject({ n: 4, action: null, text: 'Step 4 of 5. The members are resuming on the target: 1 of 2 resumed.', next: 'Next: Biraz Reviewer resumes on the target.' });
  });
  it('restored, cancelled and expired: nothing left to do', () => {
    expect(step('restored', [h('a1', 'consumed')])).toMatchObject({ n: 5, action: null, next: null });
    expect(step('cancelled', [])).toEqual({ n: 0, of: 5, text: 'The checkout was cancelled.', action: null, next: null });
    expect(step('expired', []).text).toBe('The checkout expired before it finished.');
  });
  it('never shows an agent id when a label is known', () => {
    const s = step('collecting', [h('a2', 'merged', 1), h('a3', 'requested')]);
    expect(`${s.text} ${s.next}`).not.toMatch(/\ba[0-9]\b/);
  });
});
