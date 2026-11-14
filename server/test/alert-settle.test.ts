/** Alerts that wait for a decision close once it is made (docs/security.md, Alerts); the hub sweeps old ones at start. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { testConfig } from './hub.js';

describe('alert sweep at start', () => {
  it('closes the waiting alerts whose proposal, request or task was decided, and leaves the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-settle-'));
    mkdirSync(join(dir, 'vault'));
    let app = await buildApp(testConfig(dir));
    const ids: Record<string, string> = {};
    try {
      // Raised before this fix: nothing closed them, and their rows are long decided or gone.
      for (const [type, subject] of [['bp_proposal', 'bpp_gone'], ['bp_replan', 'bpr_gone'], ['onboarding_request', 'obr_gone'], ['recruit_request', 'team_gone'],
        ['checkpoint', 'task_gone'], ['task_blocked', 'task_gone'], ['task_overdue', 'task_gone'], ['checkout_overdue', 'cko_gone'], ['stalled_member', 'agent_gone'], ['login_burst', '127.0.0.1']] as const)
        ids[type] = app.audit.alert('info', type, subject).id;
      app.db.prepare("UPDATE security_alerts SET status='acknowledged' WHERE id=?").run(ids.bp_replan);
    } finally { await app.close(); }
    app = await buildApp(testConfig(dir));
    try {
      const st = (id: string) => (app.db.prepare('SELECT status FROM security_alerts WHERE id=?').get(id) as { status: string }).status;
      for (const t of ['bp_proposal', 'bp_replan', 'onboarding_request', 'recruit_request', 'checkpoint', 'task_blocked', 'task_overdue', 'checkout_overdue', 'stalled_member']) expect([t, st(ids[t]!)]).toEqual([t, 'closed']);
      expect(st(ids.login_burst!)).toBe('open'); // not a question: it stays until the operator closes it
      expect(app.audit.settle()).toBe(0);
    } finally { await app.close(); }
  });
});
