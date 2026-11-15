/**
 * A collaborator's item page (docs/multi-user.md §7): #m/p/<id>/item/<key> draws the admin's item screen (bpItemScreen),
 * read only: a paper with its readiness and claims by part, no actions, overflow, Undo, Clarify, History, Next or issue
 * marks, tasks as plain rows only when the hub sends them (the tasks component), and a source outside the member's folders
 * by its name only. Every item link opens the next item page and Back follows the history, so Back from a claim returns to
 * its paper; an unknown key and a project without a grant read the same. Static, like console-paper.test.ts: it reads
 * public/app.js and runs the pieces with their own helpers; anything else they call is a stub.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mdPlain } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
/* One top-level declaration of app.js, up to the next one. */
const decl = (head: string) => {
  const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1);
  const rest = js.slice(i + head.length), m = /\n(?=const |function |async function |let |\/\*|\/\/|VIEWS\.)/.exec(rest);
  return js.slice(i, i + head.length + (m ? m.index : rest.length));
};
const block = (start: string, end: string) => {
  const i = js.indexOf(start); expect(i, start).toBeGreaterThan(-1);
  const j = js.indexOf(end, i + start.length); expect(j, end).toBeGreaterThan(i);
  return js.slice(i, j + end.length);
};
const helpers = ['const esc = ', 'const plural = ', 'const pill = ', 'const cap = ', 'const raw = ', 'const txt = ', 'const safeHref = ', 'function row(', 'const kv = ',
  'const overline = ', 'const REQ_ST = ', 'const MS_ST = ', 'const PRI = ', 'const BP_ST = ', 'const bpSt = ', 'const bpLabel = ', 'const bpK = ', 'const bpT = ', 'const bpUn = ',
  'const bpTM = ', 'const bpItemArg = ', 'const BP_KIND = ', 'const BP_REL = ', 'const bpReady = ', 'const BP_PARTS = ', 'function bpBody(', 'const bpRec = ', 'const bpStand = ',
  'function bpCheck(', 'const bpPh = ', 'function bpSources(', 'const trunc = ', 'function mdText(', 'function bpHypResearch(', 'const bpWait = ',
  'const muItemHash = ', 'function muOpenItem(', 'async function muItemPage(', 'const muPage = ', 'const muPid = ', 'async function muRoute('].map(decl).join('\n');
const screen = block('async function bpItemScreen(', '\n}\n');

const STUBS: Record<string, unknown> = {
  ic: () => '', prose: (t: string, cls = '') => `<div class="prose ${cls}">${String(t)}</div>`, planDate: () => '15 Jan', dt: () => '3 Nov', vlHref: (p: string) => '#m/file/' + p,
  agLabel: (x: string) => `label of ${x}`, bpWho: (x: string) => `admin reads ${x}`, bpP: (p: string) => '/projects/' + p, moreBtn: () => '<button data-dbar-more>…</button>', admBpOlder: () => '',
  none: (_i: string, t: string) => `<p class="none">${t}</p>`, mdPlain,
};
const PID = 'prj_lab';
type Ctx = { MU: Record<string, any>; history: Record<string, any>; location: { hash: string }; routed: number; drawn: number };
function load(items: Record<string, unknown>) {
  const ctx: Ctx = {
    MU: { on: true, me: { username: 'mia' }, projects: [{ id: PID, name: 'Reading lab' }], teams: { team_lab: { id: 'team_lab', name: 'Lab' } }, view: '', arg: '' },
    history: { state: null as unknown, pushState(st: unknown, _t: string, h: string) { this.state = st; ctx.location.hash = h; }, replaceState(st: unknown, _t: string, h: string) { this.state = st; ctx.location.hash = h; } },
    location: { hash: '' }, routed: 0, drawn: 0,
  };
  const api = async (path: string) => {
    const m = /\/items\/([^/]+)$/.exec(path); const key = m ? decodeURIComponent(m[1]!) : '';
    if (path.startsWith(`/projects/${PID}/items/`) && key in items) return items[key];
    throw Object.assign(new Error('No such item.'), { status: 404 });
  };
  const scope = new Proxy({ api, MU: ctx.MU, history: ctx.history, location: ctx.location, muLoadCommon: async () => {}, muLanding: async () => '',
    MU_PAGES: { home() {}, p() {} }, muDraw: async () => { ctx.drawn++; } } as Record<string | symbol, unknown>, {
    has: (_t, k) => typeof k === 'string',
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : k in STUBS ? STUBS[k] : k in globalThis ? (globalThis as Record<string, unknown>)[k] : () => ''),
  });
  // eslint-disable-next-line no-new-func
  const lib = new Function('scope', `with (scope) { ${helpers}\n${screen}\n return { bpItemScreen, muItemPage, muOpenItem, muItemHash, muRoute }; }`)(scope) as {
    bpItemScreen: (pid: string, key: string, viewer?: string, o?: unknown) => Promise<{ b: string; acts: string; menu: unknown[]; after: () => void }>;
    muItemPage: (pid: string, key: string) => Promise<{ title: string; body: string; back: string[] }>;
    muOpenItem: (pid: string, key: string) => void; muItemHash: (pid: string, key: string) => string; muRoute: () => Promise<void>;
  };
  return { ...lib, ctx };
}

