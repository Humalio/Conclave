/**
 * The Papers card on a collaborator's Home and project page (docs/multi-user.md §7). Static, like console-member-tabs.test.ts:
 * the card's own code from public/app.js (muPapers, muPaperRow, muPapersCard, with the real muCapped and bpReady) runs
 * against plain stubs for row and bpTM, so what is checked is which papers the card lists, in which order, with which meta,
 * chip and link. Home and the project page run with the hub calls stubbed, to check where the card sits.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
/* One top-level declaration of app.js, from its first line to the next top-level declaration or comment. */
const take = (start: RegExp) => {
  const i = js.search(start); if (i < 0) throw new Error(`not found: ${start}`);
  const rest = js.slice(i), end = rest.slice(1).search(/\n(?=const |function |async function |let |\/\*)/);
  return rest.slice(0, end < 0 ? undefined : end + 1);
};
const DAY = 86400e3, now = Date.now();
const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* A row as data: its title, meta (html), trailing chip and attributes, so a test reads them back. */
const row = (r: { title?: { html: string }; meta?: { html: string }; trail?: string; attrs?: Record<string, string>; chev?: boolean; lead?: string }) =>
  `<row ${Object.entries(r.attrs || {}).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}><t>${r.title?.html ?? ''}</t><m>${r.meta?.html ?? ''}</m><c>${r.trail ?? ''}</c>${r.lead ?? ''}${r.chev ? '<chev>' : ''}</row>`;
