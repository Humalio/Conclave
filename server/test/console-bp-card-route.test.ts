/**
 * Operator console: a row on the team page's Blueprint card opens the Blueprint on the project's own route. With the whole project
 * as the scope there is no team part (so the trail and the screen are the ones the project's Blueprint gives), and Back returns to
 * the team page through the screen's origin. Only "this team's part" names the team: the scope filter on that same screen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const i = js.indexOf('function bpCard(');
const card = js.slice(i, js.indexOf('\n}', i) + 2);

describe('console: the Blueprint card routes', () => {
  it('names the team in a link only when the card shows the team\'s part', () => {
    expect(card).toContain("tm = s.scope === 'part' ? id : ''");
    expect(card).toContain('to = (tab) => bpArg(pid, tab, tm)');
    expect(card).toContain("bpArg(pid, tab, tm, '', bpFiltStr({ kind, sel }))");
    expect(card).toContain("bpArg(pid, 'mtg', tm)");
    expect(card).toContain("bpArg(pid, 'dropped', tm)");
  });

  it('builds no link with the team id as its third part', () => {
    expect(card).not.toMatch(/bpArg\([^)]*,\s*id[,)]/);
    expect(card).not.toMatch(/\bto\([^)]*\)[^;]*\bid\b\)/);
  });
});