const claims = [
  { key: 'PAP-1/C1', title: 'The field is axisymmetric', part: 'results', support: 'supported', status: 'draft', chain: [{ key: 'F-L1-01', title: 'Run 46 is symmetric', confidence: 'high' }] },
  { key: 'PAP-1/C2', title: 'The drift is small', part: 'discussion', support: 'weak', status: 'draft', chain: [] },
];
/* What the hub sends a member for the paper: labels and "operator", no History rows, no Next, no issue marks. The page must
   hold to that even if a field slipped through, so actions and an issue are left in on purpose. */
const paper = (over: Record<string, unknown> = {}) => ({
  item: { kind: 'paper', key: 'PAP-1', title: 'Symmetry, measured', status: 'drafting', team_id: 'team_lab', body: 'Framing.', created_by: 'Lab coordinator', updated_by: 'operator',
    fields: { venue: 'Workshop', authors: ['operator', 'Dr. Lee'], manuscript: 'Private/drafts/PAP-1.md' } },
  plain: { summary: 'Is the field symmetric?', records: 'r'.repeat(700), issues: [{ issue: 'an undefined code' }], codes: [] }, standing: 'Not ready: C2 is weak.',
  paper: { claims, supported: 1, total: 2, holding: [], ready: false },
  sources: [{ text: 'Private/drafts/PAP-1.md', where: 'missing' }, { text: 'Shared/notes/run-46.md', where: 'vault', path: 'Shared/notes/run-46.md' }],
  links: { out: [{ key: 'L1', title: 'Field shape', kind: 'line', rel: 'part_of', status: 'active' }], in: [] },
  tasks: { items: [], done: 0, total: 0 }, children: [], history: { revisions: [], total: 4 },
  actions: [{ id: 'mark_submitted' }, { id: 'archive' }, { id: 'undo', rev: 3, to: 'planned' }], project: { name: 'Reading lab' },
  ...over,
});
const claim = { item: { kind: 'claim', key: 'PAP-1/C1', parent: 'PAP-1', title: 'The field is axisymmetric', status: 'draft', fields: { part: 'results' }, created_by: 'Lab coordinator', updated_by: 'Lab writer' },
  plain: { summary: '', records: null, issues: [] }, support: 'supported', chain: claims[0]!.chain, links: { out: [], in: [] }, tasks: { items: [], done: 0, total: 0 }, children: [],
  history: { revisions: [], total: 1 }, actions: [], project: { name: 'Reading lab' } };
const hyp = { item: { kind: 'hypothesis', key: 'H-L1-01', parent: 'L1', title: 'The field is symmetric', status: 'testing', team_id: 'team_lab', fields: {}, created_by: 'Lab coordinator', updated_by: 'operator' },
  plain: { summary: 'Statement.', records: null, issues: [] }, standing: 'Testing.', next: 'Run the drift test', research: { papers: [], results: [], runs: [], changes: [{ at: 1, was: 'untested', to: 'testing', actor: 'Lab writer' }, { at: 0, was: null, to: 'untested', actor: 'operator' }] },
  links: { out: [], in: [] }, tasks: { items: [], done: 0, total: 0 }, children: [], history: { revisions: [], total: 2 }, actions: [], project: { name: 'Reading lab' } };
const ITEMS = { 'PAP-1': paper(), 'PAP-1/C1': claim, 'H-L1-01': hyp, L1: { ...hyp, item: { ...hyp.item, kind: 'line', key: 'L1', parent: null, title: 'Field shape', fields: { mode: 'validate' } } } };

