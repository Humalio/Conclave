/**
 * Task refs to a pending proposal (docs/blueprint.md §2.3): a task may name a key that an open proposal of its own team
 * writes. The ref is kept as pending until the proposal closes: applied, it goes live by itself; rejected or withdrawn, it is
 * dropped and the coordinators get one notice. Another team's proposal does not count, and an unknown key is still refused.
 * The console shows a pending ref as a dashed chip that says it waits for the operator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Who } from '../src/teams/teams.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, P = '', teamA = '', teamB = '', adminId = '';
type A = { id: string; cred: string };
let coordA: A, workerA: A, coordB: A;
const opr = () => ({ kind: 'operator' as const, id: adminId });
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
const v = () => app.blueprint.project(P)!.version;
const propose = (a: A, ops: Op[]) => {
  const r = app.blueprint.submit(P, { version: v(), ops }, a.id);
  expect(r.status).toBe('proposed');
  return r.status === 'proposed' ? r.proposal.id : '';
};
const task = (id: string) => app.teams.taskView(app.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as never);
const dropNotices = (a: A) => (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='task_refs_dropped' ORDER BY seq").all(a.id) as { body: string }[]).map((r) => r.body);
const refusal = (fn: () => unknown) => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
let n = 0;
/** A new module of team A with one requirement in it: always a proposal, since opening a module needs the operator. */
const firstPlan = () => {
  const mod = `MD${String.fromCharCode(65 + n)}`, fr = `FR-${mod}-01`; n++;
  const id = propose(coordA, [
    { op: 'upsert', kind: 'module', key: mod, title: `Module ${mod}`, team_id: teamA },
    { op: 'upsert', kind: 'fr', key: fr, parent_key: mod, title: `Requirement of ${mod}`, fields: { priority: 'must' } },
  ]);
  return { id, mod, fr };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahpend-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string } | undefined)?.id ?? '';
  const agent = (label: string): A => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id };
  };
  coordA = agent('coord-a'); workerA = agent('worker-a'); coordB = agent('coord-b');
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: coordA.id, role: 'coordinator', credential_id: coordA.cred }, { agent_id: workerA.id, role: 'worker', credential_id: workerA.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: coordB.id, role: 'coordinator', credential_id: coordB.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  app.blueprint.write(P, { version: v(), ops: [{ op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model', team_id: teamA }, { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', parent_key: 'FLD', title: 'Field map' }] }, opr());
});
afterAll(async () => { await app?.close(); });

