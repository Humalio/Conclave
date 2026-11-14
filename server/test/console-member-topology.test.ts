/**
 * The collaborator's Topology card draws with the operator's graph code (topoModel, topoScope, topoGraph, topoBase through
 * topoStatic), read-only and limited to the project's teams, so it looks the same and drops the same shared name prefix.
 * Static, like console-topo-prefix.test.ts: the shared functions run from public/app.js with stubbed helpers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const decl = (head: string) => {
  const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1);
  const rest = js.slice(i + head.length), m = /\n(?=const |function |async function |let |\/\*|\/\/|VIEWS\.)/.exec(rest);
  return js.slice(i, i + head.length + (m ? m.index : rest.length));
};
const muCard = decl('function muTopoCard(');

describe('muTopoCard has no drawing of its own', () => {
  it('calls the shared graph code and builds no svg', () => {
    expect(muCard).toContain('topoStatic(');
    expect(muCard).not.toContain('<svg');
    expect(muCard).not.toContain('Math.cos');
    expect(js).not.toMatch(/mu-tg/);
    expect(css).not.toMatch(/mu-tg/);
  });
  it('topoStatic runs topoModel, topoScope, topoGraph and the shared node and edge markup', () => {
    const body = decl('function topoStatic(');
    for (const f of ['topoModel(', 'topoScope(', 'topoGraph(', 'egoNodeParts(', 'egoEdgeParts(']) expect(body).toContain(f);
  });
});

describe('the card draws what a collaborator may see, like the operator graph', () => {
  const names = ['topoModel', 'topoScope', 'topoGraph', 'topoBase', 'topoStatic', 'shelfPack', 'bestPack', 'egoNodeParts', 'egoEdgeParts', 'muTopoSource', 'muTopoCard', 'sharedPrefix', 'projectOf', 'tmProject', 'initials', 'edgeWidth', 'agState', 'AG_STATE'];
  const heads = ['function topoModel(', 'function topoScope(', 'function topoGraph(', 'function topoBase(', 'function topoStatic(', 'function shelfPack(', 'function bestPack(', 'function egoNodeParts(', 'function egoEdgeParts(', 'function muTopoSource(', 'function muTopoCard(', 'const sharedPrefix = ', 'const projectOf = ', 'function tmProject(', 'const initials = ', 'const edgeWidth = ', 'const agState = ', 'const AG_STATE = '];
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const S = { agents: [], teams: [] };
  const build = new Function('S', 'esc', 'plural', 'trunc', 'overline', 'row', 'kd', 'cap', 'ago', 'AG', 'DR', 'REC_MS', 'tasksLabel', 'linkKindLabel',
    `const TG_S = { win: 86400000, layers: { team: true, msg: true, link: true }, focus: null }, TEAM_TOOLS = /^(team_|task_|work_)/, NO_PROJECT = 'No project', TEAM_TONE = {};
const recency = (t) => (!t ? 'old' : Date.now() - t < 30000 ? 'act' : 'rec');
${heads.map(decl).join('\n')}
return { ${names.join(', ')} };`)(S, esc, plural, trunc, (t: string) => `<h>${esc(t)}</h>`, (o: { title: string; meta: string; trail: string }) => `<r>${esc(o.title)}|${esc(o.meta)}|${o.trail}</r>`,
    (t: string, r: string) => `<k>${t}${r}</k>`, (s: string) => s[0].toUpperCase() + s.slice(1), () => '1m', () => undefined, { type: null }, 1, () => '', () => '') as Record<string, (...a: any[]) => any>;

  const label = (n: string) => `BIRAZ · ${n}`;
  const topo = {
    teams: [
      { id: 't1', name: 'Mapping', room_id: 'r1', agents: [{ agent_id: 'a1', label: label('Coordinator'), role: 'coordinator' }, { agent_id: 'a2', label: label('CAD Modeler'), role: 'worker' }] },
      { id: 't2', name: 'Other project team', room_id: 'r2', agents: [{ agent_id: 'a3', label: 'Elsewhere · Scout', role: 'worker' }] },
    ],
    comm_edges: [{ from: 'a1', to: 'r1', room_id: 'r1', room_kind: 'team', count: 3, last_at: Date.now() - 1000 }],
  };
  const p = { name: 'Alpha', teams: [{ id: 't1' }] };
  const html = build.muTopoCard(topo, p) as string;

  it('is limited to the teams of the project', () => {
    expect(html).toContain('<svg class="tg tg-static');
    expect(html).toContain('Mapping');
    expect(html).not.toContain('Other project team');
    expect(html).not.toContain('Scout');
    expect(build.muTopoSource(topo, p).teams.map((t: { id: string }) => t.id)).toEqual(['t1']);
  });
  it('drops the shared prefix from the node names and initials and keeps the full label in the tip', () => {
    expect(html).toContain('Coordinator');
    expect(html).toContain('CAD Modeler');
    expect(html).toContain('<title>BIRAZ · Coordinator · coordinator</title>');
    expect(html).not.toMatch(/class="tg-lbl"[^>]*>BIRAZ/);
    expect(html).toMatch(/class="ini"[^>]*>C[A-Z]?</);
  });
  it('keeps the list under the graph: agent, role and the messages sent in 7 days', () => {
    expect(html).toContain('<r>BIRAZ · Coordinator|Coordinator|<span class="meta">3 messages</span></r>');
    expect(html).toContain('<r>BIRAZ · CAD Modeler|Worker|<span class="meta">Quiet</span></r>');
  });
  it('shows nothing the collaborator cannot know: no live state, no progress bar, edges are read-only', () => {
    expect(html).not.toMatch(/offline|connected|tg-prog|tg-hit|tabindex|data-n=/);
  });
  it('draws nothing for a project without teams in the topology', () => {
    expect(build.muTopoCard(topo, { name: 'Alpha', teams: [{ id: 'zzz' }] })).toBe('');
  });
});
