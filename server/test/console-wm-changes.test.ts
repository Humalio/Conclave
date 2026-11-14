/**
 * Operator console, Home Work in motion: "n changes" sits on the right of a row, before the time ("3 changes · 3m"), so the
 * description starts the second line on every row. One change shows no count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const at = js.indexOf("const what = many");
const row = js.slice(at, js.indexOf("</div></div></div>';", at));

describe('console: Work in motion rows', () => {
  it('the description is first on the second line; the count is not before it', () => {
    expect(row).toContain("const what = many\n    ? '<span class=\"wm-what\"");
    expect(row).not.toContain("'<span class=\"wm-n\">' + g.length + ' changes</span><span class=\"wm-what\"");
  });

  it('the count only shows for several changes and comes right before the time', () => {
    expect(row).toContain("const n = many ? '<span class=\"wm-n\">' + g.length + ' changes</span>' : '';");
    expect(row).toContain("+ n + '<span class=\"wm-ago\"");
  });

  it('the count is plain text on the right with a dot, and stays on phones with the time', () => {
    expect(css).toContain('.wm-n{flex:none;margin-left:auto}');
    expect(css).toContain('.wm-n::after{content:"·"');
    expect(css).toContain('.wm-n+.wm-ago{margin-left:0}');
    expect(css).not.toContain('.wm-n+.wm-what');
  });
});
