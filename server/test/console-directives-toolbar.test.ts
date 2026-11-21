/**
 * Operator console, Work → Directives, the list (docs/dashboard-ux.md, Directives): one toolbar row (the search box with the
 * category, scope, read state and tag as chips, In force / Retired, Filters), and the list overline (Select all shown, the
 * live "6 of 14 · 2 not reviewed · 1 not read by everyone", Group by). Filters change in place, so the chips are swapped
 * in the box without redrawing it (csrchSet).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const block = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('].filter(Boolean);', i) + 18); };
type DF = Record<string, string>;
const H = new Function(`${line('const DIR_KIND_LABEL = ')}\n${line('const DIR_READS = ')}\n${line('const DIR_CATS = ')}\n${line('const DIR_CAT_LABEL = ')}\n${block('const dirChips = ')}\nreturn { dirChips };`)() as
  { dirChips: (f: DF) => { label: string; name: string; attrs: string }[] };
const view = (() => { const i = js.indexOf('VIEWS.directives = async'); return js.slice(i, js.indexOf('\n};\n', i)); })();

describe('console: Work → Directives list toolbar', () => {
  it('shows the active filters as chips in the order category, scope, read state, tag; a default is never a chip', () => {
    expect(H.dirChips({ st: 'active', q: 'keys', g: 'cat' })).toEqual([]);
    const ch = H.dirChips({ c: 'tokens', sc: 'team', rd: 'new', t: 'relay' });
    expect(ch.map((c) => c.label)).toEqual(['Token economy', 'Scope: Team', 'Not reviewed', '#relay']);
    expect(ch.map((c) => c.name)).toEqual(['Remove the category filter Token economy', 'Remove the scope filter Team', 'Remove the read state filter Not reviewed', 'Remove the tag filter relay']);
    expect(ch.map((c) => c.attrs)).toEqual(['data-dl-rm="c"', 'data-dl-rm="sc"', 'data-dl-rm="rd"', 'data-dl-rm="t"']);
    expect(H.dirChips({ c: 'none', sc: 'hub' }).map((c) => c.label)).toEqual(['No category', 'Scope: All agents']);
  });

  it('draws one row: the search box with the chips, In force / Retired, then Filters; no category row and no inline selects', () => {
    const tb = fn('function dirToolbar(');
    expect(tb).toContain('<div class="ltb">${chipSearch({ attrs: \'id="dlQ"\', label: \'Search directives\', value: f.q, chips: ch, clear: \'data-dl-clr\', more: DIR_MORE })}');
    expect(tb).toContain("subTabs('data-dirs', [['', 'In force'], ['retired', 'Retired']]");
    expect(tb).toContain("filterBtn('dlMore', ch.length)");
    expect(js).toContain(`const DIR_MORE = 'data-cs-filt="dlMore"';`);
    expect(js).not.toMatch(/function dirCatChips|data-dcat=|data-dtagclr|id="dlSc"|id="dlRd"|dl-sels|class="dl-sum"/);
    expect(tb).not.toContain('only-m');
  });

  it('Filters holds Category with its counts, Scope and Read state; the search stays in the toolbar', () => {
    const sh = fn('function dirFilterSheet(');
    expect(sh).toContain("selField('dlCm', 'Category', cats, f.c)");
    expect(sh).toContain("[k, `${l} · ${base.filter((d) => dirCatKey(d) === k).length}`]");
    expect(sh).toContain("selField('dlScm', 'Scope'");
    expect(sh).toContain("selField('dlRdm', 'Read state', DIR_READS, f.rd)");
    expect(sh).not.toMatch(/dlQm|type="search"|dlGm/);
  });

  it('puts Select all shown, the live count and Group by in the list overline', () => {
    const l = fn('function dirListHtml(');
    expect(l).toContain('const sum = all.length ? listOverline([');
    // Select all shown sits outside the live region, which holds only the count line.
    expect(l).toMatch(/\{ html: `<input type="checkbox" class="dl-chk" id="dlAll" aria-label="Select all shown"[^`]*` \} : '',\n    \{ html: `<span class="lov-n" id="dlShown" tabindex="-1" aria-live="polite"><b>\$\{L\.length\}<\/b> of \$\{rules\}/); // the same rule for several scopes counts once
    expect(l).toContain('${unrev} not reviewed');
    expect(l).toContain('${behind} not read by everyone');
    expect(l).toContain("{ name: 'Group by', attrs: 'id=\"dlG\"', options: DIR_GROUPS, value: f.g }");
    expect(js).toContain("const DIR_GROUPS = [['', 'Grouped by scope'], ['cat', 'Grouped by category'], ['none', 'Not grouped']];");
    expect(l).toContain("emptyAct('Clear search and filters', 'data-dclr')");
    // Select all ticks only the rows the filters show.
    expect(js).toContain("if (t.id === 'dlAll') { const L = DIR_UI.data.directives.filter((d) => dirMatch(d, f));");
    expect(css).toContain('.dl-list .lov{align-items:center;min-height:44px;margin:0}');
  });

  it('changes filters in place: the chips are swapped in the box, the ✕ goes back to the default and keeps the status and grouping', () => {
    const set = fn('function dirSet(');
    expect(set).toContain("const ch = dirChips(f); csrchSet($('#dlQ'), ch, DIR_MORE); setFilterCount('dlMore', ch.length);");
    expect(fn('function dirClear(')).toContain("dirSet({ q: '', sc: '', rd: '', c: '', t: '' }); inp?.focus();");
    expect(view).toContain("form.onclick = (e) => { const rm = e.target.closest('[data-dl-rm]'); if (rm) { dirSet({ [rm.dataset.dlRm]: '' }); q.focus(); } else if (e.target.closest('[data-dl-clr]')) dirClear(); };");
    expect(view).toContain('form.onsubmit = (e) => { e.preventDefault(); go(q.value.trim().toLowerCase()); };');
    expect(js).toContain("box.onchange = (e) => { e.stopPropagation(); if (e.target.id === 'dlG') { dirSet({ g: e.target.value }); $('#dlG')?.focus(); } };");
  });

  it('csrchSet replaces the chips and "+k" before the input and keeps the input itself', () => {
    const els: { html?: string; removed?: boolean; placeholder?: string }[] = [];
    const chip = { removed: false, remove() { this.removed = true; } };
    const inp = { placeholder: 'Search', insertAdjacentHTML(_w: string, h: string) { els.push({ html: h }); } };
    const form = {};
    const marks: string[] = [];
    const set = new Function('$', '$$', 'csChipsHtml', 'csrchMark', 'csrchFit', `${fn('function csrchSet(')}\nreturn csrchSet;`)(
      (s: string) => (s === '.csrch-in' ? inp : null), () => [chip], (c: { label: string }[], m: string) => c.map((x) => `[${x.label}]`).join('') + (m && c.length ? '[+k]' : ''),
      () => marks.push('mark'), () => marks.push('fit')) as (f: object, c: { label: string }[], m: string) => void;
    set(form, [{ label: 'Tooling' }], 'data-cs-filt="dlMore"');
    expect(chip.removed).toBe(true);
    expect(els).toEqual([{ html: '[Tooling][+k]' }]);
    expect(inp.placeholder).toBe('');
    expect(marks).toEqual(['mark', 'fit']);
    set(form, [], 'data-cs-filt="dlMore"');
    expect(inp.placeholder).toBe('Search');
  });
});
