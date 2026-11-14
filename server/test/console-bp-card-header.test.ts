/**
 * Operator console, team page Blueprint card: its header is the plain section header the other cards use, "Blueprint · whole
 * project" with a small Open link, not a project row. The project name stays off it (the page already shows it); Open goes to the
 * same place the old row did, and the section rows below are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const i = js.indexOf('function bpCard(');
const card = js.slice(i, js.indexOf('\n}', i) + 2);
const head = card.slice(card.indexOf('const head = '), card.indexOf('// What waits for the operator'));

describe('console: the Blueprint card header', () => {
  it('is a section header (h4) with the scope and no project row, kind or name', () => {
    expect(head).toContain('<h4 class="bp-hd">Blueprint · ');
    expect(head).toContain("s.scope === 'part' ? \"this team's part\" : 'whole project'");
    expect(head).not.toContain('<b ');
    expect(head).not.toContain('cap(s.project.kind)');
    expect(head).not.toMatch(/>\$\{name\}</);
    expect(card).not.toContain('class="bp-hd"><span');
    expect(js).not.toContain('bp-hd-l');
    expect(css).not.toContain('bp-hd-l');
  });

  it('Open goes where the old row went: the research workspace or Foundation', () => {
    expect(head).toContain("data-bpv=\"${esc(to(s.measures?.kind === 'research' ? 'res' : '1'))}\"");
    expect(head).toContain('>Open</button>');
    expect(head).toContain('aria-label="Open the Blueprint of ${name}"');
  });

  it('Open keeps a 44 x 44 px target on phones while staying compact', () => {
    const at = css.indexOf('@media (max-width:767.98px){.sec h4.bp-hd{align-items:flex-start}.bp-hd .lnk{');
    expect(at).toBeGreaterThan(-1);
    const m = css.slice(at, css.indexOf('}}', at));
    // The header aligns to the top, so the heading and the Open text share a line although the button's extra height hangs below.
    expect(m).toContain('.sec h4.bp-hd{align-items:flex-start}');
    expect(m).toContain('min-height:var(--h-touch)');
    expect(m).toContain('padding:0 var(--s3)');
    expect(m).toContain('margin:calc((16px - var(--h-touch)) / 2) calc(-1 * var(--s3)) 0');
    // No negative bottom margin: the button's extra height must not reach into the first row below.
    expect(m.trimEnd().endsWith('var(--s3))')).toBe(false);
    expect(css).toContain('--h-touch:44px');
  });

  it('the section rows below keep their order', () => {
    expect(card).toContain("list([bpLine('Foundation', to('1'), ''), bpLine('Requirements'");
    expect(card).toContain('return `<section class="sec bp-card">${head}${wait}${body}</section>`;');
  });
});
