/**
 * Operator console, saved Blueprint views and links (docs/dashboard-ux.md, List analysis): a view keeps filters only, opens
 * through the route, and its link holds closed words and the search, never the view's name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
type St = { q?: string; kind?: string; sel?: string; status?: string; f?: string[]; gap?: string; x?: string; g?: string; s?: string };
type V = { id: string; project_id: string; section: number; name: string; pinned: boolean; team?: string } & St;
const lib = new Function('location', `const esc = (s) => String(s);
${line('const routeOf = ')}\n${line('const bpArg = ')}\n${line('const BP_FK = ')}\n${line('const bpFiltStr = ')}\n${line('const bpViewArg = ')}
${fn('function bpVState(')}\n${line('const bpVSt = ')}\n${line('const bpVArg = ')}\n${line('const bpVLink = ')}\n${line('const bpVCount = ')}\n${line('const bpVHere = ')}
return { bpVState, bpVArg, bpVLink, bpVCount, bpVHere };`)({ origin: 'https://hub.example', pathname: '/' }) as {
  bpVState: (team: string, st: St) => Record<string, unknown>; bpVArg: (v: V) => string; bpVLink: (v: V) => string; bpVCount: (v: V) => number; bpVHere: (vs: V[], pid: string, section: string | number) => V[];
};
const view: V = { id: 'bv_0123456789ab', project_id: 'prj_abc', section: 2, name: 'Alice\'s secret plan', pinned: false, team: 'team_x1', kind: 'fr,nfr', sel: 'open', status: 'agreed', f: ['priority:must', 'owner:no'], gap: 'no_ac', x: 'area*milestone', g: 'milestone', s: 'risk', q: 'login' };

describe('console: saved Blueprint views', () => {
  it('keep filters only, and leave out what is empty', () => {
    expect(lib.bpVState('', { q: '', kind: '', sel: '', status: '', f: [], gap: '', x: '', g: '', s: '' })).toEqual({});
    expect(lib.bpVState('team_x1', { q: 'login', kind: 'fr', status: 'agreed', f: ['priority:must'], gap: 'no_ac', x: '-', g: 'milestone', s: 'risk' }))
      .toEqual({ q: 'login', kind: 'fr', status: 'agreed', team: 'team_x1', f: ['priority:must'], gap: 'no_ac', x: '-', g: 'milestone', s: 'risk' });
  });

  it('open through the same route the toolbar writes', () => {
    expect(lib.bpVArg(view)).toBe('prj_abc|2|team_x1|agreed|q=login&kind=fr,nfr&sel=open&f=priority:must,owner:no&gap=no_ac&x=area*milestone&g=milestone&s=risk');
  });

  it('link as v=1 and closed words, with no view name and no count', () => {
    const link = lib.bpVLink(view), hash = decodeURIComponent(link.split('#blueprint/')[1]!);
    expect(link.startsWith('https://hub.example/#blueprint/')).toBe(true);
    expect(hash).toBe('prj_abc|2|team_x1|agreed|v=1&q=login&kind=fr,nfr&sel=open&f=priority:must,owner:no&gap=no_ac&x=area*milestone&g=milestone&s=risk');
    expect(link).not.toMatch(/Alice|secret|plan/);
    expect(hash.split('|')[4]!.split('&').map((p) => p.split('=')[0])).toEqual(['v', 'q', 'kind', 'sel', 'f', 'gap', 'x', 'g', 's']);
    expect(decodeURIComponent(lib.bpVLink({ ...view, q: undefined, f: [], team: '', status: '' }))).toContain('|2|||v=1&kind=fr,nfr&sel=open&gap=no_ac&x=area*milestone&g=milestone&s=risk');
  });

  it('count a view\'s filters, and list only this screen\'s', () => {
    expect(lib.bpVCount(view)).toBe(7);
    expect(lib.bpVHere([view, { ...view, id: 'bv_2', section: 4 }, { ...view, id: 'bv_3', project_id: 'prj_other' }], 'prj_abc', '2').map((v) => v.id)).toEqual([view.id]);
  });

  it('draw Views with Save view as its first row (only while the view differs from the default), read and write the hub, and never the browser', () => {
    expect(js).toContain('BP_VIEW.save = bpViewSave;');
    // Views sits in the toolbar row, so it opens from the unfiltered summary too, not only from a filtered list.
    expect(js).toContain('id="bpViews" aria-haspopup="dialog">Views</button>');
    expect(js).toContain("if (vw) vw.onclick = () => bpViewsSheet({ pid, section: tab, anchor: vw, save });");
    expect(js).toContain("title: 'Save view', attrs: { 'data-bpv-save': '1'");
    expect(js).not.toContain('id="bpSave"');
    const block = js.slice(js.indexOf('const BP_V_MAX'), js.indexOf('BP_VIEW.save = bpViewSave;'));
    expect(block).toContain("api('/blueprint/views')");
    expect(block).toContain("'PUT', { views:");
    expect(block).not.toMatch(/localStorage|sessionStorage/);
    // The 20-view limit is said in words, and a replaced name keeps its view.
    expect(block).toContain('You keep ${BP_V_MAX} views on this screen. Delete one to save another.');
    expect(css).toContain('.bpv{display:flex');
  });
});
