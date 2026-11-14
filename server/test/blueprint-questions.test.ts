/**
 * Questions outside research lines (docs/blueprint.md §2.2, §2.3, §4): a question may sit under a module (Q-<module>-nn,
 * in the module's team part) or at project level (Q-nn, which needs the operator); it records whom it was asked of and
 * when; outside a line it is answered only with its answer; it may block any item ("Waiting on …"); and answering it
 * offers a ready-made proposed decision op that nothing applies by itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Op, SubmitResult } from '../src/blueprint/blueprint.js';
import { KINDS, relAllows, rulesText, DEFAULT_LIMITS } from '../src/blueprint/kinds.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: any };
let app: App, dir = '', adminId = '', coordA = '', coordB = '', teamA = '', teamB = '', P = '';
let C: (name: string, args?: Record<string, unknown>) => Promise<Res>;
const opr = () => ({ kind: 'operator' as const, id: adminId });
const code = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; } };
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const sub = (agent: string, ops: Op[]): SubmitResult => app.blueprint.submit(P, { version: v(), ops }, agent);
const item = (key: string) => app.blueprint.item(P, key);
/** The verdict only: a proposal is rejected at once, so the open-proposal limit is never reached. */
const vrd = (agent: string, ops: Op[]): SubmitResult => { const r = sub(agent, ops); if (r.status === 'proposed') app.blueprint.rejectProposal(r.proposal.id, opr(), null); return r; };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahbpq-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const { cookie, csrf } = await adminLogin(base);
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const ca = agent('coord-a'), cb = agent('coord-b');
  coordA = ca.id; coordB = cb.id;
  teamA = app.teams.create({ name: 'Delivery', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Platform', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put([
    { op: 'upsert', kind: 'module', key: 'TEAM', title: 'Teams', team_id: teamA },
    { op: 'upsert', kind: 'module', key: 'PWR', title: 'Power', team_id: teamB },
    { op: 'upsert', kind: 'fr', key: 'FR-TEAM-04', parent_key: 'TEAM', title: 'A missed check-in raises an alert' },
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Field shape', fields: { mode: 'validate' }, team_id: teamA },
    { op: 'upsert', kind: 'stakeholder', key: 'SH-2', title: 'Client product owner' },
  ]);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: ca.secret } })) as Res).structuredContent.session_token;
  C = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
});
afterAll(async () => { await app?.close(); });

describe('keys and places', () => {
  it('Q-<module>-nn and Q-nn are valid and cannot be taken for Q-<line>-nn', () => {
    const k = KINDS['question']!.key;
    for (const x of ['Q-L1-01', 'Q-L1.2-03', 'Q-TEAM-02', 'Q-03', 'Q-AB-10']) expect(k.test(x), x).toBe(true);
    for (const x of ['Q-1', 'Q-L1', 'Q-team-02', 'Q-TOOLONGX-01', 'Q-TEAM-2']) expect(k.test(x), x).toBe(false);
    // A module key is 2-6 capitals: it never reads as a line (L and a digit), so the shapes never overlap.
    for (const m of ['L1', 'L12', 'L1.2']) expect(KINDS['module']!.key.test(m), m).toBe(false);
  });

  it('a question\'s key names its place: line, its own module, or project level', () => {
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-TEAM-01', parent_key: 'PWR', title: 'x' }]))).toMatch(/^invalid_argument: Q-TEAM-01 is a question of module TEAM and sits under it\./);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-TEAM-01', title: 'x' }]))).toMatch(/is a question of module TEAM/);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-01', parent_key: 'TEAM', title: 'x' }]))).toMatch(/^invalid_argument: Q-01 is a project-level question and has no parent\./);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-L1-05', parent_key: 'TEAM', title: 'x' }]))).toMatch(/is a research line's question and sits under a line/);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-L1-05', title: 'x' }]))).toMatch(/sits under a line/);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-L1-05', parent_key: 'L1', title: 'x' }]))).toBe('ok');
  });

  it('the next number counts each place apart', () => {
    const r = put([
      { op: 'upsert', kind: 'question', key: 'Q-TEAM-*', parent_key: 'TEAM', title: 'Should a missed check-in also tell the client?' },
      { op: 'upsert', kind: 'question', key: 'Q-*', title: 'Which tracker does the client use?' },
    ]);
    expect(r.keys).toEqual({ 'Q-TEAM-*': 'Q-TEAM-01', 'Q-*': 'Q-01' });
  });
});

