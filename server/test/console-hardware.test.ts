/** Operator console, Hardware (docs/dashboard-ux.md, docs/hardware.md#console): one route, its Security tab, the screen and its sheet. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i)); };
const view = () => { const i = js.indexOf('VIEWS.hardware = async'); expect(i).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n};\n', i)); };

describe('console: Hardware', () => {
  it('is one route under Security, after PCs, on desktop and phone', () => {
    expect(js).toContain("pcs: navRoot('PCs'), hardware: navRoot('Hardware'),");
    expect(js).toContain('  hardware: (a) => !a,');
    expect(js).toContain("hardware: '#securityBar'");
    expect(js).toMatch(/security: \[[^\]]*'pc', 'hardware', 'req'/);
    expect(js).toContain("hardware: 'hardware', req: 'req'");
    const bar = html.slice(html.indexOf('id="securityBar"'), html.indexOf('</section>', html.indexOf('id="securityBar"')));
    expect(bar.match(/data-go="hardware"/g)).toHaveLength(2);
    expect(bar.indexOf('data-go="hardware"')).toBeGreaterThan(bar.indexOf('data-go="pcs"'));
  });

  it('shows flags first, then a card per machine, with an empty state that offers Register machine', () => {
    const v = view();
    expect(v).toContain("api('/hardware')");
    expect(v.indexOf('hw-flags')).toBeLessThan(v.indexOf('hw-grid'));
    expect(v).toContain('No machine is offered for compute yet');
    expect(v).toContain("arm(b, () => run(async () => { await post(`/hardware/entries/");
    expect(v).toContain('/clear`');
    expect(v).toContain("$$('#hwReg,#hwRegE,#hwRegM').forEach");
    expect(fn('hwSheet')).toContain("$$('[data-team]', sh)");
    const card = fn('hwCard');
    for (const s of ["kv('Access'", "kv('Availability'", "kv('Limits'", "kv('Teams'", "overline('Holder')", "overline('Waiting', m.waiting.length)", 'data-hw-edit', 'hwRm(h)', 'hwRm(e)']) expect(card).toContain(s);
    expect(js).toContain('when it lost its ${f.reason === \'task\' ? \'task\' : \'access\'}');
  });

  it('registers and edits in one sheet with a preview, and Stop offering compute asks once more', () => {
    const s = fn('hwSheet');
    for (const o of ["overline('Machine')", "overline('Access')", "overline('Availability')", "overline('Limits')", "overline('Teams')", "overline('Preview')", 'Add a machine', 'Add window']) expect(s).toContain(o);
    expect(s).toContain("post('/hardware/preview'");
    expect(s).toContain("'PUT', b)");
    expect(s).toContain("confirmOnce(sh, 'hwStop'");
    expect(s).toContain('never paste a key here');
  });

  it('has its styles and maps its reset tables to the screen', () => {
    for (const c of ['.hw-grid', '.hw-card', '.hw-ent', '.hw-win', '.hw-pre']) expect(css).toContain(c);
    expect(css).not.toMatch(/\.hw-[^{]*\{[^}]*#[0-9a-f]{3,6}/i);
    for (const t of ['hw_machines', 'hw_machine_teams', 'hw_queue', 'hw_flags']) expect(js).toMatch(new RegExp(`${t}: \\['[^']+', 'hardware'\\]`));
  });
});
