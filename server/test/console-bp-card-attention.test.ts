/**
 * Operator console, team page Blueprint card (docs/blueprint.md §9, docs/dashboard-ux.md): the card's "what waits for you"
 * line counts the list Blueprint Review shows, read with the same query, so its button always opens what the line counts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}', i) + 2); };

/* bpReviewTeam, bpReviewQ, bpWaits and bpWaitLine, built from the lines app.js runs. */
const helpers = (() => {
  const a = js.indexOf('const bpReviewTeam = '), b = js.indexOf('\n};', js.indexOf('const bpWaitLine = ')) + 3;
  expect(a).toBeGreaterThan(-1);
  return new Function('NY_Q', 'plural', `${js.slice(a, b)}\nreturn { bpReviewTeam, bpReviewQ, bpWaits, bpWaitLine };`)(
    '/needs-you?limit=200', (n: number, w: string, ws = w + 's') => `${n} ${n === 1 ? w : ws}`);
})();

const row = (kind: string, team: string | null = 'team_a') => ({ kind, scope: { team_id: team } });
const ny = (items: unknown[], aw: unknown[] = []) => ({ items, awareness: { items: aw } });

/* What Blueprint Review (the Needs tab) shows for a list: the Needs you rows, the For awareness rows and the failing ACs. */
const screenTab = (L: ReturnType<typeof ny>, failN: number) => {
  const w = helpers.bpWaits(L); return { needs: w.N.length, aware: w.A.length + failN };
};

describe('console: the Blueprint card and Blueprint Review agree on what waits', () => {
  it('the card reads the same query the Review screen reads, with the same team scope', () => {
    expect(helpers.bpReviewQ('prj_1', '')).toBe('/needs-you?limit=200&project=prj_1&review=1');
    expect(helpers.bpReviewQ('prj_1', 'team_a')).toBe('/needs-you?limit=200&project=prj_1&review=1&team=team_a');
    // One contributing team: both read the whole project; two or more: the team's part.
    expect(helpers.bpReviewTeam(1, 'team_a')).toBe('');
    expect(helpers.bpReviewTeam(2, 'team_a')).toBe('team_a');
    expect(js).toContain("const one = (sum.contributing ?? (sum.parts || []).length) <= 1, team = one ? '' : team0;");
    const team = fn('VIEWS.team = async');
    expect(team).toContain('nyRead(bpReviewQ(s.project.id, bpReviewTeam(s.contributing, id)))');
    expect(team).toContain('bpCard(t, id, bps, bpRev)');
    const bp = fn('VIEWS.blueprint = async');
    expect(bp).toContain('nyRead(bpReviewQ(pid, team)).catch(() => null)');
    expect(bp).toContain('bpWaits(nyB, team)');
    // The card counts from that list, not from the summary's own tally.
    const card = fn('function bpCard(');
    expect(card).toContain('bpWaitLine(ny && bpWaits(ny), n.failing_acs || 0, n.proposals || 0)');
    expect(js).not.toContain('bpNeedsN');
  });

  it('every count the line gives is a count of rows the screen it opens lists', () => {
    const cases: [ReturnType<typeof ny>, number, number, string, string, string][] = [
      [ny([row('unclear')]), 0, 0, '1 item needs you', 'needs', 'Review'],
      [ny([row('proposal'), row('proposal')]), 0, 2, '2 changes wait for you', 'prop', 'Review'],
      [ny([row('proposal'), row('unclear')]), 0, 1, '1 change and 1 item wait for you', 'needs', 'Review'],
      [ny([], [row('claim_not_supported')]), 0, 0, '1 claim not supported', 'needs', 'View'],
      [ny([]), 2, 0, '2 acceptance criteria failing', 'needs', 'View'],
      [ny([], [row('claim_not_supported'), row('missed_milestone')]), 1, 0, '3 items for awareness', 'needs', 'View'],
    ];
    for (const [L, failN, props, text, tab, btn] of cases) {
      const line = helpers.bpWaitLine(helpers.bpWaits(L), failN, props), shown = screenTab(L, failN);
      expect(line, text).toEqual({ text, tab, btn });
      const n = Number(text.match(/\d+/g)!.reduce((a: string, b: string) => String(Number(a) + Number(b))));
      if (tab === 'needs') expect(btn === 'Review' ? shown.needs : shown.aware, text).toBe(n);
      else expect(helpers.bpWaits(L).pr, text).toBe(n);
    }
  });

  it('open proposals that do not wait for this viewer are named as open and open Proposals; nothing at all leaves no line', () => {
    expect(helpers.bpWaitLine(helpers.bpWaits(ny([])), 0, 1)).toEqual({ text: '1 proposal open', tab: 'prop', btn: 'Open' });
    expect(helpers.bpWaitLine(helpers.bpWaits(ny([])), 0, 0)).toBeNull();
  });

  it('a list that cannot be read is said so on the card and on the screen, never "Nothing waits for you"', () => {
    expect(helpers.bpWaitLine(null, 0, 0)).toEqual({ text: 'Could not check what waits for you', tab: 'needs', btn: 'Review' });
    const bp = fn('VIEWS.blueprint = async');
    expect(bp).toContain("nyB ? `<div class=\"bp-c\">${none('check', 'Nothing waits for you', true)}</div>`");
    expect(bp).toContain("none('warn', 'Could not check what waits for you', false,");
    expect(bp).toContain('>Try again</button>');
  });
});
