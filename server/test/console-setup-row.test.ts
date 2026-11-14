/**
 * The team page's Setup (docs/onboarding.md#setup-progress): a Done setup folds into one row on the Blueprint card that opens
 * the setup details; every other state keeps its card. Static, like console-nav.test.ts: the functions from public/app.js run in vm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
const part = (s: string, end: string) => { const i = at(s); return js.slice(i, js.indexOf(end, i) + end.length); };
const line = (name: string) => part(`const ${name} = `, '\n');

const SRC = [...['esc', 'cap', 'pill', 'OB_SRC', 'OB_SETUP', 'obSrcText', 'OB_NOACCESS', 'obSetBtn', 'obSetupFolds', 'OB_SETUP_OF', 'obSrcShort', 'obSetupLine'].map(line),
  part('const obSetupRows = ', '\n};\n'), part('const obSetupCard = ', '\n};\n'), part('const bpLine = ', '</button>`;\n')].join('');
const ctx = vm.createContext({
  ic: (n: string) => `<i data-ic="${n}"></i>`, kd: (t: string, r = '') => `<h3>${t}</h3>${r}`, kv: (k: string, v: string) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`,
  bpArg: () => 'arg', bpTrack: () => '',
});
vm.runInContext(SRC + '\nthis.F = { obSetupFolds, obSrcShort, obSetupLine, obSetupCard, OB_SETUP_OF };', ctx);
const F = (ctx as unknown as { F: Record<string, any> }).F;
const done = (source: unknown) => ({ state: 'done', responsible: null, next: 'Done: the team plans from its part (2 items).', source, request_id: 'obr_1', proposal: null, filed: [] });

describe('a Done setup is one row on the Blueprint card', () => {
  it('folds only when Done and the team has a Blueprint to show', () => {
    expect(F.obSetupFolds(done(null), { project: {} })).toBe(true);
    expect(F.obSetupFolds(done(null), null)).toBe(false); // no Blueprint card: the card stays
    for (const state of ['not_asked', 'from_source', 'coordinator_derives', 'operator_supplies', 'in_review', 'returned']) expect(F.obSetupFolds({ ...done(null), state }, { project: {} })).toBe(false);
  });

  it('reads "Setup · Done · source: …" and opens the details', () => {
    const r = F.obSetupLine(done({ from: 'existing', ref: 'docs/specification.md' }), 'prj_1');
    expect(r).toContain('>Setup<');
    expect(r).toContain('Done · source: docs/specification.md');
    expect(r).toContain('data-ob-setup="obr_1"');
    expect(F.OB_SETUP_OF.get('obr_1')[1]).toBe('prj_1');
    expect(F.obSetupLine(done(null), 'prj_1')).toContain('Done · source: not asked');
    expect(F.obSrcShort({ from: 'coordinator' })).toBe('the coordinator derives them');
    expect(F.obSrcShort({ from: 'operator' })).toBe('you supply them');
  });

  it('keeps the full card, with its action and the access note, while the setup asks for something', () => {
    const c = F.obSetupCard({ ...done(null), state: 'not_asked', responsible: 'operator', next: 'Set where the requirements or the brief come from.' }, 'prj_1');
    expect(c).toContain('Source not asked');
    expect(c).toContain('data-ob-src="obr_1"');
    expect(c).toContain('grants no access to read it');
    expect(F.obSetupCard({ ...done(null), state: 'in_review' }, 'prj_1')).not.toContain('data-ob-src');
  });

  it('is wired: the team page hides the folded card, the Blueprint card adds the row, and the row opens the sheet', () => {
    expect(js).toContain("${t.setup && !obSetupFolds(t.setup, bps) ? obSetupCard(t.setup, t.project_id) : ''}");
    expect(js).toContain('if (obSetupFolds(t.setup, s) && t.setup.request_id) cov.push(obSetupLine(t.setup, t.project_id));');
    expect(js).toContain("const obd = t.closest('[data-ob-setup]'); if (obd) { obSetupSheet(obd); return; }");
    const sheet = part('function obSetupSheet(', '\n}\n');
    expect(sheet).toContain('OB_NOACCESS');
    expect(sheet).toContain('obSetBtn(s)');
  });
});
