/**
 * Clarify (docs/blueprint.md §2.7, docs/multi-user.md §4): a team marks a requirement unclear with one team_ask that names it;
 * answering the ask clears the mark in the same step. Needs you shows the ask's row (Clarify), deciders only answer, and a
 * legacy item marked with no question gets "Ask the team what's unclear".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Who } from '../src/teams/teams.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, dana: S, eve: S;
const PW = 'clarify test password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
type A = { id: string; cred: string };
const mk = (label: string): A => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, cred: k.credential.id };
};
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
const ver = () => app.blueprint.project(cnv)!.version;
const needs = async (s: S) => (await call(s, 'GET', '/needs-you')).body;
const rowOf = (b: any, id: string) => b.items.find((i: any) => i.id === id);
const item = (key: string) => app.blueprint.item(cnv, key)!;
const operator = { kind: 'operator' as const, id: null };

let cnv = '', one = '', two = '', coord: A, coord2: A, wk: A, danaId = '', n = 0;
const team = (name: string, members: A[]) => {
  const t = app.teams.create({ name, goal: `${name} goal`, members: members.map((m, i) => ({ agent_id: m.id, role: i ? 'worker' : 'coordinator' })) }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(cnv, t.id);
  return t.id;
};
/** Each test asks its own questions; earlier ones are closed so the agent stays under the open-question cap. */
const closeAsks = () => app.db.prepare("UPDATE decisions SET status='declined' WHERE status IN ('open','needs_info')").run();
/** A new requirement of team one, and (when asked) its open question. */
const fresh = (unclear: 'none' | 'ask' | 'legacy' = 'ask') => {
  closeAsks();
  const key = `FR-ONE-${String(++n).padStart(2, '0')}`;
  app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, parent_key: 'ONE', title: `Requirement ${n}`, body: `Statement ${n}`, fields: { priority: 'must', evidence: 'vault/a.md' } }] }, operator);
  if (unclear === 'legacy') app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, fields: { unclear: true } }] }, operator);
  let ask = '';
  if (unclear === 'ask') {
    ask = app.decisions.ask(who(coord), { team_id: one, question: `What is unclear in ${key}?`, refs: [key] }).id;
    mark(key, ask);
  }
  return { key, ask };
};
const mark = (key: string, ask: string | undefined, actor: A = coord) =>
  app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, fields: { unclear: true, ...(ask ? { unclear_ask: ask } : {}) } }], team_id: one }, { kind: 'agent', id: actor.id });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahclarify-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base, 'admin', ADMIN_PASSWORD);
  cnv = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  coord = mk('cnv-coord'); coord2 = mk('cnv2-coord');
  wk = mk('cnv-worker'); one = team('CNV One', [coord, wk]); two = team('CNV Two', [coord2]);
  expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'module', key: 'ONE', title: 'Team one module', team_id: one }] })).status).toBe(200);
  const mkUser = async (username: string) => {
    const c = await call(admin, 'POST', '/users', { username });
    const first = await adminLogin(base, username, c.body.password);
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: cnv, components: ['tasks', 'blueprint'] }] })).status).toBe(200);
    return c.body.user.id as string;
  };
  danaId = await mkUser('dana'); await mkUser('eve');
  expect((await call(admin, 'PUT', `/teams/${one}/deciders`, { user_ids: [danaId] })).status).toBe(200);
  dana = await adminLogin(base, 'dana', PW); eve = await adminLogin(base, 'eve', PW);
});
afterAll(async () => { await app?.close(); });

describe('Clarify: marking a requirement unclear is one question', () => {
  it('an agent cannot mark without an open question of its team that names the item', async () => {
    const { key } = fresh('none');
    const refuse = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e; } throw new Error('expected a refusal'); };
    // no question at all
    expect(refuse(() => mark(key, undefined))).toMatchObject({ code: 'invalid_argument', extra: { rule: 'unclear_needs_ask' } });
    // a question that does not name the item
    const other = app.decisions.ask(who(coord), { team_id: one, question: 'Something else?', refs: ['ONE'] }).id;
    expect(refuse(() => mark(key, other)).message).toMatch(/does not name/);
    // another team's question
    const theirs = app.decisions.ask(who(coord2), { team_id: two, question: 'Theirs?', refs: [key] }).id;
    expect(refuse(() => mark(key, theirs)).message).toMatch(/not a question of your team/);
    // an answered question is no longer open
    const done = app.decisions.ask(who(coord), { team_id: one, question: 'Answered?', refs: [key] }).id;
    app.db.prepare("UPDATE decisions SET status='answered' WHERE id=?").run(done);
    expect(refuse(() => mark(key, done)).message).toMatch(/not an open team question/);
    expect(item(key).fields['unclear']).toBeUndefined();
    // the operator is not refused, and an agent's open question is accepted
    app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, fields: { unclear: true } }] }, operator);
    app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, fields: { unclear: null } }] }, operator);
    const ask = app.decisions.ask(who(coord), { team_id: one, question: `What is unclear in ${key}?`, refs: [key] }).id;
    mark(key, ask);
    expect(item(key).fields).toMatchObject({ unclear: true, unclear_ask: ask });
  });

  it('clearing the mark clears the question\'s id with it, and editing a legacy item\'s other fields is not refused', async () => {
    const { key, ask } = fresh('ask');
    app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, fields: { unclear: null } }], team_id: one }, { kind: 'agent', id: coord.id });
    expect(item(key).fields['unclear_ask']).toBeUndefined();
    expect(ask).toBeTruthy();
    const legacy = fresh('legacy').key;
    app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key: legacy, fields: { evidence: 'vault/b.md' } }], team_id: one }, { kind: 'agent', id: coord.id });
    expect(item(legacy).fields).toMatchObject({ unclear: true, evidence: 'vault/b.md' });
  });
});

