/**
 * Operator console, Work → Feedback (docs/dashboard-ux.md, Feedback): one toolbar row (the search box with the active filters
 * as chips, New · Open · Closed, Filters), and the list overline with the count, Group by and Sort. The search is out of the
 * Filters sheet, and the filters change the list in place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const stmt = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n};\n', i) + 3); };
const view = (() => { const i = js.indexOf('VIEWS.feedback = async'); return js.slice(i, js.indexOf('\n};\n', i)); })();
type Chip = { label: string; name: string; attrs: string };
const mk = (F: Record<string, unknown>) => new Function('S', `${line('const FB_F = ')}\n${line('const FB_KIND = ')}\nObject.assign(FB_F, ${JSON.stringify(F)});\n${stmt('const fbChips = ')}\nreturn fbChips();`)(
  { agents: [{ id: 'ag_1', label: 'scribe' }], teams: [{ id: 'team_a', name: 'Relay' }] }) as Chip[];

describe('console: Work → Feedback toolbar', () => {
  it('shows every active filter as a chip, in the Filters order; the search, sort and grouping are never chips', () => {
    expect(mk({ q: 'lease', sort: 'recent', group: true })).toEqual([]);
    const ch = mk({ kind: 'bug', tool: 'task_submit', team: 'team_a', agent: 'ag_1', assignee: 'ag_1', linked: 'not_linked' });
    expect(ch.map((c) => c.label)).toEqual(['Bug', 'task_submit', 'Relay', 'From scribe', 'Assigned to scribe', 'Not linked']);
    expect(ch.map((c) => c.attrs)).toEqual(['kind', 'tool', 'team', 'agent', 'assignee', 'linked'].map((k) => `data-fb-rm="${k}"`));
    expect(ch[0].name).toBe('Remove the kind filter Bug');
  });

  it('draws one row: the search box with the chips, New · Open · Closed, then Filters', () => {
    expect(view).toContain('`<div class="ltb">${chipSearch({ attrs: \'id="fbQ"\', label: \'Search reports\', value: FB_F.q, chips: ch, clear: \'data-fb-clr\', more: FB_MORE })}<div class="seg eq fb-seg"');
    expect(view).toContain("${filterBtn('fbMore', ch.length)}</div>`");
    expect(view).not.toContain('vtools(');
    expect(css).toContain('@media (max-width:767.98px){.ltb>.seg.fb-seg{flex:1 1 0;min-width:0}}');
  });

  it('takes the search, the sort and the grouping out of Filters, which keeps every picker', () => {
    const sh = fn('function openFbFilters(');
    for (const id of ['fbK', 'fbT', 'fbTm', 'fbA', 'fbAs', 'fbLk']) expect(sh).toContain(`selField('${id}'`);
    expect(sh).not.toMatch(/type="search"|'fbS'|id="fbG"|Group by tool or area/);
    expect(sh).toContain("Object.assign(FB_F, { kind: '', tool: '', team: '', agent: '', assignee: '', linked: '' });");
  });

  it('puts the count, Group by and Sort in the list overline', () => {
    const l = fn('function fbList(');
    expect(l).toContain("listOverline([lovN(reports.length, total, 'fbShown'), { name: 'Group by', attrs: 'id=\"fbG\"', options: FB_GROUPS, value: FB_F.group ? 'tool' : '' }, { name: 'Sort', attrs: 'id=\"fbS\"', options: FB_SORTS, value: FB_F.sort }])");
    expect(js).toContain("const FB_GROUPS = [['', 'Not grouped'], ['tool', 'Grouped by tool or area']], FB_SORTS = [['impact', 'Most impact first'], ['recent', 'Last seen first']];");
    expect(l).toContain("emptyAct('Clear search and filters', 'data-fbclr')");
    expect(view).toContain("if (e.target.id === 'fbG') { FB_F.group = !!e.target.value; run(() => draw('#fbG')); }");
  });

  it('changes the list in place and swaps the chips; the ✕ clears the text and every filter, not the sort or grouping', () => {
    expect(view).toContain('const ch = fbChips(); csrchSet(form, ch, FB_MORE); setFilterCount(\'fbMore\', ch.length);');
    expect(view).toContain("const clear = () => { for (const k of FB_NARROW) FB_F[k] = ''; q.value = ''; q.dataset.q = ''; run(draw); q.focus(); };");
    expect(line('const FB_NARROW = ')).toBe("const FB_NARROW = ['kind', 'tool', 'team', 'agent', 'assignee', 'linked', 'q'];");
    expect(view).toContain("form.onclick = (e) => { const rm = e.target.closest('[data-fb-rm]'); if (rm) { FB_F[rm.dataset.fbRm] = ''; run(draw); q.focus(); } else if (e.target.closest('[data-fb-clr]')) clear(); };");
  });
});
