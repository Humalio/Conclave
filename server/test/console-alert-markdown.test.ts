/**
 * Alert messages and Needs you rows in the console (docs/design-guidelines.md, Markdown contexts): a message that quotes an
 * agent's Markdown (a Blueprint change note with **bold**, a link or `code`) shows as plain text, escaped, never with raw marks.
 * The helpers are loaded from public/app.js in vm with md.js's own functions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { mdPlain, esc } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };

const NOTE = '**Pilot of the Blueprint rewrite** is live, see [the plan](https://example.com/p) and run `blueprint check` <now>';
const PLAIN = 'Pilot of the Blueprint rewrite is live, see the plan and run blueprint check <now>';

const ctx: Record<string, unknown> = {
  mdPlain, esc, trunc: (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s),
  nyKind: () => ['Change note'], nyUntil: () => '', ago: () => '2m',
};
vm.createContext(ctx);
vm.runInContext(`function mdText(t, n) { const s = mdPlain(t); return esc(n ? trunc(s, n) : s); }\n${line('const nySum = ')}\n${line('const nyMeta = ')}\nthis.out = { mdText, nyMeta };`, ctx);
const F = ctx.out as Record<string, (...a: any[]) => string>;

describe('console: alert messages show Markdown as plain text', () => {
  it('mdText drops the marks and the link target and keeps the text escaped', () => {
    const t = F.mdText(NOTE);
    expect(t).toBe(esc(PLAIN));
    expect(t).not.toMatch(/\*\*|`|\]\(|https:/);
  });
  it('the three alert cards print their message through mdText, not esc', () => {
    const msgs = js.split('\n').filter((l) => l.includes('class="alert-msg"'));
    expect(msgs.length).toBe(3);
    for (const l of msgs) { expect(l).toMatch(/alert-msg">\$\{mdText\(/); expect(l).not.toMatch(/alert-msg">\$\{esc\(/); }
    expect(msgs.some((l) => l.includes('mdText(a.msg)'))).toBe(true);
    expect(msgs.some((l) => l.includes('mdText(i.text)'))).toBe(true);
    expect(msgs.some((l) => l.includes('mdText(msg)'))).toBe(true);
  });
  it('a Needs you row strips the marks from its summary or reason (the meta line)', () => {
    expect(F.nyMeta({ kind: 'x', reason: NOTE, at: 1 })).toBe(`Change note · ${PLAIN} · 2m ago`);
    expect(F.nyMeta({ kind: 'x', at: 1 })).toBe('Change note · 2m ago');
    // The hub's summary leads over the reason, and the sender is named by label.
    expect(F.nyMeta({ kind: 'x', reason: 'accept or discard', summary: NOTE, by: 'Coordinator', at: 1 })).toBe(`Change note · Coordinator · ${PLAIN} · 2m ago`);
    expect(F.nyMeta({ kind: 'x', reason: 'accept or discard', summary: null, at: 1 })).toBe('Change note · 2m ago');
  });
  it('the Needs you, For awareness and Later rows strip the marks from their titles', () => {
    for (const head of ['const nyRow = ', 'const awRow = ']) expect(line(head)).toContain("title: mdPlain(r.title || '')");
    expect(js).toContain("title: mdPlain(r.title || ''), meta: [nyKind(r.kind)[0], `Later, ${nyLaterWhen(r.later)}`, r.reason && mdPlain(r.reason)]");
  });
  it('the Needs you card prints its title and summary, and the For awareness card its reason, as plain text', () => {
    expect(js).toContain('<h3 class="ny-msg">${mdText(title || \'\')}</h3>');
    expect(js).toContain('return { sum: mdText([nyUntil(r), nySum(r)].filter(Boolean).join(\' · \')), ctx: \'\', meta: [], acts: L.slice(0, 2), more: L.slice(2) };');
    expect(js).toContain('nyCardBox(r.id, nyHead(r), r.title, mdText([nyUntil(r), nySum(r)].filter(Boolean).join(\' · \')), \'\', \'\', [awBtns(r, open, pfx, false)]);');
  });
  it('the fallback alert text strips the marks before it cuts, so a long note never ends in half a link', () => {
    expect(line('    .slice(0, 4).map(([k, v]) => `${k.replace(/_/g')).toContain('trunc(mdPlain(String(v)), 60)');
  });
});