describe('Clarify: Needs you', () => {
  it('shows the question\'s row only, to the decider, with the item and a Clarify action', async () => {
    const { key, ask } = fresh('ask');
    const d = await needs(dana), a = await needs(admin);
    const row = rowOf(d, `question:${ask}`);
    expect(row).toMatchObject({ kind: 'unclear', source: { kind: 'decision', id: ask }, scope: { project_id: cnv, team_id: one },
      actions: [{ id: 'clarify', label: 'Clarify', path: `/api/decisions/${ask}/answer`, input: true }],
      ask: { id: ask, question: `What is unclear in ${key}?`, team_id: one }, item: { project_id: cnv, key, rev: item(key).rev, priority: 'must', statement: expect.stringContaining('Statement') } });
    // one row for the item: no plain unclear row, for the decider or for the admin the question is routed away from
    expect(d.items.filter((i: any) => i.item?.key === key)).toHaveLength(1);
    expect(a.items.filter((i: any) => i.item?.key === key || i.id === `unclear:${cnv}:${key}`)).toHaveLength(0);
    expect(rowOf(await needs(eve), `question:${ask}`)).toBeUndefined();
  });

  it('a legacy item (unclear, no question) is the admin\'s, with Ask the team', async () => {
    const { key } = fresh('legacy');
    const row = rowOf(await needs(admin), `unclear:${cnv}:${key}`);
    expect(row).toMatchObject({ kind: 'unclear', source: { kind: 'bp_item' }, item: { key }, actions: [{ id: 'ask_team', label: "Ask the team what's unclear", path: `/api/projects/${cnv}/items/${key}/ask-unclear` }] });
    expect(row.ask).toBeUndefined();
    expect(rowOf(await needs(dana), `unclear:${cnv}:${key}`)).toBeUndefined();
  });
});

