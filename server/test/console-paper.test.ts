/**
 * Paper screen, Blueprint rows and requirement chips (dashboard-ux.md, Paper; design-guidelines.md, List row and Ref):
 * a paper reads readiness first (Holding it back: at most 5, worst first, then "and n more"), then Claims by part (every
 * claim once), Summary, Sources and Records; the Paper card links the manuscript into the vault viewer or says it is not
 * available, Delivered by shows the milestone's title, and studies sit in their own card instead of Links. Blueprint rows
 * lead with the title and the key leads the muted second line. A requirement chip opens its item on the task screen and is
 * a tip only on board cards. Static, like console-directive-detail.test.ts: it reads public/app.js and renders the pieces
 * with their own helpers; anything else the screen calls is a stub.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mdPlain } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
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
  'function bpCheck(', 'const bpPh = ', 'function bpSources(', 'function refChips(', 'const trunc = ', 'function mdText('].map(decl).join('\n');
const view = block('VIEWS.bp = async (arg) => {', '\n};');

/* Every name the screen uses that is not one of the helpers above is a stub that renders nothing, except these few. */
const STUBS: Record<string, unknown> = {
  ic: () => '', prose: (t: string, cls = '') => `<div class="prose ${cls}">${String(t)}</div>`, planDate: () => '15 Jan', dt: () => '3 Nov', vlHref: (p: string) => '#vault' + p,
  agLabel: (x: string) => x, bpWho: (x: string) => x, bpP: () => '/projects/prj/blueprint', moreBtn: () => '', admBpOlder: () => '',
  // Titles, row meta and tooltips are Plain text (mdText → mdPlain), so the screen gets md.js's own mdPlain.
  mdPlain,
};
function load(d: unknown) {
  const scope = new Proxy({ api: async () => d } as Record<string | symbol, unknown>, {
    has: (_t, k) => typeof k === 'string' && !['VIEWS'].includes(k),
    get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : k in STUBS ? STUBS[k] : k in globalThis ? (globalThis as Record<string, unknown>)[k] : () => ''),
  });
  // eslint-disable-next-line no-new-func
  return new Function('scope', 'VIEWS', `with (scope) { ${helpers}\n${view}\n return { VIEWS, refChips, bpTM, row }; }`)(scope, {}) as {
    VIEWS: { bp: (arg: string) => Promise<{ b: string }> }; refChips: (k: unknown, t: unknown, o?: unknown) => string; bpTM: (...a: unknown[]) => Record<string, unknown>; row: (o: unknown) => string;
  };
}

/* A paper with 12 claims, 7 not supported: 1 contradicted, 3 unsupported, 3 weak. */
const SUP = ['supported', 'weak', 'contradicted', 'supported', 'weak', 'supported', 'supported', 'unsupported', 'supported', 'unsupported', 'unsupported', 'weak'];
const PART = ['results', 'results', 'results', 'results', 'results', 'method', 'method', 'method', 'method', 'discussion', 'discussion', 'discussion'];
const claims = SUP.map((s, i) => ({ key: `PAP-1/C${i + 1}`, title: `Claim number ${i + 1}`, part: PART[i], support: s, status: 'draft', chain: [] }));
const paper = (over: Record<string, unknown> = {}) => ({
  item: { kind: 'paper', key: 'PAP-1', title: 'Agent-curated knowledge graphs', status: 'drafting', team_id: null, body: 'Framing.', fields: { venue: 'Workshop', manuscript: 'PAP-1 draft/README.md', authors: ['operator'] } },
  plain: { summary: 'Can agents keep a graph accurate?', records: 'r'.repeat(700), issues: [] }, standing: 'Not ready: C3 is contradicted.',
  paper: { claims, supported: 5, total: 12, holding: [], ready: false },
  sources: [{ text: 'PAP-1 draft/README.md', where: 'vault', path: '/Vault/papers/kq/PAP-1 draft/README.md' }],
  links: { out: [{ key: 'H-L2-03', title: 'Review catches false positives', kind: 'hypothesis', rel: 'studies', status: 'confirmed' }, { key: 'L2', title: 'Review quality', kind: 'line', rel: 'part_of', status: 'active' }],
    in: [{ key: 'M3', title: 'Paper submitted', kind: 'milestone', rel: 'delivers', status: 'planned' }] },
  tasks: { items: [], done: 0, total: 0 }, children: [], history: { revisions: [{ rev: 1, note: 'created', actor: 'operator', at: 1 }], total: 1 }, actions: [], project: { name: 'Knowledge quality' },
  ...over,
});
const render = async (d: unknown) => (await load(d).VIEWS.bp('prj|PAP-1')).b;
const between = (s: string, a: string, b: string) => { const i = s.indexOf(a); expect(i, a).toBeGreaterThan(-1); const j = b ? s.indexOf(b, i) : s.length; return s.slice(i, j < 0 ? s.length : j); };
const mainCol = (b: string) => [between(b, '<div class="bp-col">', '</div><div class="bp-col">'), b.slice(b.indexOf('</div><div class="bp-col">'))] as const;