const bpTM = (k: string, t: string, meta: { html: string }, attrs: Record<string, string>) => ({ title: { html: esc(t) }, meta: { html: `${k} · ${meta.html}` }, attrs });
const card = (() => {
  const code = [/^const raw = /m, /^const MU_CAP = /m, /^const muCapped = /m, /^const bpReady = /m, /^const MU_PAPER_OPEN = /m, /^const muPaperGroup = /m, /^function muPapers\(/m, /^function muPaperRow\(/m, /^function muPapersCard\(/m].map(take).join('\n');
  return new Function('esc', 'row', 'bpTM', 'ic', 'kd', 'cap', 'planDate', 'pill', `${code}\nreturn { muPapers, muPapersCard };`)(
    esc, row, bpTM, (n: string) => `<ic ${n}>`, (t: string) => `<h3>${t}</h3>`, (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
    (t: number) => new Date(t).toISOString().slice(0, 10), (l: string, tone: string) => `<pill ${tone}>${l}</pill>`,
  ) as { muPapers: (P: unknown[]) => { key: string; pid: string }[]; muPapersCard: (P: unknown[], home: boolean) => string };
})();
type Paper = { key: string; title?: string; status: string; target_at?: number | null; ready?: boolean; supported?: number; total?: number };
const paper = (key: string, status: string, target_at: number | null = null, x: Partial<Paper> = {}): Paper => ({ key, title: `${key} title`, status, target_at, ready: false, supported: 0, total: 0, ...x });
const proj = (id: string, name: string, papers: Paper[]) => ({ id, name, papers });
const rows = (html: string) => [...html.matchAll(/<row data-mu-item="([^"]+)" data-mu-pid="([^"]+)"><t>([^<]*)<\/t><m>(.*?)<\/m><c>(.*?)<\/c>/g)].map((m) => ({ key: m[1], pid: m[2], title: m[3], meta: m[4], chip: m[5] }));

describe('the Papers card', () => {
  it('orders open papers by nearest date (undated last), then accepted and published by latest date, then rejected', () => {
    const P = [proj('prj_b', 'Beta', [paper('PAP-1', 'published', now - 30 * DAY), paper('PAP-2', 'rejected'), paper('PAP-3', 'drafting'), paper('PAP-4', 'submitted', now + 2 * DAY)]),
      proj('prj_a', 'Alpha', [paper('PAP-1', 'planned', now + 9 * DAY), paper('PAP-2', 'accepted', now - 2 * DAY), paper('PAP-3', 'drafting', now + 2 * DAY), paper('PAP-4', 'published'), paper('PAP-5', 'dropped', now)])];
    expect(card.muPapers(P).map((x) => `${x.pid}/${x.key}`)).toEqual([
      'prj_a/PAP-3', 'prj_b/PAP-4', // the same date: by project name (Alpha before Beta), then key
      'prj_a/PAP-1', 'prj_b/PAP-3', // undated open papers after dated ones
      'prj_a/PAP-2', 'prj_b/PAP-1', 'prj_a/PAP-4', // accepted and published: latest date first, undated last
      'prj_b/PAP-2', // rejected last; a dropped paper is left out
    ]);
  });

  it('keys sort as numbers within one project, so PAP-2 comes before PAP-10', () => {
    expect(card.muPapers([proj('prj_a', 'A', [paper('PAP-10', 'planned'), paper('PAP-2', 'planned')])]).map((x) => x.key)).toEqual(['PAP-2', 'PAP-10']);
  });

  it('the chip shows readiness only while a paper is planned or drafting', () => {
    const P = [proj('prj_a', 'Alpha', ['planned', 'drafting', 'submitted', 'accepted', 'rejected', 'published'].map((s, i) => paper(`PAP-${i + 1}`, s, null, { ready: i === 0 })))];
    const R = rows(card.muPapersCard(P, true));
    expect(Object.fromEntries(R.map((r) => [r.meta.split(' · ')[2], r.chip]))).toEqual({
      Planned: '<pill ok>Ready</pill>', Drafting: '<pill warn>Not ready</pill>', Submitted: '', Accepted: '', Rejected: '', Published: '',
    });
    // A ready planned paper has one chip, Ready, and no status chip next to it.
    expect(R[0]!.chip.match(/<pill/g)).toHaveLength(1);
    // Chips have square corners (--r-chip), as every pill does.
    expect(css).toMatch(/\.pill\{[^}]*border-radius:var\(--r-chip\)/);
  });

  it('the meta line: the project on Home only, the status, a due date for open papers (warning once late), the claims', () => {
    const P = [proj('prj_a', 'Alpha', [paper('PAP-1', 'drafting', now - 3 * DAY, { supported: 3, total: 5 }), paper('PAP-2', 'planned', now + 5 * DAY), paper('PAP-3', 'published', now - 9 * DAY, { supported: 4, total: 4 })])];
    const [late, soon, pub] = rows(card.muPapersCard(P, true));
    expect(late!.meta).toBe(`PAP-1 · Alpha · Drafting · <span class="mu-late">due ${new Date(now - 3 * DAY).toISOString().slice(0, 10)}</span> · 3 of 5 claims supported`);
    expect(soon!.meta).toBe(`PAP-2 · Alpha · Planned · <span>due ${new Date(now + 5 * DAY).toISOString().slice(0, 10)}</span> · No claims yet`);
    expect(pub!.meta).toBe('PAP-3 · Alpha · Published · 4 of 4 claims supported'); // no due date once published
    expect(css).toMatch(/\.mu-late\{color:var\(--warn-t\)\}/);
    // On a project page the rows leave the project out.
    expect(rows(card.muPapersCard(P, false))[0]!.meta).toBe(`PAP-1 · Drafting · <span class="mu-late">due ${new Date(now - 3 * DAY).toISOString().slice(0, 10)}</span> · 3 of 5 claims supported`);
  });

  it('each row opens its paper: the item view of that project, with no buttons on the row', () => {
    const html = card.muPapersCard([proj('prj_a', 'Alpha', [paper('PAP-1', 'planned')]), proj('prj_b', 'Beta', [paper('PAP-1', 'planned')])], true);
    expect(rows(html).map((r) => [r.pid, r.key])).toEqual([['prj_a', 'PAP-1'], ['prj_b', 'PAP-1']]);
    expect(html).toContain('<chev>');
    expect(html).not.toMatch(/<button(?![^>]*data-mu-more)/);
    // The console's click handler opens [data-mu-item] with its own data-mu-pid, on whichever page the row is.
    expect(js).toContain("const it = t.closest('[data-mu-item]'); if (it) { const pid = it.dataset.muPid ||");
  });

  it('shows 8 rows, then Show all N; the title counts every paper', () => {
    const html = card.muPapersCard([proj('prj_a', 'Alpha', Array.from({ length: 11 }, (_, i) => paper(`PAP-${i + 1}`, 'planned')))], true);
    expect(html).toContain('<h3>Papers · 11</h3>');
    const [shown, rest] = html.split('<div class="mu-rest" hidden>');
    expect(rows(shown!)).toHaveLength(8);
    expect(rows(rest!)).toHaveLength(3);
    expect(html).toContain('>Show all 11</button>');
  });

  it('is not drawn when there are no papers (dropped ones do not count)', () => {
    expect(card.muPapersCard([], true)).toBe('');
    expect(card.muPapersCard([proj('prj_a', 'Alpha', []), { id: 'prj_b', name: 'Beta' }], true)).toBe('');
    expect(card.muPapersCard([proj('prj_a', 'Alpha', [paper('PAP-1', 'dropped')])], false)).toBe('');
  });

  it('lists only the projects it is given: a project the member is not granted adds no row and no name', () => {
    // MU.projects is GET /api/projects, which lists granted projects only (multiuser-leak.test.ts checks their papers).
    const html = card.muPapersCard([proj('prj_a', 'Alpha', [paper('PAP-1', 'planned')])], true);
    expect(rows(html).map((r) => r.pid)).toEqual(['prj_a']);
    expect(html).not.toContain('Beta');
  });
});

describe('every page of GET /api/projects', () => {
  const all = new Function('api', `${take(/^async function muAllProjects\(/m)}\nreturn muAllProjects;`);
  it('follows next_cursor, so papers of a second page are included; a failed page keeps what was read', async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown> = { '/projects': { projects: [{ id: 'p1' }], next_cursor: 'c:2' }, '/projects?cursor=c%3A2': { projects: [{ id: 'p2' }], next_cursor: 'c:3' } };
    const api = async (u: string) => { calls.push(u); if (u in pages) return pages[u]; throw new Error('500'); };
    expect((await all(api)()).projects.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
    expect(calls).toEqual(['/projects', '/projects?cursor=c%3A2', '/projects?cursor=c%3A3']);
    expect(js).toContain('muAllProjects().catch(() => ({ projects: [] }))');
  });
});

/* A member page from MU_PAGES with the hub calls stubbed; muPapersCard and muNeedsCard are markers, to read their order. */
const pageSrc = (start: string, end: string) => { const a = js.indexOf(start), b = js.indexOf(end, a); if (a < 0 || b < 0) throw new Error('no ' + start); return js.slice(a + 1, b).trim().replace(/,$/, ''); };
async function run(src: string, known: Record<string, unknown>, arg?: string) {
  const scope = new Proxy({}, { has: (_t, k) => typeof k === 'string' && !(k in globalThis), get: (_t, k) => (k in known ? known[k as string] : () => '') });
  const fn = new Function('S', `with (S) { return (async function ${src.slice('async '.length)}); }`)(scope);
  return (await fn(arg)).body as string;
}

describe('where the card sits', () => {
  it('Home: Papers is the first card of the right column, above Work in motion; Teams sits in the left column under the projects', async () => {
    const MU = { projects: [{ id: 'prj_a', name: 'Alpha', teams: [] }], teams: { team_1: { id: 'team_1', name: 'Team One' } } };
    const body = await run(pageSrc('\n  async home() {', '\n  async projects() {'), {
      MU, muLoadCommon: async () => {}, muAny: () => true, api: async () => ({ events: [] }), muSums: async () => [null], muProjCard: () => '<PROJ>',
      muPapersCard: (P: unknown[], home: boolean) => `<PAPERS ${(P as { id: string }[]).map((p) => p.id).join(',')} home=${home}>`,
      kd: (t: string) => `<h3>${t}</h3>`, muFeed: () => '', none: () => '', dlgMemberHtml: () => '', dlgMine: async () => null, muPage: (title: string, b: string) => ({ title, body: b }),
      row: (r: { title?: string }) => `<row>${r.title ?? ''}</row>`, ic: () => '', muTeamMeta: () => '',
    });
    const [, left, right] = body.split('<div class="kd-col">') as [string, string, string];
    expect(right.startsWith('<PAPERS prj_a home=true>')).toBe(true);
    expect(right.indexOf('<PAPERS')).toBeLessThan(right.indexOf('Work in motion'));
    expect(right).not.toContain('<h3>Teams</h3>');
    // Teams follows the project cards in the first column, so on a phone it still comes after the projects.
    expect(left.startsWith('<PROJ>')).toBe(true);
    expect(left.indexOf('<PROJ>')).toBeLessThan(left.indexOf('<h3>Teams</h3>'));
    expect(left).toContain('<row>Team One</row>');
  });

  const projectPage = async (needs: number, needsCard: string) => {
    const pid = 'prj_a', P = { id: pid, name: 'Alpha', key: 'ALP', kind: 'implementation', teams: [], member_board: false, papers: [] };
    return run(pageSrc('\n  async p(arg) {', '\n  async dec(id) {'), {
      MU: { projects: [P], teams: {}, me: {} }, muPid: () => true, muLoadCommon: async () => {}, bpP: (p: string) => '/projects/' + p,
      api: async (u: string) => (u.endsWith('/summary') ? { project: { ecosystem: false }, measures: { bars: {} } } : u.endsWith('/blueprint') ? { items: [] } : null),
      muHas: () => false, muNeeds: () => Array(needs).fill('<row>'), muNeedsCard: () => needsCard,
      muPapersCard: (L: { id: string }[], home: boolean) => `<PAPERS ${L.map((p) => p.id).join(',')} home=${home}>`,
      esc: String, cap: String, plural: String, planDate: String, row: () => '', bpTM: () => ({}), kd: (t: string) => `<h3>${t}</h3>`, none: () => '', bpBars: () => '',
      muPage: (title: string, b: string) => ({ title, body: b }), muMayExport: () => false,
    }, pid);
  };

  it('project page: right after a card that holds Needs you rows', async () => {
    const body = await projectPage(2, '<NEEDS>');
    expect(body).toContain('<div class="kd-col"><NEEDS><PAPERS prj_a home=false>');
  });

  it('project page: before a card that holds only For awareness or Later rows, and alone when there is no such card', async () => {
    expect(await projectPage(0, '<AWARE>')).toContain('<div class="kd-col"><PAPERS prj_a home=false><AWARE>');
    expect(await projectPage(0, '')).toContain('<div class="kd-col"><PAPERS prj_a home=false></div>');
  });
});
