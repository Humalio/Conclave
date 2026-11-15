/* A blocked task's reason is Markdown with an optional Records part. The board's cards, tooltips and the activity feed show its plain
   first part on one line (never asterisks or Records text); the task sheet renders it with the Records folded. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error the console's module has no types
import { mdPlain } from '../public/md.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

// The helpers, cut from the console source and run here.
const between = (a: string, b: string) => { const i = js.indexOf(a), j = js.indexOf(b); expect(i, a).toBeGreaterThan(-1); expect(j, b).toBeGreaterThan(i); return js.slice(i, j); };
const src = `${between('const BP_RECORDS = ', 'const bpOneLine')}\nreturn tkReason;`;
const tkReason = new Function('mdPlain', src)(mdPlain) as (s: string) => string;

const REASON = '**Parked until after the history squash**, then run the token bench.\n\nIt needs a quiet hub.\n\n## Records\n- task_x, branch dev/token-bench';

describe('blocked task reason', () => {
  it('reads as plain text on a card: no asterisks, no Records', () => {
    const t = tkReason(REASON);
    expect(t).toBe('Parked until after the history squash, then run the token bench. It needs a quiet hub.');
    expect(t).not.toMatch(/\*|Records|dev\/token-bench/);
  });

  it('every place that shows the reason goes through it', () => {
    expect(js).not.toMatch(/text: k\.blocked_reason/);
    expect(js).not.toContain('esc(k.blocked_reason');
    expect(js.match(/text: tkReason\(k\.blocked_reason\)/g)?.length).toBe(2);
    expect(js).toContain('trunc(tkReason(k.blocked_reason), 90)');
    expect(js).toContain("e.note ? ': ' + tkReason(e.note)");
  });

  it('the task sheet renders it as Markdown with the Records folded', () => {
    expect(js).toContain("(k.blocked_reason ? tkBlock(k.blocked_reason) : '')");
    const b = between('const tkBlock = ', 'const bpSummaryOf = (body)');
    expect(b).toContain('mdRender(main, mdCtx())');
    expect(b).toContain('<details class="tk-brec"><summary>Records</summary>');
    expect(css).toContain('.tk-brec>summary{cursor:pointer}');
  });
});