describe('paper screen', () => {
  it('opens with one summary card (head, readiness, summary), then Claims by part, Sources and Records', async () => {
    const [main] = mainCol(await render(paper()));
    const at = ['aria-label="Paper summary"', 'class="bp-ph"', 'class="bp-rd"', 'class="bp-psum"', 'id="bpOutline"', '<h4>Sources · 1</h4>', 'Records</summary>'].map((x) => main.indexOf(x));
    at.forEach((x) => expect(x).toBeGreaterThan(-1));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Readiness is a card like every other: no accent border or inset bar (Bruno, 18 Nov 2026); the state reads in its words and pills.
    expect(main).toContain('<section class="sec bp-sec bp-pcard" aria-label="Paper summary">');
    expect(main).not.toContain('bp-acc');
    expect(readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8')).not.toContain('bp-acc');
    // The standing line sits in the summary card, under readiness, and Records longer than 600 characters start folded.
    expect(between(main, 'aria-label="Paper summary"', '</section>')).toContain('Not ready: C3 is contradicted.');
    expect(main).not.toContain('<h4>Summary</h4>');
    expect(main).toMatch(/<details class="task-brief bp-rec">/);
  });

  it('lists at most 5 claims holding it back, worst first, then "and 2 more"; the outline lists all 12 once', async () => {
    const [main] = mainCol(await render(paper()));
    const held = between(main, 'class="bp-held"', 'id="bpOutline"'), keys = [...held.matchAll(/<span class="bp-k">(C\d+)<\/span>/g)].map((m) => m[1]);
    expect(keys).toEqual(['C3', 'C8', 'C10', 'C11', 'C2']); // contradicted, the unsupported ones, then the first weak
    expect(held).toContain('data-bp-outline>and 2 more in Claims by part</button>');
    const outline = between(main, 'id="bpOutline"', '<h4>Sources'), all = [...outline.matchAll(/<span class="bp-k">(C\d+)<\/span>/g)].map((m) => m[1]);
    expect(all).toHaveLength(12); expect(new Set(all).size).toBe(12);
    expect(outline).toContain('Claims by part · 12');
  });

  it('with 3 of 7 claims not supported lists those 3, worst first, and no "more" button', async () => {
    // C2 weak, C3 contradicted, C7 unsupported, the other four supported.
    const few = claims.slice(0, 7).map((c, i) => ({ ...c, support: i === 1 ? 'weak' : i === 2 ? 'contradicted' : i === 6 ? 'unsupported' : 'supported' }));
    const [main] = mainCol(await render(paper({ paper: { claims: few, supported: 4, total: 7, holding: [], ready: false } })));
    const held = between(main, 'class="bp-held"', 'id="bpOutline"');
    expect([...held.matchAll(/<span class="bp-k">(C\d+)<\/span>/g)].map((m) => m[1])).toEqual(['C3', 'C7', 'C2']);
    expect(held).not.toContain('data-bp-outline');
  });

  it('draws the strip as one graphic with one label and no per-claim tooltips', async () => {
    const [main] = mainCol(await render(paper()));
    const strip = between(main, '<div class="bp-strip"', '</div>');
    expect(strip).toContain('role="img" aria-label="5 supported, 3 weak, 3 unsupported, 1 contradicted"');
    expect(strip).not.toContain('title=');
    expect(strip).not.toContain('tabindex');
    // The label is not repeated as visible text: the strip's own label is what screen readers get.
    expect(main).not.toContain('bp-strip-l');
  });

  it('has no separate Paper card: the manuscript and milestones live in the top card, readiness in its own block at the right', async () => {
    const b = await render(paper());
    expect(b).not.toContain('<h4>Paper</h4>');
    expect(b).not.toContain('Delivered by');
    const [main] = mainCol(b);
    const top = between(main, 'class="bp-top"', 'class="bp-psum"');
    expect(top.indexOf('class="bp-ph"')).toBeLessThan(top.indexOf('class="bp-hl"'));
    expect(top.indexOf('class="bp-hl"')).toBeLessThan(top.indexOf('class="bp-rd"'));
    const rd = between(top, 'class="bp-rd"', '');
    expect(rd).toContain('<b>5 of 12</b><span class="of">claims supported</span>');
    expect(rd).toContain('class="bp-strip"');
    expect(between(top, 'class="bp-hl"', 'class="bp-rd"')).not.toContain('claims supported');
  });

  it('shows the manuscript as its file name, linked into the vault viewer with the full path in its tooltip', async () => {
    const [main] = mainCol(await render(paper()));
    const hl = between(main, 'class="bp-hl"', 'class="bp-rd"');
    expect(hl).toContain('<span class="bp-hk">Manuscript</span><span class="bp-hv"><a class="bp-vf" href="#vault/Vault/papers/kq/PAP-1 draft/README.md" data-vf="/Vault/papers/kq/PAP-1 draft/README.md" title="/Vault/papers/kq/PAP-1 draft/README.md">README.md</a></span>');
  });

  it('shows a manuscript this viewer cannot read as not available, with no path', async () => {
    for (const sources of [[{ text: 'PAP-1 draft/README.md', where: 'missing' }], []]) {
      const [main] = mainCol(await render(paper({ sources })));
      const hl = between(main, 'class="bp-hl"', 'class="bp-rd"');
      expect(hl).toContain('Not available to you');
      expect(hl).not.toContain('README');
      expect(hl).not.toContain('data-vf');
    }
  });

  it('lists the milestones that deliver it, by short name, joined by " · ", with the full title in the tooltip; without a short name the title is cut off with an ellipsis', async () => {
    const long = 'Pre-registration of the removal-plan study';
    const d = paper({ links: { out: [], in: [
      { key: 'M3', title: 'Paper submitted to the journal', short: 'Submission', kind: 'milestone', rel: 'delivers', status: 'planned' },
      { key: 'M4', title: long, kind: 'milestone', rel: 'delivers', status: 'planned' },
      { key: 'M5', title: 'Prototype', kind: 'milestone', rel: 'delivers', status: 'planned' }] } });
    const [main] = mainCol(await render(d));
    const dl = between(main, '<span class="bp-hk">Delivers</span>', 'class="bp-rd"');
    expect(dl).toContain('<button type="button" class="bp-inl" data-bp="prj|M3" title="Paper submitted to the journal">Submission</button> · ');
    expect(dl).toContain(`title="${long}">Pre-registration of the…</button>`);
    expect(dl).toContain('data-bp="prj|M5" title="Prototype">Prototype</button>');
    expect(long.slice(0, 23).trimEnd() + '…').toBe('Pre-registration of the…');
  });

  it('leaves out the Delivers line when no milestone delivers the paper, and the Manuscript line when it has none', async () => {
    const [main] = mainCol(await render(paper({ item: { ...paper().item, fields: { venue: 'Workshop' } }, links: { out: [], in: [] }, sources: [] })));
    expect(main).not.toContain('Delivers');
    expect(main).not.toContain('Manuscript');
  });

  it('moves studies out of Links into their own card', async () => {
    const [, side] = mainCol(await render(paper()));
    const studies = between(side, '<h4>Studies · 1</h4>', '</section>'), links = between(side, '<h4>Links</h4>', '</section>');
    expect(studies).toContain('H-L2-03'); expect(links).not.toContain('H-L2-03'); expect(links).toContain('L2');
  });

  it('draws chips with 3 px corners and the readiness strip with 1 px segments; the readiness block drops below the title on a phone', () => {
    const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
    expect(css).toContain('--r-chip:3px');
    for (const sel of ['.pill{', '.chk{', '.hd .n,.dh .n{']) expect(css.slice(css.indexOf(sel)).split('\n')[0], sel).toContain('border-radius:var(--r-chip)');
    expect(css.split('\n').find((l) => l.startsWith('.bp-strip i{'))).toContain('border-radius:1px');
    expect(css).toMatch(/@media \(max-width:719\.98px\)\{\.bp-top\{grid-template-columns:minmax\(0,1fr\)/);
  });

  it('leads a link row with its title and starts the second line with the key', async () => {
    const [, side] = mainCol(await render(paper()));
    const studies = between(side, '<h4>Studies · 1</h4>', '</section>');
    expect(studies).toContain('<span class="lrow-title">Review catches false positives</span><span class="lrow-meta"><span class="bp-k">H-L2-03</span> · Hypothesis · studies</span>');
    expect(studies).toContain('title="Review catches false positives · H-L2-03 · Hypothesis · studies"');
  });
});

describe('Blueprint rows: title first', () => {
  it('puts the title alone on the first line, the key first on the second, and the full text in the tooltip', () => {
    const { bpTM, row } = load({});
    const r = row({ ...bpTM('CLM-3', 'Field model holds', raw('R2 Field model <b>frozen</b> · Draft'), { 'data-bp': 'prj|CLM-3', title: 'Title codes: P25' }) });
    expect(r).toMatch(/^<button class="lrow" type="button" title="Field model holds · CLM-3 · R2 Field model frozen · Draft. Title codes: P25" data-bp="prj\|CLM-3">/);
    expect(r).toContain('<span class="lrow-title">Field model holds</span><span class="lrow-meta"><span class="bp-k">CLM-3</span> · R2 Field model <b>frozen</b> · Draft</span>');
    // A row with nothing to open stays a plain row, not a button.
    expect(row({ ...bpTM('L2', 'Review quality', 'part of') })).toMatch(/^<div class="lrow" title="Review quality · L2 · part of">/);
  });

  it('changes every two-line bpT row and keeps the one-line rows', () => {
    expect(js.match(/bpTM\(/g)?.length).toBeGreaterThanOrEqual(17); // the declaration and 16 rows
    const left = [...js.matchAll(/row\(\{[^\n]*?bpT\([^\n]*?\}\)/g)].map((m) => m[0]);
    expect(left).toHaveLength(2);
    left.forEach((x) => expect(x).toContain('one: true'));
  });
});
function raw(html: string) { return { html }; }

describe('requirement chips', () => {
  const t = { id: 'team_1', project_id: 'prj', plan: { requirements: [{ key: 'R1', title: 'Search works', priority: 'must', status: 'open' }], milestones: [{ key: 'M1', title: 'Ship it', status: 'planned' }] } };
  const k = { id: 'k_1', refs: ['R1', 'M1', 'R9'] };
  it('on the task screen opens the item in the task\'s project, milestones too; a removed key does not navigate', () => {
    const h = load({}).refChips(k, t, { open: true });
    expect(h).toContain('<button type="button" class="ref" data-ref-bp="prj|R1" aria-label="Open R1 · Must · Open: Search works">R1');
    expect(h).toContain('data-ref-bp="prj|M1"');
    const gone = h.split('<button').find((x) => x.includes('>R9'))!;
    expect(gone).not.toContain('data-ref-bp');
    expect(gone).toContain('R9 is not in the Blueprint any more');
  });

  it('on board cards is a tip only: not focusable, and a click opens the task', () => {
    const h = load({}).refChips(k, t, { task: 'team_1|k_1' });
    expect(h).not.toContain('<button'); expect(h).not.toContain('tabindex'); expect(h).not.toContain('data-ref-bp');
    expect(h.match(/<span class="ref" data-task="team_1\|k_1">/g)).toHaveLength(3);
    expect(js).toContain("refChips(k, t, { task: `${id}|${k.id}` })");
    expect(js).toContain("kv('Requirement', refChips(k, t, { open: true }))");
  });

  it('a task-screen chip opens the item on click or Enter, and a sheet with Open on touch', () => {
    const click = block("const rb = t.closest('[data-ref-bp]');", 'return;\n  }');
    expect(click).toContain("if (!matchMedia('(hover: none)').matches) { openD('bp', rb.dataset.refBp); return; }");
    expect(click).toContain('data-bp="${esc(rb.dataset.refBp)}">Open</button>');
    expect(js.indexOf("t.closest('[data-ref-bp]')")).toBeLessThan(js.indexOf("t.closest('[data-info]')"));
  });
});

describe('paper summary card', () => {
  it('puts the paper summary in the card under a divider, and shows no empty block when there is none', async () => {
    const [withSum] = mainCol(await render(paper()));
    const card = between(withSum, 'aria-label="Paper summary"', '</section>');
    expect(card).toContain('class="bp-psum"');
    const [none] = mainCol(await render(paper({ plain: { summary: '', records: null } })));
    expect(between(none, 'aria-label="Paper summary"', '</section>')).not.toContain('bp-psum');
    expect(none).not.toContain('No summary written');
  });
});

describe('paper summary card: order and breakdown', () => {
  it('the summary follows the readiness strip and comes before Holding it back', async () => {
    const [main] = mainCol(await render(paper()));
    const card = between(main, 'aria-label="Paper summary"', '</section>');
    const at = ['class="bp-rd"', 'class="bp-strip"', 'class="bp-psum"', 'class="bp-held"'].map((x) => card.indexOf(x));
    at.forEach((x) => expect(x).toBeGreaterThan(-1));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('a paper with unsupported claims says in words how many are weak, unsupported and contradicted', async () => {
    const [main] = mainCol(await render(paper()));
    const card = between(main, 'aria-label="Paper summary"', '</section>');
    expect(card).toContain('<p class="meta bp-brk">3 weak · 3 unsupported · 1 contradicted</p>');
    // The strip keeps its single label for screen readers.
    expect(card.match(/role="img"/g)).toHaveLength(1);
  });

  it('an all-supported paper has no breakdown line', async () => {
    const all = claims.slice(0, 4).map((c) => ({ ...c, support: 'supported' }));
    const [main] = mainCol(await render(paper({ paper: { claims: all, supported: 4, total: 4, holding: [], ready: true } })));
    expect(main).not.toContain('bp-brk');
  });
});
