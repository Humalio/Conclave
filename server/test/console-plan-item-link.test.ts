/**
 * Operator console, team page For awareness: a milestone or unclear requirement row carries its own key in its plan link
 * (<team>|ms|M6, <team>|req|FR-CC-02) and the route opens that item; an old link without a key still opens the list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };

const BP_KEY = new Function(`${line('const BP_KEY = ')}\nreturn BP_KEY;`)() as RegExp;
const RID = /^[a-z0-9_]+$/;
const planOk = new Function('RID', 'BP_KEY', `return ${line('  plan: (a) => { const [i, k').trim().replace(/^plan:\s*/, '').replace(/,\s*room:.*$/, '')};`)(RID, BP_KEY) as (a: string) => boolean;
const redirect = new Function('bpTeamTo', 'bpItemArg', 'BP_KEY', `return ${line('  plan: async (a) =>').trim().replace(/^plan:\s*/, '').replace(/,$/, '')};`)(
  async (id: string, tab: string) => ['blueprint', `prj_1|${tab}|${id}`], (p: string, k: string) => `${p}|${k}`, BP_KEY) as (a: string) => Promise<string[]>;

describe('console: For awareness rows open their own item', () => {
  it('a milestone row and an unclear requirement row carry their keys', () => {
    expect(js).toContain("chev: true, attrs: door('ms', m.key) });");
    expect(js).toContain("chev: true, attrs: door('req', r.key) })),");
    expect(js).toContain("door = (go, key = '') => ({ 'data-plan': `${id}|${go}${key ? '|' + key : ''}` });");
  });

  it('accepts a key, and still accepts the old links', () => {
    for (const ok of ['team_a|ms|M6', 'team_a|req|FR-CC-02', 'team_a|ms', 'team_a|req|unclear', 'team_a|sum']) expect(planOk(ok), ok).toBe(true);
    for (const bad of ['team_a|ms|M6;x', 'team_a|ms|m6 ', 'team_a|zzz|M6', 'TEAM|ms|M6']) expect(planOk(bad), bad).toBe(false);
  });

  it('opens the item for a key and the list for an old link', async () => {
    expect(await redirect('team_a|ms|M6')).toEqual(['bp', 'prj_1|M6']);
    expect(await redirect('team_a|req|FR-CC-02')).toEqual(['bp', 'prj_1|FR-CC-02']);
    expect(await redirect('team_a|ms')).toEqual(['blueprint', 'prj_1|4|team_a']);
    expect(await redirect('team_a|req|unclear')).toEqual(['blueprint', 'prj_1|2|team_a']);
  });
});

describe('console: a milestone with no body shows the reason from its latest change note', () => {
  const note = new Function('it', 'd', `return ${line('    const msNote = ').trim().replace(/^const msNote = /, '').replace(/;$/, '')};`) as (it: unknown, d: unknown) => { note: string } | null;
  const revs = [{ rev: 1, note: 'created' }, { rev: 4, note: 'changed' }, { rev: 3, note: '' }, { rev: 2, note: 'Missed: the gate review slipped a week' }];
  it('uses the newest revision that has a note when the body is empty', () => {
    expect(note({ kind: 'milestone', body: '' }, { plain: { summary: '' }, history: { revisions: revs } })?.note).toBe('Missed: the gate review slipped a week');
  });
  it('keeps the body first, and leaves other kinds alone', () => {
    expect(note({ kind: 'milestone', body: 'Reason in the body' }, { plain: { summary: 'Reason in the body' }, history: { revisions: revs } })).toBeNull();
    expect(note({ kind: 'fr', body: '' }, { plain: null, history: { revisions: revs } })).toBeNull();
  });
  it('the summary draws the note and drops "No summary written" for it', () => {
    expect(js).toContain("it.kind === 'ac' || msNote ? '' : 'No summary written'");
    expect(js).toContain('From the latest change');
  });
});
