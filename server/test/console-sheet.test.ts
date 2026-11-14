/**
 * Operator console, the shared sheet (docs/design-guidelines.md, Overflow sheet): what openSheet() and the .sheet styles
 * promise every dialog. Content never widens a sheet, the centred dialog is not placed with a translate, and a popover
 * that holds a form or a document is the 360 px form popover, never the 260 px menu one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
/** Every declaration block whose selector list names exactly `sel` (at any media level). */
const rules = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(',').map((x) => x.trim()).includes(sel)).map((m) => m[2]!);

/* A small stand-in for the DOM: enough for openSheet to build, place and focus a sheet. */
class El {
  className = ''; attrs: Record<string, string> = {}; style: Record<string, string> = {}; innerHTML = ''; tabIndex = 0;
  constructor(public w = 0, public h = 0, public rect = { top: 0, bottom: 0, right: 0, left: 0 }) {}
  get classList() { const el = this; return { remove: (c: string) => { el.className = el.className.split(' ').filter((x) => x !== c).join(' '); }, contains: (c: string) => el.className.split(' ').includes(c) }; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getClientRects() { return this.w ? [this.rect] : []; }
  getBoundingClientRect() { return this.rect; }
  get offsetWidth() { return this.className.includes('form') ? 360 : 260; }
  get offsetHeight() { return this.h; }
  get scrollHeight() { return this.h; }
  addEventListener() {}
  focus() {}
  matches() { return false; }
}
function open(opts: { html: string; cls?: string; anchor?: El; desktop?: boolean; tall?: boolean }) {
  const body: El[] = [];
  const doc = { createElement: () => new El(0, opts.tall ? 2000 : 200), body: { append: (...e: El[]) => body.push(...e) }, activeElement: null };
  const src = `let SHEET = null; const FOCUSABLE = 'button';\nfunction closeSheet() {}\n${fn('openSheet')}\nreturn openSheet;`;
  const openSheet = new Function('document', 'matchMedia', 'innerHeight', 'innerWidth', 'esc', 'ic', '$$', src)(
    doc, () => ({ matches: opts.desktop !== false }), 900, 1440, (s: string) => s, () => '', () => []);
  const sh = openSheet({ title: 'T', html: opts.html, cls: opts.cls ?? '', anchor: opts.anchor }) as El;
  return { sh, scrim: body[0]! };
}
const anchor = () => new El(32, 32, { top: 100, bottom: 132, right: 1200, left: 1168 });

describe('console: the shared sheet', () => {
  it('lets nothing inside widen it: text wraps anywhere, meta lines wrap, media fit, code and tables scroll on their own', () => {
    expect(rules('.sheet')[0]).toContain('overflow-wrap:anywhere');
    expect(rules('.sheet')[0]).toContain('overflow:auto');
    expect(rules('.sheet .meta').join(';')).toContain('white-space:normal');
    expect(css).toMatch(/\.sheet :is\([^)]*img[^)]*\)\{max-width:100%\}/);
    expect(css).toMatch(/\.sheet :is\(pre,table\)\{display:block;max-width:100%;overflow-x:auto\}/);
  });

  it('centres the desktop dialog by margin, not with a translate that leaves text on half pixels', () => {
    const all = [...rules('.sheet'), ...rules('.sheet.pop')].join(';');
    expect(all).not.toMatch(/transform|translate/);
    expect(rules('.sheet').some((r) => r.includes('inset:0;margin:auto;height:fit-content'))).toBe(true);
    expect(rules('.sheet.pop').join(';')).toContain('margin:0');
  });

  it('makes a popover that holds a form or a document the 360 px form popover; a menu stays the 260 px one', () => {
    expect(css).toContain('.sheet.pop.form{width:360px;padding:var(--s4)}');
    const paper = open({ html: '<div class="sheet-form mu-item"><b>Paper</b></div>', anchor: anchor() });
    expect(paper.sh.className.split(' ')).toEqual(['sheet', 'pop', 'form']);
    expect(paper.sh.style.left).toBe(`${1200 - 360}px`);
    expect(paper.sh.style.top).toBe('140px');
    expect(paper.scrim.className).toBe('scrim pop');
    const menu = open({ html: '<button class="sheet-item">Edit</button>', anchor: anchor() });
    expect(menu.sh.className).toBe('sheet pop');
    // fbSheet already passes form: it is not added twice.
    expect(open({ html: '<div class="sheet-form">x</div>', cls: 'form wide', anchor: anchor() }).sh.className).toBe('sheet pop form wide');
  });

  it('is wide enough to read: a document opens as the 640 px dialog, never a popover, and a form dialog is 560 px', () => {
    expect(css).toContain('.sheet.form:not(.pop):not(.wide){width:min(560px,calc(100vw - 2 * var(--gutter)))}');
    expect(css).toContain('.sheet.wide{width:min(640px,calc(100vw - 2 * var(--gutter)))}');
    const paper = open({ html: '<div class="sheet-form mu-item"><b>Paper</b><div class="md prose"><p>Body</p></div></div>', anchor: anchor() });
    expect(paper.sh.className).toBe('sheet form wide');
    expect(paper.scrim.className).toBe('scrim');
    expect(paper.sh.style.left).toBeUndefined();
    expect(open({ html: '<div class="md prose">x</div>', cls: 'wide' }).sh.className).toBe('sheet wide');
  });

  it('opens whole: a popover too tall for the room beside its button, or one on a phone, is the centred dialog or bottom sheet', () => {
    const tall = open({ html: '<div class="sheet-form">long paper</div>', anchor: anchor(), tall: true });
    expect(tall.sh.className).toBe('sheet form');
    expect(tall.scrim.className).toBe('scrim');
    expect(tall.sh.style.left).toBeUndefined();
    const phone = open({ html: '<div class="sheet-form">x</div>', anchor: anchor(), desktop: false });
    expect(phone.sh.className).toBe('sheet form');
    expect(phone.sh.attrs['aria-modal']).toBe('true');
  });
});
