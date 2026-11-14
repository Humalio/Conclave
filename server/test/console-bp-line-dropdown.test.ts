/**
 * Operator console, Blueprint Questions (docs/blueprint.md §9): the research line is one dropdown on the right of the status
 * row, not a second row of buttons. The route keeps `l=<line>`, so links, reload and Back keep the choice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const q = js.slice(js.indexOf('async function bpQuestions('), js.indexOf('const where = (r) =>'));

describe('console: the Questions line dropdown', () => {
  it('has no second row of line buttons any more', () => {
    expect(q).not.toContain('lchips');
    expect(q).not.toContain("seg('Line'");
  });
  it('is one labelled select after the status row, naming the line on its button and every line with its count', () => {
    expect(q).toContain('<select data-bp-line aria-label="Line">');
    expect(q).toContain("`Line: ${lcur === '' ? 'All' : lcur === 'project' ? 'Project' : lcur}`");
    expect(q).toContain("'All lines'");
    expect(q).toContain("'Project level'");
    expect(q).toContain('title="${esc(full)}"'); // a long title is cut in the menu, whole on hover
    expect(q).toContain("'l=' + k"); // the route keeps l=<line>
    expect(q.indexOf("seg('Status', chips)")).toBeLessThan(q.indexOf('${lsel}'));
  });
  it('changing it opens the route in the option value', () => {
    expect(js).toContain("$$('[data-bp-line]').forEach((s) => (s.onchange = (e) => openD('blueprint', e.target.value, true)));");
  });
  it('sits on the right, and wraps under the status row on phones', () => {
    expect(css).toContain('.bp-lsel{position:relative;margin-left:auto;');
    expect(css).toContain('.bp-qtb .bp-br{display:block;flex:0 0 100%;height:0}');
  });
});
