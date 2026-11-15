/**
 * Topology semantic zoom and focus position (dashboard-ux.md, Topology). The zoom maths (tzClampZ, tzCentre, tzPt, the
 * address suffix) and the focus layout (egoLayout with egoCentre) are loaded from public/app.js in vm: a focused node sits in
 * the middle of the part of the graph on screen and its ring stays inside it, and zoom keeps the picture inside the graph.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from: string, to: string) => { const a = js.indexOf(from), b = js.indexOf(to, a); if (a < 0 || b < 0) throw new Error('missing ' + from); return js.slice(a, b); };
const fnSrc = (name: string) => slice(`function ${name}(`, '\n}\n') + '\n}\n';

type P = { x: number; y: number };
type Ctx = Record<string, any>;
const ctx: Ctx = {};
vm.createContext(ctx);
vm.runInContext(
  "const EGO_RANK = { team: 0, msg: 1, room: 1, link: 2 }; const EGO = { focus: null };\n"
  + slice('const TZ = {', 'const AG_STATE') + fnSrc('egoNbrs') + fnSrc('egoLayout')
  + '\nthis.lib = { TZ, EGO, tzClampZ, tzCentre, tzPt, tzArg, tzArgStr, egoCentre, egoLayout };',
  ctx,
);
const L = ctx.lib;

/* A team hub with members on a ring, laid out on a graph taller than the window. */
function graph(W: number, H: number, members: number) {
  const nodes = new Map<string, { label: string }>(), base = new Map<string, P>(), edges: { kind: string; a: string; b: string; count: number }[] = [];
  nodes.set('team:t1', { label: 'Orchid' }); base.set('team:t1', { x: W / 2, y: H - 120 });
  for (let i = 0; i < members; i++) {
    const id = 'agent_' + i; nodes.set(id, { label: 'Agent ' + i }); base.set(id, { x: 40 + i * 30, y: H - 60 });
    edges.push({ kind: 'team', a: id, b: 'team:t1', count: 1 });
  }
  return { W, H, narrow: W < 560, nodes, base, edges, tz: false, vis: null as null | { y0: number; y1: number }, pbox: new Map(), caps: [] };
}

describe('the focus view centres the focus on screen', () => {
  it('puts a pinned team in the middle of the visible part of a tall graph, with the ring inside it', () => {
    // The Orchid case: a 1400 px graph whose top is 120 px down a 900 px window; the old layout centred at H/2 = 700.
    const G = graph(1000, 1400, 6);
    G.vis = { y0: 0, y1: 900 - 120 };
    L.EGO.focus = 'team:t1';
    const { P, ring } = L.egoLayout(G);
    const f = P.get('team:t1');
    expect(f.x).toBe(500);
    expect(f.y).toBe(390);
    expect(ring).toHaveLength(6);
    for (const id of ring) {
      const p = P.get(id);
      expect(p.y).toBeGreaterThanOrEqual(G.vis.y0 + 40);
      expect(p.y).toBeLessThanOrEqual(G.vis.y1 - 40);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(G.W);
    }
  });
  it('follows a page scrolled down: the visible part starts inside the graph', () => {
    const G = graph(390, 1600, 4);
    G.vis = { y0: 500, y1: 1240 };
    L.EGO.focus = 'agent_2';
    const { P } = L.egoLayout(G);
    expect(P.get('agent_2')).toEqual({ x: 195, y: 870 });
    expect(P.get('team:t1').y).toBeGreaterThan(500);
    expect(P.get('team:t1').y).toBeLessThan(1240);
  });
  it('uses the whole graph when it is all on screen', () => {
    expect(L.egoCentre(800, 500, null)).toEqual({ x: 400, y: 250, hh: 250 });
    expect(L.egoCentre(800, 500, { y0: -20, y1: 900 })).toEqual({ x: 400, y: 250, hh: 250 });
  });
  it('is wired: egoApply measures what is on screen and egoLayout centres there, not at H / 2', () => {
    const apply = fnSrc('egoApply');
    expect(apply).toMatch(/svg\.getBoundingClientRect\(\)/);
    expect(apply).toMatch(/G\.vis = \{ y0, y1 \}/);
    expect(fnSrc('egoLayout')).toMatch(/egoCentre\(W, H, G\.vis\)/);
    expect(fnSrc('egoLayout')).not.toMatch(/cy = H \/ 2/);
  });
});