describe("a collaborator's paper page", () => {
  it('renders the paper as the admin screen does: the top card with readiness, then the claims by part', async () => {
    const { muItemPage } = load(ITEMS);
    const r = await muItemPage(PID, 'PAP-1');
    expect(r.title).toBe('Symmetry, measured');
    expect(r.body).toContain('<p class="meta mu-ikm"><span class="id">PAP-1</span> · Paper · Reading lab</p>');
    const b = r.body;
    expect(b).toContain('aria-label="Paper summary"');
    expect(b).toContain('<b>1 of 2</b><span class="of">claims supported</span>');
    expect(b).toContain('class="bp-strip" role="img"');
    expect(b).toContain('<h4>Claims by part · 2</h4>');
    expect(b.indexOf('Results')).toBeLessThan(b.indexOf('Discussion'));
    // Records last: in the tail column, after the side cards on a phone.
    expect(b.indexOf('<div class="bp-col bp-tail">')).toBeGreaterThan(b.indexOf('Links'));
    expect(b).toMatch(/<div class="bp-col bp-tail"><section class="sec bp-sec"><details class="task-brief bp-rec">/);
    // People read as the hub sends them: the operator, never "You" on someone else's console.
    expect(b).toContain('the operator, Dr. Lee');
    expect(b).not.toContain('You');
  });

  it('draws no actions, overflow, Undo, Clarify or Export, and the admin screen still does', async () => {
    const { bpItemScreen } = load(ITEMS);
    const m = await bpItemScreen(PID, 'PAP-1', 'member', { team: () => ({ name: 'Lab' }) });
    expect(m.acts).toBe('');
    expect(m.menu).toEqual([]);
    for (const x of ['bpSubmit', 'data-dbar-more', 'data-bpundo', 'data-clarify', 'Export outline']) expect(m.b, x).not.toContain(x);
    const a = await bpItemScreen(PID, 'PAP-1', 'admin');
    expect(a.acts).toContain('bpSubmit');
    expect(a.menu.map((x: any) => x.label)).toEqual(expect.arrayContaining(['Export outline', 'Archive']));
  });

  it('has no History card, no Next line and no issue marks', async () => {
    const { bpItemScreen } = load(ITEMS);
    const p = await bpItemScreen(PID, 'PAP-1', 'member');
    expect(p.b).not.toContain('<h4>History');
    expect(p.b).not.toContain('bp-chk');
    const h = await bpItemScreen(PID, 'H-L1-01', 'member');
    expect(h.b).toContain('Testing.');
    expect(h.b).not.toContain('Next:');
    // Who moved the status reads as sent; "operator" as the operator.
    expect(h.b).toContain('Lab writer · 15 Jan');
    expect(h.b).toContain('the operator · 15 Jan');
    expect(h.b).toContain('changed by the operator');
    // The admin's screen keeps them.
    const ha = await bpItemScreen(PID, 'H-L1-01', 'admin');
    expect(ha.b).toContain('<b>Next:</b> Run the drift test');
    expect((await bpItemScreen(PID, 'PAP-1', 'admin')).b).toContain('<h4>History');
  });

  it('shows the tasks card only when the hub sends tasks, as rows that do nothing', async () => {
    const tasks = { items: [{ id: 'tsk_1', team_id: 'team_lab', title: 'Draft the results', status: 'in_progress' }, { id: 'tsk_2', team_id: 'team_lab', title: 'Check the drift', status: 'blocked' }], done: 0, total: 2 };
    const { bpItemScreen } = load({ ...ITEMS, 'PAP-1': paper({ tasks }) });
    const b = (await bpItemScreen(PID, 'PAP-1', 'member')).b;
    expect(b).toContain('<h4>Tasks · 0 of 2 done</h4>');
    expect(b).toContain('Draft the results');
    expect(b).not.toContain('data-task');
    expect(b).not.toContain('data-unb');
    expect(b).not.toContain('unblocking returns');
    expect((await load(ITEMS).bpItemScreen(PID, 'PAP-1', 'member')).b).not.toContain('Tasks ·');
  });

  it('shows a source outside the member\'s folders by its name only, with no link and no path', async () => {
    const b = (await load(ITEMS).bpItemScreen(PID, 'PAP-1', 'member')).b;
    const src = b.slice(b.indexOf('<h4>Sources'));
    expect(src).toContain('PAP-1.md');
    expect(src).toContain('Not available to you');
    expect(b).not.toContain('Private/drafts');
    expect(b).not.toContain('data-vf="Private');
    // One inside the grant opens the member's file viewer.
    expect(src).toContain('data-vf="Shared/notes/run-46.md"');
  });
});

