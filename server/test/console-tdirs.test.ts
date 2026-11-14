/**
 * Team Directives tabs (docs/proposals/console-systems.md §6.5 item 1, DIRECTIVES-4, 6.A5, 6.A12, 6.A13): `#tdirs/<team>|team|members|hub`
 * is one `.tabs` bar with the tab in the hash, every tab the same row, hub-wide rules kept off the team with "Not for this team"
 * and back with "Apply again" (the exemption routes), member copies flagged and folded. Static, like console-plain.test.ts: it
 * reads public/app.js, checks the source, and renders VIEWS.tdirs with its own row helpers and a stubbed api.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const view = js.slice(js.indexOf('VIEWS.tdirs = async'), js.indexOf('/* One directive opened from the team:'));
/* One top-level declaration of app.js, up to the next one. */
const decl = (head: string) => {
  const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1);
  const rest = js.slice(i + head.length), m = /\n(?=const |function |async function |let |\/\*|\/\/|VIEWS\.)/.exec(rest);
  return js.slice(i, i + head.length + (m ? m.index : rest.length));
};
const helpers = ['const esc = ', 'const ic = ', 'const plural = ', 'const raw = ', 'const txt = ', 'const safeHref = ', 'function row(', 'const overline = ',
  'const pill = ', 'const none = ', 'const vtools = ', 'const cap = ', 'const dirFirstLine = ', 'const dirReadPill = ', 'const dirTarget = ', 'const teamDirMeta = ',
  'const TDIR_TABS = ', 'const TDIR_KINDS = ', 'const tdirArg = '].map(decl).join('\n');

const dir = (o: Record<string, unknown>) => ({ body: 'Do the thing.', version: 1, reported_by: null, reviewed_at: 1, exempt_here: null, copy_of: null, agents: 3, current: 3, ...o });
const DATA = {
  count: 3, behind: 1, hub: 1, hub_behind: 0, hub_exempt: 1, copies: 1, open_reports: 0,
  directives: [
    dir({ id: 'dir_team', title: 'Commit small', scope_kind: 'team', scope_label: 'team Conclave Developers', reach_label: 'team Conclave Developers', group: 'team', tab: 'team', current: 2 }),
    dir({ id: 'dir_prj', title: 'Use the vault', scope_kind: 'project', scope_label: 'project APPS', reach_label: 'project APPS', group: 'project', tab: 'team' }),
    dir({ id: 'dir_copy', title: 'Commit small', scope_kind: 'agent', scope_label: 'agent Leonor', reach_label: 'agent Leonor', group: 'member', tab: 'members', agents: 1, current: 1,
      copy_of: { id: 'dir_team', title: 'Commit small', scope_kind: 'team', scope_label: 'team Conclave Developers' } }),
    dir({ id: 'dir_hub', title: 'Be kind', scope_kind: 'hub', scope_label: 'all agents', reach_label: 'All agents', group: 'hub', tab: 'hub' }),
    dir({ id: 'dir_hubx', title: 'Log every call', scope_kind: 'hub', scope_label: 'all agents', reach_label: 'All agents except team Conclave Developers', group: 'hub', tab: 'hub', agents: 0, current: 0,
      exempt_here: { id: 'dex_1', kind: 'team', label: 'team Conclave Developers', own: true } }),
    dir({ id: 'dir_hubp', title: 'Pin versions', scope_kind: 'hub', scope_label: 'all agents', reach_label: 'All agents except project APPS', group: 'hub', tab: 'hub', agents: 0, current: 0,
      exempt_here: { id: 'dex_2', kind: 'project', label: 'project APPS', own: false } }),
  ],
};
/* The same team, its one copy repeating a hub-wide rule instead. */
const HUBCOPY = { ...DATA, directives: DATA.directives.map((x) => (x.id === 'dir_copy' ? { ...x, title: 'Be kind', copy_of: { id: 'dir_hub', title: 'Be kind', scope_kind: 'hub', scope_label: 'all agents' } } : x)) };
/* Renders #tdirs/<arg> as an admin (or not); returns the screen and the api paths it fetched. */
const render = async (arg: string, admin = true, data: unknown = DATA) => {
  const calls: string[] = [];
  const api = async (p: string) => { calls.push(p); return p.endsWith('/directives') ? data : { team: { id: 'team_cd', name: 'Conclave Developers', members: [] } }; };
  const VIEWS: Record<string, (a: string) => Promise<any>> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const f = new Function('api', 'S', 'VIEWS', 'stOf', `${helpers}\n${view}\nreturn VIEWS;`);
  const V = f(api, { me: { role: admin ? 'admin' : 'member' } }, VIEWS, () => ['', '', '']);
  return { r: await V.tdirs(arg), calls };
};

