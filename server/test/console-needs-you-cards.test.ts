/**
 * Operator console, Needs you cards (the Needs you screen and the team page's Needs you section): separate cards that lead
 * with the item's title (one small meta line, the title as the heading, a three-line summary), at most three buttons with the rest in
 * ⋯, Reply… opening the note box in the card, full-width buttons on phones, and no left accents anywhere in the console.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { mdPlain } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const guide = readFileSync(join(process.cwd(), '..', 'docs', 'design-guidelines.md'), 'utf8').replace(/\r\n/g, '\n');
const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
const part = (s: string, end: string) => { const i = at(s); return js.slice(i, js.indexOf(end, i) + end.length); };
const line = (name: string) => part(`const ${name} = `, '\n');
const fn = (head: string) => part(head, '\n}\n');

const SRC = [part('function mdText(', '\n'), ...['ic', 'esc', 'ago', 'plural', 'trunc', 'cap', 'pill'].map(line), part('const NY_KIND = ', '};\n'), line('nyKind'), fn('function nyOpenAttr('),
  line('nyLaterBtn'), fn('function awBtns('), line('nyUntil'), line('nySum'), line('NY_EFFECT_MAX'), part('const nyWho = ', '; };\n'), line('nyTeamOf'), line('nyHeadLine'), line('nyHead'), fn('function nyOpsLine('),
  line('nyReplyBtn'), line('nyReplyBox'), line('nyOpenBtn'), line('nyActBtn'), fn('function nyBody('), part('const nyCardBox = ', '</article>`;\n'), fn('function nyCard(')].join('\n');
const card = (r: unknown) => {
  const ctx: Record<string, unknown> = { S: { teams: [{ id: 'team_a', name: 'Conclave Developers' }] }, Date, mdPlain, NAV_NAMES: new Map([['prj_c', 'Conclave']]), BP_KIND: {}, dt: () => '', bpArg: () => '', bpItemArg: () => '', r };
  vm.createContext(ctx);
  return vm.runInContext(`${SRC}\nnyCard(r)`, ctx) as string;
};
const now = Date.now();
const sc = { project_id: 'prj_c', team_id: 'team_a' };
const blocked = { id: 'task:t1', kind: 'unblock', source: { kind: 'task', id: 't1', version: '3' }, scope: sc, title: 'One consistent page header', reason: 'Blocked', open: { kind: 'task', id: 't1', team_id: 'team_a' },
  actions: [{ id: 'unblock', label: 'Unblock' }], at: now - 60_000, detail: { kind: 'blocked', reason: 'Review the brief. Say go.', blocked_by: 'Coordinator', blocked_at: now - 60_000, assignee: 'Developer 9' } };
const other = { id: 'request:r1', kind: 'access_request', source: { kind: 'request', id: 'r1', version: '1' }, scope: sc, title: 'Developer 1 asks to write notes', reason: 'Inside your ceiling', open: { kind: 'request', id: 'r1' },
  actions: [{ id: 'approve', label: 'Approve', tone: 'ok' }, { id: 'deny', label: 'Deny' }, { id: 'later2', label: 'Ask again' }], at: now - 120_000 };
// The visible buttons: from the start of the button row to the ⋯ button.
const acts = (c: string) => { const i = c.indexOf('<div class="ny-acts">'); return c.slice(i, c.indexOf('data-ny-more', i)); };

describe("Needs you cards lead with the item's title", () => {
  it('one meta line (kind, who, for whom, team, age), then the title as the heading, then its summary, in that order', () => {
    const c = card(blocked);
    const order = ['<p class="ny-hd"><svg', '<span>Task blocked · Coordinator · for Developer 9 · Conclave Developers · 1m ago</span></p>', '<h3 class="ny-msg">One consistent page header</h3>',
      '<p class="ny-sum">Review the brief. Say go.</p>', '<div class="ny-acts">'].map((s) => c.indexOf(s));
    expect(order.every((x) => x > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(c).not.toContain('class="pill'); // the meta line replaces the pill
    expect(c).not.toContain('ny-meta'); // and the separate team line
  });

  it('the meta line names the team, not also the project, and never says how long it waited twice', () => {
    const c = card(blocked);
    expect(c).not.toContain('Conclave ·');
    expect(c).not.toContain('waiting');
    expect(card({ ...blocked, scope: { project_id: 'prj_c', team_id: null } })).toContain('for Developer 9 · Conclave · 1m ago</span>');
  });

  it("the hub's summary and sender lead over the reason; a null summary leaves no third line and no generic instruction", () => {
    const bl = { ...other, id: 'backlog:t2', kind: 'backlog', title: 'Photograph the dump-resistor bay', reason: 'Proposed by Conclave Developers · accept or discard', by: 'Coordinator', summary: 'Take four photos of the bay.' };
    const c = card(bl);
    expect(c).toContain('<span>New brief · Coordinator · Conclave Developers · 2m ago</span>');
    expect(c).toContain('<h3 class="ny-msg">Photograph the dump-resistor bay</h3><p class="ny-sum">Take four photos of the bay.</p>');
    expect(c).not.toContain('accept or discard');
    const none = card({ ...bl, summary: null });
    expect(none).not.toContain('ny-sum');
    expect(none).not.toContain('accept or discard');
    // A kind the hub sends no summary for still shows its reason.
    expect(card(other)).toContain('<p class="ny-sum">Inside your ceiling</p>');
    // A blocked task's summary is the hub's (the block reason) when it sends one.
    expect(card({ ...blocked, summary: 'Waits for the brief.' })).toContain('<p class="ny-sum">Waits for the brief.</p>');
  });

  it('at most three buttons on the card, the main decision first; the rest and Later are in ⋯', () => {
    const c = card(other), a = acts(c);
    expect(a.match(/<button/g)!.length).toBe(3); // two actions and the ⋯ button
    expect(a).toMatch(/^<div class="ny-acts"><button type="button" class="btn pri" data-ny="request:r1\|1\|approve"/);
    expect(c).toMatch(/<div class="ny-more-acts" hidden>.*data-ny="request:r1\|1\|later2".*data-ny-later=/);
    expect(c).toContain('class="btn ic ny-more" data-ny-more aria-haspopup="true" aria-label="More actions: Developer 1 asks to write notes"');
  });

  it('a card with no reason keeps its title as the heading and has no summary line', () => {
    const c = card({ ...other, reason: '' });
    expect(c).toContain('<h3 class="ny-msg">Developer 1 asks to write notes</h3><div class="ny-acts">');
    expect(c).not.toContain('class="ny-sum"');
  });

  it('a question leads with itself; its context is the summary, the task it blocks and the recommendation the extras line', () => {
    const c = card({ id: 'question:q2', kind: 'question', source: { kind: 'question', id: 'q2', version: '1' }, scope: sc, title: 'Ship now?', reason: '', open: { kind: 'question', id: 'q2' }, actions: [], at: now - 60_000,
      by: 'Coordinator', summary: 'The gate passed.', detail: { kind: 'question', context: 'The gate passed.', asked_by: 'Coordinator', blocks: { title: 'Gate task' }, recommended: 'a', options: [{ key: 'a', label: 'Ship now' }, { key: 'b', label: 'Wait' }] } });
    expect(c).toContain('<span>Question for you · Coordinator · Conclave Developers · 1m ago</span></p><h3 class="ny-msg">Ship now?</h3><p class="ny-sum">The gate passed.</p>');
    expect(c).toContain('<p class="meta ny-meta">blocks Gate task · recommends Ship now</p>');
  });

  it('Reply… opens the note box in place of the buttons; ⋯ runs the hidden buttons and Later opens at ⋯', () => {
    expect(js).toContain("const nyr = t.closest('[data-ny-reply]'); if (nyr) { nyReply(nyr); return; }");
    expect(js).toContain("const nym = t.closest('[data-ny-more]'); if (nym) { nyMore(nym); return; }");
    expect(fn('function nyMore(')).toContain("fn: () => nyLater(btn, h.dataset.nyLater, nyAfter)");
    expect(fn('function nyMore(')).toContain('fn: () => h.click()');
    expect(css).toContain('.ny-card:has(>.ny-reply:not([hidden]))>.ny-acts{display:none}');
    // An action from ⋯ that asks for a note opens its sheet at the ⋯ button, not at its hidden button.
    expect(fn('function nyAct(')).toContain("const anchor = (b.closest('[hidden]') && b.closest('[data-ny-row]')?.querySelector('[data-ny-more]')) || b;");
  });

  it('the old Details fold and helper texts are gone', () => {
    expect(js).not.toContain('data-ny-det');
    expect(js).not.toContain('Ask for more and Decline are on the question');
    expect(css).not.toContain('.ny-det');
  });
});

describe('Needs you card styles', () => {
  it('separate cards with a gap, on the team page too, the title in the 16 px lead type and the summary cut to three lines', () => {
    expect(css).toContain('--t-lead:400 16px/24px var(--font-sans);');
    expect(css).toContain('.ny-msg{margin:0;font:var(--t-lead);');
    expect(css).toContain('.ny-sum{margin:0;font:var(--t-body);color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}');
    expect(css).toContain('.ny-hd{display:flex;gap:var(--s2);align-items:flex-start;margin:0;font:var(--t-meta);color:var(--muted);');
    expect(guide).toContain('Top: one meta line, `--t-meta` muted');
    expect(css).toContain('[data-ny-box="team"] .ny-card{background:var(--panel-2)}');
    expect(css).not.toMatch(/\[data-ny-box="team"\] \.ny-card\{[^}]*border:0/);
    expect(css).toContain('.ny-card+.ny-card,[data-ny-box]>div>.ny-card:first-child{margin-top:var(--s3)}');
  });

  it('phones keep the order with full-width buttons', () => {
    expect(css).toContain('  .ny-acts .btn{height:var(--h-touch);flex:1 1 100%;justify-content:center}');
  });

  it('no left accents anywhere in the console', () => {
    expect(css).not.toMatch(/border-(left|inline-start):\s*[3-9]px/);
    expect(css).not.toMatch(/border-(left|inline-start):\s*[2-9]px[^;}]*var\(--(warn|bad|ok|info|accent)/);
    expect(css).not.toContain('.ny-reason');
    expect(guide).toContain('8. **No left accents.**');
    expect(guide).toContain('| `--t-lead` | 400 16/24 |');
    expect(guide).toContain('| Needs you card | `.ny-card` |');
  });
});

describe('question options keep their effect readable before the choice', () => {
  const q = { id: 'question:q1', kind: 'question', source: { kind: 'question', id: 'q1', version: '1' }, scope: sc, title: 'Which path for the gate?', reason: '', open: { kind: 'question', id: 'q1' },
    actions: [], at: now - 60_000, detail: { kind: 'question', context: 'The gate slipped.', blocks: { title: 'Gate task' }, recommended: 'a', options: [
      { key: 'a', label: 'Approve', effect: 'Ships the amendment today.' }, { key: 'b', label: 'Hold', effect: 'Waits a week for the reviewer.' }, { key: 'c', label: 'Split', effect: 'Ships half now, half later.' }] } };
  it('every option with an effect has one visible line on the card, including the one only in ⋯', () => {
    const c = card(q);
    expect(c).toContain('<ul class="ny-fx"><li><b>Approve</b> · Ships the amendment today.</li><li><b>Hold</b> · Waits a week for the reviewer.</li><li><b>Split</b> · Ships half now, half later.</li></ul>');
    expect(c.indexOf('class="ny-fx"')).toBeLessThan(c.indexOf('<div class="ny-acts">'));
    expect(c).toMatch(/<div class="ny-more-acts" hidden>.*Split/);
  });
  it('a question whose options have no effect has no list', () => {
    const plain = { ...q, detail: { ...q.detail, options: q.detail.options.map((o: { key: string; label: string }) => ({ key: o.key, label: o.label })) } };
    expect(card(plain)).not.toContain('ny-fx');
  });
});
