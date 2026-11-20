/* One delivery model in the console: each waiting item says where delivery stands (Delivered hh:mm, Waiting behind task X,
   Not delivered: PC offline since hh:mm, Not delivered: why, or Not delivered yet) on the task and in Needs you, with Reassign for the operator; an
   answered decision says when it reached the asker; and no screen offers a delivery mode any more. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const between = (a: string, b: string) => { const i = js.indexOf(a), j = js.indexOf(b, i); expect(i, a).toBeGreaterThan(-1); expect(j, b).toBeGreaterThan(i); return js.slice(i, j); };

// The helpers, cut from the console source and run here with small stand-ins for the console's own.
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const S = { me: { role: 'admin' } as { role: string } | null };
const make = () => new Function('esc', 'S', 'AG', 'ic', 'dt', `${between('const DELIV = ', 'async function reassignSheet')}\nreturn { delivText, delivLine, atTime, nyOffline };`)(
  esc, S, (id: string) => ({ ag_w: 'Developer 2' } as Record<string, string>)[id] ?? '', () => '', (t: number) => `on ${new Date(t).toISOString().slice(0, 10)}`) as {
  delivText: (u: unknown) => string; nyOffline: (r: unknown, t: string) => string; delivLine: (k: unknown, teamId: string) => string; atTime: (t: number) => string };
const { delivText, delivLine, atTime, nyOffline } = make();
const turn = (over: Record<string, unknown> = {}) => ({ phase: 'queued', holder: 'ag_w', holder_label: 'Developer 2', since: Date.now(), seen_at: null, due_at: null, delivered_at: null, delivery_reason: null, ...over });

describe('delivery state words', () => {
  it('an item not yet delivered reads "Not delivered yet"; a reason names why; delivered names the time', () => {
    expect(delivText(turn())).toBe('Not delivered yet');
    expect(delivText(turn({ delivery_reason: 'pc_offline' }))).toBe('Not delivered: waiting for the PC');
    expect(delivText(turn({ delivery_reason: 'chat_in_use' }))).toBe('Not delivered: chat in use');
    expect(delivText(turn({ delivery_reason: 'wake_held' }))).toBe('Not delivered: wake held on this platform');
    expect(delivText(turn({ delivery_reason: 'agent_unknown' }))).toBe('Not delivered: no session to wake');
    expect(delivText(turn({ delivery_reason: 'connector_too_old' }))).toBe('Not delivered: connector too old');
    const at = new Date(); at.setHours(9, 5, 0, 0);
    // An offline PC names since when, in the viewer's clock, and never says "asleep"; a busy woken run names the task it works on.
    expect(delivText(turn({ delivery_reason: 'pc_offline', pc_offline_since: at.getTime() }))).toBe('Not delivered: PC offline since 09:05');
    expect(delivText(turn({ pc_offline_since: at.getTime(), waiting_behind: { id: 't2', title: 'Fix login' } }))).toBe('Waiting behind task Fix login');
    expect(js).not.toMatch(/PC asleep/i);
    expect(delivText(turn({ delivered_at: at.getTime() }))).toBe('Delivered 09:05');
    // Delivered wins over a stale reason; a seen item that was never reported delivered says nothing.
    expect(delivText(turn({ delivered_at: at.getTime(), delivery_reason: 'pc_offline' }))).toBe('Delivered 09:05');
    expect(delivText(turn({ seen_at: Date.now() }))).toBe('');
    expect(delivText(null)).toBe('');
  });
  it('a time from another day names the day', () => {
    expect(atTime(Date.UTC(2020, 0, 2, 12))).toBe('on 2020-01-02');
  });
});

describe('the task screen', () => {
  it('shows who holds it and "Not delivered yet", with Reassign for the operator', () => {
    S.me = { role: 'admin' };
    const h = delivLine({ id: 'task_1', status: 'assigned', turn: turn() }, 'team_1');
    expect(h).toContain('Developer 2 · ');
    expect(h).toContain('<span class="warn-t">Not delivered yet</span>');
    expect(h).toContain('data-reassign="team_1|task_1"');
    expect(h).toContain('Reassign</button>');
  });
  it('offers no Reassign to a viewer, nor on a task in review; shows nothing once delivered and read for a viewer', () => {
    S.me = { role: 'viewer' };
    expect(delivLine({ id: 'task_1', status: 'assigned', turn: turn() }, 'team_1')).not.toContain('data-reassign');
    expect(delivLine({ id: 'task_1', status: 'in_progress', turn: turn({ seen_at: 1 }) }, 'team_1')).toBe('');
    S.me = { role: 'admin' };
    const rv = delivLine({ id: 'task_2', status: 'in_review', turn: turn({ phase: 'review' }) }, 'team_1');
    expect(rv).toContain('Not delivered yet');
    expect(rv).not.toContain('data-reassign');
    expect(delivLine({ id: 'task_3', status: 'done', turn: null }, 'team_1')).toBe('');
  });
  it('is rendered under the task\'s progress, and styled to wrap on a phone', () => {
    expect(js).toContain('${lifecycle(k, t, events)}${delivLine(k, t.id)}');
    expect(css).toMatch(/\.tk-deliv\{[^}]*flex-wrap:wrap[^}]*white-space:normal/);
  });
  it('a waiting review on the board says it in the same words', () => {
    expect(between('const waitText = ', 'function tkText')).toContain('delivText(u).toLowerCase()');
  });
});

describe('Needs you', () => {
  it('names the two kinds and gives undelivered and overdue rows a Reassign button and Open task', () => {
    const kinds = between('const NY_KIND = ', '\n');
    expect(kinds).toContain("undelivered: ['Not delivered yet', 'clock']");
    expect(kinds).toContain("overdue: ['Past its check-in time', 'warn']");
    const body = between("if ((r.kind === 'undelivered' || r.kind === 'overdue')", "if (r.kind === 'proposal'");
    expect(body).toContain("r.actions.some((a) => a.id === 'reassign')");
    expect(body).toContain('data-reassign=');
    expect(body).toContain("'Open task'");
  });
  it('adds the offline time to a delivery row in the viewer clock', () => {
    const at = new Date(); at.setHours(7, 40, 0, 0);
    expect(nyOffline({ offline_since: at.getTime() }, 'Not delivered: PC offline · waiting for Developer 2 to work on it')).toBe('Not delivered: PC offline since 07:40 · waiting for Developer 2 to work on it');
    expect(nyOffline({ offline_since: null }, 'Not delivered yet')).toBe('Not delivered yet');
    expect(js).toContain("const nySum = (r) => nyOffline(r, ");
  });
  it('the Reassign sheet posts the reassign route with the chosen worker', () => {
    const sheet = between('async function reassignSheet', 'document.addEventListener(\'click\', (e) => { const b = e.target.closest?.(\'[data-reassign]\')');
    expect(sheet).toContain("['worker', 'coordinator'].includes(m.role) && m.agent_id !== k?.assignee");
    expect(sheet).toContain('/reassign`, { agent_id: $(\'#raTo\', sh).value }');
  });
});

describe('decisions and settings', () => {
  it('an answered decision says when it reached the asker', () => {
    expect(js).toContain("d.status === 'answered' && d.delivered_at ? ` · Reached ${d.agent_label || 'the coordinator'} at ${atTime(d.delivered_at)}` : ''");
  });
  it('no screen offers or sends a delivery mode', () => {
    expect(js).not.toMatch(/delivery_mode|onDemand|obMode|twMode|bMode/);
    expect(js).not.toMatch(/On demand<\/option>|Polling<\/option>/);
  });
});
