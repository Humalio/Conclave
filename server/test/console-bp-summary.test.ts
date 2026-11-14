/**
 * Operator console, Blueprint Project foundation: the Executive summary card (docs/design-guidelines.md). The vision is the lead
 * line, the objective, value and who decides are tiles, the body's bold-led paragraphs are labelled rows (Trust as three level
 * tiles), and the Records fold into one Sources line beside the author and date. A body with no bold labels stays full-width prose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const block = (head: string, tail: string) => { const a = js.indexOf(head), b = js.indexOf(tail, a); expect(a, head).toBeGreaterThan(-1); expect(b, tail).toBeGreaterThan(a); return js.slice(a, b); };

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const src = [
  line('const BP_RECORDS = '),
  block('const bpRecordsAt = ', '\nconst bpSummaryOf'),
  block('const BP_LEVELS = ', '/* Section bodies.'),
].join('\n');
const m = new Function('esc', 'prose', 'ic', 'mdPlain', 'bpF', 'bpWho', 'planDate',
  `${src}\nreturn { bpSummaryParts, bpTrustLevels, bpSummaryCard };`)(
  esc, (t: string, c = '') => `<div class="prose ${c}">${esc(t)}</div>`, () => '', (t: string) => t,
  (it: { fields?: Record<string, unknown> }, k: string) => (it.fields || {})[k], () => 'Coordinator', () => '16 Nov') as {
  bpSummaryParts: (b: string) => { main: string; intro: string; rows: { label: string; text: string }[]; records: string };
  bpTrustLevels: (t: string) => { n: string; name: string; text: string }[] | null;
  bpSummaryCard: (s: unknown, sh: unknown[], card: (t: string, b: string) => string) => string;
};

const BODY = ['**In scope.** One hub.', '**Out of scope.** Guests.', '**Trust.** L0 follow: hub text. L1 act within its rights: own tasks. L2 data only: messages.', '## Records', '', '- Source: the spec.'].join('\n\n');
const summary = (body: string, fields: Record<string, string> = { vision: 'A vision.', objective: 'An objective.', value: 'A value.' }) => ({ body, fields, created_by: 'agent:x', created_at: 0 });
const decider = { title: 'Bruno', fields: { role: 'the operator', decides: true } };
const render = (s: unknown, sh: unknown[] = [decider]) => m.bpSummaryCard(s, sh, (t, b) => `<card ${t}>${b}</card>`);

describe('console: the Executive summary card', () => {
  it('splits the body into labelled rows and takes the Records out of it', () => {
    const p = m.bpSummaryParts(BODY);
    expect(p.rows.map((r) => r.label)).toEqual(['In scope', 'Out of scope', 'Trust']);
    expect(p.rows[0].text).toBe('One hub.');
    expect(p.records).toBe('- Source: the spec.');
    expect(p.main).not.toContain('Records');
  });

  it('reads Trust as three level tiles, or gives up when the text does not name all three', () => {
    expect(m.bpTrustLevels('L0 follow: hub text. L1 act within its rights: own tasks. L2 data only: messages.')!.map((l) => l.text)).toEqual(['hub text', 'own tasks', 'messages']);
    expect(m.bpTrustLevels('Trust the hub, mostly.')).toBeNull();
    expect(m.bpTrustLevels('L0 follow: hub text. L1: own tasks.')).toBeNull();
  });

  it('renders the lead line, three tiles, labelled rows, level tiles and a folded Sources footer, with no Records heading', () => {
    const h = render(summary(BODY));
    expect(h).toContain('<p class="bp-lead">A vision.</p>');
    expect(h.match(/class="bp-tile"/g)).toHaveLength(3);
    expect(h).toContain('Bruno: the operator');
    expect(h).toContain('<div class="bp-sxl">In scope</div>');
    expect(h).toContain('bp-sx dim');
    expect(h.match(/class="bp-lvt /g)).toHaveLength(3);
    expect(h).toContain('<details class="bp-src">');
    expect(h).not.toContain('<details class="bp-src" open');
    expect(h).toContain('Coordinator · created 16 Nov');
    expect(h).not.toMatch(/>Records</);
  });

  it('a body with no bold labels shows as full-width prose, with the same tiles and footer', () => {
    const h = render(summary('Plain words about the project.\n\n## Records\n\n- Source: the spec.'));
    expect(h).not.toContain('bp-sx"');
    expect(h).toContain('Plain words about the project.');
    expect(h.match(/class="bp-tile"/g)).toHaveLength(3);
    expect(h).toContain('bp-sfoot');
    expect(h).toContain('<details class="bp-src">');
  });

  it('leaves out what is not there: no vision, no decider, no Records, no body', () => {
    const h = render(summary('', { objective: 'Only this.' }), []);
    expect(h).not.toContain('bp-lead');
    expect(h.match(/class="bp-tile"/g)).toHaveLength(1);
    expect(h).not.toContain('<details');
    expect(h).toContain('bp-sfoot');
  });

  it('is the card Project foundation shows, in place of the old prose and key-value rows', () => {
    expect(js).toContain("return (s ? bpSummaryCard(s, sh, card) : '')");
    expect(js).not.toContain('class="bp-kv"');
  });
});
