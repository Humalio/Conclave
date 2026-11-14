/**
 * Empty states (design-guidelines.md, Empty state): by default one compact row (a 16 px icon, the line, any action) left-aligned
 * with its list; only a whole view with nothing at all uses the centred 160 px .empty.lg. The per-place height overrides are gone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const rule = (sel: string) => { const m = css.match(new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')); return m ? m[2] : null; };

describe('the default empty state', () => {
  it('is one compact left-aligned row that wraps', () => {
    const r = rule('.empty')!;
    expect(r).toContain('display:flex');
    expect(r).toContain('flex-wrap:wrap');
    expect(r).toContain('align-items:center');
    expect(r).toContain('min-height:44px');
    expect(r).toContain('text-align:left');
    expect(r).not.toContain('flex-direction:column');
    expect(r).not.toContain('160px');
    expect(rule('.empty svg')).toContain('width:var(--icon);height:var(--icon)');
    expect(rule('.empty>span')).toContain('overflow-wrap:anywhere');
  });
  it('keeps actions on the row; only a large one puts them under the line', () => {
    expect(rule('.empty.lg [data-clear-q]')).toContain('margin-top');
    expect(rule('.empty.lg .empty-act')).toContain('margin-top');
    expect(rule('.empty [data-clear-q]')).toBeNull();
    expect(rule('.empty .empty-act')).toBeNull();
  });
  it('drops the per-place height overrides', () => {
    for (const s of ['.empty.sm', '.sec .empty', '.mu-needs .empty']) expect(rule(s)).toBeNull();
    expect(js).not.toContain('class="empty sm"');
  });
});

describe('the large empty state', () => {
  it('is centred in 160 px with a 24 px icon', () => {
    const r = rule('.empty.lg')!;
    expect(r).toContain('flex-direction:column');
    expect(r).toContain('min-height:160px');
    expect(r).toContain('text-align:center');
    expect(rule('.empty.lg svg')).toContain('width:24px');
  });
  it('is used for a hub with no teams at all', () => {
    expect(js).toContain(`<div class="empty lg">\${ic('team')}<span>No teams yet</span></div>`);
  });
  it('is the only kind marked large in the list helpers', () => {
    expect(js).toMatch(/const none = \(icon, label, ok, act = ''\) => `<div class="empty\$\{ok \? ' ok' : ''\}">/);
  });
});
