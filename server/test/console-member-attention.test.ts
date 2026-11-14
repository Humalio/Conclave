/**
 * The member console's attention rows (docs/multi-user.md §7): Open on a For awareness row does something on every page,
 * or is not shown. Static, like console-home-needs.test.ts: muNyOpen() from public/app.js runs in vm with the member
 * state stubbed. The Account page says how to get another agent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (head: string) => { const i = js.indexOf(`\n${head}`); if (i < 0) throw new Error(`app.js has no ${head}`); return js.slice(i + 1, js.indexOf('\n}\n', i) + 3); };

const open = (view: string, arg: string | null, o: Record<string, unknown>) => {
  const ctx = { MU: { view, arg }, esc: (s: unknown) => String(s), muProjOf: (t: string) => (t === 'team_1' ? { id: 'prj_1' } : null), out: '' as string, o };
  vm.runInNewContext(`${fn('function muNyOpen(')}\nout = muNyOpen(o);`, ctx);
  return ctx.out;
};

describe('member attention rows', () => {
  it('Open on an item row opens its sheet in its project, on the project page and everywhere else', () => {
    const o = { kind: 'item', id: 'M1', project_id: 'prj_1', team_id: 'team_1' };
    for (const [v, a] of [['p', 'prj_1'], ['home', null], ['p', 'prj_2']] as const) expect(open(v, a, o)).toBe('data-mu-item="M1" data-mu-pid="prj_1"');
    // A row that names only its team still finds the project.
    expect(open('p', 'prj_1', { kind: 'item', id: 'C-1', team_id: 'team_1' })).toBe('data-mu-item="C-1" data-mu-pid="prj_1"');
  });

  it('a stalled agent opens its project, but no Open is shown on that project\'s own page; a paused team has none', () => {
    const o = { kind: 'agent', id: 'agent_1', team_id: 'team_1' };
    expect(open('home', null, o)).toBe('data-mu-go="p|prj_1"');
    expect(open('p', 'prj_1', o)).toBe('');
    expect(open('p', 'prj_1', { kind: 'team', id: 'team_1' })).toBe('');
  });

  it('the click handler opens an item sheet in the project the row names', () => {
    expect(js).toMatch(/const it = t\.closest\('\[data-mu-item\]'\); if \(it\) \{ const pid = it\.dataset\.muPid \|\| \(MU\.view === 'p' \? MU\.arg\.split\('\/'\)\[0\] : ''\);/);
    expect(js).toContain("t.closest('[data-mu-ny-dis]')");
  });

  it('Account says how to get another agent, as text: the hub has no admin contact to link', () => {
    const acc = js.slice(js.indexOf('  async account() {\n    const me = MU.me'), js.indexOf("return muPage('Account'"));
    expect(acc).toContain('<p class="hint mu-acc-more">Need another agent? Ask the hub admin.</p>');
    expect(acc).not.toMatch(/mailto:/);
  });
});