describe('task refs to a pending proposal', () => {
  it('accepts a key of an open proposal of the same team as pending, next to a live one', () => {
    const plan = firstPlan();
    const k = app.teams.create_task(who(coordA), { team_id: teamA, title: 'Build it', refs: ['FR-FLD-01', plan.fr, plan.mod] });
    const t = task(k.id);
    expect(t.refs).toEqual(['FR-FLD-01']);
    expect(t.pending_refs).toEqual([plan.fr, plan.mod]);
  });

  it('turns a pending ref live as soon as the operator writes the item directly, while the proposal is still open', () => {
    const plan = firstPlan();
    const k = app.teams.create_task(who(coordA), { team_id: teamA, title: 'Written by hand', refs: [plan.fr, plan.mod] });
    expect(task(k.id).pending_refs).toEqual([plan.fr, plan.mod]);
    app.blueprint.write(P, { version: v(), ops: [{ op: 'upsert', kind: 'module', key: plan.mod, title: `Module ${plan.mod}`, team_id: teamA }] }, opr());
    let t = task(k.id);
    expect(t.refs).toEqual([plan.mod]);
    expect(t.pending_refs).toEqual([plan.fr]);
    // The proposal is still open; withdrawn later, it drops only what never went live.
    app.blueprint.withdrawProposal(plan.id, coordA.id);
    t = task(k.id);
    expect(t.refs).toEqual([plan.mod]);
    expect(t.pending_refs).toEqual([]);
    expect(dropNotices(coordA).join('\n')).toContain(`${k.id} (${plan.fr})`);
  });

  it('turns the pending refs live when the operator applies the proposal, with no call from anyone', () => {
    const plan = firstPlan();
    const k = app.teams.create_task(who(coordA), { team_id: teamA, title: 'Live soon', refs: [plan.fr] });
    app.blueprint.applyProposal(plan.id, opr());
    const t = task(k.id);
    expect(t.refs).toEqual([plan.fr]);
    expect(t.pending_refs).toEqual([]);
    expect(dropNotices(coordA).join('\n')).not.toContain(k.id);
  });

  it('drops the pending refs when the proposal is rejected, with one notice to the coordinator listing the tasks', () => {
    const plan = firstPlan();
    const one = app.teams.create_task(who(coordA), { team_id: teamA, title: 'First', refs: ['FR-FLD-01', plan.fr] });
    const two = app.teams.create_task(who(coordA), { team_id: teamA, title: 'Second', refs: [plan.mod] });
    const before = dropNotices(coordA).length;
    app.blueprint.rejectProposal(plan.id, opr(), 'Not this module');
    expect(task(one.id).refs).toEqual(['FR-FLD-01']);
    expect(task(one.id).pending_refs).toEqual([]);
    expect(task(two.id).pending_refs).toEqual([]);
    const got = dropNotices(coordA).slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(plan.id);
    expect(got[0]).toContain(`${one.id} (${plan.fr})`);
    expect(got[0]).toContain(`${two.id} (${plan.mod})`);
    expect(got[0]).toContain('2 tasks lost their links');
    expect(got[0]).not.toContain('First'); // task titles are team text: the notice names ids and keys only
  });

  it('drops them on a withdrawal too, and keeps a key that another open proposal of the team still writes', () => {
    const a = firstPlan();
    const b = propose(coordA, [{ op: 'upsert', kind: 'module', key: a.mod, title: `Module ${a.mod}, again`, team_id: teamA }]);
    const k = app.teams.create_task(who(coordA), { team_id: teamA, title: 'Waits', refs: [a.fr, a.mod] });
    const before = dropNotices(coordA).length;
    app.blueprint.withdrawProposal(a.id, coordA.id);
    expect(task(k.id).pending_refs).toEqual([a.mod]); // b still proposes the module
    const got = dropNotices(coordA).slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('was withdrawn');
    expect(got[0]).toContain(`${k.id} (${a.fr})`);
    app.blueprint.rejectProposal(b, opr(), null);
    expect(task(k.id).pending_refs).toEqual([]);
  });

  it("refuses another team's pending key and a key nobody proposed, as before", () => {
    const theirs = propose(coordB, [{ op: 'upsert', kind: 'module', key: 'TRN', title: 'Tern module', team_id: teamB }]);
    expect(refusal(() => app.teams.create_task(who(coordA), { team_id: teamA, title: 'Not ours', refs: ['TRN'] }))).toBe('Not in the project blueprint or in an open proposal of your team: TRN. Name a key once it is in the Blueprint, or once your team has proposed it with bp_write.');
    expect(refusal(() => app.teams.create_task(who(coordA), { team_id: teamA, title: 'Unknown', refs: ['FR-FLD-09'] }))).toContain('FR-FLD-09');
    // Their own team's task may name it.
    const k = app.teams.create_task(who(coordB), { team_id: teamB, title: 'Ours', refs: ['TRN'] });
    expect(task(k.id).pending_refs).toEqual(['TRN']);
    app.blueprint.rejectProposal(theirs, opr(), null);
    // A team question still takes live keys only.
    expect(refusal(() => app.decisions.ask(who(coordA), { team_id: teamA, question: 'Which one?', refs: [firstPlan().fr] }))).toMatch(/^Not in the project blueprint: FR-/);
  });

  it('task_update with refs replaces both lists', () => {
    const plan = firstPlan();
    const k = app.teams.create_task(who(coordA), { team_id: teamA, title: 'Edit me', refs: [plan.fr] });
    const u = app.teams.update_task(who(coordA), { task_id: k.id, version: k.version, refs: ['FR-FLD-01'] });
    expect(task(u.id).refs).toEqual(['FR-FLD-01']);
    expect(task(u.id).pending_refs).toEqual([]);
    const u2 = app.teams.update_task(who(coordA), { task_id: k.id, version: u.version, refs: [plan.mod] });
    expect(task(u2.id).pending_refs).toEqual([plan.mod]);
    const u3 = app.teams.update_task(who(coordA), { task_id: k.id, version: u2.version, title: 'Edited' });
    expect(task(u3.id).pending_refs).toEqual([plan.mod]); // left alone without refs
    app.blueprint.rejectProposal(plan.id, opr(), null);
  });
});

describe('the console shows a pending ref on the task', () => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
  const i = js.indexOf('function refChips('), rest = js.slice(i), m = /\n(?=const |function |async function |let |\/\*)/.exec(rest.slice(1));
  const body = rest.slice(0, m ? m.index + 1 : rest.length);
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const plural = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const refChips = new Function('esc', 'plural', 'PRI', 'REQ_ST', 'MS_ST', 'bpItemArg', `${body}\nreturn refChips;`)(esc, plural, {}, {}, {}, (p: string, k: string) => `${p}|${k}`) as (k: object, t: object, o?: object) => string;
  const T = { project_id: 'p1', plan: { requirements: [{ key: 'FR-1', title: 'Live one' }], milestones: [] } };

  it('renders a pending key as a dashed chip whose tip says it waits for the operator, on the card and the task page', () => {
    const card = refChips({ refs: ['FR-1'], pending_refs: ['FR-MDA-01'] }, T, { task: 'a|b' });
    expect(card).toContain('class="ref pend" data-task="a|b">FR-MDA-01');
    expect(card).toContain('Waiting for the operator to apply the plan.');
    const only = refChips({ refs: [], pending_refs: ['FR-MDA-01'] }, T, { open: true });
    expect(only).toContain('<button type="button" class="ref pend" data-info="FR-MDA-01: Waiting for the operator to apply the plan."');
    expect(only).not.toContain('data-ref-bp'); // not in the Blueprint yet: it never navigates
    expect(refChips({ refs: [], pending_refs: [] }, T)).toBe('');
  });
  it('the task page shows the Requirement row for pending refs alone, with the sentence in words', () => {
    expect(js).toContain("${refs || pend ? kv('Requirement', refChips(k, t, { open: true })");
    expect(js).toContain('is waiting for the operator to apply the plan.');
    expect(css).toMatch(/\.ref\.pend\{text-decoration:underline dashed/);
  });
});