describe('Clarify: answering the question', () => {
  it('clears the mark and the question\'s id in one step, records who answered, and keeps the clarification', async () => {
    const { key, ask } = fresh('ask');
    const rev = item(key).rev;
    const r = await call(dana, 'POST', `/decisions/${ask}/answer`, { text: 'It means the dry-bulb value.', item_rev: rev });
    expect(r.status).toBe(200);
    expect(r.body.decision).toMatchObject({ status: 'answered' });
    const it = item(key);
    expect(it.fields['unclear']).toBeUndefined();
    expect(it.fields['unclear_ask']).toBeUndefined();
    expect(it.rev).toBe(rev + 1);
    // the revision names the answerer and carries the answer
    const read = (await call(admin, 'GET', `/projects/${cnv}/items/${key}`)).body;
    expect(read.history.revisions[0]).toMatchObject({ rev: rev + 1, note: 'clarified: It means the dry-bulb value.' });
    expect(read.history.revisions[0].actor).toMatch(/^operator/);
    expect(read.clarification).toMatchObject({ text: 'It means the dry-bulb value.', by_label: 'dana', decision_id: ask });
    // the ask's own path is as before: the coordinator hears the answer, and the decision log has it
    expect(app.decisions.get(ask)).toMatchObject({ status: 'answered', answer_text: 'It means the dry-bulb value.' });
    expect(rowOf(await needs(dana), `question:${ask}`)).toBeUndefined();
    expect(app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='decision' ORDER BY seq DESC").all(coord.id).map((x: any) => x.body).join('\n')).toMatch(new RegExp(`${key} is no longer marked unclear`));
  });

  it('answers without item_rev too, and an ordinary question is unchanged', async () => {
    const { key, ask } = fresh('ask');
    expect((await call(admin, 'POST', `/decisions/${ask}/answer`, { text: 'Ok.' })).status).toBe(200);
    expect(item(key).fields['unclear']).toBeUndefined();
    const plain = app.decisions.ask(who(coord), { team_id: one, question: 'Ship it?' }).id;
    expect((await call(dana, 'POST', `/decisions/${plain}/answer`, { text: 'Yes.', item_rev: 3 })).status).toBe(200);
  });

  it('refuses with a conflict when the item moved since the answerer opened it, and changes nothing', async () => {
    const { key, ask } = fresh('ask');
    const seen = item(key).rev;
    app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, title: 'Reworded', fields: { evidence: 'vault/c.md' } }] }, operator);
    const r = await call(dana, 'POST', `/decisions/${ask}/answer`, { text: 'Late.', item_rev: seen });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'conflict' });
    expect(item(key).fields).toMatchObject({ unclear: true, unclear_ask: ask });
    expect(app.decisions.get(ask).status).toBe('open');
    // answering again on the new revision works
    expect((await call(dana, 'POST', `/decisions/${ask}/answer`, { text: 'Now.', item_rev: item(key).rev })).status).toBe(200);
  });

  it('says the team cleared it already when the mark is gone, and leaves the question open', async () => {
    const { key, ask } = fresh('ask');
    const seen = item(key).rev;
    app.blueprint.write(cnv, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, fields: { unclear: null } }], team_id: one }, { kind: 'agent', id: coord.id });
    const r = await call(dana, 'POST', `/decisions/${ask}/answer`, { text: 'Too late.', item_rev: seen });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'already_clear' });
    expect(app.decisions.get(ask).status).toBe('open');
  });

  it('turns a pending proposal on the item stale, as any write does', async () => {
    const { key, ask } = fresh('ask');
    const ops: Op[] = [{ op: 'upsert', kind: 'fr', key, title: 'Proposed title' }];
    // a worker of team one proposes a change to the item
    const sub = app.blueprint.submit(cnv, { version: ver(), ops, reason: 'test', team_id: one }, wk.id);
    if (sub.status !== 'proposed') throw new Error('expected a proposal');
    const id = sub.proposal.id;
    expect((await call(dana, 'POST', `/decisions/${ask}/answer`, { text: 'Cleared.', item_rev: item(key).rev })).status).toBe(200);
    const applied = app.blueprint.applyProposal(id, { kind: 'operator', id: null });
    expect(applied.stale).toBeTruthy();
    expect(applied.proposal.status).toBe('stale');
  });

  it('is the decider\'s to answer only: Edit and Drop on the item stay the admin\'s', async () => {
    const { key, ask } = fresh('ask');
    // another team's decider-less viewer and an unrelated member cannot answer
    expect((await call(eve, 'POST', `/decisions/${ask}/answer`, { text: 'Not mine.' })).status).toBeGreaterThanOrEqual(400);
    // a decider's ops write on the item (Edit, Drop) is refused; the status moves of the plan stay theirs
    const edit = await call(dana, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, title: 'Dana edit' }], team_id: one });
    expect(edit.status).toBe(403);
    const drop = await call(dana, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'remove', key }], team_id: one });
    expect(drop.status).toBeGreaterThanOrEqual(400);
    expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, title: 'Admin edit' }] })).status).toBe(200);
    expect(item(key).title).toBe('Admin edit');
  });
});

