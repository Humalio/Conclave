/**
 * Operator console, Blueprint Project foundation: two columns on wide screens. The section sits on the left, the project card and a
 * Next milestone card of their own in a 340 px column on the right that stays in view; the filter bar stays above both; below 1100 px
 * it is one column with the side cards first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const bpTimeLeft = new Function('plural', `${line('const bpTimeLeft = ')}\nreturn bpTimeLeft;`)(plural) as (t: number) => string;
const day = 86400000;

describe('console: Project foundation in two columns', () => {
  it('says how long is left in plain words', () => {
    const at = (d: number) => Date.now() + d * day + 1000;
    expect(bpTimeLeft(at(-3))).toBe('passed');
    expect(bpTimeLeft(at(0))).toBe('today');
    expect(bpTimeLeft(at(3))).toBe('3 days');
    expect(bpTimeLeft(at(42))).toBe('about 6 weeks');
    expect(bpTimeLeft(at(400))).toBe('about 13 months');
  });

  it('gives the Next milestone a card of its own, apart from the project card', () => {
    expect(js).toContain("return [card, next].filter(Boolean);");
    expect(js).toContain('<div class="bp-c bp-ms">${overline(\'Next milestone\')}');
    expect(js).not.toContain("kv('Next milestone'");
  });

  it('wraps the section and the side cards, the filter bar above both', () => {
    expect(js).toContain('body = `${tools}<div class="bp-fnd"><div class="bp-fnd-main">${main}</div><div class="bp-fnd-side">${side.join(\'\')}</div></div>`');
    expect(js).toContain('<div class="bp-two">${glossary');
  });

  it('is a 340 px sticky right column from 1100 px, one column with the side cards first below', () => {
    expect(css).toContain('.bp-fnd{display:grid;grid-template-columns:minmax(0,1fr) 340px;');
    expect(css).toContain('.bp-fnd-side{display:grid;gap:var(--s3);min-width:0;position:sticky;top:var(--s4);max-height:calc(100vh - 2 * var(--s4));overflow-y:auto}');
    expect(css).toContain('@media (max-width:1099.98px){.bp-fnd{grid-template-columns:minmax(0,1fr)}.bp-fnd-side{order:-1;position:static;max-height:none;overflow:visible}}');
  });
});
