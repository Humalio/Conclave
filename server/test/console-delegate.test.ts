/**
 * Operator console, Delegate one agent (docs/dashboard-ux.md "Delegate an agent"): the sheet's choices, the steps it walks
 * through, the status line, Take back and Run on my PC. The sheet's source and its drawn markup are checked here; the
 * screens are looked at on a dev hub at 1440 and 390 px.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const blk = js.slice(js.indexOf('// ==== Delegate one agent to a collaborator ===='), js.indexOf('// ==== Settings: Checkout ===='));

/** The step and the permission helpers, run as the page runs them (they use only esc, kv and pill from the page). */
const fns = new Function('esc', 'kv', 'pill', 'CO_PERM', 'CO_PROV', 'selField', 'ic', `${blk.slice(blk.indexOf('const DLG_OPEN'), blk.indexOf('/* The Status card'))}
  ${blk.slice(blk.indexOf('const dlgPerms'), blk.indexOf('function dlgFormHtml'))}
  return { dlgStep, dlgPerms };`);
const realEsc = new Function(`return ${js.slice(js.indexOf('const esc = ') + 12, js.indexOf('\n', js.indexOf('const esc = '))).replace(/;$/, '')}`)() as (s: unknown) => string;
const { dlgStep, dlgPerms } = fns(realEsc, () => '', () => '', {}, {}, () => '', () => '') as { dlgStep: (c: any) => { tone: string; head: string; text: string }; dlgPerms: (p: string) => string[] };

