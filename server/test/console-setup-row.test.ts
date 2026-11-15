/**
 * The team page's Setup (docs/onboarding.md#setup-progress): the setup is one row on the Blueprint card in every state,
 * "<state> · <the source, in short>" in the state's tone, opening the setup details; a team with no Blueprint to show, or a
 * setup with no request id, keeps the card. Static, like console-nav.test.ts: the functions from public/app.js run in vm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const at = (s: string) => { const i = js.indexOf(`\n${s}`); if (i < 0) throw new Error(`app.js has no ${s}`); return i + 1; };
const part = (s: string, end: string) => { const i = at(s); return js.slice(i, js.indexOf(end, i) + end.length); };
const line = (name: string) => part(`const ${name} = `, '\n');

const SRC = [...['esc', 'cap', 'pill', 'OB_SRC', 'OB_SETUP', 'obSrcText', 'OB_NOACCESS', 'obSetBtn', 'obSetupFolds', 'OB_SETUP_OF', 'obPathShort', 'obSrcShort', 'OB_TONE_T'].map(line),
  part('const obSetupRows = ', '\n};\n'), part('const obSetupCard = ', '\n};\n'), part('const obSetupLine = ', '\n};\n'), part('async function obSetupSheet(', '\n}\n'),
  part('const bpLine = ', '</button>`;\n'), part('function nyOpenAttr(', '\n}\n')].join('');
const sheets: { html: string }[] = [];
const teams: Record<string, unknown> = {};
const ctx = vm.createContext({
  ic: (n: string) => `<i data-ic="${n}"></i>`, kd: (t: string, r = '') => `<h3>${t}</h3>${r}`, kv: (k: string, v: string) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`,
  bpArg: () => 'arg', bpItemArg: () => 'item', bpTrack: () => '', openSheet: (o: { html: string }) => sheets.push(o), toast: () => {},
  api: async (p: string) => teams[decodeURIComponent(p.split('/')[2]!)],
});
vm.runInContext(SRC + '\nthis.F = { obSetupFolds, obSrcShort, obPathShort, obSetupLine, obSetupCard, obSetupSheet, nyOpenAttr, OB_SETUP_OF };', ctx);
const F = (ctx as unknown as { F: Record<string, any> }).F;
const STATES = ['not_asked', 'from_source', 'coordinator_derives', 'operator_supplies', 'in_review', 'done', 'returned'] as const;
const LONG = 'C:/Users/someone/Vault/Projects/Project Tracking.md';
const setup = (state: string, source: unknown = { from: 'existing', ref: LONG }, id = 'obr_1') => ({ state, responsible: null, next: 'Next step.', source, request_id: id, proposal: null, filed: [] });
const value = (h: string) => /<span class="bp-li-v([^"]*)">([^<]*)</.exec(h)!;
const sheet = async (s: ReturnType<typeof setup>, project: string | null) => { F.obSetupLine(s, project); sheets.length = 0; await F.obSetupSheet({ dataset: { obSetup: s.request_id } }); return sheets[0]!.html; };

describe('the setup is one row on the Blueprint card in every state', () => {
  it('folds every state when the team has a Blueprint and the setup a request id; otherwise the card stays', () => {
    for (const st of STATES) expect(F.obSetupFolds(setup(st), { project: {} })).toBe(true);
    expect(F.obSetupFolds(setup('done'), null)).toBe(false); // no Blueprint card
    expect(F.obSetupFolds({ ...setup('not_asked'), request_id: undefined }, { project: {} })).toBe(false); // no request id: no row, so the card
    expect(F.obSetupFolds(null, { project: {} })).toBe(false);
  });

  it('reads "<state> · <short source>" with the state\'s tone; Source not asked and Coordinator derives alone; info and Done plain', () => {
    const want: Record<string, [string, string]> = {
      not_asked: ['Source not asked', ' warn-t'], from_source: ['From a source · …/Project Tracking.md', ''], coordinator_derives: ['Coordinator derives', ''],
      operator_supplies: ['Waiting for you · …/Project Tracking.md', ' warn-t'], in_review: ['Proposal to review · …/Project Tracking.md', ' warn-t'],
      done: ['Done · …/Project Tracking.md', ''], returned: ['Returned · …/Project Tracking.md', ' bad-t'],
    };
    for (const st of STATES) {
      const r = F.obSetupLine(setup(st), 'prj_1'), [, cls, val] = value(r);
      expect([val, cls], st).toEqual(want[st]);
      expect(r).toContain('>Setup<');
      expect(r).toContain('data-ob-setup="obr_1"');
    }
    expect(value(F.obSetupLine(setup('coordinator_derives', { from: 'coordinator' }), 'prj_1'))[2]).toBe('Coordinator derives');
    expect(value(F.obSetupLine(setup('operator_supplies', { from: 'operator' }), 'prj_1'))[2]).toBe('Waiting for you · you supply them');
    expect(value(F.obSetupLine(setup('done', null), 'prj_1'))[2]).toBe('Done');
  });

  it('holds the full source in its tooltip and cuts only a long path to its last part', () => {
    expect(F.obSetupLine(setup('done'), 'prj_1')).toContain(`title="Setup · An existing source · ${LONG}"`);
    expect(F.obSetupLine(setup('not_asked', null), 'prj_1')).toContain('title="Setup · Not asked: the onboarding client did not ask"');
    expect(F.obPathShort('docs/specification.md')).toBe('docs/specification.md');
    expect(F.obPathShort('C:\\Users\\someone\\Vault\\Project Tracking.md')).toBe('…/Project Tracking.md');
    expect(F.obPathShort('https://example.org/specs/the-long-one/')).toBe('…/the-long-one/');
    expect(F.obPathShort('a-very-long-reference-without-any-slash')).toBe('a-very-long-reference-without-any-slash');
  });

  it('the sheet shows the state\'s pill and the rows; Set the source in every state but a proposal in review, and only with a project', async () => {
    for (const st of STATES) {
      const h = await sheet(setup(st), 'prj_1');
      expect(h, st).toContain('grants no access to read it');
      expect(h.includes('data-ob-src="obr_1"'), st).toBe(st !== 'in_review');
    }
    expect(await sheet(setup('returned'), 'prj_1')).toContain('Returned');
    expect(await sheet(setup('not_asked'), null)).not.toContain('data-ob-src');
  });

  it('a Needs you "Setup:" row opens the same sheet, read from the team when the page has not drawn it', async () => {
    expect(F.nyOpenAttr({ kind: 'setup', id: 'obr_9', team_id: 'tm_9' })).toBe('data-ob-setup="obr_9" data-ob-team="tm_9"');
    teams.tm_9 = { team: { project_id: 'prj_9' }, setup: setup('operator_supplies', { from: 'operator' }, 'obr_9') };
    sheets.length = 0;
    await F.obSetupSheet({ dataset: { obSetup: 'obr_9', obTeam: 'tm_9' } });
    expect(sheets[0]!.html).toContain('Waiting for you');
    expect(sheets[0]!.html).toContain('data-ob-src="obr_9"');
  });

  it('keeps the full card where there is no row: its state, its action and the access note', () => {
    const c = F.obSetupCard({ ...setup('not_asked', null), responsible: 'operator' }, 'prj_1');
    expect(c).toContain('Source not asked');
    expect(c).toContain('data-ob-src="obr_1"');
    expect(c).toContain('grants no access to read it');
    expect(F.obSetupCard(setup('in_review'), 'prj_1')).not.toContain('data-ob-src');
  });

  it('is wired: the team page hides the card when it folds, the Blueprint card adds the row, the request page and member console keep the card', () => {
    expect(js).toContain("${t.setup && !obSetupFolds(t.setup, bps) ? obSetupCard(t.setup, t.project_id) : ''}");
    expect(js).toContain('if (obSetupFolds(t.setup, s)) cov.push(obSetupLine(t.setup, t.project_id));');
    expect(js).toContain("const obd = t.closest('[data-ob-setup]'); if (obd) { obSetupSheet(obd); return; }");
    expect(js).toContain('${obSetupCard(R.setup, null)}'); // the request page
    expect(js.match(/obSetupLine\(/g)).toHaveLength(1); // called only on the Blueprint card
  });
});