describe('#tdirs source', () => {
  it('drops the folded Hub-wide group and its state', () => {
    expect(js).not.toMatch(/TDIR_OPEN/);
    expect(js).not.toMatch(/data-tdir-hub/);
    expect(js).not.toMatch(/TDIR_GROUPS/);
  });
  it('reads the tab from the hash and switches tabs by replacing the route', () => {
    expect(view).toMatch(/const \[teamId, tab0 = 'team'\] = String\(arg\)\.split\('\|'\)/);
    expect(js).toMatch(/closest\('\[data-tdirs-tab\]'\); if \(tdt\) \{ openD\('tdirs', tdt\.dataset\.tdirsTab, true\)/);
  });
  it('keeps a rule off the team and applies it again through the exemption routes, and folds copies by retiring them', () => {
    expect(view).toMatch(/post\(`\/directives\/\$\{encodeURIComponent\(x\.id\)\}\/exemptions`, \{ target_kind: 'team', target_ref: teamId, note \}\)/);
    expect(view).toMatch(/api\(`\/directives\/\$\{encodeURIComponent\(x\.id\)\}\/exemptions\/\$\{encodeURIComponent\(e\.id\)\}`, 'DELETE'\)/);
    expect(view).toMatch(/post\(`\/directives\/\$\{encodeURIComponent\(x\.id\)\}\/retire`, \{ note: `same as "\$\{x\.copy_of\.title\}"/);
    expect(view).toMatch(/Kept off \$\{t\.name\}; \$\{plural\(r\.lost, 'agent'\)\} told to stop/);
  });
  it('lifts only this team\'s own exemption at once; a project, agent or other-team exemption asks first, naming the wider target', () => {
    expect(view).toMatch(/if \(x\.exempt_here\.own\) unexempt\(x\); else againWide\(x, b\);/);
    expect(view).toMatch(/title: `Apply "\$\{x\.title\}" again to \$\{e\.label\}`/);
    expect(view).toContain('agents outside ${esc(t.name)} are told too.');
  });
  it('reopens the list after folding, even when a retire fails partway', () => {
    expect(view).toMatch(/try \{\n\s+for \(const x of copies\) await post\([^\n]*\n[^\n]*\n\s+\} finally \{ reopen\(\); \}/);
  });
  it('accepts the tab argument in ROUTE_OK and nothing else', () => {
    const RID = /^[a-z]+[_-][A-Za-z0-9_-]+$/;
    // A #tdir route may carry the directive page's agent-list filters after the first & (dirAgSplit, dirAgOk).
    const ag = ['const DIR_AG = ', 'const dirAgOk = ', 'const dirAgSplit = '].map(decl).join('\n');
    const ok = (k: string) => {
      const m = new RegExp(`\\b${k}: (\\(a\\) => \\{[^\\n]*?\\}),`).exec(js); expect(m, k).toBeTruthy();
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('RID', 'TDIR_TAB_OK', `${ag}\nreturn ${m![1]};`)(RID, ['team', 'members', 'hub']) as (a: string) => boolean;
    };
    const tdirs = ok('tdirs'), tdir = ok('tdir');
    for (const a of ['team_cd', 'team_cd|team', 'team_cd|members', 'team_cd|hub']) expect(tdirs(a), a).toBe(true);
    for (const a of ['team_cd|', 'team_cd|x', 'team_cd|hub|x', 'x|hub', '']) expect(tdirs(a), a).toBe(false);
    for (const a of ['team_cd|dir_1', 'team_cd|dir_1|members', 'team_cd|dir_1|hub']) expect(tdir(a), a).toBe(true);
    for (const a of ['team_cd', 'team_cd|dir_1|x', 'team_cd|dir_1|hub|x']) expect(tdir(a), a).toBe(false);
    for (const a of ['team_cd|dir_1&aq=ops', 'team_cd|dir_1|members&at=team_cd&as=unread']) expect(tdir(a), a).toBe(true);
    for (const a of ['team_cd|dir_1&zz=1', 'team_cd|dir_1&as=nope', 'team_cd|dir_1|x&aq=ops']) expect(tdir(a), a).toBe(false);
  });
  it('styles kept-off rows and gives the trail actions a 44x44 px target (the 32 px phone icon button too)', () => {
    expect(css).toMatch(/\.lrow\.tdir-off \.lrow-title\{color:var\(--muted\)\}/);
    expect(css).toMatch(/\.lrow-trail \.btn\.tdir-act::after\{[^}]*height:var\(--h-touch\)/);
    expect(css).toMatch(/\.lrow-trail \.btn\.tdir-act::after\{[^}]*width:max\(100%,var\(--h-touch\)\)/);
  });
});

describe('#tdirs render', () => {
  it('shows one .tabs tablist with three tabs and This team selected by default', async () => {
    const { r, calls } = await render('team_cd');
    expect(calls).toEqual(['/teams/team_cd', '/teams/team_cd/directives']);
    const nav = /<nav class="tabs" role="tablist"[^>]*>(.*?)<\/nav>/.exec(r.b)!;
    expect(nav).toBeTruthy();
    const tabs = [...nav[1]!.matchAll(/<button type="button" role="tab" class="(on)?" aria-selected="(true|false)" data-tdirs-tab="([^"]+)">([^<]+)<span class="cnt">(\d+)<\/span>/g)]
      .map((m) => [m[4], m[5], m[2], m[3]]);
    expect(tabs).toEqual([['This team', '2', 'true', 'team_cd'], ['Members', '1', 'false', 'team_cd|members'], ['Hub-wide', '3', 'false', 'team_cd|hub']]);
    // Two kinds present: an overline per kind; meta is the reach label; rows open the directive.
    expect(r.b).toContain('For the team'); expect(r.b).toContain('For the project'); expect(r.b).not.toContain('For a role');
    expect(r.b).toContain('Team Conclave Developers'); expect(r.b).toContain('data-tdir="team_cd|dir_team"');
    expect(r.here).toEqual({ label: 'Directives', meta: '3 directives · 1 not read · 1 hub-wide (1 exempt)' });
  });
  it('counts kept-off rows in the tab badge and says "kept off" when no hub rule is in force', async () => {
    const ONLY_OFF = { ...DATA, hub: 0, hub_exempt: 1, directives: DATA.directives.filter((x) => x.id !== 'dir_hub' && x.id !== 'dir_hubp') };
    const { r } = await render('team_cd|hub', true, ONLY_OFF);
    expect(r.b).toMatch(/data-tdirs-tab="team_cd\|hub">Hub-wide<span class="cnt">1<\/span>/);
    expect(r.here.meta).toBe('3 directives · 1 not read · 1 hub-wide kept off');
  });
  it('flags member copies and offers to fold them (6.A12)', async () => {
    const { r } = await render('team_cd|members');
    expect(r.b).toMatch(/aria-selected="true" data-tdirs-tab="team_cd\|members"/);
    expect(r.b).toContain('Same as team rule'); expect(r.b).toContain('Copy of &quot;Commit small&quot;');
    expect(r.b).toMatch(/<div class="overline"><span>Leonor<\/span>/);
    expect(r.b).toContain('data-tdir="team_cd|dir_copy|members"');
    expect(r.b).toMatch(/data-tdir-fold>Fold 1 copy into team rules/);
    expect((await render('team_cd|members', false)).r.b).not.toContain('data-tdir-fold');
  });
  it('names the kind of rule a copy repeats', async () => {
    const { r } = await render('team_cd|members', true, HUBCOPY);
    expect(r.b).toContain('Same as hub rule'); expect(r.b).not.toContain('Same as team rule');
    expect(r.b).toMatch(/data-tdir-fold>Fold 1 copy into hub rules/);
  });
  it('lists hub-wide rules in force with Not for this team, then the kept-off ones with Apply again', async () => {
    const { r } = await render('team_cd|hub');
    const [inForce, kept] = r.b.split('Not for this team</span>');
    expect(inForce).toContain('data-tdir-off="dir_hub"'); expect(inForce).toContain('data-tdir-more="dir_hub"');
    expect(kept).toContain('lrow tdir-off'); expect(kept).toContain('data-tdir-on="dir_hubx|dex_1"');
    expect(kept).toContain('Kept off team Conclave Developers');
    // This team's own exemption applies again at once; a project one is marked as reaching wider (it opens a confirm sheet).
    expect(kept).toMatch(/data-tdir-on="dir_hubx\|dex_1">Apply again/);
    expect(kept).toContain('Kept off project APPS');
    expect(kept).toContain('data-tdir-on="dir_hubp|dex_2" title="Lifts the exemption on project APPS" aria-haspopup="dialog">Apply again');
    expect(r.b).toContain('Hub-wide rules are in force for every agent unless kept off a team, project or agent.');
    // Rows are divs with role=button, so the trail buttons are not nested in another button.
    expect(r.b).not.toMatch(/<button[^>]*class="lrow/);
    const member = (await render('team_cd|hub', false)).r.b;
    expect(member).not.toContain('data-tdir-off'); expect(member).not.toContain('data-tdir-on');
  });
  it('falls back to This team for an unknown tab', async () => {
    const { r } = await render('team_cd|nope');
    expect(r.b).toMatch(/aria-selected="true" data-tdirs-tab="team_cd"/);
  });
});
