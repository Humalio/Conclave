/**
 * Operator console: Home's Backlog card shows All plus at most seven tags by display name, and a picked tag outside them
 * takes the last of the seven places (docs/dashboard-ux.md, Home's Backlog card tag row).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const esc = (x: unknown) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
type Tag = { tag: string; n: number; name?: string };
const chips = (tags: Tag[], cur: string, card = true) => new Function('esc', `${fn('function tagChips(')}\nreturn tagChips;`)(esc)('home', tags, cur, card) as string;
const vals = (h: string) => [...h.matchAll(/data-ktag="home\|([^"]*)"/g)].map((m) => m[1]);
// The hub sends the tags most used first.
const tags: Tag[] = 'abcdefghij'.split('').map((t, i) => ({ tag: t, n: 20 - i, ...(t === 'j' ? { name: 'Jobs' } : {}) }));

describe('console: Home Backlog card tags', () => {
  it('shows All plus the seven tags with the most tasks', () => {
    const h = chips(tags, '');
    expect(vals(h)).toEqual(['', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(h).toContain('>All</button>');
  });
  it('puts a picked tag outside the seven in the last place, by display name and with its count', () => {
    const h = chips(tags, 'j');
    expect(vals(h)).toEqual(['', 'a', 'b', 'c', 'd', 'e', 'f', 'j']);
    expect(h).toContain('Jobs <span class="fcount">11</span>');
  });
  it('keeps every tag outside the card', () => {
    expect(vals(chips(tags, 'j', false))).toEqual(['', ...'abcdefghij'.split('')]);
  });
});