describe('moving between item pages', () => {
  it('a claim row opens the claim page, and Back on it goes back in the history to the paper', async () => {
    const { muItemPage, muOpenItem, ctx } = load(ITEMS);
    const b = (await muItemPage(PID, 'PAP-1')).body;
    expect(b).toContain(`data-bp="${PID}|PAP-1/C1"`);
    // The member click handler sends a data-bp click to muOpenItem: a new history entry, the key encoded whole.
    muOpenItem(PID, 'PAP-1/C1');
    expect(ctx.location.hash).toBe(`#m/p/${PID}/item/PAP-1%2FC1`);
    expect(ctx.history.state).toEqual({ mu: 1 });
    const c = await muItemPage(PID, 'PAP-1/C1');
    expect(c.title).toBe('The field is axisymmetric');
    expect(c.back).toEqual(['back', 'Back']);
    expect(c.body).toContain(`data-bp="${PID}|PAP-1"`);
    const handler = block("  $('#member').addEventListener('click', (e) => {", '\n  });');
    expect(handler).toContain("if (s === 'back') { history.back(); return; }");
    expect(handler).toMatch(/closest\('\[data-bp\], \[data-gl\]'\); if \(bi\) \{ e\.preventDefault\(\); e\.stopPropagation\(\);[^\n]*muOpenItem\(/);
    expect(handler).toMatch(/closest\('\[data-vf\]'\); if \(vf\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); muGo\('file', vf\.dataset\.vf\)/);
  });

  it('opened from a link (no history of its own), Back goes to the project', async () => {
    const { muItemPage } = load(ITEMS);
    expect((await muItemPage(PID, 'PAP-1')).back).toEqual([`p|${PID}`, 'Reading lab']);
  });

  it('the Papers card row and every other item row open the page; the item sheet is gone', () => {
    expect(decl('function muPaperRow(')).toContain("'data-mu-item': x.key, 'data-mu-pid': x.pid");
    const handler = block("  $('#member').addEventListener('click', (e) => {", '\n  });');
    expect(handler).toContain('if (pid) muOpenItem(pid, it.dataset.muItem); return;');
    expect(js).not.toMatch(/\bmuItem\(/);
    expect(js).not.toContain('async function muItem(');
  });

  it('an unknown key and a project without a grant show the same page', async () => {
    const { muItemPage } = load(ITEMS);
    const unknown = await muItemPage(PID, 'PAP-9'), ungranted = await muItemPage('prj_other', 'PAP-1'), bad = await muItemPage('not a project', 'PAP-1');
    expect(unknown.title).toBe('No such item');
    // Back differs only in where it can go: a project without a grant has no page to return to.
    for (const x of [ungranted, bad]) expect([x.title, x.body]).toEqual([unknown.title, unknown.body]);
    expect(unknown.body).toContain('No such item');
  });

  it('routes #m/p/<id>/item/<key> to the item page, a key with a slash whole', async () => {
    const { muRoute, muItemHash, ctx } = load(ITEMS);
    ctx.location.hash = muItemHash(PID, 'PAP-1/C1');
    await muRoute();
    expect(ctx.MU.view).toBe('p');
    expect(ctx.MU.arg).toBe(`${PID}/item/PAP-1/C1`);
    const p = block('  async p(arg) {', "parts.slice(2).join('/'));");
    expect(p).toContain("if (want === 'item') return muItemPage(pid, parts.slice(2).join('/'));");
    // The 15-second refresh leaves an item page alone.
    expect(decl('async function muPoll(')).toContain("MU.view === 'p' && MU.arg.split('/')[1] !== 'item'");
  });
});

describe('the page looks like the admin screen', () => {
  it('draws the item cards as cards on the member page too', () => {
    expect(css).toContain('#workspaceView .bp-sec,#muBody .bp-sec{background:var(--panel);border:1px solid var(--line)');
  });
  it('names a vault note the member cannot open by its name only, in the item text as in Sources', () => {
    const draw = decl('async function vlDraw(');
    expect(draw).toContain("const label = MU.on && !found.length ? esc(e.textContent.split('/').pop().trim() || e.textContent) : e.innerHTML;");
    expect(draw).toContain('<span class="md-wl miss" title="${MD_UNAVAILABLE}">${label}</span>');
  });
});

describe('on a phone', () => {
  it('is one column below 1180 px, with Records last, and nothing wider than the screen', () => {
    expect(css).toContain('.bp-grid{display:flex;flex-direction:column;gap:var(--s3)}');
    expect(css).toMatch(/@media \(min-width:1180px\)\{\.bp-grid\{display:grid;/);
    expect(screen).toContain("b: `<div class=\"bp-grid${tail ? ' bp-g3' : ''}\"><div class=\"bp-col\">${main}</div><div class=\"bp-col\">${side}</div>${tail ? `<div class=\"bp-col bp-tail\">${tail}</div>` : ''}</div>`");
  });
});
