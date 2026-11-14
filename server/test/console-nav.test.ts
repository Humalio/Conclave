/**
 * Console navigation (docs/proposals/console-systems.md §4, NAVAGENTS-1): one route tree (ROUTES) and one trail (navTrail) give
 * every screen its crumbs and its one Back target. Static, like console-fixes.test.ts: it reads public/app.js, runs the route
 * region (between "// ROUTES begin" and "// ROUTES end") with stubbed caches, and walks every chain.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const block = (name: string) => { const i = js.indexOf(`const ${name} = {\n`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n};\n', i)); };

/* Every screen the console can open: the VIEWS, MU_VIEWS and ADM_VIEWS literals plus every VIEWS.x / MU_VIEWS.x assignment. */
const viewKeys = (() => {
  const keys = new Set<string>();
  for (const n of ['VIEWS', 'ADM_VIEWS']) for (const m of block(n).matchAll(/^ {2}(?:async )?([a-z]+)(?:\(|: )/gm)) keys.add(m[1]!);
  for (const m of js.matchAll(/^\s*(?:VIEWS|MU_VIEWS)\.([a-z]+) *=/gm)) keys.add(m[1]!);
  return [...keys];
})();
const routeOkKeys = (() => {
  const keys = new Set<string>();
  for (const n of ['ROUTE_OK', 'ADM_ROUTES']) for (const m of block(n).matchAll(/\b([a-z]+): (?:\(a\) =>|tmArgs\b)/g)) keys.add(m[1]!);
  for (const m of js.matchAll(/ROUTE_OK\.([a-z]+) = /g)) keys.add(m[1]!);
  for (const m of js.matchAll(/Object\.assign\(ROUTE_OK, \{([^}]*)\}\)/g)) for (const k of m[1]!.matchAll(/\b([a-z]+): \(a\)/g)) keys.add(k[1]!);
  return [...keys];
})();
const redirects = [...block('BP_REDIRECT').matchAll(/\b([a-z]+): (?:async )?\(/g)].map((m) => m[1]!);

/* The route region, run with stub caches: one team, one agent, one key, one PC; Home's list filters read "o=az". */
const bpArgSrc = /const bpArg = [^\n]+/.exec(js)![0];
const region = js.slice(js.indexOf('// ROUTES begin'), js.indexOf('// ROUTES end'));
/* openD and go are stubbed to their navigation bookkeeping (navEnter, navClear), so the harness can open screens and press Back:
   open() is a click from the open screen (or from Home with none), go() a fresh visit, reload() the browser's history or a link. */
const nav = () => {
  const DR = { type: null as string | null, arg: null as unknown, origin: null as [string, unknown] | null, stack: [] as unknown[], walk: new Set<string>() };
  const S = { teams: [{ id: 'team_cd', name: 'Conclave Developers' }] };
  const AG = (id: string) => (id === 'agt_leonor' ? { label: 'Leonor' } : undefined);
  const K = (id: string) => (id === 'key_1' ? { label: 'Laptop key' } : undefined);
  const PC = (id: string) => (id === 'pc_1' ? { name: 'studio' } : undefined);
  const keyName = (k: { label: string }) => k.label, cap = (s: string) => s[0]!.toUpperCase() + s.slice(1), homeListArg = () => 'o=az';
  let n: any;
  const openD = (t: string, a: unknown, replace = false, reset = false, origin?: unknown) => n.navEnter(t, a, replace, reset, origin);
  const go = (t: string, a?: unknown) => (t === 'home' ? n.navClear() : openD(t, a, false, true, DR.type ? [DR.type, DR.arg] : ['home']));
  const window = { scrollTo() {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function('DR', 'S', 'AG', 'K', 'PC', 'keyName', 'cap', 'homeListArg', 'openD', 'go', 'window',
    `${bpArgSrc};\n${region};\nreturn { ROUTES, navTrail, navChain, navFrom, navEnter, navClear, navBack, navGo, back, navHere, navName, navKey };`);
  n = { DR, ...f(DR, S, AG, K, PC, keyName, cap, homeListArg, openD, go, window) };
  n.open = (t: string, a: unknown) => openD(t, a);
  n.go = go;
  n.reload = (t: string, a: unknown) => openD(t, a, false, true);
  n.at = () => (DR.type ? `${DR.type}/${String(DR.arg ?? '')}` : 'home');
  n.backLabel = () => n.navTrail(DR.type, DR.arg).back?.label;
  /* Press Back until Home (at most max times): the screens it passed through, Home last. */
  n.walkBack = (max = 8) => { const seen: string[] = []; for (let i = 0; i < max && DR.type; i++) { n.navBack(); seen.push(n.at()); } return seen; };
  return n;
};
/* A well-formed argument per screen that takes one. */
const SAMPLE: Record<string, string> = {
  team: 'team_cd', members: 'team_cd', tsettings: 'team_cd', tstatus: 'team_cd', tdirs: 'team_cd', tchats: 'team_cd', tses: 'team_cd', tco: 'team_cd',
  tasks: 'team_cd|open', task: 'team_cd|task_1', decisions: 'team_cd|open', dec: 'dec_1', tdir: 'team_cd|dir_1', thist: 'team_cd|pending',
  blueprint: 'prj_c|needs|team_cd', bp: 'prj_c|FR-1', replan: 'rp_1', ses: 'agt_leonor|overview', key: 'key_1|overview', pc: 'pc_1', ob: 'ob_1',
  room: 'conv_1', fbr: 'fb_1', directive: 'dir_1', share: 'shr_1', user: 'usr_1', app: 'pc_1', diff: 'file_1|absent', log: 'calls', home: 'o=az',
};

describe('route registry', () => {
  it('finds the screens and routes it checks', () => {
    expect(viewKeys.length).toBeGreaterThan(40);
    expect(viewKeys).toEqual(expect.arrayContaining(['team', 'members', 'blueprint', 'bp', 'ses', 'ob', 'topology', 'projects', 'replan', 'tco', 'users', 'user', 'shares']));
    expect(routeOkKeys).toEqual(expect.arrayContaining(['home', 'topology', 'teams', 'tco', 'users', 'projects']));
  });

  it('gives every view an entry whose chain ends at a root within 6 steps, without a cycle or the Teams tab', () => {
    const { ROUTES } = nav();
    for (const type of [...viewKeys, 'home']) {
      expect(ROUTES[type], `ROUTES.${type}`).toBeTruthy();
      const seen = new Set<string>();
      let cur: [string, unknown] | null = [type, SAMPLE[type] ?? ''], steps = 0;
      while (cur) {
        const [t, a] = cur, key = `${t}/${String(a ?? '')}`;
        expect(seen.has(key), `cycle at ${key} from ${type}`).toBe(false); seen.add(key);
        expect(ROUTES[t], `ROUTES.${t} (from ${type})`).toBeTruthy();
        expect(t).not.toBe('teams');
        const label = ROUTES[t].label(a);
        expect(typeof label).toBe('string'); expect(label).not.toMatch(/Work ›/);
        cur = ROUTES[t].parent(a); if (cur) steps++;
        expect(steps, `chain from ${type}`).toBeLessThanOrEqual(6);
      }
    }
  });

  it('has an entry for every ROUTE_OK pattern, except the old links BP_REDIRECT forwards', () => {
    const { ROUTES } = nav();
    expect(redirects).toEqual(expect.arrayContaining(['teams', 'goal', 'plan', 'objective', 'project']));
    for (const k of routeOkKeys) expect(ROUTES[k] || redirects.includes(k), `ROUTES.${k}`).toBeTruthy();
    expect(ROUTES.teams).toBeUndefined();
  });

  it('roots the tabs and hangs team screens under Home with the list filters', () => {
    const { ROUTES } = nav();
    for (const t of ['home', 'topology', 'sessions', 'chats', 'feedback', 'directives', 'keys', 'pcs', 'users', 'vault', 'log']) expect(ROUTES[t].parent(SAMPLE[t] ?? '')).toBeNull();
    expect(ROUTES.team.parent('team_cd')).toEqual(['home', 'o=az']);
    expect(ROUTES.ob.parent('ob_1')).toEqual(['home', 'o=az']);
    expect(ROUTES.tbuild.parent('')).toEqual(['home', 'o=az']);
    expect(ROUTES.lock.parent('')).toEqual(['home', 'o=az']);
    // The Needs you screen hangs under Home, or roots at the team or project it was filtered to.
    expect(ROUTES.needs.parent('')).toEqual(['home', 'o=az']);
    expect(ROUTES.needs.parent('team=team_cd')).toEqual(['team', 'team_cd']);
    expect(ROUTES.needs.parent('project=prj_c&s=aw')?.[0]).toBe('blueprint');
    expect(ROUTES.members.parent('team_cd')).toEqual(['team', 'team_cd']);
    expect(ROUTES.task.parent('team_cd|task_1')).toEqual(['team', 'team_cd']);
    expect(ROUTES.tdir.parent('team_cd|dir_1')).toEqual(['tdirs', 'team_cd']);
    // #tdirs/<team>|<tab> (DIRECTIVES-4): the tab stays under the team, and a directive opened from a tab returns to it.
    expect(ROUTES.tdirs.parent('team_cd|hub')).toEqual(['team', 'team_cd']);
    expect(ROUTES.tdirs.label('team_cd|members')).toBe('Directives');
    expect(ROUTES.tdir.parent('team_cd|dir_1|members')).toEqual(['tdirs', 'team_cd|members']);
    expect(ROUTES.tdir.parent('team_cd|dir_1|team')).toEqual(['tdirs', 'team_cd']);
    expect(ROUTES.ses.parent('agt_leonor|overview')).toEqual(['sessions']);
  });

  it('puts a question under its team decision log once the screen has said its team', () => {
    const n = nav();
    expect(n.ROUTES.dec.parent('dec_1')).toEqual(['home', 'o=az']);
    n.navHere('dec', 'dec_1', { label: 'Question', team: 'team_cd' });
    expect(n.ROUTES.dec.parent('dec_1')).toEqual(['decisions', 'team_cd']);
  });
});

describe('navTrail', () => {
  it('reads Home › team › Blueprint · project above a Blueprint section, and Back names the team (4.A1)', () => {
    const n = nav();
    n.navName('prj_c', 'Conclave'); n.navHere('blueprint', 'prj_c|needs|team_cd', { label: 'Needs you' });
    const tr = n.navTrail('blueprint', 'prj_c|needs|team_cd');
    expect(tr.crumbs.map((c: any) => c.label)).toEqual(['Home', 'Conclave Developers', 'Blueprint · Conclave']);
    expect(tr.crumbs[0]).toMatchObject({ type: 'home', arg: 'o=az' });
    expect(tr.here.label).toBe('Needs you');
    expect(tr.back).toMatchObject({ type: 'team', arg: 'team_cd', label: 'Conclave Developers' });
  });

  it('sends Back from a Blueprint section with no team filter to Home with the list filters (4.A3)', () => {
    const tr = nav().navTrail('blueprint', 'prj_c|needs');
    expect(tr.crumbs[0].label).toBe('Home');
    expect(tr.back).toMatchObject({ type: 'home', arg: 'o=az', label: 'Home' });
  });

  it('names the agent a team was opened from, keeps the crumbs, and goes Home after a reload (4.A4)', () => {
    const n = nav();
    n.reload('team', 'team_cd');
    expect(n.navTrail('team', 'team_cd').back).toMatchObject({ type: 'home', arg: 'o=az', label: 'Home' });
    n.navClear(); n.open('team', 'team_cd');
    expect(n.navTrail('team', 'team_cd').back).toMatchObject({ type: 'home', arg: 'o=az' });
    n.navClear(); n.open('ses', 'agt_leonor|overview'); n.open('team', 'team_cd');
    const tr = n.navTrail('team', 'team_cd');
    expect(tr.back).toMatchObject({ type: 'ses', arg: 'agt_leonor|overview', label: 'Leonor', origin: true });
    expect(tr.crumbs.map((c: any) => c.label)).toEqual(['Home']);
    // Members opened from the team, then a crumb (or the browser's Back) up to the team: the team still names the agent.
    n.open('members', 'team_cd'); n.open('team', 'team_cd');
    expect(n.backLabel()).toBe('Leonor');
    n.open('members', 'team_cd'); n.reload('team', 'team_cd');
    expect(n.backLabel()).toBe('Leonor');
    // A link to the team from elsewhere records nothing.
    n.open('ses', 'agt_leonor|overview'); n.reload('team', 'team_cd');
    expect(n.backLabel()).toBe('Home');
  });

  it('sends Back from the agent page to the Members list it came from, else to Sessions (4.A5)', () => {
    const n = nav();
    n.reload('ses', 'agt_leonor|overview');
    expect(n.navTrail('ses', 'agt_leonor|overview').back).toMatchObject({ type: 'sessions', label: 'Sessions' });
    n.go('home'); n.go('members', 'team_cd'); n.open('ses', 'agt_leonor|overview');
    expect(n.navTrail('ses', 'agt_leonor|overview').back).toMatchObject({ type: 'members', arg: 'team_cd', label: 'Members' });
  });

  it('lets a screen that replaces the open one take its origin, never a link or the browser history', () => {
    const n = nav();
    n.go('members', 'team_cd'); n.open('ses', 'agt_leonor|teams');
    n.navEnter('ses', 'agt_leonor|overview', true); // a tab switch on the agent page
    expect(n.backLabel()).toBe('Members');
    n.reload('team', 'team_cd');
    expect(n.backLabel()).toBe('Home');
  });

  it('ends a Back walk at Home through agent → team → Members → agent, without looping', () => {
    const n = nav();
    n.open('ses', 'agt_leonor|overview'); n.open('team', 'team_cd'); n.open('members', 'team_cd'); n.open('ses', 'agt_leonor|overview');
    expect(n.backLabel()).toBe('Members');
    const walk = n.walkBack();
    expect(walk.at(-1)).toBe('home');
    expect(walk.length).toBeLessThanOrEqual(4);
    // The team does not go back to the agent Back already left.
    expect(walk).toEqual(['members/team_cd', 'team/team_cd', 'home']);
  });

  it('ends a Back walk between two Blueprint items opened from each other at their section', () => {
    const n = nav();
    n.navHere('bp', 'prj_c|FR-1', { label: 'FR-1', section: 2 }); n.navHere('bp', 'prj_c|FR-2', { label: 'FR-2', section: 2 });
    n.go('blueprint', 'prj_c|2'); n.open('bp', 'prj_c|FR-2'); n.open('bp', 'prj_c|FR-1'); n.open('bp', 'prj_c|FR-2');
    const walk = n.walkBack();
    // FR-1 does not go back to FR-2, which Back already left: it goes to the section, then Home.
    expect(walk).toEqual(['bp/prj_c|FR-1', 'blueprint/prj_c|2', 'home']);
  });

  it('forgets an origin from an earlier visit: a team reached from Home goes back Home (4.A4)', () => {
    const n = nav();
    n.open('ses', 'agt_leonor|overview'); n.open('team', 'team_cd');
    expect(n.backLabel()).toBe('Leonor');
    n.go('home'); n.go('task', 'team_cd|task_1');
    n.navBack();
    expect(n.at()).toBe('team/team_cd');
    expect(n.backLabel()).toBe('Home');
    n.navBack();
    expect(n.at()).toBe('home');
  });

  it('returns each screen on the stack to the origin it had, after Back pops it', () => {
    const n = nav();
    n.open('ses', 'agt_leonor|overview'); n.open('team', 'team_cd'); n.open('tsettings', 'team_cd');
    n.navBack();
    expect(n.at()).toBe('team/team_cd');
    expect(n.backLabel()).toBe('Leonor');
  });

  it('sends Back from an onboarding request with no history to Home (4.A6)', () => {
    expect(nav().navTrail('ob', 'ob_1').back).toMatchObject({ type: 'home', arg: 'o=az' });
  });

  it('gives a root tab no Back and a Blueprint item its section', () => {
    const n = nav();
    expect(n.navTrail('sessions', undefined).back).toBeNull();
    n.navHere('bp', 'prj_c|FR-1', { label: 'FR-1', section: 2 });
    n.navHere('blueprint', 'prj_c|2', { label: 'Requirements' });
    expect(n.navTrail('bp', 'prj_c|FR-1').back).toMatchObject({ type: 'blueprint', arg: 'prj_c|2', label: 'Requirements' });
    // Opened from another item, Back names that item.
    n.go('bp', 'prj_c|FR-2'); n.open('bp', 'prj_c|FR-1');
    expect(n.navTrail('bp', 'prj_c|FR-1').back).toMatchObject({ type: 'bp', arg: 'prj_c|FR-2', label: 'FR-2' });
  });

  it('names the team on ‹ for an item opened from the team page, and Back returns there', () => {
    const n = nav();
    n.navName('prj_c', 'Conclave'); n.navHere('bp', 'prj_c|PAP-1', { label: 'PAP-1', section: 4 });
    n.go('team', 'team_cd'); n.open('bp', 'prj_c|PAP-1');
    const tr = n.navTrail('bp', 'prj_c|PAP-1');
    expect(tr.back).toMatchObject({ type: 'team', arg: 'team_cd', label: 'Conclave Developers', origin: true });
    // The crumbs stay structural: Home › Blueprint · Conclave › the paper's section.
    expect(tr.crumbs.map((c: any) => `${c.type}/${c.arg}`)).toEqual(['home/o=az', 'blueprint/prj_c|ov', 'blueprint/prj_c|4']);
    n.navBack();
    expect(n.at()).toBe('team/team_cd');
  });

  it('shows no origin for an item opened from its Blueprint section: Back is the section', () => {
    const n = nav();
    n.navHere('bp', 'prj_c|PAP-1', { label: 'PAP-1', section: 4 }); n.navHere('blueprint', 'prj_c|4', { label: 'Papers & Planning' });
    n.go('blueprint', 'prj_c|4'); n.open('bp', 'prj_c|PAP-1');
    const back = n.navTrail('bp', 'prj_c|PAP-1').back;
    expect(back).toMatchObject({ type: 'blueprint', arg: 'prj_c|4', label: 'Papers & Planning' });
    expect(back.origin).toBeUndefined();
  });
});

describe('one Back rule in the source', () => {
  it('keeps no per-view up and none of the old Back mechanisms', () => {
    expect(js).not.toMatch(/^\s*up[:,]/m);
    expect(js).not.toMatch(/\bup: \{ label/);
    for (const gone of ['teamOrigin', 'TEAM_FROM', 'goUp', 'setUp(', 'let UP', 'NAV_REPLACE', "{ key: ['keys'], pc: ['pcs']", "dec: home, directive: ['directives']"]) expect(js).not.toContain(gone);
    expect(js).not.toMatch(/Work ›/);
  });

  it('routes every Back control through navTrail', () => {
    expect(js).toMatch(/function detailBack\(\) \{[\s\S]{0,400}navBack\(\);/);
    expect(js).toMatch(/function navBack\(\) \{\n {2}const b = DR\.type \? navTrail\(DR\.type, DR\.arg\)\.back : null;/);
    // Origins live on the open screen and its stack entries for one visit, never in a hub-lifetime map.
    expect(js).not.toContain('DR.from');
    expect(js).toMatch(/function closeD\(\) \{[\s\S]{0,400}navClear\(\);/);
    expect(js).toContain("if (t.closest('[data-ctx-back]')) { detailBack(); return; }");
    expect(js).toContain("$('#dBack').onclick = () => detailBack();");
    // Esc on an open screen is the same Back, after the topology focus steps.
    expect(js).toContain("if (topoOn() && TG_S.focus) { topoFocus(null); return; }\n    // On an open screen Esc is Back");
    expect(js).toContain("\n    if (DR.type && !$('#workspaceView').hidden) { detailBack(); return; }\n    back(); return;\n");
    // openD builds one trail and hands it to the context bar, the phone app bar and the header.
    expect(js).toContain('const trail = navTrail(type, arg);');
    expect(js).toContain("$('#ctxBar').innerHTML = r.bar ? ctxTrailH(trail) + r.bar : '';");
    expect(js).toContain('setDetailBar(r.dbar, trail);\n  setBack(trail);');
    // Every Back control names its target the same way.
    expect(js).toContain("const backAria = (bk) => (bk ? 'Back to ' + bk.label : 'Back');");
    expect(js).toContain('data-dbar-back aria-label="${esc(backAria(trail && trail.back))}"');
  });
});

/* NAVAGENTS-2: the trail drawn. crumbsH and the trail helpers (between "let NAV_CUR" and "function setBack") run with the
   app's own esc and ic, against navTrail from the harness above. */
const fnSrc = (start: string) => { const i = js.indexOf(start); expect(i, start).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const ui = (n?: any) => {
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const ic = (name: string, c = '') => `<svg class="i ${c}"><use href="#i-${name}"/></svg>`;
  const routeOf = /const routeOf = [^\n]+/.exec(js)![0];
  const helpers = js.slice(js.indexOf('let NAV_CUR = null;'), js.indexOf('function setBack('));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const u = new Function('esc', 'ic', `${routeOf};\n${fnSrc('function crumbsH(')}\n${helpers}\nreturn { crumbsH, navMeta, ctxTrailH, trailCrumbs, backAria, backIn, backCls };`)(esc, ic);
  return { ...u, trail: n ? (t: string, a: unknown) => n.navTrail(t, a) : null };
};
/* The top-level keys of every object literal that follows `marker` in app.js (dbar: { … }, setDetailBar({ … })). */
const objectsAfter = (marker: string) => {
  const out: string[] = [];
  for (let i = js.indexOf(marker); i > -1; i = js.indexOf(marker, i + 1)) {
    let j = i + marker.length - 1, depth = 0, top = '';
    for (; j < js.length; j++) {
      const ch = js[j]!;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (!depth) break; }
      else if (depth === 1) top += ch;
    }
    out.push(top);
  }
  return out;
};

describe('trail rendering', () => {
  it('draws every breadcrumb through crumbsH, the one template with class="crumbs"', () => {
    expect(js.split('class="crumbs').length - 1).toBe(1);
    expect(fnSrc('function crumbsH(')).toContain('<nav class="crumbs');
    expect(readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8')).not.toContain('class="crumbs');
    // The three trails that were written by hand: the member vault path, the topology focus trail, the vault phone path.
    expect(fnSrc('function muCrumbs(')).toContain('crumbsH(');
    expect(fnSrc('function egoChrome(')).toMatch(/crumbsH\(\[\.\.\.EGO\.trail\.map/);
    // The focused node is the trail's current step; with no focus there is no trail, and no pin is built.
    expect(fnSrc('function egoChrome(')).toContain('const pin = f && { label: trunc(lab(f), 22),');
    expect(js).toContain("{ label: 'Path', more: { 'data-vcrumbs': '' } }");
    for (const gone of ['mu-cr-mid', 'mu-cr-cur', 'class="tg-crumbs"', 'crumbBtn']) expect(js).not.toContain(gone);
  });

  it('keeps every topology focus step reachable on phones: the focus trail wraps and never folds to "…" (4.A13)', () => {
    const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toContain('.tg-crumbs{flex:0 1 auto;flex-wrap:wrap}');
    expect(css).toContain('.tg-crumbs .cr-mid{display:inline-flex}');
    expect(css).toContain('.tg-crumbs .cr-more{display:none}');
    // Each step keeps its width (labels are cut to 18 / 22 characters), so a long trail wraps instead of squeezing the focus.
    expect(css).toContain('.tg-crumbs>:first-child,.tg-crumbs>.cr{flex:0 0 auto;max-width:100%}');
    // Same specificity as the phone fold (.crumbs .cr-mid), so the opt-out must come after it.
    expect(css.indexOf('.tg-crumbs .cr-mid{display:inline-flex}')).toBeGreaterThan(css.indexOf('.crumbs .cr-mid{display:none}'));
  });

  it('collapses the middle on phones, marks the screen itself, links each step and escapes labels (4.A13)', () => {
    const { crumbsH } = ui();
    const h = crumbsH([{ label: 'Vault root', attrs: { 'data-vault-path': '/' } }, { label: 'a', attrs: { 'data-vault-path': '/a' } }, { label: '<b>', cur: true }], { label: 'Path', more: { 'data-vcrumbs': '' } });
    expect(h).toMatch(/^<nav class="crumbs" aria-label="Path">/);
    expect(h).toContain('<span class="cr cr-more">');
    expect(h).toContain('<button type="button" class="more" data-vcrumbs="" aria-label="Show the whole path">…</button>');
    expect(h).toContain('<span class="cr cr-mid">');
    expect(h).toContain('<span class="cr cr-cur"><svg class="i sep"><use href="#i-chev"/></svg><span aria-current="page"><span>&lt;b&gt;</span></span></span>');
    // Two steps: nothing to collapse. No "more" given: the "…" is a mark, not a button.
    expect(crumbsH([{ label: 'A', href: '#a' }, { label: 'B', cur: true }])).not.toContain('cr-more');
    const m = crumbsH([{ label: 'A', href: '#a' }, { label: 'B', href: '#b' }, { label: 'C', href: '#c' }], { cls: 'mu-crumbs', tail: true });
    expect(m).toContain('<span class="more" aria-hidden="true">…</span>');
    expect(m).toMatch(/^<nav class="crumbs mu-crumbs" aria-label="Breadcrumb">/);
    expect(m).toMatch(/<svg class="i sep"><use href="#i-chev"\/><\/svg><\/nav>$/);
    // The topology pin: the current step as a button.
    expect(crumbsH([{ label: 'x', cur: true, icon: 'pin', attrs: { 'data-tg-pin': '', 'aria-pressed': 'true' } }])).toContain('<button type="button" aria-current="page" data-tg-pin="" aria-pressed="true"><svg class="i "><use href="#i-pin"/></svg><span>x</span></button>');
  });

  it('puts ‹ and linked crumbs above a Blueprint section, ‹ named "Back to Conclave Developers" (4.A1)', () => {
    const n = nav(), u = ui(n);
    n.navName('prj_c', 'Conclave'); n.navHere('blueprint', 'prj_c|needs|team_cd', { label: 'Needs you' });
    const tr = u.trail!('blueprint', 'prj_c|needs|team_cd');
    const h = u.trailCrumbs(tr);
    expect([...h.matchAll(/<a href="([^"]+)" data-crumb="(\d)"><span>([^<]+)<\/span><\/a>/g)].map((m: RegExpMatchArray) => [m[1], m[2], m[3]])).toEqual([
      ['#home/o%3Daz', '0', 'Home'], ['#team/team_cd', '1', 'Conclave Developers'], ['#blueprint/prj_c%7Cov%7Cteam_cd', '2', 'Blueprint · Conclave'],
    ]);
    expect(u.backAria(tr.back)).toBe('Back to Conclave Developers');
    // Back inside the structure: an icon button, no name (the crumbs name the screens).
    expect(u.backIn(tr.back)).not.toContain('<span>');
    expect(u.backCls(tr.back)).toBe('btn sm dback-up ic');
  });

  it('names the origin on ‹ when Back leaves the structure, and the context bar reads "‹ Members  Sessions ›" (4.A4, 4.A5)', () => {
    const n = nav(), u = ui(n);
    n.open('ses', 'agt_leonor|overview'); n.open('team', 'team_cd');
    const team = u.trail!('team', 'team_cd');
    expect(u.backIn(team.back)).toContain('<span>Leonor</span>');
    expect(u.backCls(team.back)).toBe('btn sm dback-up');
    expect(u.trailCrumbs(team)).toContain('<span>Home</span>');
    n.go('home'); n.go('members', 'team_cd'); n.open('ses', 'agt_leonor|overview');
    const bar = u.ctxTrailH(u.trail!('ses', 'agt_leonor|overview'));
    expect(bar).toMatch(/^<div class="trail ctx-trail"><button type="button" class="btn sm dback-up" data-ctx-back aria-label="Back to Members" title="Back to Members">/);
    expect(bar).toMatch(/<span>Members<\/span><\/button><nav class="crumbs" aria-label="Breadcrumb"><a href="#sessions" data-crumb="0"><span>Sessions<\/span><\/a><svg class="i sep">/);
    // A root tab has no trail in the context bar.
    expect(u.ctxTrailH(u.trail!('sessions', undefined))).toBe('');
  });

  it('names the origin on the phone app bar ‹ too: the same button, no second Back', () => {
    const src = js.slice(js.indexOf('function setDetailBar('), js.indexOf('\n}\n', js.indexOf('function setDetailBar(')));
    expect(src).toContain("class=\"ibtn${trail && trail.back && trail.back.origin ? ' dbk-named' : ''}\" data-dbar-back");
    expect(src).toContain('${backIn(trail && trail.back)}</button>');
    expect(src.match(/data-dbar-back/g)).toHaveLength(1);
    const n = nav(), u = ui(n);
    n.go('team', 'team_cd'); n.open('bp', 'prj_c|PAP-1');
    expect(u.backIn(u.trail!('bp', 'prj_c|PAP-1').back)).toContain('<span>Conclave Developers</span>');
  });

  it('writes the phone app bar meta from the trail: collapsed parent trail, then here.meta (4.A2, 4.A14)', () => {
    const n = nav(), u = ui(n);
    n.navName('prj_c', 'Conclave'); n.navHere('blueprint', 'prj_c|needs|team_cd', { label: 'Needs you' });
    expect(u.navMeta(u.trail!('blueprint', 'prj_c|needs|team_cd'))).toBe('Home › … › Conclave Developers');
    n.navHere('members', 'team_cd', { label: 'Members', meta: '3 members' });
    expect(u.navMeta(u.trail!('members', 'team_cd'))).toBe('Home › Conclave Developers · 3 members');
    expect(u.navMeta(u.trail!('team', 'team_cd'))).toBe('Home');
    expect(u.navMeta(u.trail!('tdir', 'team_cd|dir_1'))).toBe('Home › … › Directives');
    // 6.A13: any #tdirs tab reads Home › <team> › Directives.
    const td = n.navTrail('tdirs', 'team_cd|hub');
    expect([...td.crumbs.map((c: any) => c.label), td.here.label]).toEqual(['Home', 'Conclave Developers', 'Directives']);
    expect(u.navMeta(null)).toBe('');
  });

  it('lets no view write its own app-bar meta: views say here.meta, the bar reads the trail (D-9)', () => {
    const dbars = objectsAfter('dbar: {'), calls = objectsAfter('setDetailBar({');
    expect(dbars.length).toBeGreaterThan(30);
    for (const top of [...dbars, ...calls]) expect(top).not.toMatch(/(^|[\s,])meta:/);
    expect(js).not.toContain('d.meta');
    expect(fnSrc('function setDetailBar(')).toContain('const meta = navMeta(trail);');
    // The counts that used to sit in the meta line now come from the screen's here.
    expect(js).toContain("here: { label: 'Members', meta: plural(t.members.length, 'member') },");
    // The agent page's meta is its status only: the role pill sits by the title, and the team or project is never in here.meta (§4.5 C).
    expect(js).toContain("here: { label: a.label, meta: [d.live ? 'live' : 'idle', ");
    expect(js).not.toContain('[a.project, a.role]');
  });

  it('holds the header trail row in #viewHeader: ‹ and the crumbs above the title', () => {
    const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
    expect(html).toMatch(/<div class="dh" id="viewHeader"><div class="trail" id="dTrail" hidden><button type="button" class="btn sm ic dback-up" id="dBack" aria-label="Back">[\s\S]*?<\/button><div class="dcrumbs" id="dCrumbs"><\/div><\/div><h2 id="dT"/);
    expect(fnSrc('function setBack(')).toMatch(/\$\('#dTrail'\)\.hidden = !bk;[\s\S]*\$\('#dCrumbs'\)\.innerHTML = bk \? trailCrumbs\(trail, \{ tail: true \}\) : '';/);
    // A crumb opens its route in place of the screen; a modified click is left to the browser.
    expect(js).toContain("const c = NAV_CUR && NAV_CUR.crumbs[+crb.dataset.crumb]; if (c) navGo(c.type, c.arg);");
    // No context-bar screen draws its own unlabelled Back any more.
    expect(js).not.toMatch(/data-ctx-back aria-label="Back(?: to PCs)?">/);
    const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width:767\.98px\)\{\.crumbs \.cr-more,\.crumbs \.more\{display:inline-flex\}\.crumbs \.cr-mid\{display:none\}\}/);
  });
});
