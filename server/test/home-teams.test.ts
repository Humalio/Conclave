/**
 * Home: one team list, a declared layout, Topology as its own tab (docs/proposals/console-systems.md §5). Source-level checks
 * of the console (server/public/app.js), plus the pure route helpers run against a stub S.
 * HOME-1: the team list is a component (TL, tlOn, mountTeamList), not a route, and Home's route holds its state (#home/o=&k=&q=).
 * HOME-2: Home is declared once: HOME_CARDS (app.js) in DOM order, one grid-template-areas block (style.css); Activity sizes from its
 * own box; Backlog is always shown; the team list is mounted in the Home Teams card (every team, no cut-off).
 * HOME-3: Topology is its own Work tab (#topology/<focus>, D-10).
 * HOME-4: the Teams tab is gone; old #teams links are aliases (BP_REDIRECT.teams), and every former Teams target is Home with the
 * operator's list filters (homeListArg, D-8).
 * HOME-5: the key figures are a half-height strip from 768 px: one baseline line per cell, no sparklines (D-11).
 * HOME-6 (design review): no Home id is reused by a view, and Organize keeps its label when the toolbar wraps.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const RD = 'Research & Development';
/* One top-level declaration of app.js, from its first line to the next top-level declaration or comment. */
const take = (start: RegExp) => {
  const i = SRC.search(start); if (i < 0) throw new Error(`not found: ${start}`);
  const rest = SRC.slice(i), end = rest.slice(1).search(/\n(?=const |function |async function |let |VIEWS\.|\/\*)/);
  return rest.slice(0, end < 0 ? undefined : end + 1);
};

