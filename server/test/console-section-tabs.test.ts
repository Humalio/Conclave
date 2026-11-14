/**
 * In Work, Security, Vault and Log the section's tab bar is the view card's first row (docs/design-guidelines.md, Workspace tab bar):
 * placeBars moves the shown bar into #workspaceView, openD moves the view's leading .vtools to the bar's right end (.ws-tools), and the
 * header below keeps only the title or breadcrumb. sectionBar and placeBars run from app.js in vm against a small stand-in DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const doc = readFileSync(join(process.cwd(), '..', 'docs', 'design-guidelines.md'), 'utf8');
const stmt = (start: string, end: string) => { const a = js.indexOf(start), b = js.indexOf(end, a); if (a < 0 || b < 0) throw new Error('missing ' + start); return js.slice(a, b); };

/* A stand-in node: a parent, a hidden flag and the three moves placeBars uses. */
class Node {
  parentElement: Node | null = null; kids: Node[] = []; hidden = false;
  constructor(public id: string) {}
  private detach() { const p = this.parentElement; if (p) p.kids.splice(p.kids.indexOf(this), 1); }
  prepend(n: Node) { n.detach(); n.parentElement = this; this.kids.unshift(n); }
  before(n: Node) { const p = this.parentElement!; n.detach(); n.parentElement = p; p.kids.splice(p.kids.indexOf(this), 0, n); }
}
const main = new Node('main'), card = new Node('#workspaceView'), ctxBar = new Node('#ctxBar');
const bars = ['#agentsBar', '#securityBar', '#vaultBar', '#auditBar'].map((id) => new Node(id));
for (const n of [...bars, ctxBar, card]) { n.parentElement = main; main.kids.push(n); }
const byId: Record<string, Node> = Object.fromEntries([card, ctxBar, ...bars].map((n) => [n.id, n]));

const ctx: Record<string, any> = { $: (q: string) => byId[q], $$: () => [], ADM_NAV: [] };
vm.createContext(ctx);
vm.runInContext(stmt('const SECTION_BARS', 'const AREA_TITLE') + '\nthis.sectionBar = sectionBar; this.placeBars = placeBars; this.SECTION_BARS = SECTION_BARS;', ctx);
const show = (id: string | null, open: boolean) => { for (const b of bars) b.hidden = b.id !== id; card.hidden = !open; ctx.placeBars(); };

describe('section tab bar placement', () => {
  it('names the bar for each area, and none inside a team', () => {
    expect(ctx.sectionBar('keys')?.id).toBe('#securityBar');
    expect(ctx.sectionBar('sessions')?.id).toBe('#agentsBar');
    expect(ctx.sectionBar('knowledge')?.id).toBe('#vaultBar');
    expect(ctx.sectionBar('log')?.id).toBe('#auditBar');
    expect(ctx.sectionBar('team')).toBeNull();
    expect(ctx.sectionBar('task')).toBeNull();
  });
  it('puts the shown bar first in the view card', () => {
    show('#vaultBar', true);
    expect(card.kids[0].id).toBe('#vaultBar');
    expect(bars.filter((b) => b.parentElement === card).map((b) => b.id)).toEqual(['#vaultBar']);
  });
  it('moves the bar back above the page when the section changes or the card closes (Home)', () => {
    show('#securityBar', true);
    expect(card.kids[0].id).toBe('#securityBar');
    expect(byId['#vaultBar'].parentElement).toBe(main);
    show('#agentsBar', false);
    expect(byId['#agentsBar'].parentElement).toBe(main);
    expect(main.kids.indexOf(byId['#agentsBar'])).toBeLessThan(main.kids.indexOf(ctxBar));
    expect(card.kids).toEqual([]);
  });
  it('is called whenever navOn shows or hides the bars', () => {
    expect(stmt('function navOn(', '\n}\n')).toContain('placeBars();');
  });
});

describe('view filters and actions in the bar', () => {
  it('moves the view leading toolbar into the bar, before the actions', () => {
    expect(stmt('const sbar = r.bar', 'const workspace = ')).toContain("const tools = sbar && $('#dB > .vtools:first-child');");
    expect(js).toContain("slot.className = 'ws-tools'");
    expect(js).toContain('if (act) act.before(slot); else sbar.append(slot);');
    expect(js).toContain("const clearBarActions = () => $$('.ws-act,.ws-tools').forEach((x) => x.remove());");
  });
  it('keeps the header for the title or breadcrumb under a section bar', () => {
    expect(js).toContain("$('#viewHeader').hidden = !!r.bar;");
  });
  it('lays the row out: tools at the right end, wrapping under the tabs; on phones on a full line', () => {
    expect(css).toContain('#workspaceView>.workspace-bar>.ws-tools{display:flex;justify-content:flex-end;flex:1 1 auto;min-width:0;margin-left:auto}');
    expect(css).toContain('#workspaceView>.workspace-bar>.ws-tools{flex:1 1 100%;margin-left:0}');
  });
  it('keeps the filters on phones when the detail app bar replaces the tabs', () => {
    expect(css).toContain('body.has-dbar #workspaceView>.workspace-bar:not([hidden]):has(>.ws-tools){display:flex}');
    expect(css).toContain('body.has-dbar #workspaceView>.workspace-bar>:not(.ws-tools){display:none}');
  });
  it('is described in the design guidelines', () => {
    expect(doc).toContain('the bar is the **first row of the view card**');
  });
});
