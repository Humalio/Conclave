/* The woken run in the console (docs/connector.md, "The wake"): the agent's Status card shows the run's state and task, "No activity
   for 30 min" when it has been quiet that long, and, for the operator, Stop in the agent page's ⋯. Stop confirms in a sheet that
   says what is lost (anything the hub and git don't hold) and posts the audited stop route. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const between = (a: string, b: string) => { const i = js.indexOf(a), j = js.indexOf(b, i); expect(i, a).toBeGreaterThan(-1); expect(j, b).toBeGreaterThan(i); return js.slice(i, j); };

const S = { me: { role: 'admin' } as { role: string } | null };
const { wakeRow } = new Function('S', 'kv', 'pill', 'esc', 'cap', 'atTime', 'ago', 'fbSheet', 'vnote', 'post', 'toast', 'openD',
  `${between('const WAKE_ST = ', 'VIEWS.ses = async')}\nreturn { wakeRow };`)(
  S, (k: string, v: string) => `[${k}] ${v}`, (l: string, t: string) => `<${t}:${l}>`, (s: unknown) => String(s ?? ''), (s: string) => s, () => '09:30', () => '5 min',
  () => null, (h: string) => h, () => null, () => null, () => null) as { wakeRow: (w: unknown) => string };
const run = (over: Record<string, unknown> = {}) => ({ agent_id: 'ag_1', state: 'running', task: 'task_1', task_title: 'Fix login', last_activity_at: Date.now(), no_activity: false, resumes_at: null, ...over });

describe('the Status card', () => {
  it('shows the run, its task and when it was last active, with Stop pointed to ⋯ for the operator', () => {
    S.me = { role: 'admin' };
    expect(wakeRow(run())).toBe('[Woken run] <span class="kv-wake"><ok:Running> <span class="kv-sub">on Fix login · active 5 min ago · Stop is in ⋯</span></span>');
    S.me = { role: 'viewer' };
    expect(wakeRow(run())).not.toContain('Stop');
    S.me = { role: 'admin' };
  });
  it('flags 30 quiet minutes without stopping anything, and names a usage pause and a run that needs approval', () => {
    expect(wakeRow(run({ no_activity: true }))).toContain('<warn:No activity for 30 min>');
    expect(wakeRow(run({ state: 'paused_usage', resumes_at: Date.now() + 60_000 }))).toContain('<warn:Usage limit> <span class="kv-sub">on Fix login · resumes at 09:30');
    expect(wakeRow(run({ state: 'needs_approval' }))).toContain('<warn:Needs approval: open the session>');
  });
  it('an ended or stopped run has no Stop; no run shows nothing', () => {
    expect(wakeRow(run({ state: 'stopped' }))).toContain('<idle:Stopped>');
    expect(wakeRow(run({ state: 'stopped' }))).not.toContain('Stop is in');
    expect(wakeRow(run({ state: 'ended' }))).not.toContain('Stop is in');
    expect(wakeRow(null)).toBe('');
  });
});

describe('Stop', () => {
  it('sits in the agent page ⋯ as a destructive row while the run lives, never as a red button on the card', () => {
    expect(js).toContain("wk?.run && WAKE_LIVE.includes(wk.run.state) ? { label: 'Stop the woken run', icon: 'x', bad: true, fn: () => wakeStopSheet(id) } : null");
    expect(js).toContain("S.me?.role === 'admin' ? api('/agents/' + u + '/wake').catch(() => null) : null]);");
    expect(between('const WAKE_ST = ', 'VIEWS.ses = async')).not.toContain('btn bad');
  });
  it('confirms in a sheet that says what is lost and that it is audited, then posts the stop route', () => {
    const sheet = between('function wakeStopSheet', '\n}\n');
    expect(sheet).toContain("tone: 'bad', label: 'Stop the run', dismiss: 'Keep it running'");
    expect(sheet).toContain("anything the hub and git don't hold");
    expect(sheet).toContain('recorded in the audit log');
    expect(sheet).toContain('post(`/agents/${encodeURIComponent(agentId)}/wake/stop`, {})');
  });
  it('never calls an offline PC asleep', () => {
    expect(js).not.toMatch(/PC asleep/i);
  });
});