/* BP_REDIRECT with the list helpers it calls, run against a stub S: where an old #teams link or a Topology link lands. */
const redirect = (S: Record<string, unknown> = { org: '', tkw: '' }) => {
  const code = [/^const TM_ORG = /m, /^const TM_FOCUS = /m, /^const tmTopo = /m, /^function tmArgs\(/m, /^const tmArgStr = /m, /^const tmKws = /m, /^function tmFilters\(/m, /^const BP_REDIRECT = /m].map(take).join('\n');
  return new Function('S', 'bpTeamTo', 'bpArg', `${code}\nreturn BP_REDIRECT;`)(S, () => null, () => '') as Record<string, (a: string) => Promise<[string, string]>>;
};

describe('HOME-1: the team list on any route, its state in #home', () => {
  // TM_ORG to tmFilters and homeOpen, with the DOM and the router stubbed: what homeOpen writes into the address.
  const code = [/^const TM_ORG = /m, /^const TL = /m, /^const TM_FOCUS = /m, /^function tmArgs\(/m, /^const tmArgStr = /m, /^const homeListArg = /m, /^const tmKws = /m, /^function tmFilters\(/m, /^const TM_UI = /m, /^function homeOpen\(/m].map(take).join('\n');
  const make = (S: Record<string, unknown>) => {
    const routes: [string, string | null, boolean][] = [];
    const $ = () => ({ dataset: {} as Record<string, string> });
    const setRoute = (t: string, a: string | null, push: boolean) => { routes.push([t, a, push]); };
    const fns = new Function('S', '$', 'closeD', 'setRoute', `${code}\nreturn { tmArgs, homeListArg, homeOpen, TL };`)(S, $, () => {}, setRoute) as {
      tmArgs: (a: string) => Record<string, string> | null; homeListArg: () => string; homeOpen: (a: unknown, push: boolean) => void; TL: { args: Record<string, string> };
    };
    return { ...fns, routes };
  };
  const S = { kws: { keywords: [RD, 'Applications'] }, org: 'project', tkw: RD };

  it('ROUTE_OK.home is tmArgs, and restoreRoute passes a valid #home argument on (5.A3)', () => {
    expect(take(/^const ROUTE_OK = /m)).toMatch(/\bhome: tmArgs\b/);
    expect(take(/^function restoreRoute\(/m)).toContain("homeOpen(ROUTE_OK.home(a) ? a : '', false)");
    expect(take(/^function go\(/m)).toContain('homeOpen(arg, true)');
  });

  it('a bare #home writes the remembered Organize and Keyword into the address (5.A3)', () => {
    const H = make(S);
    H.homeOpen(undefined, true);
    expect(H.routes).toEqual([['home', 'o=project&k=Research+%26+Development', true]]);
    expect(H.homeListArg()).toBe('o=project&k=Research+%26+Development');
    // Restored from the address (no new history entry), with nothing remembered: plain #home.
    const N = make({ ...S, org: '', tkw: '' });
    N.homeOpen('', false);
    expect(N.routes).toEqual([['home', null, false]]);
  });

  it('a #home argument is kept as given, and one Home does not write falls back to the remembered choice', () => {
    const H = make(S);
    H.homeOpen('o=status&q=gest', false);
    expect(H.routes.at(-1)).toEqual(['home', 'o=status&q=gest', false]);
    expect(H.homeListArg()).toBe('o=status&k=Research+%26+Development&q=gest');
    H.homeOpen('o=topology&g=project%3AConclave', true);
    expect(H.routes.at(-1)).toEqual(['home', 'o=project&k=Research+%26+Development', true]);
    expect(H.tmArgs('o=topology')).toBeNull();
  });

  it('tmSet writes the list argument into TL.route, replacing the address, never DR.type teams (5.A6)', () => {
    expect(take(/^function tmSet\(/m)).toMatch(/tlWrite\(tmArgStr\(f\)\)/);
    const w = take(/^function tlWrite\(/m);
    expect(w).toContain('TL.args[TL.route] = a');
    expect(w).toMatch(/setRoute\(TL\.route, [^)]*, false\)/);
    expect(take(/^function tmDraw\(/m)).toContain('tmFilters(tlArg())');
    expect(take(/^function tmDraw\(/m)).toContain("TL.host?.querySelector('#tmList')");
    expect(SRC).not.toMatch(/DR\.type [!=]==? ?'teams'/);
  });

  it('the list is mounted by mountTeamList, its state in the Home route; tlOn means the list is on screen', () => {
    expect(SRC).toMatch(/^const TL = \{ host: null, route: 'home', args: \{ home: '' \} \};$/m);
    expect(take(/^const tlOn = /m)).toMatch(/TL\.host\?\.isConnected && !TL\.host\.closest\('\[hidden\]'\)/);
    const m = take(/^function mountTeamList\(/m);
    expect(m).toContain('Object.assign(TL, { host, route })');
    for (const id of ['#tmQ', '#tmK', '#tmSrch', '#tmList']) expect(m).toContain(`$h('${id}')`);
    expect(take(/^function tmRefreshPins\(/m)).toContain('if (tlOn())');
  });

  it('Topology is no longer an Organize choice', () => {
    expect(take(/^const TM_ORG = /m)).not.toContain('topology');
    expect(take(/^function tmToolbar\(/m)).not.toContain('topoTools');
    expect(take(/^async function tmOrg\(/m)).not.toContain('topology');
  });
  it('an old #teams/o=topology&g=<focus> link is accepted by ROUTE_OK.teams and checks its focus', () => {
    expect(take(/^const ROUTE_OK = /m)).toMatch(/teams: \(a\) => !!tmArgs\(a\) \|\| !!tmTopo\(a\)/);
    const tmTopo = new Function(`${take(/^const TM_FOCUS = /m)}\n${take(/^const tmTopo = /m)}\nreturn tmTopo;`)() as (a: string) => { g: string } | null;
    expect(tmTopo('o=topology&g=project%3AConclave')).toEqual({ g: 'project:Conclave' });
    expect(tmTopo('o=topology')).toEqual({ g: '' });
    expect(tmTopo('o=topology&g=team%3Ateam_abc')).toEqual({ g: 'team:team_abc' });
    expect(tmTopo('o=topology&g=nonsense')).toBeNull();
    expect(tmTopo('o=topology&q=x')).toBeNull();
    expect(tmTopo('o=name&g=team%3Ateam_abc')).toBeNull();
  });

  it('focus restore and a refused keyword save act on the mounted list, not the first #tmList in the page', () => {
    for (const f of [/^function tmFocusKey\(/m, /^function tmFocusBack\(/m, /^async function tmKw\(/m]) {
      const c = take(f);
      expect(c).not.toMatch(/\$\(['`]#tm(List|K)\b/);
      expect(c).toContain('TL.host?.querySelector(');
    }
  });
});

describe('HOME-3: Topology as its own Work tab', () => {
  const okTopology = () => {
    const fn = /\btopology: (\(a\) => [^,]+),/.exec(take(/^const ROUTE_OK = /m));
    if (!fn) throw new Error('ROUTE_OK.topology not found');
    // The route reads a zoom suffix (|z<level>@<x>,<y>) off first with tzArg, so its helpers load too.
    const tz = [/^const TZ_MIN = /m, /^const tzClampZ = /m, /^const tzArg = /m].map(take).join('\n');
    return new Function(`${take(/^const TM_FOCUS = /m)}\n${tz}\nreturn ${fn[1]};`)() as (a: string) => boolean;
  };

  it('VIEWS.topology draws the graph with its window, layers and legend only, no Organize and no team requests', () => {
    const v = take(/^VIEWS\.topology = /m);
    expect(v).toContain('await topoPrep(arg)');
    expect(v).toContain('${topoTools()}</div>${topoBody()}');
    expect(v).toContain('topoAfter()');
    expect(v).not.toMatch(/tmToolbar|tlHtml|obTeamsCard|TM_ORG/);
  });

  it('#topology/<focus> is a route of its own: ROUTE_OK.topology takes no focus or a TM_FOCUS one (5.A5)', () => {
    const ok = okTopology();
    expect(ok('')).toBe(true);
    expect(ok('project:Conclave')).toBe(true);
    expect(ok('team:team_abc')).toBe(true);
    expect(ok('agent:ag_x1')).toBe(true);
    expect(ok('nonsense')).toBe(false);
    expect(ok('o=topology&g=project%3AConclave')).toBe(false);
    // A zoomed link keeps the focus check: the zoom suffix is read off first.
    expect(ok('project:Conclave|z2.4@0.5,0.25')).toBe(true);
    expect(ok('|z2@0.5,0.5')).toBe(true);
    expect(ok('nonsense|z2@0.5,0.5')).toBe(false);
  });

  it('BP_REDIRECT has no topology entry, and an old #teams/o=topology&g=<focus> link opens #topology/<focus> (5.A5)', async () => {
    const R = redirect();
    expect(R.topology).toBeUndefined();
    expect(await R.teams('o=topology&g=project%3AConclave')).toEqual(['topology', 'project:Conclave']);
    expect(await R.teams('o=topology')).toEqual(['topology', '']);
  });

  it('a focus change writes #topology/<focus>, and the background refresh never rebuilds the Topology screen', () => {
    expect(take(/^function topoFocus\(/m)).toContain("setRoute('topology', DR.arg, false)");
    expect(SRC).toContain("REFRESH_VIEWS.has(DR.type) && DR.type !== 'topology' && !viewInUse()");
    expect(take(/^const REFRESH_VIEWS = /m)).not.toContain("'topology'");
    expect(take(/^const topoOn = /m)).toContain("DR.type === 'topology'");
    expect(SRC).not.toMatch(/\btmTopoOn\b|\btopoArg\b/);
  });

  it('the Work bar shows Topology and lights it for #topology (D-10)', () => {
    expect(take(/^const TAB_BAR = /m)).toContain("topology: '#agentsBar'");
    expect(take(/^function navOn\(/m)).toContain("topology: 'topology'");
    const html = readFileSync(join(HERE, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
    const bar = html.slice(html.indexOf('id="agentsBar"'), html.indexOf('id="securityBar"'));
    expect(bar).toContain('<button data-go="topology"><svg class="i"><use href="#i-graph"/></svg>Topology</button>');
    expect(bar).toContain('<button type="button" role="tab" data-go="topology">Topology</button>');
  });

  it('on phones the Work tabs scroll the lit tab into view, as Security, Vault and Audit do', () => {
    expect(SRC).toMatch(/\[[^\]]*'#agentsBar'[^\]]*\]\.forEach\(\(b\) => tabsReveal\(\$\(b\)\)\)/);
  });
});

describe('HOME-4: aliases, Teams tab removed, one Home parent', () => {
  const HTML = readFileSync(join(HERE, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const S = { kws: { keywords: [RD, 'Applications'] }, org: 'project', tkw: RD };

  it('the Work bar has no Teams tab and the console has no Teams view (5.A2)', () => {
    expect(HTML).not.toContain('data-go="teams"');
    const bar = HTML.slice(HTML.indexOf('id="agentsBar"'), HTML.indexOf('id="securityBar"'));
    for (const tab of ['home', 'topology', 'sessions', 'chats', 'feedback', 'directives']) expect(bar.match(new RegExp(`data-go="${tab}"`, 'g'))).toHaveLength(2);
    expect(bar.indexOf('data-go="home"')).toBeLessThan(bar.indexOf('data-go="topology"'));
    expect(SRC).not.toMatch(/^VIEWS\.teams = /m);
    expect(SRC).not.toMatch(/\bteams: async \(arg/);
    expect(take(/^const REFRESH_VIEWS = /m)).not.toContain("'teams'");
    expect(take(/^const TAB_BAR = /m)).not.toMatch(/\bteams:/);
    expect(take(/^const AREA = /m)).not.toContain("'teams'");
    expect(take(/^function navOn\(/m)).not.toMatch(/\bteams: |: 'teams'/);
  });

  it('no Teams target is left outside the BP_REDIRECT.teams alias', () => {
    // SES_TABS has an agent page tab keyed teams (the agent's teams), which is not a route. Reset's RS_TABLE rows are
    // [name, go target, arg]: a team part's View goes to hometeams, never the 'teams' alias (that would replace, not push, history).
    const rest = SRC.replace(take(/^const BP_REDIRECT = /m), '').replace(take(/^const SES_TABS = /m), '');
    expect(rest).not.toMatch(/go\('teams'|openD\('teams'|\['teams'\]|\['teams', (?!'Teams')|, 'teams'[\],]|'data-go': 'teams'|go: 'teams'|m: 'teams'|ob: 'teams'/);
    expect(take(/^const RS_TABLE = /m)).toContain("teams: ['Teams', 'hometeams']");
    expect(rest).not.toMatch(/label: 'Teams', go:/);
    expect(rest).not.toMatch(/DR\.type [!=]==? ?'teams'|type === 'teams'/);
  });

  it('an old #teams/<o,k,q> link opens Home with the same list choice, and #teams/o=topology&g=… opens Topology (5.A4, 5.A5)', async () => {
    const R = redirect();
    expect(await R.teams('o=status&q=gest')).toEqual(['home', 'o=status&q=gest']);
    expect(await R.teams('o=topology&g=project%3AConclave')).toEqual(['topology', 'project:Conclave']);
    expect(await R.teams('o=topology')).toEqual(['topology', '']);
    // A bare #teams opens Home with the remembered Organize and Keyword, as a bare #home does.
    const M = redirect(S);
    expect(await M.teams('')).toEqual(['home', 'o=project&k=Research+%26+Development']);
    expect(await M.teams('o=name&k=Applications')).toEqual(['home', 'o=name&k=Applications']);
    // ROUTE_OK.teams still accepts the old shapes, so the alias is reached; openD hands a Home result to homeOpen, replacing the address.
    expect(take(/^const ROUTE_OK = /m)).toMatch(/teams: \(a\) => !!tmArgs\(a\) \|\| !!tmTopo\(a\)/);
    expect(take(/^async function openD\(/m)).toMatch(/if \(type === 'home'\) \{ if \(request === viewRequest\) \{ setBusy\(false\); homeOpen\(arg, false\); \} return; \}/);
  });

  it('a team opened from Home, or a reload of #team/<id>, has "‹ Home" with the list filters as its Back (5.A10)', () => {
    // The route tree (NAVAGENTS-1) holds the parents; console-nav.test.ts runs navTrail for the origins (Home, an agent, a reload).
    const routes = SRC.slice(SRC.indexOf('// ROUTES begin'), SRC.indexOf('// ROUTES end'));
    expect(routes).toContain("const homeUp = () => ['home', homeListArg()];");
    // A team, a new team, Projects and a Blueprint with no team filter hang under Home with the filters, never under #teams.
    expect(routes).toContain('team: { parent: homeUp,');
    expect(routes).toContain("tbuild: navUnder(homeUp, 'New team'), projects: navUnder(homeUp, 'Projects')");
    expect(routes).toMatch(/blueprint: \{\n\s+parent: \(a\) => \{[^\n]*: homeUp\(\); \},/);
    expect(routes).not.toMatch(/'teams'/);
    // Back from Home's crumb goes through go('home', <filters>).
    expect(take(/^function navGo\(/m)).toContain("if (type === 'home') return go('home', arg);");
  });

  it('the ctx-bar Back of #ob/<id> with no history opens Home (5.A11)', () => {
    expect(SRC).toContain("if (t.closest('[data-ctx-back]')) { detailBack(); return; }");
    expect(SRC).toContain("ob: navUnder(homeUp, 'Onboarding request')");
  });

  it('the Tasks key figure and shortcut M open the Home Teams card with its search focused (5.A13, 5.A14)', () => {
    expect(take(/^function kpiDefs\(/m)).toContain("{ id: 'tasks', l: 'Tasks', go: 'hometeams',");
    expect(take(/^function go\(/m)).toContain("else if (t === 'hometeams') homeTeamsFocus();");
    const f = take(/^function homeTeamsFocus\(/m);
    expect(f).toContain("if (DR.type || $('#overview').hidden) go('home', homeListArg());");
    expect(f).toContain('scrollIntoView(');
    expect(f).toContain("card.querySelector('#tmQ')");
    expect(f).toContain('q?.focus(');
    expect(SRC).toContain("const m = { s: 'sessions', m: 'hometeams', c: 'chats',");
    expect(SRC).toContain("['M', 'Teams on Home']");
  });

});

describe('HOME-2: declared Home layout and card registry', () => {
  const HTML = readFileSync(join(HERE, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const CSS = readFileSync(join(HERE, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  const OV = HTML.slice(HTML.indexOf('<div id="overview"'), HTML.indexOf('id="workspaceView"'));
  const GRID = OV.slice(OV.indexOf('<section class="grid home-grid">'));
  const CARDS = [...take(/^const HOME_CARDS = /m).matchAll(/\{ id: '(\w+)', area: '(\w+)', render: (.+?) \},(?: \/\/.*)?$/gm)].map((m) => ({ id: m[1]!, area: m[2]!, render: m[3]! }));
  const areaRows = () => {
    const m = /\.home-grid\{[^}]*grid-template-areas:\s*((?:\s*"[^"]+")+)\s*\}/.exec(CSS);
    if (!m) throw new Error('grid-template-areas not found');
    return [...m[1]!.matchAll(/"([^"]+)"/g)].map((r) => r[1]!.trim().split(/\s+/));
  };

  it('index.html has no Sessions card and no old Teams card (5.A1)', () => {
    for (const gone of ['w-ses', 'w-teams', 'sesT', 'sesN', 'tmCard']) expect(HTML).not.toContain(gone);
    expect(SRC).not.toMatch(/\brenderSes\b|\bSES_N\b|\brenderTeamsCard\b|\bhomeTeams\(|\bhomeTeam\b|#tmCard|#sesT|TEAMS_WIDE/);
    // sesCard stays: Work → Sessions draws its rows with it.
    expect(take(/^VIEWS\.sessions = /m)).toContain('map(sesCard)');
  });

  it('the cards in the Home grid are HOME_CARDS, in the same order, after the alerts and key figures (5.A1)', () => {
    expect(CARDS.map((c) => c.area)).toEqual(['teams', 'bl', 'wm', 'act', 'fleet', 'exp']);
    const ids = [...GRID.matchAll(/<article class="card[^"]*" id="(\w+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(CARDS.map((c) => c.id));
    expect(OV.indexOf('id="ovAlert"')).toBeLessThan(OV.indexOf('id="kpis"'));
    expect(OV.indexOf('id="kpis"')).toBeLessThan(OV.indexOf('class="grid home-grid"'));
    // Backlog is in the grid and never hidden in the markup; it no longer sits above the grid.
    expect(GRID).toMatch(/<article class="card bl-card w-bl" id="blCard" aria-labelledby="blH">/);
    expect(OV.slice(0, OV.indexOf('class="grid home-grid"'))).not.toContain('blCard');
  });

  it('the Teams card has its header actions, then the Team requests band, then the list host', () => {
    const tm = GRID.slice(GRID.indexOf('id="homeTeams"'), GRID.indexOf('id="blCard"'));
    expect(tm).toContain('<h2 id="tmH">Teams</h2><span class="meta" id="tmN"></span>');
    expect(tm.indexOf('data-go="projects"')).toBeLessThan(tm.indexOf('data-go="tbuild"'));
    expect(tm.indexOf('data-go="tbuild"')).toBeLessThan(tm.indexOf('id="homeTlMore"'));
    // The overflow button is the same small size as its sibling header buttons.
    expect(tm).toContain('<button type="button" class="btn sm ic" id="homeTlMore"');
    // On phones Projects and + Team drop their words (aria-label names them) and no header button shrinks, so 320 px fits.
    expect(tm).toContain('data-go="projects" aria-label="Projects"><svg class="i"><use href="#i-proj"/></svg><span class="hd-lbl">Projects</span>');
    expect(tm).toContain('data-go="tbuild" aria-label="New team"><svg class="i"><use href="#i-plus"/></svg><span class="hd-lbl">Team</span>');
    const css = readFileSync(join(HERE, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toContain('#homeTeams>.hd>.btn{flex:none}');
    expect(css).toContain('@media (max-width:767.98px){\n  #homeTeams>.hd>.btn .hd-lbl{display:none}\n  #homeTeams>.hd>.btn.sm{width:32px;padding:0}\n}');
    expect(tm.indexOf('<div id="homeOb"></div>')).toBeLessThan(tm.indexOf('<div id="homeTl"></div>'));
    expect(SRC).toContain("$('#homeTlMore').onclick = (e) => openMenu([{ label: 'Keywords', icon: 'sl', fn: () => run(() => kwSheet(null)) }], e.currentTarget);");
  });

  it('style.css places the cards with one grid-template-areas block from 1180 px (5.A1)', () => {
    const rows = areaRows();
    const run = (r: string[]) => r.reduce<[string, number][]>((a, x) => { const l = a.at(-1); if (l && l[0] === x) l[1]++; else a.push([x, 1]); return a; }, []);
    expect(rows.map(run)).toEqual([
      [['teams', 12]],
      [['bl', 8], ['wm', 4]],
      [['bl', 8], ['act', 4]],
      [['fleet', 8], ['exp', 4]],
    ]);
    expect(new Set(rows.flat())).toEqual(new Set(CARDS.map((c) => c.area)));
    // Each card's w- class takes its HOME_CARDS area; below 1180 px every card spans the 12 columns, in DOM order.
    for (const c of CARDS) {
      const cls = new RegExp(`<article class="card [^"]*\\b(w-[a-z]+)\\b[^"]*" id="${c.id}"`).exec(GRID)?.[1];
      expect(cls, c.id).toBeTruthy();
      expect(CSS).toContain(`.${cls}{grid-area:${c.area}}`);
    }
    expect(CSS).toContain('@media (max-width:1179.98px){.home-grid>.card{grid-column:1 / -1}}');
    // Activity's row is the flexible one: a taller Backlog gives its height to Activity, not to Work in motion.
    expect(CSS).toMatch(/\.home-grid\{grid-auto-flow:row;grid-template-rows:auto auto 1fr auto;/);
    expect(CSS).not.toMatch(/\.tmrow|#tmCard|\.w-ses/);
  });

  it('renderAll draws the Home cards by looping over HOME_CARDS, not in a fixed call order', () => {
    const r = take(/^function renderAll\(/m);
    expect(r).toContain('for (const c of HOME_CARDS) c.render?.();');
    expect(r).not.toMatch(/renderBacklog\(|renderTopo\(|renderAct\(|renderHomeTeams\(|loadTree\(/);
    expect(CARDS.map((c) => c.render)).toEqual(['renderHomeTeams', 'renderBacklog', 'null', 'renderAct', 'renderTopo', '() => { loadTree(); renderTree(); }']);
  });

  it('Activity sizes from its own box and redraws through a ResizeObserver; no code reads another card\'s size (5.A9)', () => {
    const a = take(/^function renderAct\(/m);
    expect(a).not.toMatch(/#tmCard|#blCard|#wmCard|offsetHeight|getBoundingClientRect\(\)\.height/);
    expect(a).toContain('Ht = Math.max(box.clientHeight, actFloor())');
    expect(take(/^const actFloor = /m)).toContain("matchMedia('(min-width:768px)').matches ? 190 : 150");
    expect(SRC).toMatch(/^const ACT_RO = typeof ResizeObserver === 'function' \? new ResizeObserver\(/m);
    expect(SRC).toContain("ACT_RO?.observe($('#act'));");
    // The window resize handler no longer redraws Activity (the observer does), and nothing measures #tmCard.
    const rz = SRC.slice(SRC.indexOf("let rz; addEventListener('resize'"), SRC.indexOf("document.addEventListener('visibilitychange'"));
    expect(rz).not.toContain('renderAct');
    expect(CSS).toContain('.w-act{display:flex;flex-direction:column}');
    expect(CSS).toContain('#act{position:relative;flex:1 1 auto;min-height:150px}');
    expect(CSS).toContain('@media (min-width:768px){#act{min-height:190px}}');
    expect(CSS).toContain('#act svg{position:absolute;top:0;left:0;display:block;width:100%;height:100%}');
  });

  it('an empty backlog is one line from 1180 px, and Work in motion and Activity sit side by side under it', () => {
    const run = (r: string[]) => r.reduce<[string, number][]>((a, x) => { const l = a.at(-1); if (l && l[0] === x) l[1]++; else a.push([x, 1]); return a; }, []);
    const head = '@media (min-width:1180px){\n  .home-grid:has(>.w-bl.bl-empty){grid-template-rows:auto auto 1fr auto;grid-template-areas:';
    const at = CSS.indexOf(head);
    expect(at, 'the empty-backlog layout block').toBeGreaterThan(-1);
    const block = CSS.slice(at + head.length, CSS.indexOf('}', at + head.length));
    const rows = [...block.matchAll(/"([^"]+)"/g)].map((r) => r[1]!.trim().split(/\s+/));
    expect(rows.map(run)).toEqual([[['teams', 12]], [['bl', 12]], [['wm', 6], ['act', 6]], [['fleet', 8], ['exp', 4]]]);
    // Same cards, same DOM order: only the placement changes, and only from 1180 px.
    expect(new Set(rows.flat())).toEqual(new Set(CARDS.map((c) => c.area)));
    expect(CSS).toContain('.w-bl.bl-empty>.hd{display:contents}');
    // renderBacklog marks the card: empty means nothing waiting, nothing relayed and no tag chosen.
    const b = take(/^function renderBacklog\(/m);
    expect(b).toContain("const empty = !all && !R.length && !tag; $('#blCard').classList?.toggle('bl-empty', empty);");
    const cls = { on: null as boolean | null, toggle(c: string, v: boolean) { if (c === 'bl-empty') this.on = v; } };
    const el = () => ({ textContent: '', innerHTML: '', dataset: {} as Record<string, string>, classList: cls });
    const D: Record<string, ReturnType<typeof el>> = { '#blCard': el(), '#blN': el(), '#blL': el() };
    const mk = (bl: unknown) => new Function('S', '$', 'ic', 'tagChips', 'backlogRow', 'blNoDesc', 'gistFit', 'row', 'overline', 'emptyAct', 'esc', `${take(/^const none = /m)}\n${take(/^const htmlIf = /m)}\n${take(/^const BL_N = /m)}\n${b}\nreturn renderBacklog;`)(
      { bl, teams: [] }, (s: string) => D[s] ?? null, () => '', () => '', () => '', () => '', () => {}, () => '', () => '', () => '', (x: unknown) => String(x)) as () => void;
    mk({ tasks: [], total: 0, all_total: 0, relayed: [], tag: '' })();
    expect(cls.on).toBe(true);
    mk({ tasks: [{ id: 'k1', team_id: 't1', title: 'A task' }], total: 1, all_total: 1, relayed: [], tag: '' })();
    expect(cls.on).toBe(false);
    // A chosen tag with nothing under it keeps the full card, so its chips stay to clear the tag.
    mk({ tasks: [], total: 0, all_total: 2, relayed: [], tag: 'thermal' })();
    expect(cls.on).toBe(false);
  });

  it('Backlog is always shown: with nothing waiting it says so and keeps All backlog (5.A8)', () => {
    const b = take(/^function renderBacklog\(/m);
    expect(b).not.toMatch(/\.hidden\s*=/);
    const el = () => ({ textContent: 'x', innerHTML: '', dataset: {} as Record<string, string> });
    const D: Record<string, ReturnType<typeof el>> = { '#blCard': el(), '#blN': el(), '#blL': el() };
    const fn = new Function('S', '$', 'ic', `${take(/^const none = /m)}\n${take(/^const htmlIf = /m)}\n${take(/^const BL_N = /m)}\n${b}\nreturn renderBacklog;`)(
      { bl: { tasks: [], total: 0, all_total: 0, relayed: [], tag: '' }, teams: [] }, (s: string) => D[s] ?? null, () => '') as () => void;
    fn();
    expect(D['#blN']!.textContent).toBe('');
    expect(D['#blL']!.innerHTML).toContain('Nothing waiting. Tasks agents propose land here.');
    expect(HTML).toMatch(/<h2 id="blH">Backlog<\/h2><span class="meta" id="blN"><\/span><div class="grow"><\/div><button class="btn sm" data-go="backlog">All backlog<\/button>/);
  });

  it('the refresh redraws the Home Teams card in place and waits while Reorder is on or the keyword select has focus (5.A6, 5.A7)', () => {
    const code = take(/^function renderHomeTeams\(/m);
    const make = (reorder: boolean, focusK = false) => {
      const calls: string[] = [];
      const kSel = { id: 'tmK' }, list = { id: 'tmList' };
      const host = { querySelector: (s: string) => (s === '#tmK' ? kSel : s === '#tmList' ? list : null) };
      const body = { innerHTML: '', querySelector: (s: string) => (s === '#tmList' ? list : null) };
      const els: Record<string, unknown> = { '#homeTeams': host, '#homeTl': body, '#tmN': { textContent: '' }, '#homeOb': {} };
      const TL = { host, route: 'home', args: { home: 'o=status' } };
      const fn = new Function('$', 'S', 'TL', 'TM_UI', 'tmFilters', 'tlHtml', 'tipIcons', 'mountTeamList', 'htmlIf', 'obTeamsCard', 'tmTools', 'tmFocusKey', 'tmDraw', 'tmFocusBack', 'document', `${code}\nreturn renderHomeTeams;`)(
        (s: string) => els[s], { teams: [{}, {}] }, TL, { reorder }, (a: string) => ({ o: a.slice(2), q: '', k: '' }), () => 'HTML', () => {},
        () => calls.push('mount'), () => calls.push('ob'), () => '', () => calls.push('tools'), () => { calls.push('key'); return null; },
        () => calls.push('draw'), () => calls.push('back'), { activeElement: focusK ? kSel : null }) as () => void;
      fn();
      return { calls, els, body };
    };
    const live = make(false);
    expect(live.calls).toEqual(['ob', 'tools', 'key', 'draw', 'back']);
    expect((live.els['#tmN'] as { textContent: unknown }).textContent).toBe(2);
    expect(live.body.innerHTML).toBe(''); // the toolbar is not rebuilt: the search keeps its text and caret
    expect(make(true).calls).toEqual(['ob']);
    expect(make(false, true).calls).toEqual(['ob']);
    // Reorder is off when Home opens, before closeD() draws the overview.
    const h = take(/^function homeOpen\(/m);
    expect(h.indexOf('TM_UI.reorder = false;')).toBeLessThan(h.indexOf('closeD();'));
    expect(h.indexOf('TL.args.home = ')).toBeLessThan(h.indexOf('closeD();'));
    // The other ways back to the overview (restoreRoute's home(), showLogin) turn Reorder off too.
    for (const fn of [take(/^function restoreRoute\(/m), take(/^function showLogin\(/m)]) {
      const at = fn.indexOf('TM_UI.reorder = false;'); expect(at).toBeGreaterThan(-1); expect(at).toBeLessThan(fn.indexOf('closeD();'));
    }
    // The list is mounted once into Home's Teams card, its state in the Home route; pins redraw only the mounted list.
    expect(code).toContain("body.innerHTML = tlHtml(f); tipIcons(body); mountTeamList(host, 'home');");
    expect(take(/^const tlHtml = /m)).not.toContain('pcard');
    expect(take(/^function tmRefreshPins\(/m)).not.toContain('renderTeamsCard');
    expect(SRC).toContain("loadPrefs().then(() => { if (!$('#overview').hidden) renderHomeTeams(); refresh(); })");
  });

  it('Home lists every team: 30 teams all show under every Organize choice, with no "more teams" row (5.A16)', () => {
    const code = [/^const TM_STATUS = /m, /^const tmMatch = /m, /^function tmAttn\(/m, /^const tmScore = /m, /^function tmProject\(/m, /^function tmModel\(/m, /^const tmCmp = /m, /^const tmByStatus = /m, /^function tmGroups\(/m].map(take).join('\n');
    const status = ['running', 'paused', 'draft', 'stopped', 'done'];
    const teams = Array.from({ length: 30 }, (_, i) => ({ id: `team_${i}`, name: `Team ${i}`, status: status[i % 5], counts: { blocked: i % 7 === 0 ? 1 : 0 }, approvals: i % 9 === 0 ? 1 : 0, stalled: i % 4 === 0 ? 1 : 0, agent_ids: [] }));
    const S = { teams, pins: ['team_29', 'team_3', 'team_gone'], dec: [] };
    const fns = new Function('S', 'topoModel', 'AG', 'agLabel', 'NO_PROJECT', 'cap', `${code}\nreturn { tmModel, tmGroups };`)(
      S, () => ({ act: new Map(), agents: [], live: new Set() }), () => null, () => '', 'No project', (s: string) => s) as {
      tmModel: (f: Record<string, string>) => { pinned: { t: { id: string } }[] }; tmGroups: (f: Record<string, string>, D: unknown) => { L: { t: { id: string } }[] }[];
    };
    for (const o of ['', 'status', 'project', 'name']) {
      const f = { o, q: '', k: '' }, D = fns.tmModel(f);
      const ids = [...D.pinned, ...fns.tmGroups(f, D).flatMap((g) => g.L)].map((x) => x.t.id);
      expect(ids, `Organize ${o || 'Attention'}`).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
      expect(ids.slice(0, 2)).toEqual(['team_29', 'team_3']);
    }
    expect(take(/^function tmListHtml\(/m)).not.toMatch(/more team|data-go="teams"/);
  });
});

describe('HOME-5: half-height key-figures strip', () => {
  const CSS = readFileSync(join(HERE, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  const strip = (() => { const i = CSS.indexOf('/* key figures:'), j = CSS.indexOf('/* Home layout', i); return CSS.slice(i, j); })();

  it('from 768 px each cell is one baseline line with s2 s3 padding (s2 below 1180 px), one height at every wider width, and no sparkline (5.A12)', () => {
    expect(CSS).not.toMatch(/\.kpistrip \.sp\{display:block/);
    expect(CSS).not.toMatch(/\.kpistrip \.(sp|spk)\b/);
    const wide = /@media \(min-width:768px\)\{([\s\S]*?)\n\}/.exec(strip)?.[1] || '';
    expect(wide).toContain('.kpistrip .kpi-c,.kpistrip .kpi-c[data-k=req]{display:flex;flex-direction:row;align-items:baseline;gap:var(--s2);padding:var(--s2) var(--s3);');
    expect(wide).toMatch(/\.kpistrip \.stat-l\{order:-1;[^}]*white-space:nowrap\}/);
    // No padding step at 1180 px: the strip keeps one height from 768 px up.
    expect(strip).not.toMatch(/min-width:1180px/);
    // 768-1179 px: narrower cells take s2 side padding and an s1 gap, with the same vertical padding (labels stay readable).
    const mid = /@media \(min-width:768px\) and \(max-width:1179\.98px\)\{([\s\S]*?)\n\}/.exec(strip)?.[1] || '';
    expect(mid).toContain('.kpistrip .kpi-c,.kpistrip .kpi-c[data-k=req]{gap:var(--s1);padding:var(--s2)}');
    // The value is --t-num (22 px) at every width, and the token is not redefined for the strip.
    expect(CSS).toMatch(/--t-num:600 22px\/28px /);
    expect(strip).not.toMatch(/\.kpistrip[^{]*\.stat-v\{[^}]*font/);
    // Phones keep the stats grid with its NOW and LAST HOUR overlines, value over label.
    expect(strip).toContain('.kpistrip .kpi-c{display:flex;flex-direction:column;gap:var(--s1);');
    expect(wide).toContain('.kpistrip>.overline{display:none}');
  });

  it('renderKpis draws no sparkline and keeps no history buffer (5.A12, D-11)', () => {
    const r = take(/^function renderKpis\(/m), d = take(/^function kpiDefs\(/m);
    expect(r).not.toContain('spark(');
    expect(r).not.toMatch(/class="sp"|\.sp'|H\[/);
    expect(d).not.toContain('series:');
    expect(SRC).not.toMatch(/^const H = \{\};/m);
    expect(SRC).not.toMatch(/^function spark\(/m);
    // Requests keeps its alarm colour; the cells still open their screens.
    expect(d).toContain("{ id: 'req', l: 'Requests', go: 'req', v: S.reqs.length, alarm: 'warn' }");
    expect(r).toContain("overline('Now')");
    expect(r).toContain("overline('Last hour')");
  });
});

describe('HOME-6: design review fixes', () => {
  const HTML = readFileSync(join(HERE, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const CSS = readFileSync(join(HERE, '..', 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  const OV = HTML.slice(HTML.indexOf('<div id="overview"'), HTML.indexOf('id="workspaceView"'));

  it('no id in Home\'s markup is also built by a view, so $() never binds a view\'s handler to a Home control', () => {
    // #overview stays in the DOM under every view and $() returns the first match: a Home id reused by a view (Audit → Telemetry's
    // Filters button was #tmMore) took the view's handler and left the view's own button dead.
    const ids = [...OV.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toContain('homeTlMore');
    for (const id of ids) {
      expect(SRC, id).not.toContain(`id="${id}"`);
      expect(SRC, id).not.toContain(`filterBtn('${id}'`);
    }
    expect(SRC).toContain("$('#homeTlMore').onclick = (e) => openMenu(");
    expect(SRC).toContain("filterBtn('tmMore', nTeam)");
  });

  it('the Organize label and its control sit in one box, so a narrow card wraps them together', () => {
    expect(SRC).toContain('`<div class="tl-orgw">${lab}${seg}</div>');
    expect(CSS).toContain('.tl-orgw{display:flex;align-items:center;gap:var(--s2);margin-left:auto;min-width:0}');
    expect(CSS).not.toContain('.tl-lab{margin-left:auto');
    expect(CSS).toContain('#tmBar .tl-orgw{order:2;flex:1 1 100%}');
  });

  it('a team row puts its pills, task bar, time and chevron at the right in fixed columns; the name takes the free width', () => {
    // Desktop: the free width goes to the name, so the pills sit right-aligned next to the bar and the bars line up row under row.
    expect(CSS).toContain('.tl-row{position:relative;display:grid;grid-template-columns:var(--s8) minmax(240px,1fr) 232px 148px 48px var(--icon);');
    expect(CSS).toMatch(/.tl-at{[^}]*justify-content:flex-end/);
    expect(CSS).toContain('.tl-pg{grid-column:4;');
    expect(CSS).toContain('.tl-wh{grid-column:5;');
    expect(CSS).toContain('.tl-list.reorder .tl-row{grid-template-columns:var(--s8) minmax(240px,1fr) 232px auto;cursor:default}');
    expect(CSS).toContain('.tl-mv{grid-column:4;');
    // 768 to 1179 px: the same order with narrower fixed columns.
    expect(CSS).toContain('  .tl-row{grid-template-columns:var(--s8) minmax(0,1fr) minmax(0,200px) 120px 48px var(--icon)}');
    // No empty spacer column is left between the bar and the time.
    expect(CSS).not.toContain('148px minmax(0,1fr) 48px');
  });
});