describe('console: Delegate sheet', () => {
  it('has the choices: member, one of the administrator\'s PCs or a new one, what it runs with, and what is lost', () => {
    expect(blk).toContain("selField('dlgMember', 'Member'");
    expect(blk).toContain('data-dlg-pc="have"');
    expect(blk).toContain('Already set up');
    expect(blk).toContain('data-dlg-pc="new"');
    expect(blk).toContain('>New PC<');
    expect(blk).toContain("(S.pcs || []).filter((p) => p.status === 'active')");
    expect(blk).toContain('What the agent loses while delegated');
    expect(blk).toContain('DLG_R.preview(a.id, u)');
    expect(blk).toContain('!p.keeps_team_work && !p.reads_project');
    expect(blk).toContain("selField('dlgPerm', 'Permissions'");
  });
  it('offers active users by display name (else username), external ones with their org', () => {
    expect(blk).toContain("filter((x) => x.status === 'active' && x.id !== S.me?.id)");
    expect(blk).toContain('(x.display_name || x.username) + (x.external');
  });
  it('lists only permission levels at or below the agent\'s own: lowered, never raised', () => {
    expect(dlgPerms('plan')).toEqual(['plan']);
    expect(dlgPerms('default')).toEqual(['plan', 'default']);
    expect(dlgPerms('acceptEdits')).toEqual(['plan', 'default', 'acceptEdits']);
    expect(dlgPerms('bypassPermissions')).toHaveLength(4);
    expect(dlgPerms('something-new')).toEqual(['plan']);
  });
  it('names the step in words: saving work, the prompt, the PC check, the approval, then the running line', () => {
    expect(dlgStep({ status: 'collecting' }).head).toBe('Saving work…');
    expect(dlgStep({ status: 'rendered', member: { name: 'Lena Ortiz' }, pc: { name: 'lena-laptop' } }).head).toBe('Waiting for Lena Ortiz to run the prompt');
    expect(dlgStep({ status: 'restoring', member: { name: 'Lena Ortiz' }, pc: { name: 'lena-laptop' } }).head).toBe('Restored on lena-laptop');
    const c = dlgStep({ status: 'restoring', member: { name: 'Lena Ortiz' }, pc: { name: 'lena-laptop', new: true, enrolled: true, confirmed: false } });
    expect(c.head).toBe('Waiting for Lena Ortiz to confirm lena-laptop');
    const w = dlgStep({ status: 'restoring', member: { name: 'Lena Ortiz' }, pc: { name: 'lena-laptop', new: true, approval: 'waiting', enrolled: true, confirmed: true, enrolled_from: '203.0.113.9' } });
    expect(w.head).toBe('Waiting for you to approve lena-laptop');
    expect(w.tone).toBe('warn');
    expect(dlgStep({ status: 'restored', member: { name: 'Lena Ortiz' }, pc: { name: 'lena-laptop' } }).head).toBe('Running on lena-laptop · delegated to Lena Ortiz');
  });
  it('never shows the prompt to the administrator: only the member\'s Home does, held in the page', () => {
    const admin = blk.slice(0, blk.indexOf('/* The member\'s side'));
    expect(admin).not.toContain('codeBox');
    expect(admin).toContain("own console, behind their sign-in");
    expect(blk).toContain('DLG.prompt[id] =');
    expect(blk).not.toMatch(/sessionStorage|indexedDB/);
    expect(blk.match(/localStorage\.\w+\('[^']+'/g)).toEqual(["localStorage.getItem('dlgSeen'", "localStorage.setItem('dlgSeen'"]);
    expect(blk).toContain('good for 30 minutes');
  });
  it('approves a new PC only once the member has said it is theirs', () => {
    expect(blk).toContain("c.pc.approval === 'waiting' && !!c.pc?.enrolled && !!c.pc?.confirmed");
    expect(blk).toContain('id="dlgOk"');
  });
  it('the member\'s Home row asks Is this your PC, shows the prompt with Copy and says when it was taken back', () => {
    expect(blk).toContain('Is this your PC: ${esc(d.confirm_pc.name)}');
    expect(blk).toContain('data-dlg-mu="yes"');
    expect(blk).toContain('data-dlg-mu="no"');
    expect(blk).toContain('codeBox(P.text, true)');
    expect(blk).toContain('took ${ag} back');
    expect(js).toContain('const dm = dlgMemberHtml(await dlgMine());');
    expect(js).toContain('[data-dlg-mu]');
  });
  it('Take back offers to retire the PC and the agent page shows a Contributor tag', () => {
    expect(blk).toContain('Also retire ${esc(c.pc.name)}');
    expect(blk).toContain('retire_pc:');
    expect(js).toContain('>Contributor</span>');
  });
  it('escapes the member\'s and the PC\'s names where they are drawn', () => {
    const progress = blk.slice(blk.indexOf('function dlgProgressHtml'), blk.indexOf('/* Open the sheet'));
    expect(progress).toContain("esc(c.member?.name || 'the member')");
    expect(progress).toContain("esc(`${c.pc?.name || '—'}");
    expect(progress).toContain('<b>${esc(s.head)}</b>');
    expect(dlgStep({ status: 'restored', member: { name: '<img src=x onerror=alert(1)>' }, pc: { name: 'p' } }).text).toBe('');
    const hostile = dlgStep({ status: 'rendered', member: { name: '<img src=x onerror=alert(1)>' }, pc: { name: '<b>pc</b>', new: true } });
    expect(hostile.text).not.toContain('<img');
    expect(hostile.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(hostile.text).toContain('&lt;b&gt;pc&lt;/b&gt;');
  });
});

describe('console: Delegate on the agent page', () => {
  it('shows the delegation in the Status card and the actions in the page menu', () => {
    expect(js).toContain('${dlgRow(dl)}${kv(\'Team\'');
    expect(js).toContain('...dlgActions(a, dl, reopen)');
    expect(blk).toContain("label: 'Take back'");
    expect(blk).toContain("label: 'Run on my PC'");
    expect(blk).toContain("label: open ? 'Open delegation' : 'Delegate'");
  });
  it('Take back confirms first and says what is not recovered', () => {
    expect(blk).toContain("title: 'Take back', tone: 'bad', label: 'Take back', dismiss: 'Keep delegated'");
    expect(blk).toContain('stops working at once');
    expect(blk).toContain('is not recovered');
  });
  it('shows no action to someone who cannot delegate', () => {
    expect(blk).toContain('if (!dl || dl.can_delegate === false) return [];');
  });
  it('the sheet stacks on a phone and the prompt scrolls inside itself', () => {
    expect(css).toContain('.dlg-sheet .co-prompt .code{max-height:40vh;overflow:auto;');
    expect(css).toContain('.dlg-row{grid-template-columns:1fr}');
  });
  it('offers a drafts folder as an explicit choice (None by default) and labels the agent "via" the member', () => {
    expect(blk).toContain('id="dlgDraft"');
    expect(blk).toContain('drafts_folder:');
    expect(blk).toContain('ends at Take back');
    expect(js).toContain('esc(e.actor.label + viaTxt(e.actor))');
    expect(js).toContain('esc(who + viaTxt(pr))');
    expect(js).toContain('const viaTxt = (o) => { const n = typeof o?.via === \'string\'');
  });
  it('one helper adds "via <member>" to every place that names who wrote', () => {
    expect(js).toContain('const bpWho = (s, o) => bpWho0(s) + viaTxt(o);');
    expect(js).toContain('const by = e.actor.label + viaTxt(e.actor);');
    expect(js).toContain("e.actor?.label ? e.actor.label + viaTxt(e.actor) : ''");
    expect(js).toContain('bpWho0(r.actor)) + viaTxt(r);');
  });
  it('the took-back row can be dismissed, and stays dismissed', () => {
    expect(blk).toContain('data-dlg-mu="dismiss"');
    expect(blk).toContain("seen.includes(d.id)");
  });
  it('a member with an agent lent to them lands on Home, not on their single project', () => {
    expect(js).toContain("if ((await dlgMine()).length) return '';");
  });
});
