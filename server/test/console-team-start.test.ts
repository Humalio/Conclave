/* Start team on the team page (docs/connector.md, "Reason orders"): an admin-only "Start on PCs" row in the Team card opens a sheet
   that lists each member's check-in in fixed words and starts the team; a paused team is resumed first. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const between = (a: string, b: string) => { const i = js.indexOf(a), j = js.indexOf(b); expect(i, a).toBeGreaterThan(-1); expect(j, b).toBeGreaterThan(i); return js.slice(i, j); };
const src = `${between('const START_CODE = ', 'function teamStartSheet')}\nreturn { startLine, startMeta };`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const { startLine, startMeta } = new Function('plural', src)(plural) as { startLine: (m: unknown) => [string, string]; startMeta: (st: unknown) => string };

const T = 1_800_000_000_000;
const order = (state: string, code: string | null = null) => ({ order: 'pca_1', state, code, created_at: T, finished_at: null });

describe('Start team in the console', () => {
  it('says where each member stands, from the hub\'s codes only', () => {
    expect(startLine({ order: null, pc_online: null, run: null })).toEqual(['No PC holds its key', 'idle']);
    expect(startLine({ order: null, pc_online: true, run: null })[0]).toBe('Not started from the console');
    expect(startLine({ order: order('queued'), pc_online: false, run: null })[0]).toBe('Waiting for its PC to come online');
    expect(startLine({ order: order('fetched'), pc_online: true, run: null })[0]).toBe('Its PC has it');
    expect(startLine({ order: order('done'), pc_online: true, run: { state: 'running', updated_at: T + 1 } })).toEqual(['Checking in now', 'ok']);
    expect(startLine({ order: order('done'), pc_online: true, run: { state: 'ended', updated_at: T + 9 } })).toEqual(['Checked in', 'ok']);
    // A wake report older than this order is an earlier turn's.
    expect(startLine({ order: order('done'), pc_online: true, run: { state: 'running', updated_at: T - 1 } })[0]).toBe('Checked in');
    expect(startLine({ order: order('failed', 'team_paused'), pc_online: true, run: null })).toEqual(['Dropped: the team was paused', 'warn']);
    expect(startLine({ order: order('failed', 'something new'), pc_online: true, run: null })[0]).toBe('Its PC could not start the turn');
    expect(startLine({ order: order('expired'), pc_online: true, run: null })[0]).toBe('Its PC did not take it in time');
  });

  it('sums the members up on the row', () => {
    const done = { order: order('done'), pc_online: true, run: { state: 'ended', updated_at: T + 1 } };
    const failed = { order: order('failed', 'chat_in_use'), pc_online: true, run: null };
    expect(startMeta({ members: [done, failed] })).toBe('1 of 2 checked in · <span class="warn-t">1 member not started</span>');
    expect(startMeta({ members: [{ order: null, pc_online: true, run: null }] })).toBe('Not started from the console yet');
  });

  it('is the admin\'s, on a running or paused team, and a paused team is resumed first', () => {
    expect(js).toContain("S.me?.role === 'admin' && ['running', 'paused'].includes(t.status) ? await api(tp + '/start-turns')");
    expect(js).toContain("tStart && t.status === 'running' ? { label: 'Start team on its PCs'");
    const sheet = between('function teamStartSheet', '/* The team\'s conversations');
    expect(sheet).toContain("if (t.status !== 'running') return 'The team is paused. Resume it first, then start it.';");
    expect(sheet).toContain('await post(`${tp}/start-turns`)');
  });
});
