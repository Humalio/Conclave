/**
 * Operator console: each Lockdown list carries "2 of 8" in its overline (docs/dashboard-ux.md, Lock an agent, PC or team).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

describe('console: Lockdown list overlines', () => {
  it('puts the count in each list\'s overline and updates it as the search filters', () => {
    expect(js).toContain("${listOverline([title, items.length ? lovN(items.length, items.length) : '0', ids.length ? `${ids.length} locked` : ''])}");
    expect(js).toContain("cnt = $('.lov-n', card);");
    expect(js).toContain('if (cnt) cnt.innerHTML = `<b>${n}</b> of ${rows.length}`;');
  });
});
