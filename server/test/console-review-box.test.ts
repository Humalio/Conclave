/**
 * A review on a task page (dashboard-ux.md, Tasks) sits in a quiet box, not behind a coloured bar down its left side: a 1 px
 * --line border, an almost transparent background, rounded corners and padding, with tokens only. The status label keeps its colour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const rule = (sel: string) => css.split('\n').filter((l) => l.startsWith(sel + '{'));

describe('the review box', () => {
  const rev = rule('.rd-rev');
  it('has one rule: a thin --line border, rounded corners, padding and a faint background', () => {
    expect(rev).toHaveLength(1);
    expect(rev[0]).toContain('border:1px solid var(--line)');
    expect(rev[0]).toContain('border-radius:var(--r-md)');
    expect(rev[0]).toMatch(/padding:var\(--s3\) var\(--s4\)/);
    expect(rev[0]).toMatch(/background:color-mix\(in srgb,var\(--text\) 2%,transparent\)/);
  });
  it('has no left bar, and no status colour on the box itself', () => {
    expect(rev[0]).not.toMatch(/border-left|border-inline-start|padding-left/);
    expect(rule('.rd-rev.ok')).toHaveLength(0);
    expect(rule('.rd-rev.warn')).toHaveLength(0);
    expect(rev[0]).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
  it('keeps the colour on the status label only', () => {
    expect(rule('.rd-lab.ok-t')[0]).toContain('var(--ok-t)');
    expect(rule('.rd-lab.warn-t')[0]).toContain('var(--warn-t)');
    expect(js).toContain('<div class="rd-rev ${v[1]}"><div class="rd-st"><span class="rd-lab ${v[1] ? v[1] + \'-t\' : \'\'}">');
  });
});
