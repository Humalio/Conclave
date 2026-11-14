/** Operator console, Loading and polling (docs/dashboard-ux.md#loading-and-polling, docs/next-release.md §4 "Console load"). */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i)); };
const batch = () => { const r = fn('refresh'); return r.slice(r.indexOf('await Promise.all(['), r.indexOf(']);', r.indexOf('await Promise.all(['))); };

describe('console: loading and polling', () => {
  it('reads identity once at start and never in a poll', () => {
    expect(js).toContain("api('/me').then(enter, () => showLogin());");
    for (const f of ['refresh', 'refreshTopo', 'wmPoll', 'pollRoom', 'muPoll']) expect(fn(f)).not.toContain("'/me'");
  });

  it('reads the shell in one batch on every screen: grants, requests, alerts and decisions are never gated', () => {
    const b = batch();
    for (const p of ["api('/keys')", "api('/agents')", "api('/alerts?status=open')", "api('/requests?status=pending')", "api('/decisions?status=open')", "api('/sessions?all=1')", "api('/teams')", "api('/lockdown')", "api('/onboarding?status=pending')"]) {
      expect(b, p).toContain(p);
      expect(b, p).not.toContain(`drawn ? ${p}`);
    }
  });

  it("reads Needs you once and not the lists it already holds: Blueprint attention, open checkouts and vault conflicts", () => {
    const r = fn('refresh');
    expect(r).toContain('const nyP = nyRead(NY_Q)');
    for (const p of ["/blueprint/attention", "/checkouts?open=1", "/vault/conflicts"]) expect(r, p).not.toContain(p);
  });

  it("reads Home's and Topology's own data only while one of them is on screen, and again when it is stale on return", () => {
    expect(js).toContain("const drawnOn = () => !$('#overview').hidden;");
    const b = batch();
    for (const p of ["api('/invocations')", "api('/topology')", "api('/metrics')", "api('/links')"]) expect(b, p).toContain(`drawn ? ${p}`);
    expect(fn('refresh')).toContain('if (drawn) { S.inv = iv.invocations; S.top = tp; S.met = mt;');
    expect(fn('closeD')).toContain("if (drawnStale('home')) refresh();");
    expect(js).toContain("if (type === 'topology' && drawnStale('topology')) refreshTopo();");
    expect(fn('refreshTopo')).toContain('readAt.topology = Date.now();');
  });

  it("Topology's 4 s timer reads only what the graph draws and redraws only the graph", () => {
    expect(js).toContain('setInterval(() => { if (!document.hidden && topoOn()) refreshTopo(); }, 4000);');
    const t = fn('refreshTopo');
    expect(t.match(/api\('/g)).toHaveLength(4);
    for (const p of ["'/invocations'", "'/topology'", "'/sessions?all=1'", "'/links'"]) expect(t).toContain(p);
    expect(t).toContain('renderAgentGraph();');
    expect(t).not.toContain('renderAll(');
    expect(t).not.toContain('openD(');
  });

  it('ticks 10 s after the last full refresh ended, so sign-in and an action are not followed by a second full read', () => {
    expect(js).toContain("const nextTick = () => { clearTimeout(refreshT); refreshT = setTimeout(() => { if (document.hidden) nextTick(); else refresh(); }, 10000); };");
    expect(fn('refresh')).toContain('finally { busy = false; if (S.me) nextTick(); }');
    expect(js).not.toContain('setInterval(() => { if (!document.hidden) refresh(); }, 10000);'); // no fixed 10 s interval beside it
  });

  it('a screen poll stops when its screen closes, and Work in motion peeks before it reads a page', () => {
    expect(fn('pollRoom')).toContain("if (DR.type !== 'room' || document.hidden");
    expect(fn('wmPoll')).toContain("$('#overview').hidden) return;");
    expect(js).toContain('WM_PEEK = 5;');
    expect(fn('wmPoll')).toContain('let r = WM.seen.size ? await page(WM_PEEK) : null;');
    expect(fn('wmPoll')).toContain('if (!r || r.events.some((e) => !WM.seen.has(e.id))) r = await page(WM_PAGE);');
  });

  it('ships the trace that measures it', () => {
    expect(existsSync(join(process.cwd(), 'scripts', 'console-load-trace.mjs'))).toBe(true);
  });
});
