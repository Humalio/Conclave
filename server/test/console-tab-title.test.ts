/**
 * A view title that only repeats the selected section tab is hidden visually, its count moves onto the tab, and the tabs are never
 * cut off (docs/design-guidelines.md, Workspace tab bar). tabTitle runs from app.js in vm against a small stand-in DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const doc = readFileSync(join(process.cwd(), '..', 'docs', 'design-guidelines.md'), 'utf8');
const stmt = (start: string, end: string) => { const a = js.indexOf(start), b = js.indexOf(end, a); if (a < 0 || b < 0) throw new Error('missing ' + start); return js.slice(a, b); };

/* Stand-in elements: text parts with a class, a class list, children by selector. Enough for tabLabel, tabTitle and the count marks. */
type Part = { cls: string; text: string };
class El {
  classes = new Set<string>(); hidden = false; dataset: Record<string, string> = {}; parts: Part[]; className = '';
  constructor(parts: Part[] = [], public kids: El[] = []) { this.parts = parts; }
  get classList() { const s = this.classes; return { toggle: (c: string, on: boolean) => (on ? s.add(c) : s.delete(c)), contains: (c: string) => s.has(c) }; }
  get textContent() { return this.parts.map((p) => p.text).join(''); }
  set textContent(v: string) { this.parts = [{ cls: '', text: v }]; }
  get children() { return this.kids; }
  cloneNode() { const c = new El(this.parts.map((p) => ({ ...p }))); c.querySelectorAll = (sel: string) => { const drop = sel.split(',').map((s) => s.replace(/^\./, '')); return c.parts.filter((p) => drop.includes(p.cls)).map((p) => ({ remove: () => { c.parts = c.parts.filter((q) => q !== p); } })); }; return c; }
  querySelectorAll(_: string): any[] { return []; }
  querySelector(_: string): any { return null; }
  append(m: El) { this.marks.push(m); this.parts.push(m.parts[0] || { cls: 'tabn', text: '' }); m.parts = [this.parts[this.parts.length - 1]]; }
  marks: El[] = [];
}
const T = (text: string, n?: string) => new El([{ cls: 'svg', text: '' }, { cls: '', text }, ...(n ? [{ cls: 'n', text: ` ${n}` }] : [])]);

function setup(title: El, tab: El, opts: { trail?: boolean; actions?: boolean } = {}) {
  const trail = new El(); trail.hidden = !opts.trail;
  const acts = new El([], opts.actions ? [new El()] : []);
  const card = new El(); const bar = new El();
  const nEl = title.parts.find((p) => p.cls === 'n');
  const nNode = nEl ? { get textContent() { return nEl.text; } } : null;
  const ids: Record<string, any> = { '#dT': title, '#viewHeader': new El(), '#workspaceView': card, '#dTrail': trail, '#dA': acts };
  const ctx: Record<string, any> = {
    $: (q: string, r?: any) => (r === card ? bar : r === title ? nNode : ids[q]),
    $$: (q: string, r?: any) => (r === bar ? [tab] : q === '[data-tab-n]' ? [] : []),
    document: { createElement: () => new El([{ cls: 'tabn', text: '' }]) },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(stmt('let tabCountSync', '/* The area a screen') + '\nthis.tabTitle = tabTitle;', ctx);
  ctx.tabTitle();
  return { head: ids['#viewHeader'] as El };
}

describe('a title that repeats the selected tab', () => {
  it('is hidden visually and its count shows on the tab', () => {
    const title = T('Keys ', '112'), tab = T('Keys');
    const { head } = setup(title, tab);
    expect(title.classes.has('sr')).toBe(true);
    expect(head.classes.has('bare')).toBe(true);
    expect(tab.marks.map((m) => m.textContent)).toEqual(['112']);
  });
  it('keeps the header when a trail or actions share it', () => {
    const title = T('Calls'), { head } = setup(title, T('Calls'), { trail: true });
    expect(title.classes.has('sr')).toBe(true);
    expect(head.classes.has('bare')).toBe(false);
  });
  it('stays when it says something else (a breadcrumb, a detail page)', () => {
    const title = T('Vault root'), tab = T('Contents');
    const { head } = setup(title, tab);
    expect(title.classes.has('sr')).toBe(false);
    expect(head.classes.has('bare')).toBe(false);
    expect(tab.marks).toEqual([]);
  });
  it('runs whenever navOn sets the selected tab, and focus still goes to the title', () => {
    expect(stmt('function navOn(', '\nfunction go(')).toContain('tabTitle();');
    expect(js).toContain("$('#dT').focus({ preventScroll: true });");
  });
});

describe('the tab row fits', () => {
  it('collapses a bare header for screen readers only, and the bar takes its divider', () => {
    expect(css).toContain('#workspaceView>.dh.bare{position:absolute;width:1px;height:1px;');
    expect(css).toContain('#workspaceView>.workspace-bar:has(+.dh.bare){padding-bottom:var(--s3);border-bottom:1px solid var(--line)}');
  });
  it('wraps Agent access under the tabs before they scroll, and drops tab icons from 768 to 1180 px', () => {
    expect(css).toContain('#workspaceView>.workspace-bar>.ws-row{flex-wrap:wrap}');
    expect(css).toContain('@media (min-width:768px) and (max-width:1179.98px){\n  #workspaceView>.workspace-bar .ws-tabs button>svg{display:none}\n}');
  });
  it('keeps the phone title focusable (hidden visually, not removed)', () => {
    expect(css).not.toContain('#workspaceView>.workspace-bar+.dh{display:none}');
  });
  it('is described in the design guidelines', () => {
    expect(doc).toContain('A title that only repeats the selected tab');
  });
});
