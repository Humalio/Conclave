/**
 * Operator console, Blueprint Questions view (docs/blueprint.md §9): Waiting on someone has one block, with its Copy as one message
 * button, for every stakeholder asked an open question, including one whose questions all sit under Blocking work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const bpQWho = new Function(`${line('const bpQWho = ')}\nreturn bpQWho;`)() as (w: unknown[], b: unknown[]) => string[];

const q = (key: string, asked_to: string | null, kind = 'question') => ({ key, kind, asked_to });

describe('console: Questions view stakeholder blocks', () => {
  it('a stakeholder whose only open question blocks work still gets a block and a Copy button', () => {
    expect(bpQWho([], [q('Q-BOOK-01', 'SH-1')])).toEqual(['SH-1']);
    const fn = js.slice(js.indexOf('async function bpQuestions('), js.indexOf('\n}', js.indexOf('async function bpQuestions(')));
    expect(fn).toContain('const who = bpQWho(wait, block);');
    expect(fn).toContain("(who.length ? bpQCard('Waiting on someone',");
  });
  it('joins waiting and blocking askers once each, sorted, and leaves out issues and unasked questions', () => {
    const wait = [q('Q-2', 'SH-2'), q('Q-3', 'SH-1')];
    const block = [q('Q-1', 'SH-1'), q('Q-4', 'SH-3'), q('I40', null, 'issue'), q('Q-5', null)];
    expect(bpQWho(wait, block)).toEqual(['SH-1', 'SH-2', 'SH-3']);
    expect(bpQWho([], [q('I40', 'SH-9', 'issue')])).toEqual([]);
  });
});
