/**
 * The member project page in tabs (docs/multi-user.md §7): Overview, Work, Research and Blueprint, as the grant and the
 * project kind allow; the tab is kept in the route (#m/p/<id>/<tab>) and an unknown tab, or one outside the grant, is
 * Overview. Static, like console-member-attention.test.ts: MU_PAGES.p from public/app.js runs with the hub calls stubbed
 * and every other helper answering plain text, so what is checked is which tabs, numbers and cards the page draws.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const src = (() => { const a = js.indexOf('\n  async p(arg) {'), b = js.indexOf('\n  async dec(id) {', a); if (a < 0 || b < 0) throw new Error('no MU_PAGES.p'); return js.slice(a + 1, b).trim().replace(/,$/, ''); })();

const now = Date.now();
const item = (kind: string, key: string, status = 'open', fields: Record<string, unknown> = {}) => ({ kind, key, title: `${key} title`, status, fields, team_id: null });
type Opt = { kind: 'research' | 'implementation'; comps: string[]; teams?: number; items?: ReturnType<typeof item>[]; needs?: number };
async function page(arg: string, o: Opt) {
  const pid = 'prj_a', teams = Array.from({ length: o.teams ?? 2 }, (_, i) => ({ id: `team_${i}`, name: `Team ${i}` }));
  const items = o.items ?? [item('summary', 'S'), item('milestone', 'M1', 'open', { target_at: now + 86400e3 }), item('fr', 'FR-1'), item('question', 'Q-01'), ...(o.kind === 'research' ? [item('line', 'RL-1'), item('hypothesis', 'H-1')] : [])];
  const calls: string[] = [];
  const api = async (u: string) => {
    calls.push(u);
    if (u.endsWith('/summary')) return { project: { ecosystem: false, parent: null }, health: 'ok', next_milestone: { key: 'M1', title: 'M1 title', target_at: now, status: 'open' }, nearest_paper: null, measures: { kind: o.kind, bars: { hypotheses: { done: 1, total: 3 }, frs: { done: 2, total: 5 } } } };
    if (u.endsWith('/blueprint')) return { items };
    if (u.startsWith('/teams/')) return { team: { name: 'T', board: [{ title: 'A', status: 'in_progress' }, { title: 'B', status: 'blocked' }, { title: 'C', status: 'done' }, { title: 'D', status: 'backlog' }] } };
    return null;
  };
  const MU = { projects: [{ id: pid, name: 'Alpha', key: 'ALP', kind: o.kind, teams, member_board: false }], teams: Object.fromEntries(teams.map((t) => [t.id, t])), me: { external: false } };
  const known: Record<string, unknown> = {
    MU, api, muPid: (s: string) => /^prj_/.test(s), muLoadCommon: async () => {}, bpP: (p: string) => '/projects/' + p,
    muHas: (_p: string, c: string) => o.comps.includes(c), muNeeds: () => Array(o.needs ?? 0).fill('<row>'), muNeedsCard: () => (o.needs ? '<div id="mu-needs">NEEDS</div>' : ''),
    esc: (s: unknown) => String(s), cap: (s: string) => s, plural: (n: number, w: string) => `${n} ${w}s`, planDate: () => 'soon',
    row: (r: { title?: string }) => `<row>${r.title ?? ''}</row>`, bpTM: (k: string, t: string) => ({ title: `${k} ${t}` }), kd: (t: string, x = '') => `<h3>${t}</h3>${x}`,
    overline: (t: string) => `<ov>${t}</ov>`, none: (_i: string, t: string) => `<none>${t}</none>`, muCapped: (r: string[]) => r.join(''),
    bpBars: () => '<bars>', muPage: (title: string, body: string, after: unknown, x: unknown) => ({ title, body, after, x }), muMayExport: () => true,
    muExportBtn: (_u: string, l: string) => `<a>${l}</a>`,
  };
  const scope = new Proxy({}, { has: (_t, k) => typeof k === 'string' && !(k in globalThis), get: (_t, k) => (k in known ? known[k as string] : () => '') });
  const fn = new Function('S', `with (S) { return (async function ${src.slice('async '.length)}); }`)(scope);
  const r = await fn(arg);
  const tabs = [...r.body.matchAll(/data-mu-tab="(\w+)">(\w+)(?:<span class="tabn">(\d+)<\/span>)?</g)].map((m) => [m[1], m[2], m[3] ?? '']);
  return { body: r.body as string, title: r.title as string, tabs, on: /class="on" aria-selected="true" data-mu-tab="(\w+)"/.exec(r.body)?.[1] ?? null, calls };
}

describe('member project page tabs', () => {
  it('a research project with Tasks has Overview · Work · Research · Blueprint, with counts', async () => {
    const r = await page('prj_a', { kind: 'research', comps: ['blueprint', 'tasks'], needs: 1 });
    expect(r.tabs).toEqual([['ov', 'Overview', '1'], ['work', 'Work', '4'], ['research', 'Research', '2'], ['blueprint', 'Blueprint', '2']]);
    expect(r.on).toBe('ov');
  });

  it('a software project has no Research tab; without Tasks there is no Work tab and no board is read', async () => {
    expect((await page('prj_a', { kind: 'implementation', comps: ['blueprint', 'tasks'] })).tabs.map((t) => t[0])).toEqual(['ov', 'work', 'blueprint']);
    const r = await page('prj_a', { kind: 'implementation', comps: ['blueprint'] });
    expect(r.tabs.map((t) => t[0])).toEqual(['ov', 'blueprint']);
    expect(r.calls.some((u) => u.startsWith('/teams/'))).toBe(false);
    // The milestones go to Blueprint, and the numbers point there.
    expect(r.tabs.find((t) => t[0] === 'blueprint')![2]).toBe('3');
    expect(r.body).not.toContain('data-mu-tab="work"');
  });

  it('the route keeps the tab; an unknown tab or one outside the grant is Overview', async () => {
    const o: Opt = { kind: 'research', comps: ['blueprint', 'tasks'] };
    expect((await page('prj_a/research', o)).on).toBe('research');
    expect((await page('prj_a/work', o)).on).toBe('work');
    expect((await page('prj_a/bogus', o)).on).toBe('ov');
    expect((await page('prj_a/work', { ...o, comps: ['blueprint'] })).on).toBe('ov');
    expect((await page('prj_a/research', { ...o, kind: 'implementation' })).on).toBe('ov');
  });

  it('Overview: action buttons, four numbers that open their tab, Needs you, Next and Progress', async () => {
    const r = await page('prj_a', { kind: 'research', comps: ['blueprint', 'tasks', 'messages'], needs: 2 });
    expect(r.body).toContain('Answer 2 items');
    expect(r.body).toContain('Message the team');
    expect([...r.body.matchAll(/class="card mu-num" data-mu-tab="(\w+)"/g)].map((m) => m[1])).toEqual(['work', 'work', 'research', 'blueprint']);
    expect(r.body).toContain('Open tasks: 4, 2 blocked');
    for (const h of ['NEEDS', '<h3>Next</h3>', '<h3>Progress</h3>']) expect(r.body).toContain(h);
  });

  it('one team: no team headings in Work, and no page shows a teams line', async () => {
    const r = await page('prj_a/work', { kind: 'implementation', comps: ['blueprint', 'tasks'], teams: 1 });
    expect(r.body).not.toContain('<ov>T</ov>');
    expect(r.body).toContain('<h3>Ongoing</h3>');
    const ov = (await page('prj_a', { kind: 'implementation', comps: ['blueprint'], teams: 1 })).body;
    expect(ov).not.toMatch(/Teams?: /);
    expect(ov).not.toContain('No teams yet');
  });

  it('the page is its tab bar: no header card, the console\'s own tab bar, Export at its right end', async () => {
    const r = await page('prj_a', { kind: 'research', comps: ['blueprint', 'tasks'] });
    for (const gone of ['mu-ph', 'Research project', 'Software project', 'mu-ptabs', 'class="tabs ']) expect(r.body).not.toContain(gone);
    expect(r.body).toMatch(/^<div class="mu-stack"><div class="workspace-bar mu-wbar" id="mu-ov"><div class="ws-row"><nav class="seg ws-tabs" role="tablist"/);
    expect(r.body).toContain('<span class="ws-grant"><a>Export Markdown</a></span>');
    expect(r.title).toBe('Alpha');
    // The vision and the health are not lost: the vision leads Overview, the health heads Progress.
    expect(r.body).toContain('<p class="mu-vision">S title</p>');
    expect(r.body).toContain('<h3>Progress</h3>');
  });

  it('number tiles: no "· Tab ›" text, a name for the tab in the label, one line each', async () => {
    const r = await page('prj_a', { kind: 'research', comps: ['blueprint', 'tasks'] });
    expect(r.body).not.toContain('mu-num-go');
    expect(r.body).not.toContain('›');
    expect(r.body).toContain('aria-label="Open questions: 1, in the Blueprint. Open Blueprint"');
    expect(css).toContain('.mu-num>*{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
    expect(css).toContain('.mu-num{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;');
  });

  it('an empty Needs you card is not drawn on Overview, and the fallback block is gone', async () => {
    const r = await page('prj_a', { kind: 'research', comps: ['blueprint', 'tasks'], needs: 0 });
    expect(r.body).not.toContain('Nothing waits for you');
    expect(r.body).not.toContain('mu-needs');
  });

  it('with nothing in the left column, Next and Progress take one column each', async () => {
    const r = await page('prj_a', { kind: 'research', comps: ['blueprint', 'tasks'], needs: 0 });
    expect(r.body).toContain('<div class="kd-grid mu-grid"><div class="kd-col"><div class="card kd-card"><h3>Next</h3>');
    expect(r.body).toMatch(/<\/div><\/div><div class="kd-col"><div class="card kd-card"><h3>Progress<\/h3>/);
    expect(r.body).not.toContain('<div class="kd-col"></div>');
  });

  it('with a Needs you card, it stays in the first column and Next and Progress share the second', async () => {
    const r = await page('prj_a', { kind: 'research', comps: ['blueprint', 'tasks'], needs: 1 });
    expect(r.body).toContain('<div class="kd-col"><div id="mu-needs">NEEDS</div></div><div class="kd-col"><div class="card kd-card"><h3>Next</h3>');
    expect(r.body.indexOf('<h3>Progress</h3>')).toBeGreaterThan(r.body.indexOf('<h3>Next</h3>'));
  });

  it('the redraw reveals the selected tab of the page\'s own tab bar (ws-tabs), not of the old .tabs bars', () => {
    expect(js).toContain("const muTabsReveal = () => $$('.mu-wbar .ws-tabs').forEach(");
    expect(js).toContain('() => muTabsReveal(), { back: MU.projects.length > 1');
    expect(js).not.toContain('() => tabsReveal(), { back: MU.projects.length > 1');
  });

  it('the tabs replace the section chips; tab clicks go through the route', () => {
    expect(js).not.toContain('mu-chips');
    expect(css).not.toContain('.mu-chips');
    expect(js).toMatch(/const tb = t\.closest\('\[data-mu-tab\]'\); if \(tb && MU\.view === 'p'\) \{[^\n]*history\.pushState\(null, '', '#m\/p\/' \+ encodeURIComponent\(pid\)/);
  });
});