describe('Clarify: the other ways a question settles', () => {
  const relay = (ask: string, text: string) => app.decisions.update(who(coord), { decision_id: ask, relayed_answer: text, source: 'chat with operator' });

  it('a relayed answer keeps the item on the question until the operator confirms it, and confirming clears the mark', async () => {
    const { key, ask } = fresh('ask');
    relay(ask, 'It is the dry-bulb value.');
    expect(rowOf(await needs(dana), `question:${ask}`)).toMatchObject({ kind: 'relayed_answer' });
    // no "no question was asked" row while the relay waits
    expect((await needs(admin)).items.filter((i: any) => i.id === `unclear:${cnv}:${key}`)).toHaveLength(0);
    expect(item(key).fields).toMatchObject({ unclear: true, unclear_ask: ask });
    expect((await call(dana, 'POST', `/decisions/${ask}/confirm`, {})).status).toBe(200);
    expect(item(key).fields['unclear']).toBeUndefined();
    expect(item(key).fields['unclear_ask']).toBeUndefined();
    const read = (await call(admin, 'GET', `/projects/${cnv}/items/${key}`)).body;
    expect(read.history.revisions[0]).toMatchObject({ note: expect.stringContaining('clarified: '), actor_name: 'dana' });
    expect(read.clarification).toMatchObject({ by_label: 'dana' });
    expect((await needs(admin)).items.filter((i: any) => i.item?.key === key)).toHaveLength(0);
  });

  it('overturning a relayed answer clears the mark with the operator\'s own answer', async () => {
    const { key, ask } = fresh('ask');
    relay(ask, 'Probably wet-bulb.');
    expect((await call(dana, 'POST', `/decisions/${ask}/overturn`, { text: 'Dry-bulb, not wet-bulb.' })).status).toBe(200);
    expect(item(key).fields['unclear']).toBeUndefined();
    const read = (await call(admin, 'GET', `/projects/${cnv}/items/${key}`)).body;
    expect(read.history.revisions[0]).toMatchObject({ note: 'clarified: Dry-bulb, not wet-bulb.' });
  });

  it('a declined question leaves the mark, and its row says the question was declined, not that none was asked', async () => {
    const { key, ask } = fresh('ask');
    expect((await call(dana, 'POST', `/decisions/${ask}/decline`, { note: 'Not now.' })).status).toBe(200);
    expect(item(key).fields).toMatchObject({ unclear: true, unclear_ask: ask });
    const row = rowOf(await needs(admin), `unclear:${cnv}:${key}`);
    expect(row).toMatchObject({ reason: 'Marked unclear · its question was declined', actions: [{ id: 'ask_team' }] });
  });

  it('the history names the decider who answered, not just "operator"', async () => {
    const { key, ask } = fresh('ask');
    expect((await call(dana, 'POST', `/decisions/${ask}/answer`, { text: 'Done.' })).status).toBe(200);
    const read = (await call(admin, 'GET', `/projects/${cnv}/items/${key}`)).body;
    expect(read.history.revisions[0]).toMatchObject({ actor: `operator:${danaId}`, actor_name: 'dana' });
    const page = (await call(admin, 'GET', `/projects/${cnv}/items/${key}/history`)).body;
    expect(page.revisions[0]).toMatchObject({ actor_name: 'dana' });
  });
});

describe('Clarify: a legacy item', () => {
  it('Ask the team sends the coordinator one fixed notice, admin only, once the item is unclear and has no open question', async () => {
    const { key } = fresh('legacy');
    const before = (app.db.prepare("SELECT COUNT(*) c FROM agent_notices WHERE agent_id=? AND kind='unclear_ask'").get(coord.id) as { c: number }).c;
    expect((await call(dana, 'POST', `/projects/${cnv}/items/${key}/ask-unclear`, {})).status).toBeGreaterThanOrEqual(400);
    const r = await call(admin, 'POST', `/projects/${cnv}/items/${key}/ask-unclear`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key, notified: 1 });
    const notes = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='unclear_ask' ORDER BY seq").all(coord.id) as { body: string }[];
    expect(notes).toHaveLength(before + 1);
    expect(notes.at(-1)!.body).toContain(`what is unclear in ${key}`);
    expect(notes.at(-1)!.body).toContain('team_ask');
    // the team then marks it properly; the second ask is refused while its question is open
    const ask = app.decisions.ask(who(coord), { team_id: one, question: `What is unclear in ${key}?`, refs: [key] }).id;
    mark(key, ask);
    expect((await call(admin, 'POST', `/projects/${cnv}/items/${key}/ask-unclear`, {})).status).toBe(409);
    // an item that is not unclear is refused too
    const { key: plain } = fresh('none');
    expect((await call(admin, 'POST', `/projects/${cnv}/items/${plain}/ask-unclear`, {})).status).toBe(409);
  });

  it('the note written with Edit or Drop shows in the item\'s own history, naming who wrote it', async () => {
    const { key } = fresh('legacy');
    expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, title: 'Reworded' }], note: 'The operator says: use dry-bulb.' })).status).toBe(200);
    let read = (await call(admin, 'GET', `/projects/${cnv}/items/${key}`)).body;
    expect(read.history.revisions[0]).toMatchObject({ note: 'The operator says: use dry-bulb.', actor_name: 'admin' });
    expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, status: 'dropped' }], note: 'Not needed any more.' })).status).toBe(200);
    read = (await call(admin, 'GET', `/projects/${cnv}/items/${key}`)).body;
    expect(read.history.revisions[0]).toMatchObject({ note: 'Not needed any more.', actor_name: 'admin' });
    // with no note, the revision keeps the plain history it had
    const other = fresh('legacy').key;
    expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key: other, title: 'Again' }] })).status).toBe(200);
    expect((await call(admin, 'GET', `/projects/${cnv}/items/${other}`)).body.history.revisions[0].note).toBeNull();
  });

  it('Edit and Drop on it are the admin\'s ordinary writes, with no migration of the item', async () => {
    const { key } = fresh('legacy');
    expect(item(key).fields['unclear_ask']).toBeUndefined();
    expect((await call(admin, 'POST', `/projects/${cnv}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, fields: { unclear: null }, title: 'Settled' }], note: 'Edited by the operator' })).status).toBe(200);
    expect(item(key).fields['unclear']).toBeUndefined();
  });
});
