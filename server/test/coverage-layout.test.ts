/**
 * Coverage layout (docs/dashboard-ux.md, Coverage): each gap card is as tall as its rows, shows its first 8 and folds the rest
 * behind Show all, so a long list no longer pushes the next row of cards a screen down. Two columns from 1180 px, one list
 * full width, one column below. The Coverage block of public/app.js is loaded in vm with small stand-ins for its helpers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const pub = (f: string) => readFileSync(join(process.cwd(), 'public', f), 'utf8').replace(/\r\n/g, '\n');
const js = pub('app.js'), css = pub('style.css');
const block = js.slice(js.indexOf('const BP_GAPS = '), js.indexOf('/* A status pill with'));
type Click = (e: { target: { closest: (s: string) => unknown } }) => void;
const ctx: { bpCoverage?: (pid: string, c: object) => string; click?: Click; els: Record<string, { hidden: boolean }> } = { els: {} };
vm.runInNewContext(`
  const esc = (s) => String(s), cap = (s) => s, plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's'), planDate = () => '2 Nov';
  const none = (i, t) => '<p class="none">' + t + '</p>', overline = (t, n) => '<h3>' + t + ' · ' + n + '</h3>';
  const BP_KIND = { fr: 'Requirement' }, bpLabel = (s) => s, bpRow = (pid, i) => '<a class="lrow">' + i.key + '</a>';
  const document = { addEventListener: (k, f) => { this.click = f; }, getElementById: (id) => this.els[id] };
  ${block}
  this.bpCoverage = bpCoverage;`, ctx);
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `FR-${i + 1}`, kind: 'fr', title: 't', status: 'agreed' }));
const cov = (counts: Partial<Record<string, [number, number?]>>) => {
  const out: Record<string, unknown> = {};
  for (const k of ['no_ac', 'no_milestone', 'no_task', 'passing_no_evidence', 'decisions_govern_nothing', 'old_questions']) {
    const [sent = 0, count = sent] = counts[k] ?? [];
    out[k] = { count, items: items(sent) };
  }
  return out;
};
const rows = (h: string) => (h.match(/class="lrow"/g) || []).length;

describe('Coverage cards fold long lists', () => {
  it('a short list shows every row and no button', () => {
    const h = ctx.bpCoverage!('p', cov({ no_ac: [3], no_task: [2] }));
    expect(rows(h)).toBe(5);
    expect(h).not.toContain('data-cov-all');
  });

  it('a list longer than 8 shows 8 and keeps the rest hidden behind Show all n', () => {
    const h = ctx.bpCoverage!('p', cov({ no_ac: [1], no_milestone: [12] }));
    const rest = h.slice(h.indexOf('<div class="bp-cov-rest"'), h.indexOf('<button'));
    expect(rest).toContain('id="bpCov-no_milestone" hidden');
    expect(rows(rest)).toBe(4);
    expect(rows(h) - rows(rest)).toBe(9);
    expect(h).toContain('aria-expanded="false" aria-controls="bpCov-no_milestone">Show all 12</button>');
  });

  it('when the hub sent 50 of 137 the button says so, and the "and 87 more" line folds with the rest', () => {
    const h = ctx.bpCoverage!('p', cov({ decisions_govern_nothing: [50, 137] }));
    expect(h).toContain('>Show 50 of 137</button>');
    const rest = h.slice(h.indexOf('<div class="bp-cov-rest"'), h.indexOf('<button'));
    expect(rest).toContain('and 87 more');
  });

  it('a single list takes the full width; two or more share the grid', () => {
    expect(ctx.bpCoverage!('p', cov({ decisions_govern_nothing: [50, 137] }))).toContain('<div class="bp-cov one">');
    expect(ctx.bpCoverage!('p', cov({ no_ac: [1], no_task: [1] }))).toContain('<div class="bp-cov">');
  });

  it('Show all opens the rest in place and Show fewer folds it again', () => {
    const box = { hidden: true }; ctx.els['bpCov-x'] = box;
    const attrs: Record<string, string> = { 'aria-controls': 'bpCov-x', 'aria-expanded': 'false' };
    const b = { dataset: { covAll: 'Show all 12' }, textContent: 'Show all 12', getAttribute: (k: string) => attrs[k], setAttribute: (k: string, v: string) => { attrs[k] = v; } };
    const e = { target: { closest: (s: string) => (s === '[data-cov-all]' ? b : null) } };
    ctx.click!(e);
    expect([box.hidden, attrs['aria-expanded'], b.textContent]).toEqual([false, 'true', 'Show fewer']);
    ctx.click!(e);
    expect([box.hidden, attrs['aria-expanded'], b.textContent]).toEqual([true, 'false', 'Show all 12']);
  });
});

describe('Coverage grid CSS', () => {
  it('one column by default, cards as tall as their content', () => {
    expect(css).toContain('.bp-cov{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s3);align-items:start}');
  });
  it('two columns only from 1180 px, and never for a single list', () => {
    expect(css).toContain('@media (min-width:1180px){.bp-cov:not(.one){grid-template-columns:repeat(2,minmax(0,1fr))}}');
    expect(css).not.toMatch(/\.bp-cov\{[^}]*repeat\(2/);
  });
});
