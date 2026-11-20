/**
 * Marking a new requirement unclear in one write (docs/blueprint.md §2.7, docs/decisions.md): an agent's bp_write may give
 * the question itself in unclear_ask (its text, or {question, options, recommended, context}). The write opens that team
 * question, naming the requirement, and returns its id; Clarify in Needs you answers it like any other. The id of an open
 * question still works. In a proposal the question opens only when the operator applies it. A bad value says what to pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Who } from '../src/teams/teams.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { BP_WRITING } from '../src/mcp/writing.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const operator = { kind: 'operator' as const, id: null };
let app: App, base = '', cnv = '', one = '', two = '';
type S = { cookie: string; csrf: string };
let admin: S;
type A = { id: string; cred: string };
let coord: A, coord2: A;
const call = async (s: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
const ver = () => app.blueprint.project(cnv)!.version;
const item = (key: string) => app.blueprint.item(cnv, key)!;
const decision = (id: string) => app.db.prepare('SELECT * FROM decisions WHERE id=?').get(id) as { id: string; team_id: string; agent_id: string; status: string; question: string; refs: string; options: string; recommended: string | null; context: string | null; credential_id: string | null } | undefined;
const asksNaming = (key: string) => (app.db.prepare("SELECT d.id FROM decisions d, json_each(d.refs) j WHERE j.value=?").all(key) as { id: string }[]).map((r) => r.id);
const closeAsks = () => app.db.prepare("UPDATE decisions SET status='declined' WHERE status IN ('open','needs_info')").run();
const submit = (a: A, ops: Op[]) => app.blueprint.submit(cnv, { version: ver(), ops, team_id: one }, a.id);
const refusal = (fn: () => unknown): { code?: string; message: string; extra?: unknown } => { try { fn(); } catch (e: any) { return e; } throw new Error('expected a refusal'); };
let n = 0;
const nextKey = () => `FR-ONE-${String(++n).padStart(2, '0')}`;
const unclearFr = (key: string, ask: unknown, parent = 'ONE'): Op => ({ op: 'upsert', kind: 'fr', key, parent_key: parent, title: `Requirement ${key}`, body: 'The gauge reads the dry value.', fields: { priority: 'must', unclear: true, unclear_ask: ask } });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahunclear-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  cnv = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  const mk = (label: string): A => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id };
  };
  const team = (name: string, c: A) => {
    const t = app.teams.create({ name, goal: `${name} goal`, members: [{ agent_id: c.id, role: 'coordinator' }] }, sys);
    app.teams.start(t.id, sys);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(cnv, t.id);
    return t.id;
  };
  coord = mk('cnv-coord'); coord2 = mk('cnv2-coord');
  one = team('CNV One', coord); two = team('CNV Two', coord2);
  app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'module', key: 'ONE', title: 'Team one module', team_id: one }] }, operator);
});
afterAll(async () => { await app?.close(); });

describe('unclear_ask with the question itself', () => {
  it('one write adds the requirement and opens its question, which Clarify answers', async () => {
    closeAsks();
    const key = nextKey();
    const r = submit(coord, [unclearFr(key, 'Is the dry value read before or after the warm-up?')]);
    expect(r.status).toBe('applied');
    if (r.status !== 'applied') return;
    expect(r.asks).toHaveLength(1);
    const id = r.asks![0]!.decision_id;
    expect(r.asks![0]).toEqual({ key, decision_id: id });
    expect(item(key).fields).toMatchObject({ unclear: true, unclear_ask: id });
    expect(decision(id)).toMatchObject({ team_id: one, agent_id: coord.id, status: 'open', question: 'Is the dry value read before or after the warm-up?', refs: JSON.stringify([key]), credential_id: null });
    // Needs you shows it as a Clarify row, and answering it clears the mark.
    const row = (await call(admin, 'GET', '/needs-you')).body.items.find((i: any) => i.id === `question:${id}`);
    expect(row).toMatchObject({ kind: 'unclear', actions: [{ id: 'clarify', label: 'Clarify', path: `/api/decisions/${id}/answer`, input: true }], item: { key } });
    const a = await call(admin, 'POST', `/decisions/${id}/answer`, { text: 'After the warm-up.', item_rev: item(key).rev });
    expect(a.status).toBe(200);
    expect(item(key).fields['unclear']).toBeUndefined();
    expect(item(key).fields['unclear_ask']).toBeUndefined();
  });

  it('takes options, a recommendation and context too, and tells the coordinator of a member\'s question as for team_ask', () => {
    closeAsks();
    const key = nextKey();
    const r = submit(coord, [unclearFr(key, { question: 'Which gauge counts?', options: [{ key: 'a', label: 'The inner one' }, { key: 'b', label: 'The outer one', effect: 'Needs a new mount' }], recommended: 'a', context: 'Both are fitted today.' })]);
    if (r.status !== 'applied') throw new Error(r.status);
    const d = decision(r.asks![0]!.decision_id)!;
    expect(JSON.parse(d.options)).toEqual([{ key: 'a', label: 'The inner one', effect: null }, { key: 'b', label: 'The outer one', effect: 'Needs a new mount' }]);
    expect(d).toMatchObject({ recommended: 'a', context: 'Both are fitted today.' });
  });

  it('still takes the id of an open question of the team that names the requirement', () => {
    closeAsks();
    const key = nextKey();
    expect(submit(coord, [{ op: 'upsert', kind: 'fr', key, parent_key: 'ONE', title: `Requirement ${key}`, fields: { priority: 'must' } }]).status).toBe('applied');
    const ask = app.decisions.ask(who(coord), { team_id: one, question: `What is unclear in ${key}?`, refs: [key] }).id;
    const r = submit(coord, [{ op: 'upsert', kind: 'fr', key, fields: { unclear: true, unclear_ask: ask } }]);
    expect(r.status).toBe('applied');
    if (r.status === 'applied') expect(r.asks).toBeUndefined();
    expect(item(key).fields['unclear_ask']).toBe(ask);
  });

  it('in a proposal, opens the question only when the operator applies it, even past the agent\'s question limit', () => {
    closeAsks();
    const key = 'FR-NEW-01';
    // A new module needs the operator, so the whole write is a proposal.
    const r = submit(coord, [{ op: 'upsert', kind: 'module', key: 'NEW', title: 'New module', team_id: one }, unclearFr(key, 'Who reads the gauge?', 'NEW')]);
    expect(r.status).toBe('proposed');
    if (r.status !== 'proposed') return;
    expect(asksNaming(key)).toEqual([]);
    // Meanwhile the agent reaches its limit of open questions: the operator's apply is not refused for it.
    for (let i = 0; i < 5; i++) app.decisions.ask(who(coord), { team_id: one, question: `Other ${i}?` });
    const applied = app.blueprint.applyProposal(r.proposal.id, operator);
    expect(applied.stale).toBeNull();
    const ids = asksNaming(key);
    expect(ids).toHaveLength(1);
    expect(applied.result!.asks).toEqual([{ key, decision_id: ids[0] }]);
    expect(item(key).fields).toMatchObject({ unclear: true, unclear_ask: ids[0] });
    expect(decision(ids[0]!)).toMatchObject({ agent_id: coord.id, team_id: one, status: 'open', question: 'Who reads the gauge?' });
  });

  it('in a direct write, the agent\'s question limit refuses the write and nothing is written', () => {
    closeAsks();
    for (let i = 0; i < 5; i++) app.decisions.ask(who(coord), { team_id: one, question: `Other ${i}?` });
    const key = nextKey();
    expect(refusal(() => submit(coord, [unclearFr(key, 'One too many?')]))).toMatchObject({ code: 'rate_limited' });
    expect(app.blueprint.item(cnv, key)).toBeUndefined();
    expect(asksNaming(key)).toEqual([]);
  });

  it('a check (dry run) opens nothing', () => {
    closeAsks();
    const key = nextKey();
    const before = (app.db.prepare('SELECT COUNT(*) n FROM decisions').get() as { n: number }).n;
    app.blueprint.check(cnv, { version: ver(), ops: [unclearFr(key, 'Only checking?')], team_id: one }, coord.id);
    expect((app.db.prepare('SELECT COUNT(*) n FROM decisions').get() as { n: number }).n).toBe(before);
  });
});

describe('a bad unclear_ask says what to pass', () => {
  const how = 'Put your question to the operator in unclear_ask, as its text or as {question, options, recommended}, and the write asks it for you';
  it.each([
    ['a number', 42, 'is neither a question nor the id of one'],
    ['an empty question', { question: ' ' }, 'needs the question in words'],
    ['an unknown field', { question: 'Which?', answer: 'x' }, 'takes question, options, recommended and context, not answer'],
    ['one option', { question: 'Which?', options: [{ key: 'a', label: 'A' }] }, 'Give two or more options'],
    ['a recommendation that is no option', { question: 'Which?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], recommended: 'c' }, 'recommended must be one of the option keys'],
    ['a question too long', 'x'.repeat(301), 'at most 300 characters'],
  ])('refuses %s, naming the rule and the two forms', (_what, value, says) => {
    closeAsks();
    const key = nextKey();
    const e = refusal(() => submit(coord, [unclearFr(key, value)]));
    expect(e).toMatchObject({ code: 'invalid_argument', extra: { rule: 'unclear_needs_ask' } });
    expect(e.message).toContain(says);
    expect(e.message).toContain(how);
    expect(e.message).toContain(`Or give the id of an open team_ask of your team that names ${key} in refs.`);
    expect(app.blueprint.item(cnv, key)).toBeUndefined();
  });
  it('refuses a mark with no question, an unknown id and a question without unclear: true, each with the same advice', () => {
    closeAsks();
    const key = nextKey();
    expect(submit(coord, [{ op: 'upsert', kind: 'fr', key, parent_key: 'ONE', title: `Requirement ${key}`, fields: { priority: 'must' } }]).status).toBe('applied');
    expect(refusal(() => submit(coord, [{ op: 'upsert', kind: 'fr', key, fields: { unclear: true } }])).message).toContain(how);
    expect(refusal(() => submit(coord, [{ op: 'upsert', kind: 'fr', key, fields: { unclear: true, unclear_ask: 'dec_nosuchone1' } }])).message).toMatch(/is not an open team question\. Put your question/);
    expect(refusal(() => submit(coord, [{ op: 'upsert', kind: 'fr', key, fields: { unclear: false, unclear_ask: 'Why?' } }])).message).toBe(`${key}: a question in unclear_ask goes with unclear: true.`);
  });
  it('keeps the open question when the text is sent again, and opens no second one', () => {
    closeAsks();
    const key = nextKey();
    const r = submit(coord, [unclearFr(key, 'Which gauge do we read?')]);
    if (r.status !== 'applied') throw new Error(r.status);
    const id = r.asks![0]!.decision_id;
    // A retry with the same text, then a rewrite of the item with other text: both are taken as unchanged.
    for (const text of ['Which gauge do we read?', 'Which gauge, inner or outer?']) {
      const again = submit(coord, [{ ...unclearFr(key, text), body: `The gauge reads the dry value (${text.length}).` } as Op]);
      expect(again.status).toBe('applied');
      if (again.status === 'applied') expect(again.asks ?? []).toEqual([]);
    }
    expect(asksNaming(key)).toEqual([id]);
    expect(decision(id)!.status).toBe('open');
    expect(item(key).fields).toMatchObject({ unclear: true, unclear_ask: id });
    // Once that question is declined, new text asks a new one.
    app.db.prepare("UPDATE decisions SET status='declined' WHERE id=?").run(id);
    const next = submit(coord, [unclearFr(key, 'Then which one, please?')]);
    if (next.status !== 'applied') throw new Error(next.status);
    expect(next.asks).toHaveLength(1);
    expect(item(key).fields['unclear_ask']).toBe(next.asks![0]!.decision_id);
  });

  it('gives agents the guidance sentence the operator approved for Clarify, word for word', () => {
    expect(BP_WRITING).toContain('Mark a requirement unclear rather than guess, and ask the operator what is unclear with one team_ask that names the requirement; set unclear_ask to that question.');
  });

  it('leaves the operator\'s own writes alone', () => {
    const key = nextKey();
    app.blueprint.write(cnv, { version: ver(), ops: [unclearFr(key, 'Free text from the operator')] }, operator);
    expect(item(key).fields['unclear_ask']).toBe('Free text from the operator');
    expect(asksNaming(key)).toEqual([]);
    void two; void coord2;
  });
});
