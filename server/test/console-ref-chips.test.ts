/**
 * Requirement chips never run past their card: the `.refs` list wraps at every width, the card's meta row wraps so the chips
 * can drop under the team name, and a long list shows the first few chips and one "+N" chip whose tip lists the rest.
 * Static, like console-plain.test.ts: it reads public/app.js and style.css and renders refChips with stubbed lookups.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const decl = (head: string) => {
  const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1);
  const rest = js.slice(i + head.length), m = /\n(?=const |function |async function |let |\/\*|\/\/|VIEWS\.)/.exec(rest);
  return js.slice(i, i + head.length + (m ? m.index : rest.length));
};
const rule = (sel: string) => { const i = css.indexOf(String.fromCharCode(10) + sel + '{'); expect(i, sel).toBeGreaterThan(-1); return css.slice(i, css.indexOf('}', i)); };

describe('requirement chips wrap inside the card', () => {
  it('lets the chip list shrink and wrap at every width', () => {
    const r = rule('.refs');
    expect(r).toMatch(/flex-wrap:\s*wrap/);
    expect(r).toMatch(/min-width:\s*0/);
    expect(r).toMatch(/max-width:\s*100%/);
    expect(r).not.toMatch(/flex:\s*none/);
  });
  it('lets the board card meta row wrap', () => {
    expect(css).toMatch(/\.kc-m\{flex-wrap:wrap;[^}]*min-width:0/);
  });

  const body = decl('function refChips(');
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const refChips = new Function('esc', 'plural', 'PRI', 'REQ_ST', 'MS_ST', 'bpItemArg', `${body}
return refChips;`)(esc, plural, {}, {}, {}, (p: string, k: string) => `${p}|${k}`) as (k: object, t: object, o?: object) => string;
  const T = { project_id: 'p1', plan: { requirements: Array.from({ length: 12 }, (_, i) => ({ key: `FR-${i + 1}`, title: `Title ${i + 1}` })), milestones: [] } };
  const k = (n: number) => ({ refs: Array.from({ length: n }, (_, i) => `FR-${i + 1}`) });
  it('shows every chip up to max + 1, then the first few and a "+N" chip with the rest in its tip', () => {
    expect(refChips(k(4), T, { task: 'a|b' })).not.toContain('ref more');
    const seven = refChips(k(7), T, { task: 'a|b' });
    expect(seven).toContain('ref more');
    expect(seven).toContain('+4');
    expect(seven).toContain('FR-4: Title 4');
    expect(seven).toContain('FR-7: Title 7');
    expect(seven.match(/class="ref"/g)).toHaveLength(3);
    expect(refChips({ refs: [] }, T)).toBe('');
  });
  it('keeps each chip tip, and the task page shows every chip as its own Open button', () => {
    expect(refChips(k(2), T, { task: 'a|b' }).match(/info-tip/g)).toHaveLength(2);
    const open = refChips(k(12), T, { open: true });
    expect(open).not.toContain('ref more');
    expect(open.match(/data-ref-bp/g)).toHaveLength(12);
  });
});

describe('board column footer buttons keep their labels', () => {
  it('does not squeeze the buttons below their text', () => {
    const r = rule('.bc-foot .btn');
    expect(r).toMatch(/flex:\s*1 1 auto/);
    expect(r).toMatch(/min-width:\s*max-content/);
    expect(r).toMatch(/white-space:\s*nowrap/);
    expect(rule('.bc-foot')).toMatch(/flex-wrap:\s*wrap/);
  });
});
