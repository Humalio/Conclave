/**
 * Operator console, a team's tasks (docs/dashboard-ux.md, Tags and the team's task list): one toolbar row (the search box with
 * the tag as a chip, then Filters with Tag) over the status tabs. The search reads the title and the brief across the whole
 * loaded board, done tasks past the Done cap and hidden ones included, and lives in the route after the tag.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const view = (() => { const i = js.indexOf('VIEWS.tasks = async'); return js.slice(i, js.indexOf('\n};\n', i)); })();
type K = { id: string; title: string; description?: string | null; status: string; awaiting_approval?: boolean; updated_at: number; dismissed_at?: number | null; tags?: string[] };
type G = { key: string; L: K[]; shown: K[]; capped: boolean; hiddenN: number };
const lib = new Function(`${line('const tkArg = ')}\n${line('const tkDec = ')}\n${line('const tkMatch = ')}\n${line('const BOARD_COLS = ')}\n${line('const DONE_CAP = ')}\n${fn('function taskGroups(')}\nreturn { tkArg, tkDec, tkMatch, taskGroups };`)() as
  { tkArg: (t: string, s: string, g: string, q: string) => string; tkDec: (h: string) => string; tkMatch: (k: K, q: string) => boolean; taskGroups: (t: { board: K[] }, id: string, every?: boolean) => G[] };
const ok = new Function(`const RID = /^[a-z]+_[A-Za-z0-9_-]+$/;\nreturn ${line('  tasks: (a) => ').trim().replace(/^tasks: /, '').replace(/,$/, '')};`)() as (a: string) => boolean;

describe('console: a team\'s tasks toolbar', () => {
  it('keeps the tag and the search in the route, encoded, and leaves out empty parts at the end', () => {
    expect(lib.tkArg('team_a', 'done', '', '')).toBe('team_a|done');
    expect(lib.tkArg('team_a', '', 'docs', '')).toBe('team_a||docs');
    const a = lib.tkArg('team_a', 'all', '', 'relay | keys & 50%');
    expect(a).toBe('team_a|all||relay%20%7C%20keys%20%26%2050%25');
    expect(lib.tkDec(a.split('|')[3])).toBe('relay | keys & 50%');
    expect(lib.tkDec('%E0%A4%A')).toBe('');
    for (const good of ['team_a', 'team_a|done', 'team_a|done|docs', a]) expect(ok(good), good).toBe(true);
    for (const bad of ['team_a|Done', 'team_a|done|docs|x|y', 'team_a|done|docs|a&b', `team_a|||${'x'.repeat(601)}`]) expect(ok(bad), bad).toBe(false);
  });

  it('the search reads the title and the brief, every word, in any case', () => {
    const k: K = { id: 'k1', title: 'Fix the relay', description: 'The **keys** rotate weekly.', status: 'done', updated_at: 1 };
    expect(lib.tkMatch(k, 'relay')).toBe(true);
    expect(lib.tkMatch(k, 'KEYS weekly')).toBe(true);
    expect(lib.tkMatch(k, 'keys monthly')).toBe(false);
    expect(lib.tkMatch({ ...k, description: null }, 'keys')).toBe(false);
  });

  it('a search shows every match: done tasks past the Done cap and hidden ones too', () => {
    const board: K[] = Array.from({ length: 12 }, (_, i) => ({ id: 'k' + i, title: 't' + i, status: 'done', updated_at: i, dismissed_at: i < 2 ? 5 : null }));
    const plain = lib.taskGroups({ board }, 'team_a').find((g) => g.key === 'done')!;
    expect(plain.capped).toBe(true);
    expect(plain.L.length).toBe(10);
    expect(plain.shown.length).toBe(8);
    const all = lib.taskGroups({ board }, 'team_a', true).find((g) => g.key === 'done')!;
    expect(all.capped).toBe(false);
    expect(all.L.length).toBe(12);
    expect(all.shown.length).toBe(12);
    expect(view).toContain('G = [...taskGroups(t, teamId, !!q), ...tkExtra(t)]');
    expect(view).toContain('(!q || tkMatch(k, q))');
  });

  it('draws one toolbar row (the search with the tag chip, then Filters) over the status tabs, with no tag chip row', () => {
    expect(view).toContain('<div class="ltb">${chipSearch({ attrs: \'id="tkQ"\', label: \'Search tasks\', value: q, chips, clear: clearTo, more: \'data-cs-filt="tkF"\' })}${filterBtn(\'tkF\', chips.length)}</div>');
    // The tag by its display name (Project settings, Tags) in the chip, its Remove label and the Tag select.
    expect(view).toContain("const tgName = (g) => (t0.task_tags || []).find((x) => x.tag === g)?.name || '#' + g;");
    expect(view).toContain("const chips = tg ? [{ label: tgName(tg), name: `Remove tag ${tgName(tg)}`, attrs: go('', q) }] : [];");
    expect(view).toContain(".concat(tags).map((g) => [g.tag, `${tgName(g.tag)} · ${g.n}`])], tg)");
    // The ✕ goes back to the default and keeps the status tab, which is not a filter.
    expect(view).toContain("const go = (g, qq) => `data-cs-nav=\"tasks|${esc(tkArg(teamId, fl, g, qq))}\"`, clearTo = go('', '');");
    expect(view).toContain('const body = tools + (order.length');
    expect(view).toContain('<nav class="tabs" role="tablist" aria-label="Task status">');
    expect(view).toContain('data-tasks-f="${esc(tkArg(teamId, key, tg, q))}"');
    expect(view).not.toContain('tagChips(');
    expect(view).toContain("emptyAct('Clear search and filters', clearTo)");
    expect(view).toContain("selField('tkTag', 'Tag', [['', 'All tags']");
    expect(view).toContain("openD('tasks', tkArg(teamId, fl, tg, form.q.value.trim()), true); $('#dB .csrch-in')?.focus();");
    expect(js).not.toContain("list.startsWith('tasks:')");
  });
});
