/**
 * Operator console, Refine with coordinator (docs/dashboard-ux.md): the ticks of the review follow what each change needs,
 * and the button, the sheet and the For awareness row exist where the brief puts them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const lib = new Function(`${line('const bpRfNeed = ')}\n${line('const bpRfBy = ')}\n${fn('function bpRfToggle(')}\n${line('const bpRfKind = ')}
return { bpRfNeed, bpRfBy, bpRfToggle, bpRfKind };`)() as {
  bpRfBy: (n: number[][], i: number) => number[]; bpRfToggle: (s: Set<number>, n: number[][], i: number, on: boolean) => Set<number>;
  bpRfKind: (o: Record<string, unknown>, cur: unknown) => string;
};

// Five ops: 0 changes FR-1, 1 removes FR-2 (needs 0), 2 adds FR-9, 3 links FR-9 (needs 2), 4 is alone.
const needs = [[], [0], [], [2], []];
const all = new Set([0, 1, 2, 3, 4]);

describe('console: refine review ticks', () => {
  it('unticking a change unticks what needs it, and the change shows what needs it', () => {
    expect([...lib.bpRfToggle(all, needs, 0, false)].sort()).toEqual([2, 3, 4]);
    expect(lib.bpRfBy(needs, 0)).toEqual([1]);
  });
  it('ticking a change ticks what it needs', () => {
    expect([...lib.bpRfToggle(new Set([4]), needs, 3, true)].sort()).toEqual([2, 3, 4]);
    expect([...lib.bpRfToggle(new Set([0, 4]), needs, 1, false)].sort()).toEqual([0, 4]);
  });
  it('names each change Added, Changed or Removed (removed means dropped)', () => {
    expect(lib.bpRfKind({ op: 'upsert', key: 'FR-9' }, undefined)).toBe('Added');
    expect(lib.bpRfKind({ op: 'upsert', key: 'FR-2', status: 'dropped' }, {})).toBe('Removed');
    expect(lib.bpRfKind({ op: 'upsert', key: 'FR-1', title: 'x' }, {})).toBe('Changed');
  });
});

describe('console: refine surfaces', () => {
  it('has the button after Views, in the ⋯ menu on a phone, and the sheet fields', () => {
    const tb = line('+ `<button type="button" class="btn sm bp-fbtn" id="bpFilt"');
    expect(tb.indexOf('id="bpViews"')).toBeLessThan(tb.indexOf('id="bpRefine"'));
    expect(js).toContain("label: 'Refine with coordinator'");
    for (const t of ['What should change', 'Which requirements', 'The ones shown', 'Consistency', 'Duplicates', 'Missing acceptance criteria', 'Send to coordinator']) expect(js, t).toContain(t);
    expect(js).toMatch(/data-bprfc="\$\{k\}"\$\{on \? ' checked' : ''\}/);
    expect(js).toContain("maxlength=\"${max}\"");
    expect(js).toMatch(/fbArea\('bpRfN', 'What should change', 2000/);
  });
  it('shows a waiting refine under For awareness, and applies only the ticked changes', () => {
    expect(js).toContain("refine_waiting: ['Refining requirements'");
    expect(js).toContain('Apply ${sel.size} of ${pr.ops.length}');
    expect(js).toMatch(/\/apply`, \{ ops \}/);
    expect(js).toContain('needed by ${by.map');
  });
});
