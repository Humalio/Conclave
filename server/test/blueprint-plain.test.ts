/**
 * The Blueprint written for the operator (docs/blueprint.md §2.7, docs/proposals/blueprint-readability.md §2, E1–E4):
 * the summary/Records split, private codes and the glossary, the six write-time warnings worked out on the state after
 * the batch, the standing line, and sources resolved per viewer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { splitBody, slugCode, findCodes, glossaryOf, resolve, acceptanceEmpty, citedSources, citedRefs, isItemKey, trimCited, warn, issueText, classifySource, warningText, leadingCode, EMPTY_AC_TITLE } from '../src/blueprint/plain.js';
import { Sources } from '../src/blueprint/sources.js';
import { MemberScope } from '../src/admin/memberScope.js';
import { testConfig } from './hub.js';

const NO = { keys: new Set<string>() };
const known = (terms: { key: string; title: string; body?: string; aliases?: string[] }[], keys: string[] = []) =>
  glossaryOf(terms.map((t) => ({ key: t.key, title: t.title, body: t.body ?? null, fields: t.aliases ? { aliases: t.aliases } : {} })), keys);

describe('findCodes (§2.1)', () => {
  it('flags the codes of the real ECHO titles, and not versions, acronyms, dates, units, URLs, code spans or keys', () => {
    expect(findCodes('Project A v0.3 RC (P25 + P26)', NO)).toEqual(['P25', 'P26']);
    expect(findCodes('S2m A6 gate read', NO)).toEqual(['S2m', 'A6']);
    expect(findCodes("T′ and T' rise; H_oa holds at B1i", NO)).toEqual(['T′', "T'", 'H_oa', 'B1i']);
    expect(findCodes('Notes in Projects/EXAMPLE/03 Evidence and src/v2/app.ts', NO)).toEqual([]);
    expect(findCodes('On 2026-11-16, 95% of 3rd runs were 10x faster in 48h: https://x.test/A17 `A17` FR-TEAM-04 ECHO', { keys: new Set(['FR-TEAM-04', 'ECHO']) })).toEqual([]);
    expect(findCodes('Agent agent-ab12cd34 measured CF-28 at f6f163d', NO)).toEqual(['CF-28', 'f6f163d']);
  });

  it('runs a 40,000-character body in under 50 ms', () => {
    const body = 'The result of P26 holds at depth, and T′ rises. '.repeat(820).slice(0, 40_000);
    const t = performance.now();
    expect(findCodes(body, NO)).toEqual(['P26', 'T′']);
    expect(performance.now() - t).toBeLessThan(50);
  });
});

describe('splitBody, slugCode, resolve, acceptanceEmpty', () => {
  it('splits at the first Records heading, ## or ###, in any case', () => {
    expect(splitBody('All of it.')).toEqual({ summary: 'All of it.', records: null });
    expect(splitBody(null)).toEqual({ summary: '', records: null });
    expect(splitBody('Result.\n\n## Records\n- f6f163d')).toEqual({ summary: 'Result.', records: '- f6f163d' });
    expect(splitBody('Result.\n### records \nA\n## Records\nB')).toEqual({ summary: 'Result.', records: 'A\n## Records\nB' });
    expect(splitBody('See ## Records inline.').records).toBeNull();
  });
  it('never splits inside a fenced code block: a quoted Records heading stays in its code, the real one splits', () => {
    const quoted = 'Write it like this:\n\n```md\nThe result.\n\n## Records\n- the hash\n```\n\nThat is all.';
    expect(splitBody(quoted)).toEqual({ summary: quoted, records: null });
    expect(splitBody(`${quoted}\n\n## Records\n- f6f163d`)).toEqual({ summary: quoted, records: '- f6f163d' });
    // ~~~ fences; a shorter or other-character fence does not close it; text after a fence marker is an info string.
    expect(splitBody('A\n~~~~\n## Records\n~~~\n```\n## Records\n~~~~\nB').records).toBeNull();
    expect(splitBody('A\n```js\nx\n```\n### Records\nB')).toEqual({ summary: 'A\n```js\nx\n```', records: 'B' });
    // An unclosed fence runs to the end, as Markdown renders it.
    expect(splitBody('A\n```\n## Records\nB').records).toBeNull();
    expect(splitBody('A\r\n```\r\n## Records\r\n```\r\n## Records\r\nB').records).toBe('B');
  });

  it('slugs codes as the G- key a term takes', () => {
    expect(slugCode('T′')).toBe('t-prime');
    expect(slugCode("T'")).toBe('t-prime');
    expect(slugCode('H_oa')).toBe('h-oa');
    expect(slugCode('CF-28')).toBe('cf-28');
  });

  it('resolves by title, alias and slug; primes normalise; only all-caps tokens match without case', () => {
    const k = known([{ key: 'G-t-prime', title: 'T′', body: 'The corrected time. More words.' }, { key: 'G-p26', title: 'P26', aliases: ['p-26'] }, { key: 'G-rc', title: 'rc' }, { key: 'G-ab', title: 'Ab' }]);
    expect(resolve("T'", k)).toEqual({ key: 'G-t-prime', title: 'T′', definition: 'The corrected time.' });
    expect(resolve('T’', k)?.key).toBe('G-t-prime');
    expect(resolve('p-26', k)?.key).toBe('G-p26');
    expect(resolve('RC', k)?.key).toBe('G-rc'); // all caps: case-insensitive
    expect(resolve('rC', known([{ key: 'G-x', title: 'RC' }]))).toBeNull(); // mixed case: exact only
    expect(resolve('H_oa', k)).toBeNull();
    expect(resolve('h_oa', known([{ key: 'G-h-oa', title: 'Hoa' }]))?.key).toBe('G-h-oa'); // the slug
  });

  it('tells an acceptance criterion with nothing to check', () => {
    expect(acceptanceEmpty({ title: 'Field holds', body: null, fields: {} })).toBe(true);
    expect(acceptanceEmpty({ title: 'Field holds', body: 'It holds at 2 T.', fields: {} })).toBe(false);
    expect(acceptanceEmpty({ title: 'Acceptance', body: 'Something.', fields: { given: 'a run' } })).toBe(true);
    expect(acceptanceEmpty({ title: 'Acceptance', body: null, fields: { then: 'Residual under 2 %' } })).toBe(false);
    expect(acceptanceEmpty({ title: 'Residual under 2 %', body: null, fields: { then: 'it is' } })).toBe(false);
    expect(EMPTY_AC_TITLE.test('AC 3')).toBe(true);
  });

  it('finds a leading code, and the sources an item cites', () => {
    expect(leadingCode('CF-28: drift doubles', NO)).toBe('CF-28');
    expect(leadingCode('Drift: CF-28 doubles', NO)).toBeNull();
    expect(citedSources({ body: 'See [[Ledger C2]] and `Notes/run.md`.\n\n## Records\nPapers/a.md', fields: { evidence: 'Develop/projects/flexout/c2/ledger_c2.md; f6f163d' } }))
      .toEqual(['Develop/projects/flexout/c2/ledger_c2.md', 'f6f163d', 'Ledger C2', 'Notes/run.md']);
    // Paths under Records are repository paths for the record, never vault sources; a [[wikilink]] there still is one.
    expect(citedSources({ body: 'Shipped the card.\n\n## Records\n- `server/public/app.js`\n- docs/dashboard-ux.md\n- `docs/blueprint.md`\n- [[Ledger C2]]', fields: {} }))
      .toEqual(['Ledger C2']);
    expect(['f6f163d', 'https://x.test/a', 'C:\\x\\y.md', 'Notes/a.md', 'a.md', 'plain'].map(classifySource)).toEqual(['outside', 'outside', 'outside', 'vault', 'vault', null]);
  });
});

describe('one parser for what an item cites (§2.7 Reading what is cited)', () => {
  const ev = (evidence: string) => citedRefs({ body: null, fields: { evidence } });
  const bd = (body: string) => citedRefs({ body, fields: {} });

  it('keeps a wikilink whole, commas and brackets included, in a field and in the body', () => {
    expect(ev('[[Notes/Smith, 2020]]; f6f163d').sources).toEqual(['Notes/Smith, 2020', 'f6f163d']);
    expect(bd('As [[Notes/Smith, 2020]] shows.').sources).toEqual(['Notes/Smith, 2020']);
    expect(ev('[[Meeting (2024)]]').sources).toEqual(['Meeting (2024)']);
    expect(bd('Agreed at [[Meeting (2024)]].').sources).toEqual(['Meeting (2024)']);
    expect(bd('It holds (see [[Note]]).').sources).toEqual(['Note']);
    expect(ev('(see [[Note]])').sources).toEqual(['Note']);
    expect(bd('[[A (b) c]] and [[Run notes#Results|the runs]]').sources).toEqual(['A (b) c', 'Run notes']);
  });

  it('keeps a comma inside a file name, and still splits a list of files', () => {
    expect(ev('Notes/Smith, 2020.md').sources).toEqual(['Notes/Smith, 2020.md']);
    expect(bd('Read first:\nNotes/Smith, 2020.md').sources).toEqual(['Notes/Smith, 2020.md']);
    expect(ev('Notes/a.md, Notes/b.md, c.md').sources).toEqual(['Notes/a.md', 'Notes/b.md', 'c.md']);
    expect(bd('Notes/a.md, Notes/b.md').sources).toEqual(['Notes/a.md', 'Notes/b.md']);
    expect(ev('f6f163d, abc1234').sources).toEqual(['f6f163d', 'abc1234']);
  });

  it('reads a key as an item, never a file, in a field and in a code span', () => {
    expect(ev('PAP-1/C8').sources).toEqual([]);
    expect(ev('PAP-1/C8').keys).toEqual(['PAP-1/C8']);
    expect(bd('Backs `PAP-1/C8`.')).toEqual({ sources: [], keys: ['PAP-1/C8'] });
    expect(ev('R4/AC2, FR-TEAM-04/AC1; Notes/run.md')).toEqual({ sources: ['Notes/run.md'], keys: ['R4/AC2', 'FR-TEAM-04/AC1'] });
    // A path whose last part looks like a criterion is still a path, and plain prose is not scanned for keys.
    expect(ev('Notes/AC1').sources).toEqual(['Notes/AC1']);
    expect(bd('PAP-1/C8 is the claim.')).toEqual({ sources: [], keys: [] });
    expect(['PAP-1/C8', 'R4/AC2', 'H-L1-02', 'M3', 'G-echo', 'TEAM', 'SUM', 'Notes/AC1', 'Notes/x.md'].map(isItemKey))
      .toEqual([true, true, true, true, true, false, false, false, false]);
  });

  it('trims a bracket or quote only when it has no partner', () => {
    expect(['(Notes/a.md)', 'Notes/a.md).', '"Notes/a.md",', 'Meeting (2024)', '(Meeting (2024))', '<Notes/a.md>', 'x (y'].map(trimCited))
      .toEqual(['Notes/a.md', 'Notes/a.md', 'Notes/a.md', 'Meeting (2024)', 'Meeting (2024)', 'Notes/a.md', 'x (y']);
  });

  it('warns key_missing for a key the project does not have, and no source warning for any key', () => {
    const w = warn.key_missing('F-L1-03', 'Run 3: lag held', 'PAP-9/C1');
    expect(w).toMatchObject({ kind: 'key_missing', source: 'PAP-9/C1' });
    expect(w.message).toBe('F-L1-03 cites PAP-9/C1, which is no item in this Blueprint. Fix the key, or link the item it means.');
    expect(issueText(w)).toBe('cites PAP-9/C1, which is no item in this Blueprint');
    expect(citedSources({ body: 'See `PAP-1/C8` and `R4/AC2`.', fields: { evidence: 'PAP-9/C1' } })).toEqual([]);
  });
});

// ───── on a hub ─────
const sys = { kind: 'system' as const, id: null };
let app: App, dir = '', P = '', team = '', adminId = '', coord = '', cred = '';
const opr = () => ({ kind: 'operator' as const, id: null });
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const kinds = (ops: Op[]) => app.blueprint.plainWarnings(P, ops).warnings.map((w) => `${w.kind} ${w.key}`);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bp-plain-'));
  mkdirSync(join(dir, 'vault', 'Projects', 'Lab', 'Records'), { recursive: true });
  mkdirSync(join(dir, 'vault', 'ECHO Papers (copy 2026-11-10)', 'AgentsRoom'), { recursive: true });
  mkdirSync(join(dir, 'vault', 'HR'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Projects', 'Lab', 'Records', 'ledger_c2.md'), '# ledger\n');
  writeFileSync(join(dir, 'vault', 'Projects', 'Lab', 'notes.md'), '# notes\n');
  writeFileSync(join(dir, 'vault', 'ECHO Papers (copy 2026-11-10)', 'AgentsRoom', 'protocol.md'), '# protocol\n');
  writeFileSync(join(dir, 'vault', 'HR', 'pay.md'), '# pay\n');
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.store.scan();
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string } | undefined)?.id ?? '';
  const a = app.keys.createAgent('Ada', null, sys), k = app.keys.createSessionKey({ agentId: a.id, label: 'Ada' }, sys);
  coord = a.id; cred = k.credential.id;
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['fs.read', 'fs.list'], resource: 'path:/vault/Projects/Lab/**' }, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/ECHO Papers (copy 2026-11-10)/**' }], 'test', sys);
  team = app.teams.create({ name: 'Lab', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator', credential_id: cred }] }, sys).id;
  P = app.blueprint.ensureTeamProject(team).id;
  put([
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Flex', fields: { mode: 'validate' }, team_id: team },
    { op: 'upsert', kind: 'module', key: 'FLX', title: 'Flex', team_id: team },
    { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'Parallel agents', team_id: team },
    { op: 'upsert', kind: 'claim', key: 'PAP-1/C1', parent_key: 'PAP-1', title: 'Agents agree on the plan', status: 'draft' },
    { op: 'upsert', kind: 'claim', key: 'PAP-1/C3', parent_key: 'PAP-1', title: 'Rooms cut messages', status: 'final' },
    { op: 'upsert', kind: 'claim', key: 'PAP-1/C4', parent_key: 'PAP-1', title: 'Parallel is faster in total (P26)', status: 'draft' },
    { op: 'upsert', kind: 'claim', key: 'PAP-1/C5', parent_key: 'PAP-1', title: 'Reviews catch drift', status: 'final' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-07', parent_key: 'L1', title: 'Agents agree within a day', status: 'confirmed',
      fields: { evidence: 'Develop/projects/flexout/experiments/c2/ledger_c2.md' }, body: 'Agreement came within a day.\n\nCites [[protocol]].' },
    { op: 'upsert', kind: 'finding', key: 'F-L1-03', parent_key: 'L1', title: 'Two runs agreed', fields: { confidence: 'high' } },
    { op: 'upsert', kind: 'finding', key: 'F-L1-04', parent_key: 'L1', title: 'A third run agreed', fields: { confidence: 'low' } },
    { op: 'link', from: 'H-L1-07', to: 'PAP-1/C1', rel: 'evidence' },
    { op: 'link', from: 'F-L1-03', to: 'H-L1-07', rel: 'evidence' },
    { op: 'link', from: 'F-L1-04', to: 'H-L1-07', rel: 'evidence' },
    { op: 'link', from: 'F-L1-04', to: 'PAP-1/C3', rel: 'evidence' },
  ]);
});
afterAll(async () => { await app?.close(); });

describe('warnings (§4, E2)', () => {
  it('undefined_code, code_first and empty_ac on the merged item, never on a term', () => {
    expect(kinds([{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'CF-28: drift doubles with A17' }])).toEqual(['undefined_code F-L1-*', 'code_first F-L1-*']);
    const w = app.blueprint.plainWarnings(P, [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'S2m A6 gate read' }]).warnings[0]!;
    expect(w).toMatchObject({ kind: 'undefined_code', tokens: ['S2m', 'A6'], key: 'F-L1-*' });
    expect(w.message).toBe('F-L1-* title uses S2m, A6, which the operator cannot look up. Say what they are in words, or keep them and propose a term each: {op: upsert, kind: term, key: G-s2m, title: "S2m", body: "<one plain sentence>", fields: {aliases: ["S2m"]}}.');
    put([{ op: 'upsert', kind: 'fr', key: 'FR-FLX-01', parent_key: 'FLX', title: 'Flex reads plainly' }]);
    expect(kinds([{ op: 'upsert', kind: 'ac', key: 'FR-FLX-01/AC1', parent_key: 'FR-FLX-01', title: 'Acceptance' }])).toEqual(['empty_ac FR-FLX-01/AC1']);
    expect(app.blueprint.plainWarnings(P, [{ op: 'upsert', kind: 'ac', key: 'FR-FLX-01/AC1', parent_key: 'FR-FLX-01', title: 'Acceptance' }]).warnings[0]!.message).toContain('says nothing to check (titled "Acceptance")');
    expect(kinds([{ op: 'upsert', kind: 'term', key: 'G-p26', title: 'P26', body: 'The parallel run.' }])).toEqual([]);
  });

  it('a term in the batch is pending: its token leaves the warnings', () => {
    const c = app.blueprint.plainWarnings(P, [{ op: 'upsert', kind: 'term', key: 'G-p25', title: 'P25', body: 'The 25th protocol.' }, { op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'P25 and P27 hold' }]);
    expect(c.pending).toEqual([{ key: 'G-p25', tokens: ['P25'] }]);
    expect(c.warnings[0]).toMatchObject({ kind: 'undefined_code', tokens: ['P27'] });
    expect(warningText(c)).toContain('Terms waiting for the operator: G-p25. Until the operator applies them, P25 shows as not defined.');
  });

  it('a key the same batch creates is known, by name or allocated from *, as plainIssues sees it once settled', () => {
    const c = app.blueprint.plainWarnings(P, [
      { op: 'upsert', kind: 'hypothesis', key: 'H-L1-09', parent_key: 'L1', title: 'Depth holds the field' },
      { op: 'upsert', kind: 'hypothesis', key: 'H-L1-*', parent_key: 'L1', title: 'Depth runs back H-L1-09' },
    ]);
    expect(c.warnings.filter((w) => w.kind === 'undefined_code')).toEqual([]);
  });

  it('final_unsupported on the state after the batch; a final claim with its evidence link in the same batch does not warn', () => {
    expect(kinds([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C5', title: 'Reviews catch drift' }])).toEqual(['final_unsupported PAP-1/C5']);
    expect(app.blueprint.plainWarnings(P, [{ op: 'upsert', kind: 'claim', key: 'PAP-1/C5', title: 'Reviews catch drift' }]).warnings[0]!.message)
      .toBe('PAP-1/C5 is final but no decided evidence backs it. Link the hypothesis or finding that backs it, or set it back to draft.');
    expect(kinds([{ op: 'upsert', kind: 'claim', key: 'PAP-1/C5', title: 'Reviews catch drift' }, { op: 'link', from: 'F-L1-03', to: 'PAP-1/C5', rel: 'evidence' }])).toEqual([]);
    // The trial run is rolled back.
    expect(app.blueprint.links(P).some((l) => l.to_key === 'PAP-1/C5')).toBe(false);
  });

  it('unlinked_evidence: the PAP-1 case, a finding written after the claim that shares its rare code', () => {
    const ops: Op[] = [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'Parallel runs were 1.40 times faster (P26)', fields: { confidence: 'high' } }];
    const c = app.blueprint.plainWarnings(P, ops);
    const u = c.warnings.find((w) => w.kind === 'unlinked_evidence')!;
    expect(u).toMatchObject({ key: 'PAP-1/C4', other: 'F-L1-*', tokens: ['P26'] });
    expect(u.message).toBe('PAP-1/C4 has no evidence, but F-L1-* mentions P26. Link it if it backs the claim: {op: link, from: F-L1-*, to: PAP-1/C4, rel: evidence}.');
    const hint = () => (app.blueprint.plainIssues(P).get('PAP-1/C4') ?? []).filter((w) => w.kind === 'unlinked_evidence').map((w) => w.message);
    expect(hint()).toEqual([]); // the trial run is rolled back
    const r = put(ops);
    expect(hint()).toEqual([u.message.split('F-L1-*').join(r.keys['F-L1-*']!)]);
    // Not once the code is a glossary term.
    put([{ op: 'upsert', kind: 'term', key: 'G-p26', title: 'P26', body: 'The parallel run of the flex study.' }]);
    expect(hint()).toEqual([]);
    expect(app.blueprint.plainIssues(P).get('PAP-1/C4')).toBeUndefined();
  });

  it('never throws: a bad batch gives empty lists', () => {
    expect(app.blueprint.plainWarnings(P, [{ op: 'upsert', kind: 'nope', key: 'X' } as unknown as Op])).toMatchObject({ warnings: [], pending: [] });
    expect(app.blueprint.plainWarnings(P, null as unknown as Op[])).toMatchObject({ warnings: [], pending: [] });
    expect(app.blueprint.plainWarnings('prj_missing', [])).toMatchObject({ warnings: [] });
  });

  it('read({plain: "issues"}) keeps only items with issues, each with plain_issues; without it nothing changes', () => {
    const before = JSON.stringify(app.blueprint.read(P, team, { scope: 'project' }));
    const r = app.blueprint.read(P, team, { scope: 'project', plain: 'issues' });
    expect(r.items.map((i) => i.key)).toContain('PAP-1/C5');
    expect(r.items.map((i) => i.key)).not.toContain('FLX');
    expect(r.items.find((i) => i.key === 'PAP-1/C5')?.plain_issues).toEqual(['final, but no decided evidence backs it']);
    expect(r.items.every((i) => i.plain_issues!.length > 0)).toBe(true);
    expect(r.total).toBe(r.items.length);
    expect(app.blueprint.read(P, team, { scope: 'project', plain: 'issues', limit: 1 }).next_cursor).toBe(r.total > 1 ? 1 : null);
    expect(JSON.stringify(app.blueprint.read(P, team, { scope: 'project' }))).toBe(before);
  });
});

describe('key_missing on a write (§2.7)', () => {
  it('a known key in a source field or code span gives no warning, an unknown one gives key_missing, and neither is a source', () => {
    const c = app.blueprint.plainWarnings(P, [{ op: 'upsert', kind: 'finding', key: 'F-L1-*', parent_key: 'L1', title: 'Reviews caught the drift',
      body: 'Backs `PAP-1/C5`.', fields: { evidence: 'PAP-1/C3, PAP-9/C1; [[Projects/Lab/notes]]' } }]);
    expect(c.warnings.map((w) => `${w.kind} ${w.source ?? ''}`)).toEqual(['key_missing PAP-9/C1']);
    expect(c.cited.flatMap((x) => x.texts)).toEqual(['Projects/Lab/notes']);
  });
});

describe('standing (E1)', () => {
  it('a paper, a claim and a hypothesis, from the support model', () => {
    expect(app.blueprint.standing(P, 'PAP-1')).toBe('1 of 4 claims supported. C3 has only undecided evidence; C4 and C5 have none.');
    expect(app.blueprint.standing(P, 'PAP-1/C1')).toBe('Supported by H-L1-07 (confirmed), from 2 findings.');
    expect(app.blueprint.standing(P, 'PAP-1/C3')).toBe('Only undecided evidence: F-L1-04 (low confidence).');
    expect(app.blueprint.standing(P, 'PAP-1/C5')).toBe('No evidence linked.');
    expect(app.blueprint.standing(P, 'H-L1-07')).toBe('Confirmed. Backs C1, from 2 findings.');
    expect(app.blueprint.standing(P, 'L1')).toBeNull();
    expect(app.blueprint.read(P, team, { keys: ['PAP-1/C1'], detail: 'full' }).items[0]!.standing).toBe('Supported by H-L1-07 (confirmed), from 2 findings.');
    expect(app.blueprint.read(P, team, { keys: ['PAP-1/C1'] }).items[0]!.standing).toBeUndefined();
  });
});

describe('sources (E4)', () => {
  it('resolves for the operator by exact path, under a team folder and by unique name, and says Found at', async () => {
    const s = new Sources(app.db, app.vault);
    expect(s.folders(P, team)).toEqual(['ECHO Papers (copy 2026-11-10)', 'Projects/Lab']);
    expect(s.folders(P, null)).toEqual(s.folders(P, team));
    const r = await s.resolve(P, team, ['Projects/Lab/notes.md', 'notes.md', 'Develop/projects/flexout/experiments/c2/ledger_c2.md', 'protocol', 'Nowhere/x.md', 'f6f163d', 'HR/pay.md']);
    expect(r).toEqual([
      { text: 'Projects/Lab/notes.md', where: 'vault', path: '/vault/Projects/Lab/notes.md' },
      { text: 'notes.md', where: 'vault', path: '/vault/Projects/Lab/notes.md', cited: 'notes.md' },
      { text: 'Develop/projects/flexout/experiments/c2/ledger_c2.md', where: 'vault', path: '/vault/Projects/Lab/Records/ledger_c2.md', cited: 'Develop/projects/flexout/experiments/c2/ledger_c2.md' },
      { text: 'protocol', where: 'vault', path: '/vault/ECHO Papers (copy 2026-11-10)/AgentsRoom/protocol.md', cited: 'protocol' },
      { text: 'Nowhere/x.md', where: 'missing' },
      { text: 'f6f163d', where: 'outside' },
      { text: 'HR/pay.md', where: 'vault', path: '/vault/HR/pay.md' }, // the operator reads the whole vault
    ]);
    expect(await s.resolve(P, team, ['.obsidian/app.json', '../etc/passwd'])).toEqual([{ text: '.obsidian/app.json', where: 'missing' }, { text: '../etc/passwd', where: 'missing' }]);
  });

  it('reads every link form with the vault viewer\'s resolver: root, wiki, heading, label and %20', async () => {
    const r = await new Sources(app.db, app.vault).resolve(P, team, ['/Projects/Lab/notes.md', '/vault/Projects/Lab/notes.md', '[[Projects/Lab/notes]]',
      '[[notes#Results|the notes]]', '[[AgentsRoom/protocol]]', 'ECHO%20Papers%20(copy%202026-11-10)/AgentsRoom/protocol.md', 'projects/lab/NOTES.md']);
    const lab = '/vault/Projects/Lab/notes.md', pro = '/vault/ECHO Papers (copy 2026-11-10)/AgentsRoom/protocol.md';
    expect(r.map((x) => x.path)).toEqual([lab, lab, lab, lab, pro, pro, lab]);
    // Found at the cited path (from the root, with or without the alias or .md): no "Found at" note.
    expect(r.map((x) => 'cited' in x)).toEqual([false, false, false, true, true, false, true]);
  });

  it('a member gets missing for a file outside their grant, the same answer as for no file', async () => {
    if (!adminId) return;
    app.db.prepare("INSERT INTO user_project_grants(user_id,project_id,components,vault_folders,granted_at) VALUES (?,?,?,?,1)").run(adminId, P, '["blueprint","vault"]', '["/Projects/Lab/"]');
    const m = new MemberScope(app.db, adminId, false);
    const r = await new Sources(app.db, app.vault).resolve(P, team, ['HR/pay.md', 'pay.md', 'notes.md', 'protocol', 'HR/none.md'], m);
    expect(r).toEqual([
      { text: 'HR/pay.md', where: 'missing' },
      { text: 'pay.md', where: 'missing' },
      { text: 'notes.md', where: 'vault', path: '/vault/Projects/Lab/notes.md', cited: 'notes.md' },
      { text: 'protocol', where: 'missing' },
      { text: 'HR/none.md', where: 'missing' },
    ]);
    app.db.prepare('DELETE FROM user_project_grants WHERE user_id=? AND project_id=?').run(adminId, P);
  });
});
