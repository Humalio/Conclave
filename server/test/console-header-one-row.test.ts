/* The one-row page header (docs/design-guidelines.md, Page header): team and project screens and everything inside them put
   ‹, the crumbs, the title and the actions on one 56 px row; the workspace screens keep their own header; on phones the team
   page has no button row under the app bar, its Pause and Chat are in the app bar's ⋯. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const fnSrc = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i)); };
const teamScreens = new Set(/const TEAM_SCREENS = new Set\(\[([^\]]*)\]\)/.exec(js)![1]!.match(/[a-z]+/g));
const rule = (sel: string) => { const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\{([^}]*)\\}`).exec(css); expect(m, sel).not.toBeNull(); return m![1]!; };

describe('one-row page header', () => {
  it('applies to the team and project screens only', () => {
    for (const t of ['team', 'tasks', 'members', 'tsettings', 'tdirs', 'tchats', 'tses', 'decisions', 'task', 'blueprint', 'bp']) expect(teamScreens.has(t), t).toBe(true);
    for (const t of ['vault', 'knowledge', 'security', 'keys', 'pcs', 'pc', 'log', 'feedback', 'fbr', 'sessions', 'ses', 'topology', 'chats', 'room', 'directives', 'directive', 'needs', 'backlog']) expect(teamScreens.has(t), t).toBe(false);
    const open = fnSrc('async function openD(');
    expect(open).toContain("$('#viewHeader').classList.toggle('one', TEAM_SCREENS.has(type) || !!r.one);");
    expect(open).toContain("classList.toggle('rt', !!r.one && !TEAM_SCREENS.has(type))");
    expect(open).toMatch(/r\.after && r\.after\(\);\n\s+fitHeader\(\);/);
  });

  it('lets a screen outside the team set put its title at the right end of the back-button row (Needs you)', () => {
    const ny = fnSrc('VIEWS.needs = ');
    expect(ny).toContain("here: { label: 'Needs you' }, one: true,");
    expect(ny).not.toContain('ny-aside');
    expect(ny).not.toContain('${head}');
    expect(rule('.dh.one.rt h2')).toContain('margin-left:auto');
    expect(css).toContain('@media (max-width:719.98px){.dh.one.rt{flex-wrap:wrap');
  });

  it('keeps it on one 56 px row: nothing wraps and the actions never shrink', () => {
    expect(rule('.dh.one')).toMatch(/flex-wrap:nowrap;height:56px;min-height:56px/);
    expect(rule('.dh.one>.trail')).toContain('margin:0');
    expect(rule('.dh.one h2')).toMatch(/flex:1 1 0;min-width:8em;.*white-space:nowrap/);
    expect(rule('.dh.one .dact')).toBe('flex:none;flex-wrap:nowrap;margin-left:auto');
    // The task title and its meta share the row, one line each.
    expect(rule('.dh.one .tk-ht')).toContain('flex-direction:row');
    expect(rule('.dh.one .tk-h')).toMatch(/display:block;.*white-space:nowrap;text-overflow:ellipsis/);
    // Buttons are 28 px, ⋯ included.
    expect(rule('.dh.one .dact>.btn:not(.sm)')).toBe('height:28px');
    expect(rule('.dh.one .dact>.btn.ic')).toBe('width:28px');
    // The two-row header elsewhere is unchanged and hides the separator that leads into the title.
    expect(rule('.dh>.trail')).toBe('flex:1 0 100%;margin:calc(var(--s2) * -1) 0');
    expect(rule('.dh:not(.one) .dcrumbs .crumbs>.sep:last-child')).toBe('display:none');
  });

  it('folds the middle crumbs to … when something on the row is cut short, and lists the path in ⋯', () => {
    const fit = fnSrc('function fitHeader(');
    expect(fit).toContain("h.classList.remove('fold');");
    expect(fit).toContain("!h.querySelector('.crumbs .cr-mid')");
    expect(fit).toContain("if ($$('.crumbs a>span,#dT .ellip,#dT .tk-h,#dT .tmeta', h).some(cut)) h.classList.add('fold');");
    expect(js).toContain("addEventListener('resize', () => { cancelAnimationFrame(fitHeaderQ); fitHeaderQ = requestAnimationFrame(fitHeader); });");
    expect(rule('.dh.one.fold .crumbs .cr-mid')).toBe('display:none');
    expect(rule('.dh.one.fold .crumbs .cr-more,.dh.one.fold .crumbs .more')).toBe('display:inline-flex');
    expect(fnSrc('function setBack(')).toContain("$('#dCrumbs').title = trail.crumbs.map((c) => c.label).join(' › ')");
    const ovf = fnSrc('function openOverflow(');
    expect(ovf).toContain("$('#viewHeader').classList.contains('fold') && btn.closest('#viewHeader')");
    expect(ovf).toContain("{ heading: 'Path' }");
  });

  it('puts the team page\'s Pause and Chat in the phone app bar\'s ⋯, not in a button row, and keeps them out of the desktop ⋯', () => {
    const team = fnSrc('VIEWS.team = async');
    expect(team).not.toContain('tm-acts');
    expect(css).not.toContain('.tm-acts');
    expect(team).toContain('menu: [...teamPhoneActs(), ');
    const acts = team.slice(team.indexOf('const teamPhoneActs'), team.indexOf('  };', team.indexOf('const teamPhoneActs')));
    for (const l of ['Start', 'Pause', 'Resume', 'Chat']) expect(acts).toContain(`label: '${l}', `);
    expect(acts.match(/phone: true/g)).toHaveLength(4);
    expect(fnSrc('function openOverflow(')).toContain('DBAR_MENU.filter((m) => m && !m.phone)');
    // Desktop still shows them as the header's two labelled buttons.
    expect(team).toContain('a: prim(true) + moreBtn(),');
  });
});
