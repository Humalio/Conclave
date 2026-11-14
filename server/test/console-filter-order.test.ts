/**
 * Operator console, state filters (docs/dashboard-ux.md, Blueprint): a chip set offering Open and All reads Open first and
 * All last, in a Blueprint section list and everywhere else; a selection a card opened (Live, This month) sits after Open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

/* The Blueprint section's chips, built by the same two lines app.js runs. */
function bpSegs(sel: string, label = '') {
  const i = js.indexOf("    const segs = [['open', 'Open', lst.counts.open]");
  expect(i).toBeGreaterThan(-1);
  const src = js.slice(i, js.indexOf('\n', js.indexOf('if (f.sel && !segs.some(', i)));
  return new Function('f', 'lst', 'cap', `${src}\nreturn segs;`)({ sel }, { counts: { all: 9, open: 5, dropped: 1 }, total: 3, selection: label ? { label } : null }, (s: string) => s) as [string, string, number][];
}

describe('console: state filters read Open first and All last', () => {
  it('a Blueprint section list: Open · Dropped · All, each with its count', () => {
    expect(bpSegs('open')).toEqual([['open', 'Open', 5], ['dropped', 'Dropped', 1], ['all', 'All', 9]]);
    expect(bpSegs('')).toEqual(bpSegs('open'));
  });

  it('a selection a card opened sits right after Open, and All stays last', () => {
    expect(bpSegs('live', 'Live').map(([s, l]) => [s, l])).toEqual([['open', 'Open'], ['live', 'Live'], ['dropped', 'Dropped'], ['all', 'All']]);
  });

  it('every chip set in the console that offers both Open and All puts Open first and All last', () => {
    // Chip sets are arrays of [value, label, …] tuples; find each one that holds an 'Open' and an 'All' label.
    const sets = [...js.matchAll(/\[\s*(\[[^\[\]]*'[^']*'[^\[\]]*\](?:\s*,\s*\[[^\[\]]*\])+)\s*\]/g)].map((m) => [...m[1]!.matchAll(/\[\s*'[^']*'\s*,\s*'([^']*)'/g)].map((x) => x[1]))
      .filter((L) => L.includes('Open') && L.includes('All'));
    expect(sets.length).toBeGreaterThanOrEqual(2); // the Blueprint list and the decisions filter, at least
    for (const L of sets) { expect(L[0], L.join(' · ')).toBe('Open'); expect(L[L.length - 1], L.join(' · ')).toBe('All'); }
  });
});