describe('owners (§4)', () => {
  it('a module question is in its module\'s team part', () => {
    expect(item('Q-TEAM-01')!.team_id).toBe(teamA);
    expect(vrd(coordA, [{ op: 'upsert', kind: 'question', key: 'Q-TEAM-*', parent_key: 'TEAM', title: 'Who receives the weekly digest?', fields: { asked_to: 'SH-2', asked_at: Date.UTC(2026, 10, 2) } }]).status).toBe('applied');
    const r = vrd(coordB, [{ op: 'upsert', kind: 'question', key: 'Q-TEAM-*', parent_key: 'TEAM', title: 'Can Platform reuse the alert?' }]);
    expect(r.status).toBe('proposed');
    if (r.status === 'proposed') expect(r.why.join(' ')).toMatch(/outside your team's part/);
  });

  it('a project-level question needs the operator, and team_id cannot make it a team\'s', () => {
    expect(item('Q-01')!.team_id).toBeNull();
    expect(vrd(coordA, [{ op: 'upsert', kind: 'question', key: 'Q-*', title: 'Who signs off the release?' }]).status).toBe('proposed');
    expect(vrd(coordA, [{ op: 'upsert', kind: 'question', key: 'Q-01', title: 'Which tracker does the client use today?' }]).status).toBe('proposed');
    expect(code(() => sub(coordA, [{ op: 'upsert', kind: 'question', key: 'Q-*', title: 'x', team_id: teamA }]))).toMatch(/^invalid_argument: Q-02 is a project-level question, which is in no team's part and needs the operator/);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-01', title: 'x', team_id: teamA }]))).toMatch(/needs the operator/);
  });

  it('the rules agents read say both', () => {
    const t = rulesText(DEFAULT_LIMITS);
    expect(t).toContain('- question: key Q-<line>-nn under a line, Q-<module>-nn under a module, or Q-nn at project level, e.g. Q-L1-01, next number Q-L1-*. Sits under a line or a module, taking its team from it, or at project level, which is in no team\'s part (no team_id).');
    expect(t).toContain('asked_to: whom it was asked of, preferably a stakeholder key (SH-2); a name is personal data and goes into the export.');
    expect(t).toContain('- Questions: one under a module is in that module\'s team part, like its FRs; one at project level (Q-nn) is in no team\'s part and needs the operator.');
    expect(t).toContain('- blocks: an issue or question to any item');
    expect(t).toContain('- evidence: a finding to a question or hypothesis or claim');
    expect(t).not.toMatch(/\ba [aeiou]/);
  });
});

describe('fields and answering', () => {
  it('records whom it was asked of and when', () => {
    const q = item('Q-TEAM-02')!;
    expect(q.fields).toMatchObject({ asked_to: 'SH-2', asked_at: Date.UTC(2026, 10, 2) });
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-TEAM-02', fields: { asked_at: 'yesterday' } }]))).toMatch(/^invalid_argument/);
  });

  it('validation criteria stay with the questions of a line that validates', () => {
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-TEAM-02', fields: { criteria: 'yes or no' } }]))).toMatch(/not under a research line; validation criteria belong/);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-L1-05', fields: { criteria: 'p95 under 20 ms' } }]))).toBe('ok');
  });

  it('outside a line, answered needs the answer; a line question does not', () => {
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-01', status: 'answered' }]))).toBe('invalid_argument: Q-01 needs its answer to be answered: give fields.answer, the answer in words.');
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-01', status: 'answered', fields: { answer: '  ' } }]))).toMatch(/needs its answer/);
    expect(item('Q-01')!.status).toBe('open');
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-L1-05', status: 'answered' }]))).toBe('ok');
  });
});

