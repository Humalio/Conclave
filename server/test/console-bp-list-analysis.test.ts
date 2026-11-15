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
  const where = fn('function bpLaWhere('), table = fn('function bpLaTable('), list = fn('function bpLaList(');
  it('shows the hub\'s numbers only: Showing N of M, cells, row totals and group counts come from the browse answer', () => {
    expect(line('const bpLaShow = ')).toContain('Showing <b>${lst.total}</b> of ${lst.of ?? lst.counts.all}');
    expect(table).toContain('c.cells[i][j]');
    expect(table).toContain('c.totals?.[i]');
    expect(table).not.toMatch(/reduce\(/);
    expect(list).toContain('overline(g?.label || it.group, g?.count)');
    expect(js).toContain('of ${r.rows ?? r.total}</span>');
  });

  it('says when an item can sit in more than one column, and when a filter no longer applies', () => {
    expect(table).toContain('An item can sit in more than one column');
    expect(where).toContain("'1 filter no longer applies'");
    expect(where).toContain('filters no longer apply');
    expect(where).toContain('lst.hidden?.[0]?.reason');
  });

  it('is a table only from tablet up and a list on phones, never a sideways table on a phone', () => {
    expect(table).toContain('class="bp-xw only-d"');
    expect(table).toContain('class="bp-xm only-m"');
    expect(css).toMatch(/@media \(max-width:767\.98px\)\{\.only-d\{display:none!important\}\}/);
  });

  it('draws every chip, cell and group control as a button or select with its count in its name', () => {
    expect(where).toContain('<button type="button" class="bp-chip on');
    expect(table).toContain('aria-pressed="${on}" aria-label="${esc(name(i, j))}"');
    expect(table).toContain("plural(c.cells[i][j], 'item')");
    expect(list).toContain('data-bp-g aria-label="Group by"');
    expect(list).toContain('data-bp-s aria-label="Sort"');
    expect(css).toMatch(/\.bp-chip\{[^}]*border-radius:var\(--r-chip\)/);
    expect(css).toMatch(/\.bp-xc\{[^}]*border-radius:var\(--r-chip\)/);
  });

  it('offers Save view only when the saved-views code has set its hook, and hands it the state without counts', () => {
    expect(line('const BP_VIEW = ')).toBe('const BP_VIEW = { save: null };');
    expect(where).toContain("BP_VIEW.save ? '<button type=\"button\" class=\"btn ghost sm\" data-bp-save>Save view</button>' : ''");
    expect(js).toContain('BP_VIEW.save?.({ pid, section: tab, team, state: { q: f.q, kind: f.kind, sel: f.sel, status, f: f.f, gap: f.gap, x: f.x, g: f.g, s: f.s }, anchor: sv })');
  });
});

