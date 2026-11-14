/**
 * The workspace tab bars (docs/design-guidelines.md, Workspace tab bar): one row at every width. Security's tabs never wrap
 * (they scroll sideways when they do not fit) and "Agent access", an action and not a tab, is a small button at the right end
 * of the same row, apart from the tabs. On a phone it stays the last tab.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pub = (f: string) => readFileSync(join(process.cwd(), 'public', f), 'utf8').replace(/\r\n/g, '\n');
const html = pub('index.html'), css = pub('style.css');
const bar = html.slice(html.indexOf('id="securityBar"'), html.indexOf('id="vaultBar"'));

describe('Security tab bar', () => {
  it('the desktop tabs no longer hold Agent access, which is a small button beside them in the same row', () => {
    const seg = bar.slice(bar.indexOf('<nav class="seg ws-tabs'), bar.indexOf('</nav>'));
    expect(seg).not.toContain('data-go="grant"');
    for (const g of ['keys', 'pcs', 'hardware', 'users', 'req', 'shares', 'reset']) expect(seg, g).toContain(`data-go="${g}"`);
    const row = bar.slice(bar.indexOf('<div class="ws-row only-d">'), bar.indexOf('</div>'));
    expect(row).toContain('<nav class="seg ws-tabs');
    expect(row).toMatch(/<button type="button" class="btn sm ws-grant" data-go="grant">/);
  });
  it('the phone tabs still list Agent access as the tab before Reset', () => {
    const m = bar.slice(bar.indexOf('<nav class="tabs only-m"'));
    expect(m.indexOf('data-go="grant"')).toBeGreaterThan(-1);
    expect(m.indexOf('data-go="grant"')).toBeLessThan(m.indexOf('data-go="reset"'));
  });
  it('a workspace tab bar is one row: the tabs never wrap and scroll sideways instead', () => {
    expect(css).toContain('.ws-tabs{flex-wrap:nowrap;overflow-x:auto;max-width:100%;min-width:0;scrollbar-width:none}');
    expect(css).not.toMatch(/\.ws-tabs\{flex-wrap:wrap\}/);
    expect(css).toContain('.ws-tabs button{flex:none}');
    // The strip clips what is outside it, so the focus ring sits inside the button.
    expect(css).toContain('.ws-tabs button:focus-visible{outline-offset:-2px}');
    expect(css).toContain('.ws-row{display:flex;align-items:center;gap:var(--s3);flex:1 1 420px;min-width:0}');
    expect(css).toContain('.ws-grant{flex:none;margin-left:auto}');
  });
});
