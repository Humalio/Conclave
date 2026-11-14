/**
 * The console's plain-reading marks (docs/proposals/blueprint-readability.md §5.2, addendum E3): public/app.js marks the codes the
 * server found with nodes built by textContent, never HTML from agent text, and never inside links, code, buttons or the Records
 * fold; agent ids read as names; and the client's slug for a term key equals the server's slugCode (src/blueprint/plain.ts).
 * The block between the plain-marks markers is loaded in vm with a small DOM that refuses innerHTML.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { slugCode } from '../src/blueprint/plain.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const block = js.slice(js.indexOf('/* plain-marks:start'), js.indexOf('/* plain-marks:end */'));

// ───── a DOM just big enough for the marks: text nodes, elements, attributes, a few selectors ─────
class Node_ {
  childNodes: Node_[] = [];
  parentNode: El | null = null;
  constructor(public nodeType: number, public ownerDocument: Doc) {}
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
}
class Text_ extends Node_ {
  constructor(public nodeValue: string, doc: Doc) { super(3, doc); }
  override get textContent() { return this.nodeValue; }
}
class El extends Node_ {
  attrs = new Map<string, string>();
  constructor(public tagName: string, doc: Doc) { super(1, doc); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', v); }
  get classList() { const c = this.className.split(/\s+/).filter(Boolean); return { contains: (k: string) => c.includes(k) }; }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  override get textContent() { return super.textContent; }
  override set textContent(v: string) { this.childNodes = []; this.append(new Text_(String(v), this.ownerDocument)); }
  set innerHTML(_v: string) { throw new Error('innerHTML must not be used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML must not be used'); }
  append(...xs: (Node_ | string)[]) { for (const x of xs) { const n = typeof x === 'string' ? new Text_(x, this.ownerDocument) : x; n.parentNode?.removeChild(n); n.parentNode = this; this.childNodes.push(n); } }
  insertBefore(n: Node_, ref: Node_) { n.parentNode?.removeChild(n); const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); n.parentNode = this; return n; }
  removeChild(n: Node_) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  get children(): El[] { return this.childNodes.filter((c): c is El => c instanceof El); }
  private simple(s: string) { return s.startsWith('.') ? this.classList.contains(s.slice(1)) : this.tagName === s.toUpperCase(); }
  matches(sel: string): boolean {
    return sel.split(',').some((part) => {
      const steps = part.trim().split(/\s+/);
      if (!this.simple(steps[steps.length - 1]!)) return false;
      let at: El | null = this.parentNode;
      for (let i = steps.length - 2; i >= 0; i--) { while (at && !at.simple(steps[i]!)) at = at.parentNode; if (!at) return false; at = at.parentNode; }
      return true;
    });
  }
  closest(sel: string): El | null { let e: El | null = this; while (e) { if (e.matches(sel)) return e; e = e.parentNode; } return null; }
  querySelectorAll(sel: string): El[] { const out: El[] = []; const walk = (e: El) => { for (const c of e.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
}
class Doc {
  createElement(t: string) { return new El(t.toUpperCase(), this); }
  createTextNode(s: string) { return new Text_(s, this); }
}
const doc = new Doc();
type Kid = El | string;
const h = (tag: string, cls: string, ...kids: Kid[]) => { const e = doc.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };
const marks = (root: El, cls: string) => root.querySelectorAll('.' + cls);

const ctx = vm.createContext({});
const api = vm.runInContext(`${block}\n;({ bpSlug, bpMarkCodes, bpMarkAgents })`, ctx) as {
  bpSlug: (t: string) => string;
  bpMarkCodes: (root: El, codes: { token: string; term: { key: string; title: string; definition: string } | null }[], pid: string) => void;
  bpMarkAgents: (root: El, label: (id: string) => string | null) => void;
};
const P25 = { key: 'G-p25', title: 'P25', definition: 'The second prototype board.' };

describe('console plain marks', () => {
  it('finds the block it tests', () => {
    expect(block).toContain('function bpMarkCodes');
    expect(block).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('builds marks with textContent: agent text never becomes HTML', () => {
    const evil = { key: 'G-p25', title: '<b onmouseover=x>P25</b>', definition: '<img src=x onerror=alert(1)>' };
    const root = h('div', '', h('h3', 'bp-ih-t', 'P25 against A17 <script>alert(1)</script>'));
    api.bpMarkCodes(root, [{ token: 'P25', term: evil }, { token: 'A17', term: null }], 'prj_1');
    const t = root.querySelector('.bp-ih-t')!;
    expect(t.textContent.startsWith('P25')).toBe(true);
    expect(t.textContent).toContain(' against ');
    expect(t.textContent).toContain('<script>alert(1)</script>'); // still text, nothing parsed
    const gl = marks(root, 'gl');
    expect(gl).toHaveLength(1);
    expect(gl[0]!.tagName).toBe('BUTTON');
    expect(gl[0]!.getAttribute('type')).toBe('button');
    expect(gl[0]!.getAttribute('data-gl')).toBe('prj_1|G-p25');
    const tip = gl[0]!.querySelector('.info-tip')!;
    expect(tip.querySelector('b')!.textContent).toBe(evil.title);
    expect(tip.querySelector('b')!.children).toHaveLength(0); // the title is one text node, not markup
    expect(tip.querySelector('span')!.textContent).toBe(evil.definition);
    expect(root.querySelectorAll('img, script')).toHaveLength(0);
    const un = marks(root, 'undef');
    expect(un).toHaveLength(1);
    expect(un[0]!.tagName).toBe('SPAN');
    expect(un[0]!.getAttribute('tabindex')).toBe('0');
    expect(un[0]!.getAttribute('data-info')).toBe('A17 is not in the glossary. Define it here, or ask the team to say it in words.');
    expect(un[0]!.childNodes[0]!.textContent).toBe('A17');
  });

  it('does not mark inside links, code, pre, buttons or the Records fold, nor a token inside a longer one', () => {
    const root = h('div', '',
      h('div', 'md prose bp-sum',
        h('p', '', 'P25 leads; ', h('a', '', 'P25 link'), ' ', h('code', '', 'P25'), ' P250 and xP25 stay; FR-P25 too.'),
        h('pre', '', h('code', '', 'P25 in a block')),
        h('details', 'task-brief bp-rec', h('div', 'md prose', 'P25 in the records'))),
      h('button', 'lrow', h('span', 'bp-ih-t', 'P25 in a row button')),
      h('a', '', h('dl', 'bp-gwt', h('dd', '', 'P25 in a link'))));
    api.bpMarkCodes(root, [{ token: 'P25', term: P25 }], 'prj_1');
    const gl = marks(root, 'gl');
    expect(gl).toHaveLength(1); // only the first "P25 leads"
    expect(gl[0]!.parentNode!.tagName).toBe('P');
    expect(root.querySelector('a')!.textContent).toBe('P25 link');
    expect(root.querySelector('.bp-rec')!.querySelectorAll('.ref')).toHaveLength(0);
    expect(root.querySelector('.lrow')!.querySelectorAll('.ref')).toHaveLength(0);
    expect(root.querySelector('.bp-gwt')!.querySelectorAll('.ref')).toHaveLength(0);
    const p = root.querySelector('p')!;
    expect(p.childNodes[0]).toBe(gl[0]);
    expect(p.childNodes[1]!.textContent).toBe(' leads; ');
    expect(p.childNodes.slice(2).map((n) => n.textContent).join('')).toBe('P25 link P25 P250 and xP25 stay; FR-P25 too.');
  });

  it('marks given, when and then, codes with a prime or underscore, and leaves a mark it made alone on a second run', () => {
    const root = h('div', '', h('dl', 'bp-gwt', h('dd', '', 'T′ rises when H_oa is set.')));
    const codes = [{ token: 'T′', term: null }, { token: 'H_oa', term: null }];
    api.bpMarkCodes(root, codes, 'prj_1');
    api.bpMarkCodes(root, codes, 'prj_1');
    expect(marks(root, 'undef').map((m) => m.childNodes[0]!.textContent)).toEqual(['T′', 'H_oa']);
  });

  it('shows agent ids as names linked to the agent, and leaves unknown ids and code alone', () => {
    const root = h('div', '', h('div', 'md prose bp-sum', h('p', '', 'Run by agent-abcd1234 and agent-zzzz9999. ', h('code', '', 'agent-abcd1234'))));
    api.bpMarkAgents(root, (id) => (id === 'agent-abcd1234' ? 'Lead <i>' : null));
    const a = root.querySelectorAll('a');
    expect(a).toHaveLength(1);
    expect(a[0]!.textContent).toBe('Lead <i>');
    expect(a[0]!.children).toHaveLength(0);
    expect(a[0]!.getAttribute('data-ses')).toBe('agent-abcd1234');
    expect(root.textContent).toBe('Run by Lead <i> and agent-zzzz9999. agent-abcd1234');
  });

  it('makes the same term key as the server', () => {
    const cases = ['T′', "T'", 'T’', 'H_oa', 'CF-28', 'P25', 'S2m', 'B1i', '  A17 ', 'x--y'];
    expect(api.bpSlug('T′')).toBe('t-prime');
    expect(api.bpSlug("T'")).toBe('t-prime');
    expect(api.bpSlug('H_oa')).toBe('h-oa');
    expect(api.bpSlug('CF-28')).toBe('cf-28');
    for (const c of cases) expect(api.bpSlug(c)).toBe(slugCode(c));
  });
});
