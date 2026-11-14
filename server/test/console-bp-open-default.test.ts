/**
 * Operator console, Blueprint sections (docs/design-guidelines.md §4, docs/dashboard-ux.md): a section with nothing in its address
 * opens on Open, not All. All is the explicit `sel=all`, so Back and links keep the choice; a section with nothing open says so
 * and offers Show all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const bpFilt = new Function(`${line('const bpFilt = ')}\nreturn bpFilt;`)() as (s: string) => { q: string; kind: string; sel: string; at: string };
const section = js.slice(js.indexOf('// One row of filters (docs/design-guidelines.md'), js.indexOf('bpFilters = { f, fq, goF'));

describe('console: Blueprint sections open on Open', () => {
  it('reads sel=all as an explicit choice and still drops values it does not know', () => {
    expect(bpFilt('sel=all').sel).toBe('all');
    expect(bpFilt('sel=open').sel).toBe('open');
    expect(bpFilt('sel=nonsense').sel).toBe('');
    expect(bpFilt('').sel).toBe('');
  });

  it('an address with no filter at all becomes sel=open; any filter in it is left as it is', () => {
    expect(section).toContain("const f = status || f0.q || f0.kind || f0.sel || f0.at || !BP_OPEN_TABS.includes(tab) ? f0 : { ...f0, sel: 'open' };");
  });

  it('only the sections whose kinds have an open state open on Open; Foundation, Decisions and Appendix keep their grouped cards', () => {
    expect(line('const BP_OPEN_TABS = ')).toBe("const BP_OPEN_TABS = ['4', '5'];");
    // So a team's shared project-level items (Foundation, Decisions, Appendix) and the glossary's undefined-codes notice still show.
    expect(section).toContain("const shared = !filtered && team && team !== 'project' && BP_SHARED.includes(+tab);");
    expect(js).toContain('(+tab === 6 && mine.plain?.undefined_codes?.length)');
  });

  it('Open is a filtered (paged) list, All is the grouped cards, and All asks the hub for no selection', () => {
    expect(section).toContain("const filtered = !!(status || f.q || f.kind || (f.sel && f.sel !== 'all'));");
    expect(section).toContain("sel: f.sel === 'all' ? '' : f.sel");
  });

  it('the All chip carries sel=all, and a link with only a kind (a card or Coverage) still shows All pressed', () => {
    expect(section).toContain("['all', 'All', lst.counts.all]");
    expect(section).toContain("s === (f.sel || 'all')");
  });

  it('with nothing open it says so in one line and offers Show all with the count, without switching silently', () => {
    expect(section).toContain("f.sel === 'open' && !status && !f.q && !f.kind && lst.counts.all");
    expect(section).toContain("'Nothing open in this section'");
    expect(section).toContain('Show all (${lst.counts.all})');
    expect(section).toContain("goF({ ...f, sel: 'all', at: '' })");
  });

  it('a section with nothing in it at all keeps its own empty state, not "Nothing matches these filters"', () => {
    expect(section).toContain("f.sel === 'open' && !status && !f.q && !f.kind\n");
    expect(section).toContain("'Nothing in this section yet'");
  });
});
