/**
 * A backlog card (dashboard-ux.md, Backlog): Postpone, Discard and Accept sit at its top right, and there is no "Proposed by"
 * line, bottom action row or tag chips on the card. The row's markup is built from public/app.js in vm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const line = (re: RegExp) => { const m = js.match(re); if (!m) throw new Error('missing ' + re); const a = m.index!; const b = js.indexOf('\n', a); return js.slice(a, b); };
const stmt = (start: string, end: string) => { const a = js.indexOf(start), b = js.indexOf(end, a); if (a < 0 || b < 0) throw new Error('missing ' + start); return js.slice(a, b); };

const ctx: Record<string, any> = {
  esc: (s: unknown) => String(s), ic: (n: string) => `<i ${n}>`, ago: () => '2h', txt: (s: string) => s, raw: (s: string) => s,
  row: (o: any) => `<ROW ${o.title}|${o.attrs['data-task']}|${o.chev ? 'chev' : 'nochev'}|${o.trail || ''}|${o.meta}>`,
};
vm.createContext(ctx);
vm.runInContext(
  stmt('const blPpBtn =', '/* Task tags')
  + stmt('const tkTagTrail =', 'const tagCounts')
  + stmt('const blGist =', '/* Show all appears')
  + stmt('const blNoDesc =', '/* A task a coordinator')
  + '\nthis.lib = { backlogRow, relayedRow: typeof relayedRow };', ctx);
const L = ctx.lib;
const k = { id: 'k1', team_id: 't1', title: 'Plain title', tags: ['console', 'ux'], short_summary: 'The gist.', created_by_label: 'Coordinator', created_at: 'x' };

describe('a backlog card', () => {
  it('puts Postpone, Discard and Accept in that order beside the row, then the summary', () => {
    const h: string = L.backlogRow(k, 'Conclave Developers');
    const i = ['data-bl="postpone|t1|k1"', 'data-bl="discard|t1|k1"', 'data-bl="accept|t1|k1"'].map((s) => h.indexOf(s));
    expect(i.every((x) => x > 0)).toBe(true);
    expect([...i].sort((a, b) => a - b)).toEqual(i);
    expect(h.indexOf('<ROW')).toBeLessThan(i[0]);
    expect(h.indexOf('bl-sum')).toBeGreaterThan(i[2]);
    expect(h).toContain('class="btn sm ok" data-bl="accept');
    expect(h).toContain('class="bl-h"');
  });
  it('has no Proposed by line, no bottom row and no tags', () => {
    const h: string = L.backlogRow(k, 'Conclave Developers');
    expect(h).not.toMatch(/Proposed|tk-act|#console|#ux|tk-tags/);
    expect(h).toContain('Conclave Developers');
    expect(js).not.toContain('const blLine');
  });
  it('the card does not use the "Proposed by" line, but the task screen still has it', () => {
    const card = stmt('const blPpBtn =', '/* Task tags') + line(/^const backlogRow =/m);
    expect(card).not.toContain('blWho(');
    // Every helper the backlog code calls is defined: blHead on the task screen calls blWho.
    for (const name of ['blWho', 'blPpBtn', 'backlogBtns', 'blTaskRow']) {
      if (js.includes(name + '(')) expect(js).toMatch(new RegExp(`^(const ${name} =|function ${name}\\()`, 'm'));
    }
    expect(line(/^\s*const blHead = /m)).toContain('blWho(k)');
    const who = vm.runInContext(`(${line(/^const blWho = /m).replace(/^const blWho = /, '').replace(/;$/, '')})`, ctx);
    expect(who(k)).toBe('Proposed by Coordinator · 2h ago');
  });
  it('a postponed task shows when in its meta line and offers Return to active', () => {
    const h: string = L.backlogRow({ ...k, postponed_at: 'y' }, 'Team');
    expect(h).toContain('Postponed 2h ago · Team');
    expect(h).toContain('data-bl="restore|t1|k1"');
    expect(h).not.toContain('data-bl="postpone');
  });
  it('phones wrap the buttons under the title, equal width, with a 44 px tap target', () => {
    expect(css).toMatch(/\.bl-h\{flex-wrap:wrap;gap:0\}\.bl-h \.lrow\{flex:1 0 100%\}/);
    expect(css).toMatch(/\.bl-h \.tk-btns\{flex:1 0 100%;[^}]*\}\.bl-h \.tk-btns \.btn\{position:relative;flex:1\}/);
    expect(css).toContain('.bl-h .tk-btns .btn::after');
  });
  it('leaves the filter chips and the relayed row alone', () => {
    expect(line(/^function tagChips\(/m)).toBeTruthy();
    expect(js).toContain('tagChips(\'home\', S.bl?.tags || [], tag, true) + L.slice(0, BL_N).map((k) => backlogRow(');
    expect(js).toContain('Back to backlog: ${esc(k.title)}');
  });
});
