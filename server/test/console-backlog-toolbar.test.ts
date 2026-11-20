/**
 * Operator console, Work → Backlog (docs/dashboard-ux.md, Backlog): one toolbar row (the search box with the team, project and
 * tag as chips, the list, Filters), the count and the order in the list's overline, and a route that reads back the search.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const view = (() => { const i = js.indexOf('VIEWS.backlog = async'); return js.slice(i, js.indexOf('\n};\n', i)); })();
type BF = { l?: string; p?: string; team?: string; t?: string; q?: string; from?: string };
const lib = new Function(`${line('const blDec = ')}\n${line('const blArgOf = ')}\n${line('const blArg = ')}\nreturn { blArgOf, blArg };`)() as { blArgOf: (a: string) => BF; blArg: (f: BF) => string };
const ok = new Function(`const RID = /^[a-z]+_[A-Za-z0-9_-]+$/;\nreturn ${line('  backlog: (a) => ').trim().replace(/^backlog: /, '').replace(/, memb.*$/, '')};`)() as (a: string) => boolean;

describe('console: Work → Backlog toolbar', () => {
  it('keeps the search in the route, encoded, and reads back what it writes', () => {
    const f = { l: 'postponed', p: 'prj_a1', team: 'team_b2', t: 'docs', q: 'relay & keys|50%' };
    const a = lib.blArg(f);
    expect(a).toBe('l=postponed&p=prj_a1&team=team_b2&t=docs&q=relay%20%26%20keys%7C50%25');
    expect(lib.blArgOf(a)).toEqual(f);
    expect(ok(a)).toBe(true);
    expect(ok('q=a|b')).toBe(false);
    expect(lib.blArgOf('q=%E0%A4%A')).toEqual({ q: '' });
    expect(js).toContain("if (f.q) q.set('q', f.q);");
  });

  it('draws one toolbar row: the search with team, project and tag chips, the list, Filters; no tag row, team or project line', () => {
    expect(view).toContain('<div class="ltb">${chipSearch({ attrs: \'id="blQ"\', label: \'Search the backlog\', value: f.q, chips, clear: clearTo, more: \'data-cs-filt="blF"\' })}');
    expect(view).toContain("f.team ? { label: tname, name: `Remove team ${tname}`, attrs: go({ ...f, team: '' }) }");
    expect(view).toContain("f.p ? { label: pname, name: `Remove project ${pname}`, attrs: go({ ...f, p: '' }) }");
    // The tag by its display name (Project settings, Tags) in the chip, its Remove label and the Tag select.
    expect(view).toContain("const tagLabel = tag ? (r.tags || []).find((g) => g.tag === tag)?.name || '#' + tag : '';");
    expect(view).toContain("tag ? { label: tagLabel, name: `Remove tag ${tagLabel}`, attrs: go({ ...f, t: '' }) }");
    expect(view).toContain("...GG.map((g) => [g.tag, `${g.name || '#' + g.tag} · ${g.n}`])");
    // The ✕ and the empty state go back to the default: this list, no filter, no search.
    expect(view).toContain('clearTo = go({ l: f.l, from: f.from })');
    expect(view).toContain("emptyAct('Clear search and filters', clearTo)");
    expect(view).toContain("${filterBtn('blF', chips.length)}");
    expect(view).not.toMatch(/tagChips\(|blAllTeams|bl-proj|Showing the oldest|vtools\(/);
    // Filters holds every picker.
    expect(view).toContain("selField('blTeam', 'Team'");
    expect(view).toContain("selField('blProj', 'Project'");
    expect(view).toContain("selField('blTag', 'Tag'");
  });

  it('puts "50 of 112" and the order in the list overline, the one live region, and Show more updates it', () => {
    expect(view).toContain("listOverline([pp ? 'Postponed' : 'Waiting', lovN(acc.length, r.total, 'blShown'), 'Oldest first'])");
    expect(js).toContain('const lovN = (n, of, id = \'\') => ({ html: `<span class="lov-n"${id ? ` id="${id}"` : \'\'} tabindex="-1" aria-live="polite"><b>${n}</b> of ${of}</span>` });');
    expect(view).toContain("$('#blShown').innerHTML = shownH(acc.length);");
    expect(view).toContain('const shownH = (n) => `<b>${n}</b> of ${r.total}`;');
  });

  it('wires chips, the ✕ and "+k" once for every screen, and puts the focus back in the box', () => {
    expect(js).toContain("const b = e.target.closest?.('[data-cs-nav],[data-cs-filt]'); if (!b) return;");
    expect(js).toContain("await openD(v.slice(0, i), v.slice(i + 1), true); $('#dB .csrch-in')?.focus();");
    expect(view).toContain("$('#blQ').onsubmit = async (e) => { e.preventDefault(); await openD('backlog', blArg({ ...f, q: $('#blQ').q.value.trim() }), true); $('#dB .csrch-in')?.focus(); };");
    expect(css).toContain('.ltb{display:flex;align-items:flex-start;');
    expect(css).toContain('@media (max-width:767.98px){.ltb .srch{flex-basis:100%;max-width:none}}');
  });
});
