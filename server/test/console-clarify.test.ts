/**
 * Clarify in the console (docs/dashboard-ux.md, Clarify). The helpers are loaded from public/app.js in vm and their markup
 * checked: the sheet shows the team's question as inert text, Send for whoever may answer, Edit and Drop for the admin only,
 * "Ask the team what's unclear" for an item marked before asks existed, the Needs-you card and Blueprint Review row open the
 * sheet, the item page's Unclear pill is its third entrance, and the answer shows on the item afterwards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from: string, to: string) => { const a = js.indexOf(from), b = js.indexOf(to, a); if (a < 0 || b < 0) throw new Error('missing ' + from); return js.slice(a, b); };
const line = (start: string) => slice(start, '\n');

const ctx: Record<string, any> = { S: { me: null, teams: [] }, MU: { on: false, me: null } };
vm.createContext(ctx);
vm.runInContext(
  [line('const esc = '), line('const MON = '), line('const planDate = '), line('const PRI = '), line('const bpF = '), line('const bpItemArg = '), line('const NY_EFFECT_MAX = '),
    "const overline = (t) => `<div class=\"overline\"><span>${esc(t)}</span></div>`; const prose = (t, c = '') => `<div class=\"md prose ${c}\">${esc(t)}</div>`;",
    "const mdText = (s) => esc(s); const nyUntil = () => ''; const nySum = () => ''; const nyOpsLine = () => '';",
    slice('const CL_CLEARED = ', 'async function clarifySheet('), slice('const bpClarified = ', '</div>`; };') + '</div>`; };',
    slice('const nyLaterBtn = ', '\n'), slice('/* Reply… opens the note box', '/* A card (docs/design-guidelines.md'), slice('function nyBtns(', '/* A row set aside with Later'),
    'this.lib = { clSheetH, clOpenAsk, bpClarified, nyBody, nyBtns, CL_CLEARED };'].join('\n'),
  ctx,
);
const L = ctx.lib;
const at = Date.UTC(2026, 10, 19, 13, 2);
const item = { key: 'AN-R1', kind: 'fr', title: 'Explain the early echo', body: 'Explain why echo 47 arrives early.', rev: 4, updated_at: at,
  fields: { unclear: true, unclear_ask: 'dec_1', priority: 'must', evidence: 'CAP-014 heard it 0.71 s early.' } };
const ask = { id: 'dec_1', status: 'open', team_id: 'team_an', created_at: at, question: 'Does AN-R1 still mean <b>the firmware</b> explanation?' };

describe('the Clarify sheet', () => {
  it('shows the team question as inert text with the requirement as context, and Send for a decider', () => {
    const h = L.clSheetH(item, ask, 'Analysis', false);
    expect(h).toContain('Analysis asks');
    expect(h).toContain('Does AN-R1 still mean &lt;b&gt;the firmware&lt;/b&gt; explanation?');
    expect(h).not.toContain('<b>the firmware</b>');
    expect(h).toContain('Must · marked unclear by Analysis · 19 Nov');
    expect(h).toContain('Explain why echo 47 arrives early.');
    // A requirement's words are its body; with none, the sheet says so as the item page does.
    expect(L.clSheetH({ ...item, body: '' }, ask, 'Analysis', false)).toContain('No summary written');
    expect(h).toMatch(/<details class="cl-ev"><summary>Evidence<\/summary>/);
    expect(h).toContain('id="clSend">Send and mark clear');
    expect(h).toContain('maxlength="2000" data-req');
    expect(h).toContain('data-sheet-close>Later');
    // Edit and Drop change the requirement itself: the admin's only.
    expect(h).not.toContain('clEdit');
    expect(h).not.toContain('clDrop');
  });
  it('gives the admin Edit the requirement and Drop it beside Send', () => {
    const h = L.clSheetH(item, ask, 'Analysis', true);
    expect(h).toContain('id="clSend">Send and mark clear');
    expect(h).toContain('id="clEdit">Edit the requirement');
    expect(h).toContain('id="clDrop">Drop it');
    expect(h).not.toContain('clAsk');
  });
  it('offers an item marked before asks existed "Ask the team what\'s unclear", with no Send and the evidence open', () => {
    const old = { ...item, fields: { ...item.fields, unclear_ask: undefined } };
    const h = L.clSheetH(old, null, 'Analysis', true);
    expect(h).toContain("The team didn&#39;t say what is unclear.");
    expect(h).toContain('id="clAsk">Ask the team what&#39;s unclear');
    expect(h).not.toContain('clSend');
    expect(h).toContain('<details class="cl-ev" open>');
    expect(h).toContain('Your note to the team (the revision note)');
    // A decider has nothing to do on it: no answer box, only Later.
    const m = L.clSheetH(old, null, 'Analysis', false);
    expect(m).not.toMatch(/clAsk|clSend|clEdit|clDrop|<textarea/);
  });
  it('treats an answered or withdrawn ask as nothing to answer', () => {
    expect(L.clOpenAsk({ status: 'needs_info' })).toBe(true);
    expect(L.clOpenAsk({ status: 'answered' })).toBe(false);
    const h = L.clSheetH(item, { ...ask, status: 'answered' }, 'Analysis', false);
    expect(h).toContain('question is closed');
    expect(h).not.toContain('clSend');
    // A declined question: nothing to answer, and the admin may ask the team again (the hub's "its question was declined" row).
    const dec = L.clSheetH(item, { ...ask, status: 'declined' }, 'Analysis', true);
    expect(dec).toContain('Analysis&#39;s question was declined, so there is nothing to answer.');
    expect(dec).toContain('id="clAsk">Ask the team what&#39;s unclear');
    expect(dec).not.toContain('clSend');
    expect(L.clSheetH(item, { ...ask, status: 'declined' }, 'Analysis', false)).not.toContain('clAsk');
  });
  it('says the team cleared it already instead of a bare conflict', () => {
    expect(L.CL_CLEARED).toBe('The team cleared this already');
    const src = slice('async function clarifySheet(', '\n/* The item page after an answer');
    expect(src).toContain("e.code === 'already_clear'");
    expect(src).toContain('Open the requirement');
    expect(src).toContain('{ text, item_rev: it.rev }');
    // Edit and Drop answer first, then write with the answer as the revision note.
    expect(src).toMatch(/if \(open && !\(await answer\(t\)\)\) return false;\n\s+await bpWrite\(pid, \[\{ op: 'upsert', kind: it\.kind, key: it\.key, title, body: st,/);
    expect(src).toMatch(/status: 'dropped'[^\n]*\], t\);/);
  });
});

describe('the entrances', () => {
  const row = { id: 'ny_1', kind: 'unclear', title: 'AN-R1 · Explain the early echo', source: { kind: 'decision', id: 'dec_1', version: 1 }, open: { kind: 'item', project_id: 'p1', id: 'AN-R1' },
    ask: { id: 'dec_1', question: 'Freeze <i>now</i>?', team_label: 'Analysis' }, item: { project_id: 'p1', key: 'AN-R1', priority: 'should' },
    actions: [{ id: 'clarify', label: 'Clarify', input: true }] };
  const open = () => 'data-bp="p1|AN-R1"';
  it('puts the question on the Needs-you card and Clarify first', () => {
    const b = L.nyBody(row, open, 'ny');
    expect(b.sum).toBe('<b>Analysis asks:</b> Freeze &lt;i&gt;now&lt;/i&gt;?');
    expect(b.acts[0]).toContain('data-clarify="p1|AN-R1"');
    expect(b.acts[0]).toContain('btn pri');
    expect(b.acts[1]).toContain('Open requirement');
    expect(b.meta).toEqual(['Should']);
    expect(L.nyBody({ ...row, ask: undefined }, open, 'ny').sum).toBe('The team didn&#39;t say what is unclear.');
    expect(L.nyBody({ ...row, ask: undefined, reason: 'Marked unclear · its question was declined' }, open, 'ny').sum).toBe('The team&#39;s question was declined.');
  });
  it('gives the Blueprint Review row Clarify and Later', () => {
    const h = L.nyBtns(row, open);
    expect(h).toMatch(/^<button type="button" class="btn sm pri" data-clarify="p1\|AN-R1"/);
    expect(h).toContain('data-ny-later="ny_1|1"');
  });
  it('makes the item page\'s Unclear pill open the sheet, and routes data-clarify', () => {
    expect(js).toContain('class="pill warn pill-btn" data-clarify=');
    expect(js).toContain("const clr = t.closest('[data-clarify]'); if (clr)");
    expect(js).toContain("'unclear', 'unclear_ask', 'stories'");
  });
});

describe('afterwards', () => {
  it('shows who clarified the item, when, and the answer, as plain text', () => {
    ctx.S.me = { username: 'ben', role: 'admin' };
    const h = L.bpClarified({ clarification: { text: 'Any explanation <that holds>.', by_label: 'ben', at, decision_id: 'dec_1' } });
    expect(h).toContain('Clarified by you · 19 Nov');
    expect(h).toContain('Any explanation &lt;that holds&gt;.');
    expect(L.bpClarified({ clarification: { text: 'Yes.', by_label: 'lena', at } })).toContain('Clarified by lena');
    expect(L.bpClarified({})).toBe('');
  });
});
