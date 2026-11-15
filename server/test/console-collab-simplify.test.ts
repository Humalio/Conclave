/**
 * The collaborator console, simplified: Home starts with the project cards (no Needs you card), a project card is its name
 * and a chevron, a project's Overview shows its Needs you block only for what waits (else only For awareness, else
 * nothing), and the account page says "Collaborator" alone. Static: the functions from public/app.js run with stubs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
const fn = (head: string) => { const i = at(head); return js.slice(i, js.indexOf('\n}\n', i) + 3); };

const stubs = {
  esc: (s: unknown) => String(s), overline: (t: string, n?: number) => `<ov>${t}${n ?? ''}</ov>`, kd: (t: string, x = '') => `<h3>${t}</h3>${x}`, none: (_i: string, t: string) => `<none>${t}</none>`,
  muCapped: (r: string[]) => r.join(''), laterRow: (r: { id: string }) => `<later>${r.id}</later>`, nyRow: (r: { id: string }) => `<ny>${r.id}</ny>`, awRow: (r: { id: string }) => `<aw>${r.id}</aw>`,
  muNyOpen: () => '', muTeamN: (t: string) => t, muProjOf: () => ({ id: 'prj_a' }), muNdCount: () => 0, ic: () => '', bpHealth: () => '<health>', bpBars: () => '<bars>', bpTM: () => ({}), row: () => '', bpSt: () => '', cap: (s: string) => s,
  bpK: (k: string) => `<k>${k}</k>`, plural: (n: number, w: string) => `${n} ${w}s`, planDate: () => 'soon',
};
const needsCard = (nd: { items?: unknown[]; awareness?: { items: unknown[] }; later?: { items: unknown[] } }, pid?: string) => {
  const MU = { nd, me: { deciding_now: [] }, ndErr: false };
  const ctx = { ...stubs, MU, muInP: () => () => true };
  const src = `const muNeeds = () => (MU.nd.items || []).map((r) => nyRow(r));\nconst muAware = () => (MU.nd.awareness?.items || []).map((r) => awRow(r));\n${fn('function muNeedsCard(')}\nreturn muNeedsCard(pid);`;
  return new Function(...Object.keys(ctx), 'pid', src)(...Object.values(ctx), pid) as string;
};
const R = { id: 'r1' }, A = [{ id: 'a1' }, { id: 'a2' }];

describe('collaborator Home and project cards', () => {
  it('Home starts with the project cards: no Needs you card, whether or not something waits', () => {
    const home = js.slice(at('  async home() {'), at('  async projects() {'));
    expect(home).not.toContain('muNeedsCard');
    expect(home).toContain('const left = (P.map((p, i) => muProjCard(p, sums[i])).join(');
    expect(home).toContain('No projects yet');
  });

  it('a project card starts with the project name and the chevron: no overline, key or team count', () => {
    const ctx = { ...stubs };
    const card = new Function(...Object.keys(ctx), 'p', `${fn('function muProjCard(')}\nreturn muProjCard(p, null);`)(...Object.values(ctx), { id: 'prj_a', name: 'ECHO', key: 'ECHO', kind: 'research', teams: [{}], health: 'ok' }) as string;
    expect(card).toMatch(/^<div class="card kd-card mu-pc">\s*<button type="button" class="mu-pc-h"[^>]*><b>ECHO<\/b><span class="grow"><\/span><\/button>|<b>ECHO<\/b><span class="grow"><\/span>$/m);
    expect(card).not.toContain('<ov>');
    expect(card).not.toContain('<k>');
    expect(card).not.toMatch(/team/i);
  });

  it('the Teams card on Home carries no count in its title', () => {
    expect(js).toContain("${kd('Teams')}${T.map(");
    expect(js.slice(at('  async home() {'), at('  async projects() {'))).not.toContain('Teams · ');
  });

  it('the account page says Collaborator alone', () => {
    expect(js).toContain("kv('Role', 'Collaborator')");
    expect(js).not.toContain("'Colleague')}`");
  });
});

describe('a project\'s Overview Needs you block', () => {
  it('something waits: the card looks as before, with For awareness under it', () => {
    const c = needsCard({ items: [R], awareness: { items: A } }, 'prj_a');
    expect(c).toContain('<h3>Needs you · 1</h3>');
    expect(c).toContain('id="mu-needs"');
    expect(c).toContain('<ny>r1</ny>');
    expect(c).toContain('<ov>For awareness2</ov>');
  });

  it('nothing waiting and nothing for awareness: no card at all', () => {
    expect(needsCard({ items: [], awareness: { items: [] } }, 'prj_a')).toBe('');
    expect(needsCard({}, 'prj_a')).toBe('');
  });

  it('nothing waiting but for-awareness items: a "For awareness · N" card with no empty block', () => {
    const c = needsCard({ items: [], awareness: { items: A } }, 'prj_a');
    expect(c).toContain('<h3>For awareness · 2</h3>');
    expect(c).toContain('<aw>a1</aw><aw>a2</aw>');
    expect(c).not.toContain('Nothing waits');
    expect(c).not.toContain('Needs you');
  });

  it('the Needs you screen (no project) keeps its empty message while For awareness items exist', () => {
    const c = needsCard({ items: [], awareness: { items: A } });
    expect(c).toContain('Nothing waits for you');
    expect(c).toContain('<h3>Needs you</h3>');
  });
});
