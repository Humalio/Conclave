/**
 * Operator console, Blueprint section 2 (docs/blueprint.md §9): with no filter it opens on its summary view, not on the grouped
 * cards or on Open. The counts are the lists' totals, each reason is the hub's fixed wording, an area folds and remembers it,
 * and any filter (an explicit Open, a search, a count) opens the paged list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const block = (head: string, tail: string) => { const a = js.indexOf(head), b = js.indexOf(tail, a); expect(a, head).toBeGreaterThan(-1); expect(b, tail).toBeGreaterThan(a); return js.slice(a, b); };
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cap2 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
const stubs = {
  esc, ic: () => '', mdText: (t: string) => esc(t), raw: (h: string) => h, cap: cap2, planDate: () => '14 Nov',
  plural: (n: number, w: string) => `${n} ${n === 1 ? w : w === 'criterion' ? 'criteria' : w + 's'}`,
  pill: (t: string, k: string) => `<span class="pill ${k}">${t}</span>`, overline: (t: string, n: unknown) => `<div class="overline">${t} · ${n}</div>`,
  PRI: { must: 'Must' } as Record<string, string>, bpLabel: cap2, bpTrack: () => '<span class="pb"></span>',
  bpF: (x: { fields?: Record<string, unknown> }, k: string) => (x.fields || {})[k],
  bpLinks: (x: { links?: string[] }, rel: string, dir = 'out') => (x.links || []).filter((l) => (dir === 'out' ? l.startsWith(rel + ':') : l.startsWith(rel + '<'))).map((l) => l.slice(rel.length + 1)),
  bpItemArg: (p: string, k: string) => `${p}|${k}`, bpFiltStr: (f: Record<string, string>) => new URLSearchParams(f).toString(),
  bpTM: (k: string, t: string, meta: string, attrs: Record<string, string>) => ({ title: t, meta: `${k} · ${meta}`, attrs }),
  row: (r: { title: string; meta: string; trail?: string; attrs?: Record<string, string> }) => `<a class="lrow" data-bp="${r.attrs?.['data-bp']}"><b>${r.title}</b><i>${r.meta}</i>${r.trail || ''}</a>`,
  localStorage: { getItem: () => null },
};
const src = block('const BP_RETIRED = ', '/* Section bodies.');
const bpSummary = new Function(...Object.keys(stubs), `${src}\nreturn bpSummary;`)(...Object.values(stubs)) as (pid: string, L: unknown[], kind: string, dl: unknown, rl: unknown, team: string, go: (...a: string[]) => string) => string;
const go = (tab: string, team: string, status: string, filt: string) => `P|${tab}|${team}|${status}|${filt}`;
const it_ = (key: string, kind: string, status: string, extra: Record<string, unknown> = {}) => ({ key, kind, status, title: `Title of ${key}`, parent: null, fields: {}, links: [], created_at: 1, ...extra });
const list = (items: unknown[], total = items.length) => ({ items, total });

describe('console: the Requirements summary view', () => {
  const L = [it_('REC', 'module', 'active'), it_('FR-REC-01', 'fr', 'agreed', { parent: 'REC', fields: { priority: 'must' } }), it_('FR-REC-02', 'fr', 'verified', { parent: 'REC' }), it_('FR-REC-03', 'fr', 'built', { parent: 'REC' }),
    it_('Q-1', 'question', 'open', { parent: 'REC' }), it_('FR-GONE', 'fr', 'dropped', { parent: 'REC' })];
  const dl = list([{ ...it_('FR-REC-01', 'fr', 'agreed'), why: [{ code: 'you', text: 'Waiting on you', tone: 'warn' }] },
    { ...it_('Q-1', 'question', 'open', { fields: { asked_to: 'SH-2' } }), why: [{ code: 'asked', text: '16 days', tone: 'warn' }], blocks: ['FR-REC-01', 'FR-REC-03'], overdue: true }]);
  const rl = list([{ ...it_('FR-REC-03', 'fr', 'built'), why: [{ code: 'failing', text: '1 criterion failing', tone: 'bad' }] }]);
  const html = bpSummary('P', L, 'delivery', dl, rl, '', go);

  it('puts the counts first, each equal to its list, and links the two lists', () => {
    expect(html.indexOf('Waiting on a decision')).toBeLessThan(html.indexOf('By area'));
    expect(html).toContain('data-bpv="P|2|||sel=decide"');
    expect(html).toContain('data-bpv="P|2|||sel=risk"');
    expect(html).toMatch(/Waiting on a decision<\/span><span class="stat-v warn">2</);
    expect(html).toMatch(/At risk<\/span><span class="stat-v warn">1</);
    expect(html).toMatch(/Verified<\/span><span class="stat-v">1<small>of 3<\/small>/); // the dropped requirement is not counted
  });
  it('words each row from the hub: who it waits on, the question asker, what it blocks and Overdue', () => {
    expect(html).toContain('Waiting on you');
    expect(html).toContain('Asked of SH-2 · 16 days · Blocks 2 requirements');
    expect(html).toContain('<span class="pill warn">Overdue</span>');
    expect(html).toContain('1 criterion failing');
    for (const w of ['Overview', 'Proven', 'tested']) expect(html).not.toContain(w);
  });
  it('shows one fold per area, open when something needs attention, the settled rows behind one line, and no dropped rows', () => {
    expect(html).toContain('data-bp-fold="REC"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('3 need attention');
    expect(html).toContain('1 of 3 verified');
    expect(html).toContain('1 settled · Show');
    expect(html).toContain('Q-1 · Question · <span class="warn-t">16 days</span>');
    expect(html).not.toContain('FR-GONE');
  });
  it('leaves out a list with nothing in it, and a research project reads by line with Confirmed', () => {
    const none = bpSummary('P', L, 'delivery', list([]), list([]), '', go);
    expect(none).not.toContain('class="bp-more"');
    expect(none).not.toContain('<div class="overline">Waiting on a decision');
    const R = [it_('L1', 'line', 'active', { fields: { mode: 'validate', question: 'Does it sync?' } }), it_('H1', 'hypothesis', 'testing', { parent: 'L1' }), it_('H2', 'hypothesis', 'confirmed', { parent: 'L1' })];
    const r = bpSummary('P', R, 'research', list([]), list([]), '', go);
    expect(r).toContain('By research line');
    expect(r).toMatch(/Confirmed<\/span><span class="stat-v">1<small>of 2<\/small>/);
    expect(r).not.toContain('Verified');
    expect(r).toContain('1 of 2 decided');
  });
  it('opens on the summary only with no filter: no segment is pressed, and the folds are remembered per project', () => {
    expect(js).toContain("const sumMode = tab === '2' && !filtered;");
    expect(js).toContain("!sumOk && s === (f.sel || 'all')");
    expect(js).toContain("'bp-sum-fold:' + pid");
    expect(js).not.toContain('bp-ov-fold');
  });
});
