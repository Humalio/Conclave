import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const css = readFileSync(join(__dirname, '../public/style.css'), 'utf8');

describe('Home Backlog card tag row and the tag list screens', () => {
  it('shows All plus at most 7 tags by display name, in one row', () => {
    expect(js).toContain('const top = card ? tags.slice(0, 7) : tags;');
    expect(js).toContain("chip('', card ? 'All' : 'All tags')");
    expect(js).toContain("chip(g.tag, g.name || '#' + g.tag, g.n)");
    expect(js).toContain("tagChips('home', S.bl?.tags || [], tag, true)");
  });
  it('gives the card chips the 3 px chip corners, not the button corners', () => {
    expect(css).toMatch(/\.tk-tagf\.tg-card \.btn\{border-radius:var\(--r-chip\)\}/);
    expect(css).toMatch(/--r-chip:3px/);
  });
  it('picks the tag in the Backlog Filters sheet and edits the list in Project settings', () => {
    expect(js).toContain("selField('blTag', 'Tag'");
    expect(js).toContain("id=\"twTags\"");
    expect(js).toContain('/preview');
    expect(js).toContain("'PUT', body");
  });
});

describe('the tag map sheet', () => {
  it('drops a mapping whose target row was removed or renamed', () => {
    expect(js).toContain('if (!L.some((x) => x.tag === map[k])) delete map[k];');
    expect(js).toContain('const key = () => { prune();');
  });
});