describe('blocks: issues and questions (§2.3)', () => {
  it('a question may block any item, and the link follows the question\'s part', () => {
    expect(relAllows('blocks', 'question', 'fr')).toBe(true);
    expect(relAllows('blocks', 'issue', 'milestone')).toBe(true);
    expect(relAllows('blocks', 'finding', 'fr')).toBe(false);
    expect(vrd(coordA, [{ op: 'link', from: 'Q-TEAM-01', to: 'FR-TEAM-04', rel: 'blocks' }]).status).toBe('applied');
    expect(app.blueprint.links(P).filter((l) => l.rel === 'blocks').map((l) => `${l.from_key}>${l.to_key}`)).toEqual(['Q-TEAM-01>FR-TEAM-04']);
    expect(vrd(coordB, [{ op: 'link', from: 'Q-TEAM-01', to: 'PWR', rel: 'blocks' }]).status).toBe('proposed');
  });

  it('the console shows one label for both: "Waiting on …"', () => {
    const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(js).toContain("l.rel === 'blocks' && l.kind && l.status === 'open'");
    expect(js).toContain('Waiting on ${L.map(');
    expect(js).toContain("'waiting on this' : 'waiting on'");
    expect(js).not.toMatch(/[Bb]locked by \$\{/);
  });
});

describe('an answered question offers a proposed decision', () => {
  it('the write result carries a ready-made op; nothing is created by itself; sending it adds a proposed decision that names the question', async () => {
    const before = app.blueprint.items(P, { kinds: ['decision'] }).length;
    const r = await C('bp_write', { team_id: teamA, version: v(), ops: [{ op: 'upsert', kind: 'question', key: 'Q-TEAM-01', status: 'answered', fields: { asked_to: 'SH-2', answer: 'Yes, their channel hears it too.' } }] });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const d = r.structuredContent;
    expect(d.status).toBe('applied');
    expect(r.content[0].text).toMatch(/Offered: Q-TEAM-01 is answered\. If the answer decides something, send this op/);
    expect(d.offers).toHaveLength(1);
    const op = d.offers[0].op;
    expect(op).toMatchObject({ op: 'upsert', kind: 'decision', key: 'ADR-*', status: 'proposed', team_id: teamA, fields: { source: 'bp:Q-TEAM-01' } });
    expect(op.title).toBe('Should a missed check-in also tell the client? (answered in Q-TEAM-01)');
    expect(op.fields.context).toBe('Question asked of SH-2: Should a missed check-in also tell the client?\nAnswer: Yes, their channel hears it too.\nFrom question Q-TEAM-01.');
    expect(app.blueprint.items(P, { kinds: ['decision'] }).length).toBe(before);

    const s = await C('bp_write', { team_id: teamA, version: v(), ops: [op] });
    expect(s.isError, JSON.stringify(s.content)).toBeFalsy();
    expect(s.structuredContent.status).toBe('applied');
    const key = s.structuredContent.keys['ADR-*'];
    expect(item(key)).toMatchObject({ kind: 'decision', status: 'proposed', fields: { source: 'bp:Q-TEAM-01' } });
    expect(s.structuredContent.offers).toBeUndefined();
  });

  it('offered once: an edit of an answered question, or a write that leaves it open, offers nothing', () => {
    expect(put([{ op: 'upsert', kind: 'question', key: 'Q-TEAM-01', fields: { answer: 'Yes, their channel hears it too, once a day.' } }]).offers).toBeUndefined();
    expect(put([{ op: 'upsert', kind: 'question', key: 'Q-01', fields: { asked_to: 'Client' } }]).offers).toBeUndefined();
    const r = put([{ op: 'upsert', kind: 'question', key: 'Q-01', status: 'answered', fields: { answer: 'Their own tracker.' } }]);
    expect(r.offers?.map((o) => o.op.fields)).toEqual([{ context: 'Question asked of Client: Which tracker does the client use?\nAnswer: Their own tracker.\nFrom question Q-01.', source: 'bp:Q-01' }]);
    expect(r.offers![0]!.op.team_id).toBeUndefined();
  });
});

describe('review follow-ups', () => {
  it('a module question stays in the module its key names: moving it elsewhere is refused, with the way to ask it there', () => {
    const was = item('Q-TEAM-02')!;
    expect(code(() => put([{ op: 'move', key: 'Q-TEAM-02', parent_key: 'PWR' }]))).toMatch(/^invalid_argument: Q-TEAM-02 is a question of module TEAM and sits under it\. A key never changes: to ask it under PWR, write a new question there \(Q-PWR-\*\) and drop this one\./);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-TEAM-02', parent_key: null }]))).toMatch(/to ask it at project level, write a new question there \(Q-\*\)/);
    expect(code(() => put([{ op: 'upsert', kind: 'question', key: 'Q-01', parent_key: 'TEAM' }]))).toMatch(/^invalid_argument: Q-01 is a project-level question and has no parent\. A key never changes: to ask it under TEAM, write a new question there \(Q-TEAM-\*\)/);
    expect(item('Q-TEAM-02')).toMatchObject({ parent_key: was.parent_key, rev: was.rev });
    // Re-ordering inside its own module is still a move like any other.
    expect(code(() => put([{ op: 'move', key: 'Q-TEAM-02', parent_key: 'TEAM', position: 0 }]))).toBe('ok');
  });

  it('an answer that arrives through a proposal tells the proposer, in hub words and keys only, how to record the decision', () => {
    put([{ op: 'upsert', kind: 'question', key: 'Q-TEAM-*', parent_key: 'TEAM', title: 'Does the client want a monthly summary?' }]);
    const seen = (app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='bp_proposal'").get(coordA) as { n: number }).n;
    // The answer is the coordinator's own to apply; the stakeholder edit beside it needs the operator, so the batch is one proposal.
    const r = sub(coordA, [
      { op: 'upsert', kind: 'question', key: 'Q-TEAM-03', status: 'answered', fields: { answer: 'Only the owner team, weekly.' } },
      { op: 'upsert', kind: 'stakeholder', key: 'SH-2', title: 'Client product owner (Delivery)' },
    ]);
    expect(r.status).toBe('proposed');
    if (r.status !== 'proposed') return;
    const decisions = app.blueprint.items(P, { kinds: ['decision'] }).length;
    const a = app.blueprint.applyProposal(r.proposal.id, opr());
    expect(a.stale).toBeNull();
    expect(a.result?.offers?.map((o) => o.op.fields?.['source'])).toEqual(['bp:Q-TEAM-03']);
    expect(item('Q-TEAM-03')!.status).toBe('answered');
    expect(app.blueprint.items(P, { kinds: ['decision'] }).length).toBe(decisions);
    const bodies = () => (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='bp_proposal' ORDER BY seq").all(coordA) as { body: string }[]).map((x) => x.body).slice(seen);
    expect(bodies().find((b) => b.includes(' answered '))).toBe(`Your proposal ${r.proposal.id} in ${app.blueprint.project(P)!.key} answered Q-TEAM-03. If an answer decides something, record it as a proposed decision with bp_write: an upsert of kind decision, key ADR-*, status proposed, fields.source bp:<question key>, and the question and its answer as fields.context (bp_read {keys: [Q-TEAM-03]} has them). Nothing was created by itself.`);
    // The agent's own words (the answer, the question's title) never go into a notice.
    expect(bodies().join(' ')).not.toMatch(/Only the owner team|monthly summary/);
    // A proposal that answers nothing adds no such notice.
    const r2 = sub(coordA, [{ op: 'upsert', kind: 'stakeholder', key: 'SH-2', title: 'Client product owner' }]);
    if (r2.status === 'proposed') app.blueprint.applyProposal(r2.proposal.id, opr());
    expect(bodies().filter((b) => b.includes(' answered ')).length).toBe(1);
  });
});
