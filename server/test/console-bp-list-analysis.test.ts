/**
 * Operator console, Blueprint list analysis (docs/dashboard-ux.md, List analysis): the route keeps the analysis in closed words
 * and reads back what it wrote; a cell, a chip or a gap sets and clears filters through the route; every count drawn is the hub's.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
type F = { q: string; kind: string; sel: string; at: string; f: string[]; gap: string; x: string; g: string; s: string };
const lib = new Function(`${line('const BP_FK = ')}\n${line('const bpFilt = ')}\n${line('const bpFiltStr = ')}\n${fn('function bpLaX(')}\n${fn('function bpLaSet(')}\n${line('const bpLaIs = ')}
return { bpFilt, bpFiltStr, bpLaX, bpLaSet, bpLaIs };`)() as {
  bpFilt: (s: string) => F; bpFiltStr: (f: Partial<F>) => string; bpLaX: (tab: string, kind: string) => string;
  bpLaSet: (f: F, st: string, d: string, v: string | null) => [F, string]; bpLaIs: (f: F, st: string, d: string, v: string) => boolean;
};
const ok = new Function(`const RID = /^[a-z]+_[A-Za-z0-9_-]+$/;\nreturn ${line('  blueprint: (a) => /^prj_').trim().replace(/^blueprint: /, '').replace(/, project: \(a\) =>.*$/, '')};`)() as (a: string) => boolean;

describe('console: Blueprint list analysis route', () => {
  it('reads back exactly the analysis it writes, readably', () => {
    const f = { ...lib.bpFilt(''), sel: 'open', f: ['area:AAA', 'milestone:M1', 'milestone:none'], gap: 'no_ac', x: 'area*milestone', g: 'milestone', s: 'risk' };
    const s = lib.bpFiltStr(f);
    expect(s).toBe('sel=open&f=area:AAA,milestone:M1,milestone:none&gap=no_ac&x=area*milestone&g=milestone&s=risk');
    expect(lib.bpFilt(s)).toEqual(f);
    expect(ok(`prj_abc|2|team_x1|agreed|${s}`)).toBe(true);
    expect(ok('prj_abc|5||open|x=-&kind=fr,nfr')).toBe(true);
  });

  it('drops what is not a closed word, and v=1 from a saved or shared link is harmless', () => {
    const f = lib.bpFilt('v=1&f=area:AAA,<b>:x,milestone:M%201&gap=No%20AC&x=area*&g=Mile&s=newest');
    expect(f).toMatchObject({ f: ['area:AAA'], gap: '', x: '', g: '', s: '' });
    expect(lib.bpFiltStr(f)).toBe('f=area:AAA');
  });

  it('opens each screen on its natural count table', () => {
    expect(lib.bpLaX('2', 'fr,nfr')).toBe('area*milestone');
    expect(lib.bpLaX('2', 'ac')).toBe('area*status');
    expect(lib.bpLaX('2', 'hypothesis')).toBe('line*status');
    expect(lib.bpLaX('2', 'finding')).toBe('line*confidence');
    expect(lib.bpLaX('4', 'milestone')).toBe('phase*status');
    expect(lib.bpLaX('5', '')).toBe('likelihood*impact');
    expect(lib.bpLaX('5', 'issue')).toBe('impact*status');
    expect(lib.bpLaX('1', '')).toBe('');
  });

  it('a cell sets both dimensions to one value each, and the same cell again clears them; status and kind keep their own places', () => {
    const f = { ...lib.bpFilt('f=area:AAA,area:BBB,priority:must'), at: 'c1' };
    const [a, st] = lib.bpLaSet(f, '', 'area', 'AAA');
    const [b, st2] = lib.bpLaSet(a, st, 'status', 'agreed');
    expect(b.f).toEqual(['priority:must', 'area:AAA']);
    expect(st2).toBe('agreed');
    expect(b.at).toBe('');
    expect(lib.bpLaIs(b, st2, 'area', 'AAA') && lib.bpLaIs(b, st2, 'status', 'agreed')).toBe(true);
    // Two values of one dimension are not one cell.
    expect(lib.bpLaIs(f, '', 'area', 'AAA')).toBe(false);
    const [c, st3] = lib.bpLaSet(...lib.bpLaSet(b, st2, 'area', null), 'status', null);
    expect(c.f).toEqual(['priority:must']);
    expect(st3).toBe('');
    expect(lib.bpLaSet(f, '', 'kind', 'ac')[0].kind).toBe('ac');
  });
});

describe('console: Blueprint list analysis screen', () => {
  const chips = fn('function bpLaChips('), notes = fn('function bpLaNotes('), table = fn('function bpLaTable('), list = fn('function bpLaList('), head = fn('function bpLaHead(');
  it('shows the hub\'s numbers only: N of M, cells, row totals and group counts come from the browse answer', () => {
    expect(line('const bpLaShow = ')).toContain('<b>${lst.total}</b> of ${lst.of ?? lst.counts.all}');
    expect(table).toContain('c.cells[i][j]');
    expect(table).toContain('c.totals?.[i]');
    expect(table).not.toMatch(/reduce\(/);
    expect(list).toContain('overline(g?.label || it.group, g?.count)');
    expect(head).toContain("xOn ? String(lst.total) : { html: bpLaShow(lst) }");
    expect(js).toContain('of ${r.rows ?? r.total}</span>');
  });

  it('says when an item can sit in more than one column, and, under the toolbar, when a filter no longer applies', () => {
    expect(table).toContain('An item can sit in more than one column');
    expect(notes).toContain("'1 filter no longer applies'");
    expect(notes).toContain('filters no longer apply');
    expect(notes).toContain('lst.hidden?.[0]?.reason');
    expect(js).toContain("body = tools + (la ? bpLaNotes(lst, f) : '') + (xOn ?");
  });

  it('is a table only from tablet up and a list on phones, never a sideways table on a phone', () => {
    expect(table).toContain('class="bp-xw only-d"');
    expect(table).toContain('class="bp-xm only-m"');
    expect(css).toMatch(/@media \(max-width:767\.98px\)\{\.only-d\{display:none!important\}\}/);
  });

  it('the Where you are line is gone; the filters are chips in the search box, each a button named for what removing it does', () => {
    expect(js).not.toContain('bpLaWhere');
    expect(js).not.toContain('bp-where');
    expect(chips).toContain("name: `Remove ${name}`");
    expect(chips).toContain('data-bp-fk="q"');
    expect(table).toContain('aria-pressed="${on}" aria-label="${esc(name(i, j))}"');
    expect(table).toContain("plural(c.cells[i][j], 'item')");
    expect(css).toMatch(/\.cs-chip\{[^}]*border-radius:var\(--r-chip\)/);
    expect(css).toMatch(/\.bp-xc\{[^}]*border-radius:var\(--r-chip\)/);
  });

  it('Save view is the first row of Views, offered only while the view differs from the default, and gets the state without counts', () => {
    expect(line('const BP_VIEW = ')).toBe('const BP_VIEW = { save: null };');
    const vs = fn('function bpViewsSheet(');
    expect(vs).toContain("const sv = save ? `<div class=\"sheet-list bpv-save\">${row({ one: true, as: 'button', title: 'Save view'");
    expect(vs).toContain('html: `${sv}<div id="bpvBody">');
    expect(js).toContain('bpFilters = { f, fq, goF, statuses: lst.statuses, la: la && pg ? pg : null, canSave: la && filtered };');
    expect(js).toContain('const save = canSave && BP_VIEW.save ? (anchor) => BP_VIEW.save({ pid, section: tab, team, state: { q: f.q, kind: f.kind, sel: f.sel, status, f: f.f, gap: f.gap, x: f.x, g: f.g, s: f.s }, anchor }) : null;');
    expect(js).not.toContain('data-bp-save');
  });

  it('Ask for a report is the first row of ⋯ at every width; the app bar keeps only ⋯ (after the team filter)', () => {
    expect(js).toContain("a: `${one ? '' : teamSelH}${moreBtn()}`,");
    expect(js).toContain("menu: [!(sum.parts || []).length ? null : { label: 'Ask for a report', icon: 'note', fn: () => askFn($('[data-dbar-more]')) }, wide ? { label: 'Export'");
    expect(js).not.toContain('id="bpAsk"');
  });

  it('the empty state offers Clear search and filters, which does what the box\'s ✕ does', () => {
    expect(js).toContain("emptyAct('Clear search and filters', `data-bpv=\"${esc(clearTo)}\" data-bp-fk=\"q\"`)");
    expect(js).toContain("clearTo = goF({ ...f, q: '', kind: '', f: [], gap: '', at: '' }, '')");
    expect(js).toContain("clear: `data-bpv=\"${esc(clearTo)}\" data-bp-fk=\"q\"`");
  });
});

describe('console: the search field with chips (a shared helper)', () => {
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const H = new Function('stubs', `with (stubs) { ${fn('function csChipsHtml(')}\n${fn('function chipSearch(')}\n${fn('function csrchKey(')}\nreturn { chipSearch, csrchKey }; }`)({ esc, ic: (n: string) => `<i-${n}>`,
    $: (q: string, el: { q: Record<string, unknown> }) => el.q[q], $$: (q: string, el: { all: Record<string, unknown[]> }) => el.all[q], csrchMark: () => {} }) as {
    chipSearch: (o: object) => string; csrchKey: (e: object) => void };
  const chips = [{ label: 'Status: Agreed', name: 'Remove the filter Status: agreed', attrs: 'data-bpv="a"' }, { label: 'Gap: No AC', name: 'Remove the gap No AC', attrs: 'data-bpv="g"', gap: true }];

  it('draws the chips before the input, in one box, then the ✕ named Clear search and filters', () => {
    const h = H.chipSearch({ attrs: 'data-bp-q', label: 'Search this section', value: 'net', chips, clear: 'data-bpv="clr"', more: 'data-bp-fmore' });
    expect(h).toMatch(/^<form class="srch csrch" role="search" data-bp-q><i-search><span class="csrch-box"><button type="button" class="cs-chip" data-cs-chip data-bpv="a" aria-label="Remove the filter Status: agreed">Status: Agreed<i-x><\/button><button type="button" class="cs-chip gap"/);
    expect(h).toContain('<button type="button" class="cs-chip cs-more" data-cs-more data-bp-fmore hidden></button><input class="csrch-in"');
    expect(h).toContain('value="net" data-q="net" placeholder="" aria-label="Search this section"');
    expect(h).toMatch(/<button type="button" class="ibtn csrch-x" data-bpv="clr" aria-label="Clear search and filters" title="Clear search and filters"><i-x><\/button><\/form>$/);
  });

  it('says Search only while there are no chips, and hides the ✕ and "+k" while the box is empty', () => {
    const h = H.chipSearch({ label: 'Search this section', value: '', chips: [], clear: 'data-bpv="clr"', more: 'data-bp-fmore' });
    expect(h).toContain('placeholder="Search"');
    expect(h).toContain('aria-label="Clear search and filters" title="Clear search and filters" hidden>');
    expect(h).not.toContain('data-cs-more');
  });

  it('folds the last filter chips past two lines into "+k" (it opens Filters); the gap chip never folds', () => {
    const fit = fn('function csrchFit(');
    expect(fit).toContain("const fold = chips.filter((c) => !c.classList.contains('gap'));");
    expect(fit).toContain('lines() > 2');
    expect(fit).toContain("more.setAttribute('aria-label', `${plural(k, 'more filter')}, open Filters`)");
    expect(js).toContain("const fm = $('[data-bp-fmore]', $('#dB')); if (fm) fm.onclick = () => $('#bpFilt')?.click();");
    expect(js).toContain("addEventListener('resize', () => $$('.csrch').forEach(csrchFit));");
  });

  // A pretend box: two chips and the input; each records focus and clicks.
  const box = () => {
    const log: string[] = [], form: Record<string, unknown> = { requestSubmit: () => log.push('submit') };
    const el = (name: string, chip: boolean) => ({ name, hidden: false, value: '', selectionStart: 0, selectionEnd: 0, dataset: { q: '' } as Record<string, string>,
      closest: () => form, matches: (q: string) => chip && q === '[data-cs-chip]', focus: () => log.push(`focus ${name}`), click: () => log.push(`click ${name}`) });
    const a = el('a', true), g = el('g', true), inp = el('in', false);
    form.q = { '.csrch-in': inp }; form.all = { '[data-cs-chip],[data-cs-more]': [a, g] };
    const key = (t: object, k: string) => { let stopped = false; H.csrchKey({ target: t, key: k, preventDefault: () => {}, stopImmediatePropagation: () => { stopped = true; } }); return stopped; };
    return { log, a, g, inp, key };
  };

  it('Backspace in an empty input focuses the last chip, and a second Backspace removes it', () => {
    const b = box();
    expect(b.key(b.inp, 'Backspace')).toBe(true);
    expect(b.key(b.g, 'Backspace')).toBe(true);
    expect(b.log).toEqual(['focus g', 'click g']);
    // With text, Backspace edits the text.
    const c = box(); c.inp.value = 'ne'; c.inp.selectionStart = c.inp.selectionEnd = 2;
    expect(c.key(c.inp, 'Backspace')).toBe(false);
    expect(c.log).toEqual([]);
  });

  it('Arrow Left and Right move between the chips and the input (Left from the input only at its start)', () => {
    const b = box();
    b.key(b.inp, 'ArrowLeft'); b.key(b.g, 'ArrowLeft'); b.key(b.a, 'ArrowLeft'); b.key(b.a, 'ArrowRight'); b.key(b.g, 'ArrowRight');
    expect(b.log).toEqual(['focus g', 'focus a', 'focus g', 'focus in']);
    const c = box(); c.inp.value = 'net'; c.inp.selectionStart = c.inp.selectionEnd = 3;
    expect(c.key(c.inp, 'ArrowLeft')).toBe(false);
  });

  it('Escape clears only the text, and runs the search again when the list was searched; the chips stay', () => {
    const b = box(); b.inp.value = 'net'; b.inp.dataset.q = 'net';
    expect(b.key(b.inp, 'Escape')).toBe(true);
    expect(b.inp.value).toBe('');
    expect(b.log).toEqual(['submit']);
    // Nothing typed: Escape is left to the console (it leaves the field).
    const c = box();
    expect(c.key(c.inp, 'Escape')).toBe(false);
  });

  it('after a chip or the ✕ is pressed, focus returns to the input', () => {
    expect(js).toContain("(fk === 'q' && $('#dB .csrch-in'))");
  });
});

describe('console: the list overline (a shared helper)', () => {
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const show = '<span class="bp-show" tabindex="-1" aria-live="polite"><b>18</b> of 112</span>';
  const O = new Function('stubs', `with (stubs) { ${fn('function listOverline(')}\n${line('const BP_SORTS = ')}\n${line('const bpLaShow = ')}\n${line('const bpLc = ')}\n${fn('function bpLaHead(')}\nreturn { listOverline, bpLaHead }; }`)({ esc }) as {
    listOverline: (p: unknown[]) => string; bpLaHead: (lst: object, xOn: boolean, ctl?: boolean) => string };
  const lst = { total: 18, of: 112, counts: { all: 112 }, filters: { g: 'line', s: 'risk' }, facets: [{ id: 'line', label: 'Line', values: [{}] }, { id: 'confidence', label: 'Confidence', values: [{}] }, { id: 'empty', label: 'Empty', values: [] }] };

  it('joins its parts with "·": text, trusted markup, and inline selects that keep their names and say their words in the options', () => {
    const h = O.listOverline(['Matching', '18', '', { name: 'Sort', attrs: 'data-s', value: 'b', options: [['a', 'A first'], ['b', 'B first']] }]);
    expect(h).toBe('<div class="overline lov"><span>Matching</span><span aria-hidden="true">·</span><span>18</span><span aria-hidden="true">·</span><select class="isel" data-s aria-label="Sort"><option value="a">A first</option><option value="b" selected>B first</option></select></div>');
    expect(css).toMatch(/\.isel\{[^}]*text-transform:none;letter-spacing:normal/);
    expect(css).toMatch(/@media \(max-width:767\.98px\)\{\.isel\{height:var\(--h-touch\)\}\}/);
  });

  it('the list reads MATCHING · 18 · Grouped by line ▾ · Most at risk first ▾ while the table is drawn', () => {
    const h = O.bpLaHead(lst, true);
    expect(h).toMatch(/^<div class="overline lov"><span>Matching<\/span><span aria-hidden="true">·<\/span><span>18<\/span><span aria-hidden="true">·<\/span><select class="isel" data-bp-g data-bp-fk="g" aria-label="Group by">/);
    expect(h).toContain('<option value="">Not grouped</option><option value="line" selected>Grouped by line</option><option value="confidence">Grouped by confidence</option></select>');
    expect(h).not.toContain('Grouped by empty');
    expect(h).toContain('<select class="isel" data-bp-s data-bp-fk="s" aria-label="Sort"><option value="">Blueprint order</option><option value="risk" selected>Most at risk first</option>');
    expect(h).not.toContain('bp-show');
    // No fixed "grouped by" text around the select, and no Group by and Sort row of their own.
    expect(js).not.toContain('<span class="vlabel">Group by</span>');
    expect(js).not.toContain('<span class="vlabel">Sort</span>');
  });

  it('while the table is folded, "18 of 112" (the one live region) is the overline\'s count, never a group\'s', () => {
    const h = O.bpLaHead(lst, false);
    expect(h).toContain(`<span>Matching</span><span aria-hidden="true">·</span>${show}<span aria-hidden="true">·</span><select`);
    expect(h.match(/aria-live=/g)).toHaveLength(1);
    // An empty list keeps the count line without the selects.
    expect(O.bpLaHead(lst, false, false)).toBe(`<div class="overline lov"><span>Matching</span><span aria-hidden="true">·</span>${show}</div>`);
    expect(fn('function bpLaList(')).toContain('rows += `<div class="bp-grp">${overline(g?.label || it.group, g?.count)}</div>`');
  });
});

describe('console: the count table above the list, at full width', () => {
  // The real chips, toggle and count table, run with the console's helpers stubbed; goF writes the route state it was given.
  const src = [line('const bpLaShow = '), line('const bpLaDims = '), line('const bpLaXOn = '), fn('function bpLaSet('), line('const bpLaIs = '), line('const bpLaFacet = '), line('const bpLaDim = '),
    line('const bpLaLabel = '), fn('function bpLaChips('), fn('function bpLaXTog('), fn('function bpLaTable(')].join('\n');
  const run = new Function('stubs', `with (stubs) { ${src}\nreturn { bpLaChips, bpLaXTog, bpLaTable }; }`) as (s: object) => { bpLaChips: (...a: unknown[]) => { label: string; name: string; attrs: string; gap?: boolean }[]; bpLaXTog: (...a: unknown[]) => string; bpLaTable: (...a: unknown[]) => string };
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const L = run({ esc, ic: (n: string) => `<i-${n}>`, plural: (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`, cap: (s: string) => s, bpLabel: (s: string) => s, BP_KIND_PL: {} });
  const goF = (f: { x: string; f: string[]; gap?: string; kind?: string }, st: string) => `x=${f.x}|f=${f.f.join(',')}|st=${st}${f.gap ? `|gap=${f.gap}` : ''}${f.kind ? `|kind=${f.kind}` : ''}`;
  const F = { q: '', kind: '', sel: '', at: '', f: [] as string[], gap: '', x: 'area*status', g: '', s: '' };
  const lst = { total: 18, of: 112, counts: { all: 112 }, items: [], facets: [{ id: 'area', label: 'Area', values: [{ value: 'AAA', label: 'Alpha area' }] }, { id: 'status', label: 'Status', values: [{ value: 'agreed', label: 'Agreed' }] }],
    gaps: [{ id: 'no_ac', label: 'No AC' }],
    cross: { rows: 'area', cols: 'status', row_values: [{ value: 'AAA', label: 'Alpha area' }], col_values: [{ value: 'agreed', label: 'Agreed' }, { value: 'verified', label: 'Verified' }], cells: [[3, 0]], totals: [3], col_totals: [3, 0], multi: true } };

  it('the chips come in the Where you are order: status, kind, the dimension filters, then the gap; each link drops only its own', () => {
    const c = L.bpLaChips(lst, { ...F, kind: 'fr', f: ['area:AAA'], gap: 'no_ac' }, 'agreed', goF);
    expect(c.map((x) => x.label)).toEqual(['Agreed', 'fr', 'Area: Alpha area', 'Gap: No AC']);
    expect(c.map((x) => x.name)).toEqual(['Remove the filter Status: agreed', 'Remove the kind filter', 'Remove the filter Area: Alpha area', 'Remove the gap No AC']);
    expect(c[2].attrs).toBe('data-bpv="x=area*status|f=|st=agreed|gap=no_ac|kind=fr" data-bp-fk="q"');
    expect(c.map((x) => !!x.gap)).toEqual([false, false, false, true]);
    // A default is never a chip, and a filter the hub no longer applies is not one either.
    expect(L.bpLaChips(lst, F, '', goF)).toEqual([]);
    expect(L.bpLaChips({ ...lst, ignored: ['area:AAA'] }, { ...F, f: ['area:AAA'] }, '', goF)).toEqual([]);
  });

  it('one toggle, at the end of the toolbar, names what it does, with aria-expanded and aria-controls and no aria-pressed', () => {
    const on = L.bpLaXTog(lst, F, '', goF), off = L.bpLaXTog(lst, { ...F, x: '-' }, '', goF);
    expect(on).toBe('<button type="button" class="ibtn bp-xtog on" data-bpv="x=-|f=|st=" data-bp-fk="xshow" aria-expanded="true" aria-controls="bpX" aria-label="Hide count table" title="Hide count table"><i-grid></button>');
    expect(off).toBe('<button type="button" class="ibtn bp-xtog" data-bpv="x=|f=|st=" data-bp-fk="xshow" aria-expanded="false" aria-controls="bpX" aria-label="Show count table" title="Show count table"><i-grid></button>');
    expect(on + off).not.toContain('aria-pressed');
    // No cross from the hub: Show asks for the first two dimensions. One dimension: no toggle.
    expect(L.bpLaXTog({ ...lst, cross: null }, F, '', goF)).toContain('data-bpv="x=area*status|f=|st=" data-bp-fk="xshow" aria-expanded="false"');
    expect(L.bpLaXTog({ ...lst, facets: lst.facets.slice(0, 1) }, F, '', goF)).toBe('');
    expect(js).toContain("Refine with coordinator</button>' : ''}${xtog}</div>` : '';");
  });

  it('heads the drawn table with one line: "18 of 112" (its live region and focus target) · Rows by Columns and the swap', () => {
    const tb = L.bpLaTable(lst, F, '', goF);
    expect(tb).toMatch(/^<div class="bp-c bp-xcard" id="bpX" data-bp-x="area\*status"><div class="bp-xh"><span class="bp-show" tabindex="-1" aria-live="polite"><b>18<\/b> of 112<\/span><span aria-hidden="true">·<\/span><select class="isel" data-bp-xa="r" data-bp-fk="xr" aria-label="Rows">/);
    const hd = tb.slice(0, tb.indexOf('</div>'));
    expect(hd).toMatch(/aria-label="Rows">[^]*<\/select><span class="bp-xby">by<\/span><select class="isel" data-bp-xa="c" data-bp-fk="xc" aria-label="Columns">[^]*<\/select><button type="button" class="ibtn bp-xswap" data-bpv="x=status\*area\|f=\|st=" data-bp-fk="xswap" aria-label="Swap rows and columns"/);
    expect(tb).not.toContain('Hide count table');
    expect(tb).not.toContain('Showing');
    expect(tb).not.toContain('class="bp-xsel"');
    expect(tb.indexOf('An item can sit in more than one column')).toBeLessThan(tb.indexOf('class="bp-xw only-d"'));
    // Row names carry their full name as the tooltip; a zero is a faint cell.
    expect(tb).toContain('<th scope="row" title="Alpha area"><span>Alpha area</span></th>');
    expect(tb).toMatch(/class="bp-xc zero"[^>]*>0</);
  });

  it('a cell sets both filters and names itself, so the click handler can return focus to it', () => {
    expect(L.bpLaTable(lst, F, '', goF)).toContain('data-bpv="x=area*status|f=area:AAA|st=agreed" data-bp-fk="x:AAA|agreed" aria-pressed="false"');
    expect(L.bpLaTable(lst, { ...F, f: ['area:AAA'] }, 'agreed', goF)).toContain('class="bp-xc on" data-bpv="x=area*status|f=|st=" data-bp-fk="x:AAA|agreed" aria-pressed="true"');
  });

  it('folded, the table is an empty #bpX (what the toggle controls); not offered, it is nothing', () => {
    expect(L.bpLaTable(lst, { ...F, x: '-' }, '', goF)).toBe('<div id="bpX" hidden></div>');
    expect(L.bpLaTable({ ...lst, facets: lst.facets.slice(0, 1) }, F, '', goF)).toBe('');
  });

  it('a fold moves the one "N of M" from the table to the list\'s overline, and the toggle keeps its place (and focus)', () => {
    const screen = js.slice(js.indexOf('const xt = la ? bpLaTable(lst, f, status, goF)'), js.indexOf("bpFilters = { f, fq, goF"));
    expect(screen).toContain("(xOn ? `<div class=\"bp-la\">${xt}</div>` : xt)");
    expect(screen).toContain('bpLaList(pid, lst, f, team, xOn)');
    expect(js).toContain("const xtog = la && pg ? bpLaXTog(pg, f, status, goF) : '', xOn = la && pg ? bpLaXOn(pg, f) : false;");
    // The table comes before the list, never beside it: no 7 + 5 grid, no sticky card.
    expect(css).not.toContain('grid-template-areas:"list x"');
    expect(css).not.toMatch(/\.bp-xcard[^{]*\{[^}]*position:sticky/);
    expect(js).not.toContain('bp-la-main');
  });

  it('row names use the free width and wrap to three lines before they are cut; headers keep their size and two lines', () => {
    expect(css).toContain('.bp-xt{width:100%}');
    expect(css).toMatch(/\.bp-xt thead th\{[^}]*white-space:normal;min-width:44px;max-width:120px;width:1%\}/);
    expect(css).toContain('.bp-xt thead th:first-child{width:auto}');
    expect(css).toMatch(/\.bp-xt thead th>span,\.bp-xt tbody th>span\{[^}]*-webkit-line-clamp:2/);
    expect(css).toContain('.bp-xt thead th>span{width:max-content;max-width:104px;margin-inline:auto}');
    expect(css).toContain('.bp-xt tbody th{white-space:normal;min-width:96px;max-width:none}');
    expect(css).toContain('.bp-xt tbody th>span{-webkit-line-clamp:3}');
    expect(css).toContain('.bp-xt td{padding:0;text-align:center;width:1%}');
    expect(css).toContain('.bp-xt td.bp-xtot,.bp-xt thead th.bp-xtot{text-align:right}');
  });

  it('⇄, Rows and Columns have 44 px targets on a phone', () => {
    expect(css).toContain('@media (max-width:767.98px){.bp-xswap{width:var(--h-touch);height:var(--h-touch)}}');
    expect(css).toMatch(/\.bp-xtog\{width:var\(--h-touch\);height:var\(--h-touch\)\}/);
  });

  it('never scrolls inside the count table: no overflow scroll, no max-height and no faded edge on anything in it', () => {
    const rules = [...css.matchAll(/([^{}]*\.bp-(?:x[a-z]*|la)[^{}]*)\{([^{}]*)\}/g)].map((m) => `${m[1].trim()}{${m[2]}}`);
    expect(rules.length).toBeGreaterThan(20);
    for (const r of rules) expect(r, r).not.toMatch(/overflow(-x|-y)?:(auto|scroll)|max-height|mask-image|overscroll/);
    expect(js).not.toContain('bpXEdge');
    expect(css).toContain('.bp-xw{margin-top:var(--s3)}');
  });

  it("a click in the table keeps the page where it is and the focus on the control pressed; a swap makes the axes the viewer's", () => {
    const h = js.slice(js.indexOf("const bpv = t.closest('[data-bpv]')"), js.indexOf('const obs = t.closest('));
    expect(h).toContain("if (fk === 'xswap' && xc) { const [r, c] = xc.dataset.bpX.split('*'); BP_XU = { x: `${c}*${r}`, w: innerWidth }; }");
    expect(h).toContain('el.dataset.bpFk === fk && el.offsetParent');
    expect(h).toContain("focus({ preventScroll: !!(xc || fk.startsWith('xo:')) })");
    expect(h).not.toContain('scrollTop');
  });
});

describe('console: the count table fits without scrolling (turned, then folded into Other)', () => {
  const src = [line('const bpLaShow = '), line('const bpLaDims = '), line('const bpLaXOn = '), fn('function bpLaSet('), line('const bpLaIs = '), line('const bpLaFacet = '), line('const bpLaDim = '),
    line('const bpLaLabel = '), fn('function bpLaTable('), line('const bpXTurn = ') + '\n' + line('  cells: c.col_values.map('), fn('function bpXFold('), line('let BP_XU = '), line('const bpXFits = '), fn('function bpXFit(')].join('\n');
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  // A pretend page: the table is 60 px plus 50 px a column; the card (at full width, above the list) is 900 px.
  const page = { full: false, v: {} as { turn?: boolean; keep?: number }, h: 300, cols: 0 };
  const la = { isConnected: true, contains: () => false, classList: { remove: () => { page.full = false; }, add: () => { page.full = true; }, contains: () => page.full } };
  const card = { classList: { on: false, toggle(_: string, on: boolean) { this.on = on; } }, get offsetHeight() { return page.h; }, set outerHTML(s: string) { page.v = JSON.parse(s); }, contains: () => false };
  const xw = { offsetParent: {}, get clientWidth() { return 900; }, firstElementChild: { get offsetWidth() { return 60 + 50 * page.cols; } } };
  const stubs = { esc, ic: (n: string) => `<i-${n}>`, plural: (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`, cap: (s: string) => s, bpLabel: (s: string) => s, BP_KIND_PL: {},
    $: (q: string) => (q === '.bp-xw' ? xw : card), $$: () => [], getComputedStyle: () => ({ getPropertyValue: () => '56' }), innerWidth: 1360, innerHeight: 900, document: { activeElement: null } };
  const X = new Function('stubs', `with (stubs) { ${src}\nreturn { bpLaTable, bpXTurn, bpXFold, bpXFit, setXU: (x) => { BP_XU = x; } }; }`)(stubs) as {
    bpLaTable: (...a: unknown[]) => string; bpXTurn: (c: object) => any; bpXFold: (c: object, k: number) => { K: number[]; O: number[]; sums: number[] }; bpXFit: (...a: unknown[]) => any; setXU: (x: unknown) => void };
  const vals = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ value: `${p}${i}`, label: `${p.toUpperCase()} ${i}` }));
  const cross = (r: number, c: number) => ({ rows: 'area', cols: 'team', row_values: vals('a', r), col_values: vals('t', c), cells: vals('a', r).map((_, i) => vals('t', c).map((__, j) => (i + j) % 3)), totals: vals('a', r).map(() => 9), col_totals: vals('t', c).map((_, j) => j), multi: false });
  // draw(v) records the view; the pretend table is as wide as the view's columns (Other counts as one).
  const fit = (c: ReturnType<typeof cross>) => {
    const draw = (v: { turn?: boolean; keep?: number }) => { const n = v.turn ? c.row_values.length : c.col_values.length; page.cols = v.keep ? v.keep + 1 : n; return JSON.stringify(v); };
    const v = X.bpXFit(la, c, draw, () => {});
    return v;
  };

  it('a table that fits sits above the list as it is, at full width, never pinned', () => {
    X.setXU(null);
    expect(fit(cross(4, 5))).toEqual({});
    expect(fit(cross(4, 12))).toEqual({});
    expect(fn('function bpXFit(')).not.toMatch(/pin|full/);
  });

  it('a cross whose turned form fits gets turned, with "Turned to fit" by the swap; the turned table swaps values, cells and totals', () => {
    expect(fit(cross(5, 20))).toEqual({ turn: true });
    const c = cross(2, 3), t = X.bpXTurn(c);
    expect([t.rows, t.cols, t.row_values, t.col_values, t.totals, t.col_totals]).toEqual([c.cols, c.rows, c.col_values, c.row_values, c.col_totals, c.totals]);
    expect(t.cells).toEqual([[c.cells[0][0], c.cells[1][0]], [c.cells[0][1], c.cells[1][1]], [c.cells[0][2], c.cells[1][2]]]);
    const lst = { total: 5, of: 9, counts: { all: 9 }, facets: [{ id: 'area', label: 'Area', values: c.row_values }, { id: 'team', label: 'Team', values: c.col_values }], cross: c };
    const F = { q: '', kind: '', sel: '', at: '', f: [] as string[], gap: '', x: 'area*team', g: '', s: '' };
    const goF = (f: { x: string; f: string[] }, st: string) => `x=${f.x}|f=${f.f.join(',')}|st=${st}`;
    const tb = X.bpLaTable(lst, F, '', goF, { turn: true });
    expect(tb).toContain('data-bp-x="team*area"');
    expect(tb).toMatch(/aria-label="Swap rows and columns"[^>]*>[^<]*<i-swap><\/button><span class="meta bp-xturn">Turned to fit<\/span><\/div>/);
    // Swapping a turned table asks for the axes as the hub drew them; its cells still filter both dimensions.
    expect(tb).toContain('data-bpv="x=area*team|f=|st="');
    expect(tb).toContain('data-bpv="x=area*team|f=team:t1,area:a0|st=" data-bp-fk="x:t1|a0"');
    expect(X.bpLaTable(lst, F, '', goF)).not.toContain('Turned to fit');
  });

  it("the viewer's own axes are not turned until the window's width changes; the table folds instead", () => {
    X.setXU({ x: 'area*team', w: 1360 });
    expect(fit(cross(5, 20))).toEqual({ keep: 15 });
    X.setXU({ x: 'area*team', w: 1024 });
    expect(fit(cross(5, 20))).toEqual({ turn: true });
    X.setXU(null);
  });

  it('a cross with too many columns either way folds the smallest into Other, on the side with fewer columns, until it fits', () => {
    // 30 columns, 25 rows: turned has 25 columns, still too wide; 15 kept + Other is 60 + 16 × 50 = 860 px of 900.
    expect(fit(cross(25, 30))).toEqual({ turn: true, keep: 15 });
    expect(fit(cross(30, 25))).toEqual({ keep: 15 });
  });

  it('Other keeps the columns with the largest totals in their order and sums the rest per row', () => {
    const c = { col_values: vals('t', 5), cells: [[1, 2, 3, 4, 5], [0, 7, 0, 1, 2]], col_totals: [1, 9, 3, 5, 7] };
    const fo = X.bpXFold(c, 2);
    expect(fo.K).toEqual([1, 4]);
    expect(fo.O).toEqual([0, 2, 3]);
    expect(fo.sums).toEqual([1 + 3 + 4, 0 + 0 + 1]);
  });

  it('an Other cell opens a popover of that row\'s folded columns, each filtering to that row and column as its own cell would', () => {
    const c = { ...cross(2, 4), cells: [[5, 1, 0, 2], [0, 0, 0, 0]], col_totals: [5, 1, 0, 2] };
    const lst = { total: 5, of: 9, counts: { all: 9 }, facets: [{ id: 'area', label: 'Area', values: c.row_values }, { id: 'team', label: 'Team', values: c.col_values }], cross: c };
    const F = { q: '', kind: '', sel: '', at: '', f: [] as string[], gap: '', x: 'area*team', g: '', s: '' };
    const goF = (f: { x: string; f: string[] }, st: string) => `x=${f.x}|f=${f.f.join(',')}|st=${st}`;
    const tb = X.bpLaTable(lst, F, '', goF, { keep: 2 });
    expect(tb).toContain('<th scope="col" class="bp-xo" title="T 1, T 2"><span>Other · 2</span></th>');
    expect(tb).not.toContain('<th scope="col" title="T 1">');
    // Row a0: Other is 1 + 0; its popover lists T 1 only (no empty rows), filtering area a0 and team t1.
    expect(tb).toContain('class="bp-xc bp-xoc" data-bp-other="0" data-bp-fk="xo:a0" aria-haspopup="dialog" aria-label="Area A 0, other Team: 1 in T 1, T 2">1</button>');
    const tp = tb.slice(tb.indexOf('<template data-bp-xo="0"'), tb.indexOf('</template>'));
    expect(tp).toContain('data-title="A 0 · Other Team"');
    expect(tp.match(/data-bpv=/g)).toHaveLength(1);
    expect(tp).toContain('data-sheet-close data-bpv="x=area*team|f=area:a0,team:t1|st=" data-bp-fk="xo:a0" aria-pressed="false"');
    // A row with nothing folded shows a faint 0 that opens nothing.
    expect(tb).toContain('<td><span class="bp-xc zero">0</span></td>');
    const h = js.slice(js.indexOf("const xo = t.closest('[data-bp-other]')"), js.indexOf("const bpv = t.closest('[data-bpv]')"));
    expect(h).toContain('openSheet({ title: tp.dataset.title, html: `<div class="bp-xop">${tp.innerHTML}</div>`, anchor: xo })');
  });
});