describe('console: the count table beside the list on wide screens', () => {
  // The real Where you are and count table, run with the console's helpers stubbed; goF writes the route state it was given.
  const src = [line('const bpLaShow = '), line('const bpLaDims = '), line('const bpLaXOn = '), fn('function bpLaSet('), line('const bpLaIs = '), line('const bpLaFacet = '), line('const bpLaDim = '),
    line('const bpLaLabel = '), fn('function bpLaWhere('), fn('function bpLaTable(')].join('\n');
  const run = new Function('stubs', `with (stubs) { ${src}\nreturn { bpLaWhere, bpLaTable }; }`) as (s: object) => { bpLaWhere: (...a: unknown[]) => string; bpLaTable: (...a: unknown[]) => string };
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const L = run({ esc, ic: (n: string) => `<i-${n}>`, plural: (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`, cap: (s: string) => s, bpLabel: (s: string) => s, BP_KIND_PL: {}, BP_VIEW: { save: () => {} } });
  const goF = (f: { x: string; f: string[] }, st: string) => `x=${f.x}|f=${f.f.join(',')}|st=${st}`;
  const F = { q: '', kind: '', sel: '', at: '', f: [] as string[], gap: '', x: 'area*status', g: '', s: '' };
  const lst = { total: 18, of: 112, counts: { all: 112 }, items: [], facets: [{ id: 'area', label: 'Area', values: [{ value: 'AAA', label: 'Alpha area' }] }, { id: 'status', label: 'Status', values: [{ value: 'agreed', label: 'Agreed' }] }],
    cross: { rows: 'area', cols: 'status', row_values: [{ value: 'AAA', label: 'Alpha area' }], col_values: [{ value: 'agreed', label: 'Agreed' }, { value: 'verified', label: 'Verified' }], cells: [[3, 0]], totals: [3], col_totals: [3, 0], multi: true } };

  it('heads the drawn table with "Showing N of M" (its live region and focus target), with no title and a quiet Hide count table icon button', () => {
    const tb = L.bpLaTable(lst, F, '', goF), wh = L.bpLaWhere(lst, F, '', goF);
    expect(tb).toMatch(/^<div class="bp-c bp-xcard" data-bp-x="area\*status"><div class="bp-xh"><span class="bp-show" tabindex="-1" aria-live="polite">Showing <b>18<\/b> of 112<\/span><button type="button" class="ibtn bp-xhide"[^>]*aria-expanded="true" aria-label="Hide count table" title="Hide count table"/);
    expect(tb).not.toContain('Count table');
    expect(tb).not.toContain('<h3>');
    // One count on the page: the Where you are line keeps Save view and loses Showing while the table is drawn.
    expect(wh).not.toContain('bp-show');
    expect(wh).toContain('data-bp-save');
    expect(wh).not.toContain('Show count table');
  });

  it('puts Rows, the swap and Columns on the second line, and the several-columns note above the table', () => {
    const tb = L.bpLaTable(lst, F, '', goF);
    const at = tb.indexOf('<div class="bp-xsel">'), sel = tb.slice(at, tb.indexOf('</div>', at));
    expect(sel.indexOf('data-bp-xa="r"')).toBeLessThan(sel.indexOf('aria-label="Swap rows and columns"'));
    expect(sel.indexOf('aria-label="Swap rows and columns"')).toBeLessThan(sel.indexOf('data-bp-xa="c"'));
    expect(sel).toContain('data-bpv="x=status*area|f=|st="');
    expect(tb.indexOf('An item can sit in more than one column')).toBeLessThan(tb.indexOf('class="bp-xw only-d"'));
    // Row names carry their full name as the tooltip; a zero is a faint cell.
    expect(tb).toContain('<th scope="row" title="Alpha area"><span>Alpha area</span></th>');
    expect(tb).toMatch(/class="bp-xc zero"[^>]*>0</);
  });

  it('a cell sets both filters and names itself, so the click handler can return focus to it', () => {
    expect(L.bpLaTable(lst, F, '', goF)).toContain('data-bpv="x=area*status|f=area:AAA|st=agreed" data-bp-fk="x:AAA|agreed" aria-pressed="false"');
    expect(L.bpLaTable(lst, { ...F, f: ['area:AAA'] }, 'agreed', goF)).toContain('class="bp-xc on" data-bpv="x=area*status|f=|st=" data-bp-fk="x:AAA|agreed" aria-pressed="true"');
  });

  it('folded or not offered draws no table: Show count table ends the Where you are line, and Showing stays on it', () => {
    const folded = { ...F, x: '-' };
    expect(L.bpLaTable(lst, folded, '', goF)).toBe('');
    const wh = L.bpLaWhere(lst, folded, '', goF);
    expect(wh).toMatch(/^<div class="bp-where"><span class="bp-show"[^>]*>Showing <b>18<\/b> of 112<\/span>/);
    expect(wh).toMatch(/data-bp-save>Save view<\/button><button type="button" class="btn sm" data-bpv="x=\|f=\|st=" data-bp-fk="xshow" aria-expanded="false">Show count table<\/button><\/div>$/);
    const one = { ...lst, facets: lst.facets.slice(0, 1) };
    expect(L.bpLaTable(one, F, '', goF)).toBe('');
    expect(L.bpLaWhere(one, F, '', goF)).not.toContain('Show count table');
    // No cross from the hub: Show count table asks for the first two dimensions.
    expect(L.bpLaWhere({ ...lst, cross: null }, F, '', goF)).toContain('data-bpv="x=area*status|f=|st=" data-bp-fk="xshow" aria-expanded="false">Show count table');
  });

  it('a fold and an unfold move the one "Showing N of M" (one live region, never two) and hand focus to the other toggle', () => {
    const page = (f: typeof F) => L.bpLaWhere(lst, f, '', goF) + L.bpLaTable(lst, f, '', goF);
    for (const f of [F, { ...F, x: '-' }]) {
      const h = page(f);
      expect(h.match(/class="bp-show"/g)).toHaveLength(1);
      expect(h.match(/aria-live=/g)).toHaveLength(1);
      expect(h).toContain('tabindex="-1" aria-live="polite">Showing <b>18</b> of 112');
      // The toggle drawn is the one fk "xshow" names, so the click handler gives it focus after the redraw.
      expect(h.match(/data-bp-fk="xshow"/g)).toHaveLength(1);
    }
    expect(page(F)).toMatch(/<div class="bp-xh"><span class="bp-show"/);
    expect(page({ ...F, x: '-' })).toMatch(/^<div class="bp-where"><span class="bp-show"/);
    // Hide folds to x=-; Show brings back the same pair the link had before it folded (x= clears to the screen's default).
    expect(page(F)).toContain('data-bpv="x=-|f=|st=" data-bp-fk="xshow" aria-expanded="true"');
    expect(page({ ...F, x: '-' })).toContain('data-bpv="x=|f=|st=" data-bp-fk="xshow" aria-expanded="false"');
  });

  it('the list and the table share one grid only while the table is drawn; the table is first in the DOM, the pager stays with the list', () => {
    expect(js).toContain('laBody = (h) => (xt ? `<div class="bp-la">${xt}<div class="bp-la-main">${h}</div></div>` : h)');
    expect(js).toMatch(/laBody\(lst\.items\.length\n\s+\? `\$\{la \? bpLaList\(pid, lst, f, team\) : [^\n]*\$\{bpPager\(/);
  });

  it('from 1180 px the list takes 7 of 12 columns and the table 5 when the table fits there; below, or when it does not, one column with the table first', () => {
    const wide = css.slice(css.indexOf('@media (min-width:1180px){\n  #workspaceView:has(.bp-la)'));
    expect(wide).toMatch(/^@media \(min-width:1180px\)\{\n  #workspaceView:has\(\.bp-la\) \.db\{overflow:visible\}/);
    expect(wide).toContain('.bp-la:not(.full){display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);grid-template-areas:"list x"');
    // Sticky only while pinned (bpXFit pins a card that fits in the window), and only beside the list.
    expect(wide).toContain('.bp-la:not(.full)>.bp-xcard{grid-area:x;margin-top:0}\n  .bp-la:not(.full)>.bp-xcard.pin{position:sticky;top:calc(var(--h-bar) + var(--s3))}');
    // Nothing outside that query lays the two side by side, so below 1180 px (and when .full) the table is a card above the list.
    expect(css.slice(0, css.indexOf('#workspaceView:has(.bp-la)'))).toContain('.bp-la{display:flex;flex-direction:column;gap:var(--s3);min-width:0}');
    // Column headers and row names wrap to two lines before they are cut; a cell keeps its number's width.
    expect(css).toMatch(/\.bp-xt thead th\{[^}]*white-space:normal;min-width:44px/);
    expect(css).toMatch(/\.bp-xt tbody th\{white-space:normal;min-width:96px/);
    expect(css).toMatch(/\.bp-xt thead th>span,\.bp-xt tbody th>span\{[^}]*-webkit-line-clamp:2/);
    expect(css).toContain('.bp-xt td.bp-xtot,.bp-xt thead th.bp-xtot{text-align:right}');
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
  // A pretend page: the table is 60 px plus 50 px a column; the card is 400 px beside the list and 900 px at full width.
  const page = { full: false, v: {} as { turn?: boolean; keep?: number }, h: 300, cols: 0 };
  const la = { isConnected: true, contains: () => false, classList: { remove: () => { page.full = false; }, add: () => { page.full = true; }, contains: () => page.full } };
  const card = { classList: { on: false, toggle(_: string, on: boolean) { this.on = on; } }, get offsetHeight() { return page.h; }, set outerHTML(s: string) { page.v = JSON.parse(s); }, contains: () => false };
  const xw = { offsetParent: {}, get clientWidth() { return page.full ? 900 : 400; }, firstElementChild: { get offsetWidth() { return 60 + 50 * page.cols; } } };
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
    return { v, full: page.full, pin: card.classList.on };
  };

  it('a table that fits beside the list sits there, and is sticky when the whole card fits in the window', () => {
    page.h = 300; X.setXU(null);
    expect(fit(cross(4, 5))).toEqual({ v: {}, full: false, pin: true });
    page.h = 900;
    expect(fit(cross(4, 5))).toEqual({ v: {}, full: false, pin: false });
  });

  it('a wide cross falls back to full width above the list, and is not sticky there', () => {
    page.h = 300;
    expect(fit(cross(4, 12))).toEqual({ v: {}, full: true, pin: false });
  });

  it('a cross whose turned form fits gets turned (here, beside the list again), with "Turned to fit" by the swap; the turned table swaps values, cells and totals', () => {
    expect(fit(cross(5, 20))).toEqual({ v: { turn: true }, full: false, pin: true });
    const c = cross(2, 3), t = X.bpXTurn(c);
    expect([t.rows, t.cols, t.row_values, t.col_values, t.totals, t.col_totals]).toEqual([c.cols, c.rows, c.col_values, c.row_values, c.col_totals, c.totals]);
    expect(t.cells).toEqual([[c.cells[0][0], c.cells[1][0]], [c.cells[0][1], c.cells[1][1]], [c.cells[0][2], c.cells[1][2]]]);
    const lst = { total: 5, of: 9, counts: { all: 9 }, facets: [{ id: 'area', label: 'Area', values: c.row_values }, { id: 'team', label: 'Team', values: c.col_values }], cross: c };
    const F = { q: '', kind: '', sel: '', at: '', f: [] as string[], gap: '', x: 'area*team', g: '', s: '' };
    const goF = (f: { x: string; f: string[] }, st: string) => `x=${f.x}|f=${f.f.join(',')}|st=${st}`;
    const tb = X.bpLaTable(lst, F, '', goF, { turn: true });
    expect(tb).toContain('data-bp-x="team*area"');
    expect(tb).toMatch(/aria-label="Swap rows and columns"[^>]*>[^<]*<i-swap><\/button><label[^]*<\/label><span class="meta bp-xturn">Turned to fit<\/span><\/div>/);
    // Swapping a turned table asks for the axes as the hub drew them; its cells still filter both dimensions.
    expect(tb).toContain('data-bpv="x=area*team|f=|st="');
    expect(tb).toContain('data-bpv="x=area*team|f=team:t1,area:a0|st=" data-bp-fk="x:t1|a0"');
    expect(X.bpLaTable(lst, F, '', goF)).not.toContain('Turned to fit');
  });

  it("the viewer's own axes are not turned until the window's width changes; the table folds instead", () => {
    X.setXU({ x: 'area*team', w: 1360 });
    expect(fit(cross(5, 20)).v).toEqual({ keep: 15 });
    X.setXU({ x: 'area*team', w: 1024 });
    expect(fit(cross(5, 20)).v).toEqual({ turn: true });
    X.setXU(null);
  });

  it('a cross with too many columns either way folds the smallest into Other, on the side with fewer columns, until it fits', () => {
    // 30 columns, 25 rows: turned has 25 columns, still too wide; 15 kept + Other is 60 + 16 × 50 = 860 px of 900.
    expect(fit(cross(25, 30)).v).toEqual({ turn: true, keep: 15 });
    expect(fit(cross(30, 25)).v).toEqual({ keep: 15 });
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
