/**
 * Blueprint section 3, Decisions & Architecture (docs/dashboard-ux.md): from 1180 px the decision log sits left of the
 * architecture overview, below it one column with the overview first and its long text folded to four lines. With one side
 * missing the other takes the whole width. The block between the bp-arch markers in public/app.js is loaded in vm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const pub = (f: string) => readFileSync(join(process.cwd(), 'public', f), 'utf8').replace(/\r\n/g, '\n');
const js = pub('app.js'), css = pub('style.css');
const block = js.slice(js.indexOf('/* bp-arch:start'), js.indexOf('/* bp-arch:end */'));
const ctx: Record<string, unknown> = { prose: (t: string, cls = '') => `<div class="md prose${cls ? ' ' + cls : ''}">${t}</div>` };
vm.runInNewContext(`${block}\nthis.bpArchCols = bpArchCols; this.bpArchText = bpArchText;`, ctx);
const cols = ctx.bpArchCols as (ov: string, log: string) => string;
const text = ctx.bpArchText as (t: string) => string;
const OV = '<div class="bp-c bp-arch-ov">overview</div>', LOG = '<div class="bp-c bp-arch-log">log</div>';

describe('Decisions & Architecture columns', () => {
  it('with both cards, wraps them in the two-column grid, overview first so it reads first on a phone', () => {
    expect(cols(OV, LOG)).toBe(`<div class="bp-arch">${OV}${LOG}</div>`);
  });
  it('with no overview the log is the whole section, and with no decisions the overview is', () => {
    expect(cols('', LOG)).toBe(LOG);
    expect(cols(OV, '')).toBe(OV);
    expect(cols('', '')).toBe('');
  });
  it('the section uses it, and builds the two cards it places', () => {
    const sec = js.slice(js.indexOf('  if (sec_ === 3) {'), js.indexOf('  if (sec_ === 4) {'));
    expect(sec).toContain('return bpArchCols(ov, log);');
    expect(sec).toContain('bp-arch-ov');
    expect(sec).toContain('bp-arch-log');
  });
});

describe('the overview folds on narrow screens', () => {
  it('a short overview shows whole, with no Show all', () => {
    const h = text('One service and a queue.');
    expect(h).toContain('class="md prose bp-ov-md"');
    expect(h).not.toContain('Show all');
  });
  it('a long one, by length or by lines, folds with Show all', () => {
    for (const t of ['x'.repeat(400), 'a\nb\nc\nd\ne']) {
      const h = text(t);
      expect(h).toContain('bp-ov-md fold');
      expect(h).toMatch(/<button type="button" class="btn ghost sm bp-ov-more" data-gist aria-expanded="false">Show all<\/button>$/);
    }
  });
});

describe('the CSS', () => {
  const wide = css.slice(css.indexOf('.bp-arch{'));
  it('is one column below 1180 px and 7 + 5 with the log on the left from 1180 px', () => {
    expect(css).toContain('.bp-arch{display:grid;grid-template-columns:minmax(0,1fr)');
    expect(wide).toMatch(/@media \(min-width:1180px\)\{[^@]*\n\s*\.bp-arch\{grid-template-columns:minmax\(0,7fr\) minmax\(0,5fr\);grid-template-areas:"log ov"\}/);
  });
  it('keeps the overview sticky with its own scroll beside the log, and unfolded there', () => {
    expect(wide).toMatch(/\.bp-arch>\.bp-arch-ov\{grid-area:ov;position:sticky;[^}]*overflow:auto/);
    expect(wide).toMatch(/\.bp-ov-more\{display:none\}/);
    // The page scrolls there, as on Work → Directives, so the sticky offset under the app bar is the right one.
    expect(wide).toContain('#workspaceView:has(.bp-arch) .db{overflow:visible}');
  });
});