describe('the zoom', () => {
  it('stays between 1 and 3', () => {
    expect(L.tzClampZ(0.4)).toBe(1);
    expect(L.tzClampZ(2.6)).toBe(2.6);
    expect(L.tzClampZ(9)).toBe(3);
    expect(L.tzClampZ(NaN)).toBe(1);
  });
  it('is the identity at 1x and scales positions about the centre', () => {
    const c = L.tzCentre(null, 1, 1000, 600);
    expect(c).toEqual({ x: 500, y: 300 });
    expect(L.tzPt({ x: 123, y: 456 }, 1, c, 1000, 600)).toEqual({ x: 123, y: 456 });
    const c2 = L.tzCentre({ x: 400, y: 300 }, 2, 1000, 600);
    expect(L.tzPt({ x: 400, y: 300 }, 2, c2, 1000, 600)).toEqual({ x: 500, y: 300 });
    expect(L.tzPt({ x: 450, y: 250 }, 2, c2, 1000, 600)).toEqual({ x: 600, y: 200 });
  });
  it('keeps the zoomed view inside the graph', () => {
    // At 2x the view is 500 by 300, so its centre stays 250 / 150 from the edges.
    expect(L.tzCentre({ x: 10, y: 10 }, 2, 1000, 600)).toEqual({ x: 250, y: 150 });
    expect(L.tzCentre({ x: 990, y: 590 }, 2, 1000, 600)).toEqual({ x: 750, y: 450 });
    for (const z of [1.2, 1.8, 2.6, 3]) {
      const c = L.tzCentre({ x: 0, y: 0 }, z, 1000, 600);
      expect(L.tzPt({ x: 0, y: 0 }, z, c, 1000, 600).x).toBeCloseTo(0, 6);
      expect(L.tzPt({ x: 0, y: 0 }, z, c, 1000, 600).y).toBeCloseTo(0, 6);
    }
  });
  it('moves the resting layout through the zoom in egoLayout (Topology only), with the project middles', () => {
    const G = graph(1000, 600, 2);
    G.tz = true; G.pbox = new Map([['Orchid', { x: 500, y: 480 }]]);
    L.EGO.focus = null; L.TZ.z = 2; L.TZ.c = { fx: 0.5, fy: 0.8 };
    const { P } = L.egoLayout(G);
    // The asked centre (500, 480) is held at y 450 so the 2x view (300 high) ends at the graph's bottom: 300 + (480 - 450) * 2.
    expect(P.get('pc:Orchid')).toEqual({ x: 500, y: 360 });
    G.tz = false;
    expect(L.egoLayout(G).P.get('pc:Orchid')).toEqual({ x: 500, y: 480 });
    L.TZ.z = 1; L.TZ.c = null;
  });
});

describe('the zoom in the address', () => {
  it('reads the focus and the zoom', () => {
    expect(L.tzArg('project:Echo|z2.6@0.42,0.31')).toEqual({ f: 'project:Echo', z: 2.6, c: { fx: 0.42, fy: 0.31 } });
    expect(L.tzArg('|z3@1,0')).toEqual({ f: '', z: 3, c: { fx: 1, fy: 0 } });
    expect(L.tzArg('agent:agent_x')).toEqual({ f: 'agent:agent_x', z: 1, c: null });
    expect(L.tzArg('')).toEqual({ f: '', z: 1, c: null });
  });
  it('leaves a malformed suffix in the focus, where the route check refuses it', () => {
    expect(L.tzArg('team:t1|z9@0.5,0.5').f).toBe('team:t1|z9@0.5,0.5');
    expect(L.tzArg('|z2@2,0.5').f).toBe('|z2@2,0.5');
    expect(js).toMatch(/topology: \(a\) => \{ const t = tzArg\(a\); return !t\.f \|\| TM_FOCUS\.test\(t\.f\); \}/);
  });
  it('writes it back, and nothing at 1x', () => {
    expect(L.tzArgStr('project:Echo', 2.6, { fx: 0.4214, fy: 0.3 })).toBe('project:Echo|z2.6@0.421,0.3');
    expect(L.tzArgStr('', 1, null)).toBe('');
    expect(L.tzArgStr('agent:a_1', 1, { fx: 0.5, fy: 0.5 })).toBe('agent:a_1');
    const back = L.tzArg(L.tzArgStr('team:team_a1', 1.8, { fx: 0.25, fy: 0.75 }));
    expect(back).toEqual({ f: 'team:team_a1', z: 1.8, c: { fx: 0.25, fy: 0.75 } });
  });
});

describe('the two levels', () => {
  it('Overview draws agents as state dots and Details as pills; the focus view keeps the full node', () => {
    const parts = fnSrc('egoNodeParts');
    expect(parts).toContain('<circle class="dot"');
    expect(parts).toContain('<g class="pill">');
    expect(parts).toContain('s-${state}');
    expect(css).toContain('.tg.ov:not(.ego) .tg-agent>:not(title):not(.dot)');
    expect(css).toContain('.tg.det:not(.ego) .tg-agent .pill{display:inline}');
    expect(css).toMatch(/\.tg-agent\.s-work\{--st:var\(--ok\)\}/);
    expect(css).toMatch(/\.tg-agent\.s-wait\{--st:var\(--warn\)\}/);
    expect(css).toMatch(/\.tg-agent\.s-idle\{--st:var\(--idle\)\}/);
  });
  it('switches to Details at 1.8x, and for a project or team scope', () => {
    expect(js).toContain('const TZ_MIN = 1, TZ_MAX = 3, TZ_DET = 1.8, TZ_PROJ = 2.6;');
    expect(fnSrc('egoApply')).toContain("const det = G.tz && (TZ.z >= TZ_DET || !!TG_S.focus);");
  });
  it('Esc zooms back out before it leaves a project scope', () => {
    const esc = js.indexOf("if (topoOn() && TZ.z > TZ_MIN) { tzTo(TZ_MIN); return; }"), scope = js.indexOf('if (topoOn() && TG_S.focus) { topoFocus(null); return; }');
    expect(esc).toBeGreaterThan(0);
    expect(esc).toBeLessThan(scope);
  });
  it('a zoom move honours reduced motion through the shared animation', () => {
    expect(fnSrc('tzTo')).toContain('egoApply(instant)');
    expect(fnSrc('egoAnimate')).toContain('RM()');
  });
  it('only the zoomable Topology takes the pinch; the Members graph and the collaborator card keep the browser zoom', () => {
    expect(css).toContain('.tg.ov,.tg.det{touch-action:pan-x pan-y}');
    expect(css).not.toMatch(/(^|[\n}])\.tg\{[^}]*touch-action/);
    // The zoomable screen always carries one of the two levels; the other graphs carry neither.
    expect(js).toContain("svg.classList.toggle('ov', !!G.tz && !det); svg.classList.toggle('det', !!det);");
    expect(js).toContain('const det = G.tz && (');
    expect(js).toMatch(/<svg class="tg tg-static\$\{G\.narrow \? ' narrow' : ''\}"/);
  });
});
