/**
 * Blueprint text in the console (docs/design-guidelines.md, Markdown contexts): item titles, row meta and row tooltips are
 * Plain (mdText: no raw ** or backticks, escaped), option labels and pros/cons are Inline (proseLine), and the client finds
 * the Records heading as server/src/blueprint/plain.ts does, never inside a fenced code block. The helpers are loaded from
 * public/app.js in vm with md.js's own functions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { mdPlain, mdInline, esc } from '../public/md.js';
import { splitBody } from '../src/blueprint/plain.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
/** The source from the line that starts with `from` to the end of the line that starts with `to` (both included). */
const cut = (from: string, to: string) => { const a = js.indexOf('\n' + from) + 1, b = js.indexOf('\n' + to, a) + 1; return js.slice(a, js.indexOf('\n', b) + 1); };
const src = [cut('const bpK =', 'const bpT ='), cut('const bpUn =', '};'), cut('/* Where the Records heading is', 'const bpFirst =')].join('\n');
const ctx: Record<string, unknown> = {
  mdPlain, esc, raw: (html: string) => ({ html }), txt: (v: unknown) => (v && typeof v === 'object' && 'html' in v ? (v as { html: string }).html : esc(v)),
  trunc: (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s),
};
vm.createContext(ctx);
vm.runInContext(`function mdText(t, n) { const s = mdPlain(t); return esc(n ? trunc(s, n) : s); }\n${src}\nthis.out = { bpT, bpTM, bpRecordsAt, bpSummaryOf, bpOneLine, bpFirst };`, ctx);
const F = ctx.out as Record<string, (...a: any[]) => any>;

describe('Blueprint titles and rows read as plain text', () => {
  it('a title with ** and backticks shows no marks in the row, the heading form or the tooltip, and stays escaped', () => {
    const r = F.bpTM('FR-7', '**Fast** `runner` <start>', 'Criteria: x');
    expect(r.title.html).toBe('Fast runner &lt;start&gt;');
    expect(r.attrs.title).toBe('Fast runner <start> · FR-7 · Criteria: x');
    expect(F.bpT('FR-7', '**Fast** `runner`').html).toBe('<span class="bp-k">FR-7</span> Fast runner');
  });
  it('codes and ids in a title keep their characters, so code marking still finds them', () => {
    expect(F.bpTM('H-1', 'H_oa rises when T′ drops below CF-28').title.html).toBe('H_oa rises when T′ drops below CF-28');
  });
  it('a hypothesis row\'s criteria read on one line with no marks', () => {
    expect(F.bpOneLine('**Given** the `gate`\n- stops\n- twice')).toBe('Given the gate stops twice');
    expect(F.bpOneLine(null)).toBe('');
  });
  it('a body that starts with **Problem.** gives "Problem." as its first sentence', () => {
    expect(F.bpFirst('**Problem.** The runner stalls.\n\n## Records\n- abc')).toBe('Problem.');
  });
});

describe('the client Records split agrees with the server', () => {
  const cases = [
    'Result.\n\n## Records\n- f6f163d',
    'Write it like this:\n\n```md\nThe result.\n\n## Records\n- the hash\n```\n\nThat is all.',
    'Quoted:\n```\n## Records\n```\nReal.\n### Records\nB',
    'A\n~~~~\n## Records\n~~~\n```\n## Records\n~~~~\nB',
    'No records here.',
  ];
  it.each(cases)('%#', (body) => {
    expect(F.bpSummaryOf(body).trim()).toBe(splitBody(body).summary);
  });
  it('a quoted heading in code does not cut the glossary row\'s first sentence', () => {
    expect(F.bpFirst('```\n## Records\n```\nThe term means this.')).toBe('Records The term means this.');
  });
});

describe('option labels and pros/cons are Inline', () => {
  it('the decision card renders them through proseLine, not esc', () => {
    const line = js.split('\n').find((l) => l.includes("overline('Options considered')"))!;
    expect(line).toContain('proseLine(o.label)');
    expect(line).toContain('.map(proseLine)');
    expect(line).not.toContain('esc(o.label)');
    expect(mdInline('**Fast** path', { links: false })).toContain('<strong>Fast</strong>');
  });
});

describe('titles main added since', () => {
  it('a module heading shows its title as plain text, and a Waiting on chip\'s tooltip too', () => {
    expect(js.split('\n').find((l) => l.includes("card('2.1 Functional · by module'"))).toContain('${mdText(m.title)}');
    const wait = js.split('\n').find((l) => l.includes('class="meta warn-t bp-wait">Waiting on'))!;
    expect(wait).toContain('mdPlain(l.title)');
    expect(wait).not.toContain('esc(l.title ||');
  });
});
