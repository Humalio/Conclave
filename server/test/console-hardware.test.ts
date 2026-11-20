/** Operator console, Hardware (docs/dashboard-ux.md, docs/hardware.md#console): the list and machine routes, their Security tab,
 *  both screens, the shared toolbar, the analysis, the week grid and the sheet. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i)); };
// A const to its end: the closing '};' for a block arrow, else the first ';' at a line end.
const cst = (name: string) => { const i = js.indexOf(`const ${name} = `); expect(i, name).toBeGreaterThan(-1); const block = js.slice(i, js.indexOf('\n', i)).endsWith('{'); return js.slice(i, js.indexOf(block ? '\n};\n' : ';\n', i)); };
const view = (name: string) => { const i = js.indexOf(`VIEWS.${name} = async`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n};\n', i)); };

describe('console: Hardware', () => {
  it('has a list route and a machine route under Security, after PCs', () => {
    expect(js).toContain("pcs: navRoot('PCs'), hardware: navRoot('Hardware'),");
    expect(js).toContain('  hardware: (a) => !a, hwm: (a) => RID.test(a),');
    expect(js).toContain("hwm: { parent: () => ['hardware'],");
    expect(js).toContain("hardware: '#securityBar', hwm: '#securityBar'");
    expect(js).toMatch(/security: \[[^\]]*'pc', 'hardware', 'hwm', 'req'/);
    expect(js).toContain("hardware: 'hardware', hwm: 'hardware', req: 'req'");
    const bar = html.slice(html.indexOf('id="securityBar"'), html.indexOf('</section>', html.indexOf('id="securityBar"')));
    expect(bar.match(/data-go="hardware"/g)).toHaveLength(2);
    expect(bar.indexOf('data-go="hardware"')).toBeGreaterThan(bar.indexOf('data-go="pcs"'));
  });

  it('heads the list with counts, a period select and Add machine, the one name for the action', () => {
    expect(cst('hwHead')).toContain("plural(H.counts.machines, 'machine'))} · ${esc(H.counts.in_use)} in use · ${esc(H.counts.waiting)} waiting");
    expect(js).toContain("const HW_PERIODS = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];");
    expect(cst('hwLoad')).toContain("api('/hardware?'");
    expect(cst('hwLoad')).toContain('period: HW_F.p, tz');
    expect(js).not.toMatch(/Register machine|Add a machine/);
    expect(js.match(/Add machine/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it('shows flags, then one row per machine that opens it, then the toolbar and the analysis', () => {
    const v = view('hardware');
    expect(v.indexOf('hw-flags')).toBeLessThan(v.indexOf('hw-machines'));
    expect(v.indexOf('hw-machines')).toBeLessThan(v.indexOf('hwToolbar(H, false)'));
    expect(v.indexOf('hwToolbar(H, false)')).toBeLessThan(v.indexOf('hwAnalysis(H.analysis'));
    expect(v).toContain('No machine is offered for compute yet');
    const r = cst('hwRow');
    expect(r).toContain('href: `#hwm/${encodeURIComponent(m.id)}`');
    expect(r).toContain('m.waiting.length)} waiting');
    expect(r).toContain('h.estimate_until');
    const st = cst('hwState');
    for (const s of ["'Paused', 'warn'", "'Any time', 'ok'", '`In window · until ${m.availability.until}`', '`Closed${m.availability.next ? ` · opens ${m.availability.next}` : \'\'}`']) expect(st).toContain(s);
  });

  it('words each flag kind, keeps the hold, and clears it from the console', () => {
    const f = cst('hwFlag');
    expect(f).toContain("when it lost its ${f.reason === 'task' ? 'task' : 'access'}");
    expect(f).toContain('after its window ended.');
    expect(f).toContain("daily allowance.");
    expect(f).toContain('went over a declared limit');
    expect(f).toContain('The hold was not removed.');
    expect(fn('hwWire')).toContain('/clear`');
    expect(js).toContain("const HW_FLAG = { lost: 'Lost task', window: 'Past window', allowance: 'Past allowance', limit: 'Over limit' };");
  });

  it('uses the Blueprint toolbar: search, chips per machine, team and agent with counts, and a Where you are line', () => {
    const t = fn('hwToolbar');
    expect(t).toContain('id="hwQ"');
    expect(t).toContain("['team', 'Team'], ['agent', 'Agent']");
    expect(t).toContain("onMachine ? [] : [['machine', 'Machine']]");
    expect(t).toContain('class="bp-chip${HW_F[d] === v.id ? \' on\' : \'\'}"');
    expect(t).toContain('aria-pressed=');
    expect(t).toContain('class="hw-where"');
    expect(t).toContain('class="bp-show" aria-live="polite"');
    expect(t).toContain('data-hwf="clear"');
    const w = fn('hwWire');
    expect(w).toContain("Object.assign(HW_F, { q: '', machine: '', team: '', agent: '' })");
    expect(w).toContain("e.key === 'Enter'");
  });

  it('draws the analysis: stats, bars per day stacked by team, a legend and the top tasks', () => {
    const a = fn('hwAnalysis');
    for (const s of ["'held'", "'of open time held'", "'median wait'", "'longest wait'", "'hold with a flag'", "overline('Top tasks'", 'class="hw-bars" role="img"', 'hw-legend', 'Nothing was held in this period.']) expect(a).toContain(s);
    // Only geometry goes inline: the segment heights. Team colours are classes on the series tokens.
    expect(a).toContain('style="height:');
    expect(a).not.toMatch(/style="[^"]*background/);
    expect(cst('hwSeries')).toContain('hw-s');
  });

  it('opens a machine page with Pause, Edit, the list, allowances, limits, the week grid, What ran and its analysis', () => {
    const v = view('hwm');
    expect(v).toContain('hwLoad({ machine: id })');
    expect(v).toContain("switchBtn(m.paused ? 'Resume the machine' : 'Pause the machine', m.paused, 'id=\"hwPause\"')");
    expect(v).toContain("${m.paused ? 'resume' : 'pause'}`");
    for (const s of ['hwList(m)', "overline('Allowances'", 'hwAllow(m)', "overline('Limits')", 'hwGrid(m)', 'hw-wl', "overline('What ran'", 'hwRan', 'hwToolbar(H, true)', 'hwAnalysis(m.analysis', 'data-hw-edit']) expect(v).toContain(s);
    const l = fn('hwList');
    for (const s of ["overline('Holder')", "overline('Waiting', m.waiting.length)", 'hwRm(h)', 'hwRm(e)']) expect(l).toContain(s);
    expect(cst('hwAllow')).toContain('today');
    expect(cst('hwRan')).toContain('h.flags.map');
  });

  it('edits the week grid by dragging, saving whole-hour windows, with the list as the phone and keyboard way', () => {
    const g = fn('hwGrid');
    expect(g).toContain('role="img"');
    expect(g).toContain('Edit the hours in the list of windows below.');
    expect(g).toContain('data-d="${d}" data-h="${h}"');
    expect(g).toContain("m.week[d][h] ? ' held' : ''");
    const d = fn('hwGridDrag');
    for (const s of ['onpointerdown', 'onpointermove', 'onpointerup', 'W.length > 14']) expect(d).toContain(s);
    expect(fn('hwGridWindows')).toContain("'24:00'");
    expect(view('hwm')).toContain("'PUT', hwBody(m, W)");
    expect(css).toMatch(/@media \(max-width:767px\)\{\.hw-wk,\.hw-key\{display:none\}\}/);
  });

  it('adds and edits in one sheet with opening hours, daily hours per team and a preview; Stop asks once more', () => {
    const s = fn('hwSheet');
    for (const o of ["overline('Machine')", "overline('Access')", "overline('Opening hours')", "overline('Limits')", "overline('Teams')", "overline('Preview')", "'Add machine'", 'Add one by name', 'Add window', 'data-allow=']) expect(s).toContain(o);
    expect(s).toContain('allowances: Object.fromEntries(picked.map(');
    expect(s).toContain('Daily hours: between 0.25 and 24');
    expect(s).toContain("post('/hardware/preview'");
    expect(s).toContain("'PUT', b)");
    expect(s).toContain("confirmOnce(sh, 'hwStop'");
    expect(s).toContain('never paste a key here');
    expect(s).not.toContain("overline('Availability')");
  });

  it('shows the measured use: bars or Not measured, the figures per hold and period, the over-limit flag as the machine’s', () => {
    // The Machines card: three small bars from the live sample, or Not measured with the reason.
    const mini = cst('hwMini');
    expect(mini).toContain('Not measured');
    expect(mini).toContain("bar('CPU'");
    expect(mini).toContain("bar('Mem'");
    expect(mini).toContain("bar('GPU'");
    expect(cst('hwRow')).toContain('trail: `${hwMini(m)}${pill(st, tone)}`');
    expect(cst('hwUnmeasured')).toContain('Its user has not turned measuring on');
    // The machine page: labelled bars, what they are, and the Shared with people note.
    const use = fn('hwUse');
    expect(use).toContain("not proof of what the holder ran");
    expect(use).toContain('these figures include their own use');
    expect(view('hwm')).toContain("${overline('Use now')}${hwUse(m)}");
    // What ran and the analysis label the figures as the machine's; Top tasks stay ranked by hours held.
    expect(cst('hwRan')).toContain('The machine during this hold: ');
    const a = fn('hwAnalysis');
    expect(a).toContain("hwUx('Use with no holder'");
    expect(a).toContain('Top tasks are ranked by hours held only.');
    expect(a.indexOf("overline('Machine use')")).toBeLessThan(a.indexOf("overline('Top tasks'"));
    // Over limit, worded as the machine's use against the declared limit.
    const flag = cst('hwFlag');
    expect(flag).toContain("the machine used ${esc(hwGb(f.mem_peak))} during this hold, over the ${esc(hwGb(m.memory_gb))} limit.");
    expect(flag).toContain('CPUs during this hold, over the');
  });

  it('the sheet has Shared with people and, last, Measure this machine with the opt-in command', () => {
    const s = fn('hwSheet');
    expect(s).toContain('id="hwShared"');
    expect(s).toContain("shared_with_people: $('#hwShared', sh).checked");
    expect(s).toContain('<code>conclave hardware on</code>');
    expect(s.indexOf("overline('Measure this machine')")).toBeGreaterThan(s.indexOf("overline('Preview')"));
    expect(s).toContain('href="#pc/');
    expect(cst('hwBody')).toContain('shared_with_people: !!m.shared_with_people');
  });

  it('has its styles without new colours and maps its reset tables to the screen', () => {
    for (const c of ['.hw-row', '.hw-tools', '.hw-bars', '.hw-seg', '.hw-wk', '.hw-c.open', '.hw-c.held', '.hw-meter', '.hw-ent', '.hw-win', '.hw-alw', '.hw-pre', '.hw-mini', '.hw-meter.sm', '.hw-use', '.hw-ub', '.hw-ru']) expect(css).toContain(c);
    expect(css).not.toMatch(/\.hw-[^{]*\{[^}]*#[0-9a-f]{3,6}/i);
    for (const t of ['hw_machines', 'hw_machine_teams', 'hw_queue', 'hw_flags', 'hw_holds', 'hw_samples', 'hw_hold_use', 'hw_use_days']) expect(js).toMatch(new RegExp(`${t}: \\['[^']+', 'hardware'\\]`));
  });
});
