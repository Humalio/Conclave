/** Blueprint rules (docs/blueprint.md §4 Rules, ADR-006): the Release notes rule, its history and For awareness row, and superseding on accept. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Op, SubmitResult } from '../src/blueprint/blueprint.js';
import { rulesText, KIND_ORDER } from '../src/blueprint/kinds.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: any };
let app: App, base = '', cookie = '', csrf = '', adminId = '';
let C: (name: string, args?: Record<string, unknown>) => Promise<Res>;
let coordA = '', workerA = '', coordB = '', teamA = '', teamB = '', P = '';
const opr = () => ({ kind: 'operator' as const, id: adminId });
const code = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; } };
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const sub = (agent: string, ops: Op[]): SubmitResult => app.blueprint.submit(P, { version: v(), ops }, agent);
/** The verdict only: a proposal is rejected at once, so the open-proposal limit is never reached. */
const vrd = (agent: string, ops: Op[]): SubmitResult => { const r = sub(agent, ops); if (r.status === 'proposed') app.blueprint.rejectProposal(r.proposal.id, opr(), null); return r; };
const item = (key: string) => app.blueprint.item(P, key);
const notes = (key: string) => (app.db.prepare('SELECT r.change_note AS n, r.actor_kind AS k FROM bp_revisions r JOIN bp_items i ON i.id=r.item_id WHERE i.project_id=? AND i.key=? ORDER BY r.rev').all(P, key) as { n: string | null; k: string }[]);
const setRule = (team: string, state: 'on' | 'paused' | 'off') => app.blueprint.setRule(P, team, 'release_notes', state, adminId);
const http = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json()) as any };
};
const rel = (key: string, extra: Partial<Extract<Op, { op: 'upsert' }>> = {}): Op => ({ op: 'upsert', kind: 'release', key, title: `Release ${key}`, team_id: teamA, ...extra });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbpr-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = (await http('POST', '/pcs', { name: 'pc' })).json.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const ca = agent('coord-a'), wa = agent('worker-a'), cb = agent('coord-b');
  coordA = ca.id; workerA = wa.id; coordB = cb.id;
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }, { agent_id: wa.id, role: 'worker', credential_id: wa.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put([
    { op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model', team_id: teamA },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', parent_key: 'FLD', title: 'The field holds' },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First field', team_id: teamA },
  ]);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: ca.secret } })) as Res).structuredContent.session_token;
  C = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
});
afterAll(async () => { await app?.close(); });

describe('the Release notes rule (§4 Rules)', () => {
  it('is off by default: a coordinator\'s new release is a proposal', () => {
    expect(app.blueprint.rules(P).map((r) => [r.team, r.rule, r.state])).toEqual([['Signals Lab', 'release_notes', 'off'], ['Tern-9 Keepers', 'release_notes', 'off']]);
    expect(vrd(coordA, [rel('REL-0.1')]).status).toBe('proposed');
  });

  it('on: the coordinator creates a release and writes its notes; the write names the rule and stays the agent\'s', () => {
    setRule(teamA, 'on');
    const r = sub(coordA, [rel('REL-1.0', { body: 'The first deploy.', status: 'released', fields: { version: '1.0', notes: 'Field model shipped.' } })]);
    expect(r.status).toBe('applied');
    expect(r.status === 'applied' && r.rule).toBe('release_notes');
    expect(item('REL-1.0')).toMatchObject({ status: 'released', fields: { version: '1.0', notes: 'Field model shipped.' } });
    expect(notes('REL-1.0')).toEqual([{ n: 'created, applied by the Release notes rule (team setting)', k: 'agent' }]);
    const ev = app.db.prepare('SELECT rule, actor_kind FROM bp_events WHERE project_id=? ORDER BY id DESC LIMIT 1').get(P) as { rule: string; actor_kind: string };
    expect(JSON.parse(ev.rule)).toEqual({ rule: 'release_notes', keys: ['REL-1.0'] });
    expect(ev.actor_kind).toBe('agent');
    const au = app.db.prepare("SELECT target_id, details FROM audit_events WHERE action='blueprint.rule_applied' ORDER BY id DESC LIMIT 1").get() as { target_id: string; details: string } | undefined;
    expect(au?.target_id).toBe(teamA);
    // Rewriting the notes and title applies too, with the rule in the revision note.
    expect(sub(coordA, [{ op: 'upsert', kind: 'release', key: 'REL-1.0', title: 'Field model release', fields: { notes: 'Field model and docs shipped.' } }]).status).toBe('applied');
    expect(notes('REL-1.0').at(-1)).toEqual({ n: 'applied by the Release notes rule (team setting)', k: 'agent' });
  });

  it('a write that also changes anything outside the rule is one proposal, the whole write', () => {
    expect(vrd(coordA, [rel('REL-1.1', { fields: { target_at: Date.now() + 864e5 } })]).status).toBe('proposed');
    expect(vrd(coordA, [rel('REL-1.2'), { op: 'link', from: 'REL-1.2', to: 'FR-FLD-01', rel: 'ships' }]).status).toBe('proposed');
    expect(vrd(coordA, [{ op: 'upsert', kind: 'release', key: 'REL-1.0', fields: { version: '1.0.1' } }]).status).toBe('proposed');
    expect(vrd(coordA, [{ op: 'upsert', kind: 'release', key: 'REL-1.0', fields: { notes: 'More.' } }, { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First field, renamed' }]).status).toBe('proposed');
    expect(item('REL-1.2')).toBeFalsy();
    expect(item('M1')!.title).toBe('First field');
    // Milestones are not covered.
    expect(vrd(coordA, [{ op: 'upsert', kind: 'milestone', key: 'M2', title: 'Second field', team_id: teamA }]).status).toBe('proposed');
  });

  it('covers only the coordinator of the team it is on, in its own part', () => {
    expect(code(() => sub(workerA, [rel('REL-2.0')]))).toMatch(/^denied/);
    expect(vrd(coordB, [rel('REL-2.0')]).status).toBe('proposed');
    expect(vrd(coordB, [rel('REL-2.0', { team_id: teamB })]).status).toBe('proposed');
  });

  it('paused or off: nothing applies', () => {
    setRule(teamA, 'paused');
    expect(app.blueprint.rules(P).find((r) => r.team_id === teamA)!.state).toBe('paused');
    expect(vrd(coordA, [rel('REL-3.0')]).status).toBe('proposed');
    setRule(teamA, 'off');
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM bp_rules WHERE project_id=?').get(P)).toEqual({ n: 0 });
    expect(vrd(coordA, [rel('REL-3.0')]).status).toBe('proposed');
    expect(code(() => app.blueprint.setRule(P, 'team_nope', 'release_notes', 'on', adminId))).toMatch(/^invalid_argument/);
  });

  it('bp_read {rules: true} lists the rule and the team\'s state', async () => {
    expect(rulesText(app.blueprint.limits, KIND_ORDER)).toContain('Release notes (release_notes)');
    setRule(teamA, 'on');
    const r = await C('bp_read', { rules: true });
    expect(r.structuredContent.team_rules).toEqual([{ rule: 'release_notes', label: 'Release notes', state: 'on' }]);
    expect(r.structuredContent.rules).toContain("Your team's rules in");
  });
});

describe('the rules API and For awareness', () => {
  it('the operator turns the rule on, pauses it and turns it off, audited', async () => {
    expect((await http('PUT', `/projects/${P}/rules`, { team_id: teamB, rule: 'release_notes', state: 'on' })).json.rule).toMatchObject({ team: 'Tern-9 Keepers', state: 'on', set_by: adminId });
    expect((await http('PUT', `/projects/${P}/rules`, { team_id: teamB, rule: 'release_notes', state: 'paused' })).json.rule.state).toBe('paused');
    expect((await http('PUT', `/projects/${P}/rules`, { team_id: teamB, rule: 'release_notes', state: 'off' })).json.rule.state).toBe('off');
    const au = (app.db.prepare("SELECT details FROM audit_events WHERE action='blueprint.rule' ORDER BY id").all() as { details: string }[]).map((x) => JSON.parse(x.details));
    expect(au.map((x) => [x.was, x.state])).toEqual([['off', 'on'], ['on', 'paused'], ['paused', 'off']]);
    expect((await http('PUT', `/projects/${P}/rules`, { team_id: teamB, rule: 'other', state: 'on' })).status).toBe(400);
    const g = await http('GET', `/projects/${P}/rules`);
    expect(g.json.rules.find((r: any) => r.team_id === teamA)).toMatchObject({ state: 'on', label: 'Release notes', applies: expect.stringContaining('Creating a release') });
  });

  it('lists the changes rules applied, newest first', async () => {
    const r = await http('GET', `/projects/${P}/rules/applied?team_id=${teamA}`);
    expect(r.status).toBe(200);
    expect(r.json.changes.map((c: any) => [c.key, c.created, c.rule])).toEqual([['REL-1.0', false, 'release_notes'], ['REL-1.0', true, 'release_notes']]);
    expect(r.json.changes[0]).toMatchObject({ title: 'Field model release', kind: 'release', status: 'released', agent: 'coord-a', team_id: teamA });
    expect(r.json.rules).toHaveLength(1);
  });

  it('one For awareness row per team, at most once a day after a dismissal', async () => {
    const aw = async () => ((await http('GET', '/needs-you')).json.awareness.items as any[]).filter((x) => x.kind === 'rules_applied');
    const ny = (await http('GET', '/needs-you')).json.items as any[];
    expect(ny.some((x) => x.kind === 'rules_applied')).toBe(false);
    let rows = await aw();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ record: `rules:${P}:${teamA}`, title: '2 changes applied by rules', reason: 'Signals Lab · Release notes · today', open: { kind: 'rules', id: P, team_id: teamA } });
    // Move those changes to yesterday, dismiss the row, then a change today brings it back, counting only the new one.
    app.db.prepare('UPDATE bp_events SET created_at=created_at-864e5*2 WHERE project_id=? AND rule IS NOT NULL').run(P);
    rows = await aw();
    expect(rows[0].reason).not.toMatch(/today$/);
    expect((await http('POST', '/needs-you/dismiss', { record: rows[0].record, episode: rows[0].episode })).status).toBe(200);
    expect(await aw()).toHaveLength(0);
    expect(sub(coordA, [{ op: 'upsert', kind: 'release', key: 'REL-1.0', fields: { notes: 'Hotfix noted.' } }]).status).toBe('applied');
    rows = await aw();
    expect(rows.map((x) => [x.title, x.reason])).toEqual([['1 change applied by rules', 'Signals Lab · Release notes · today']]);
    // Dismissed again today: another change today keeps it hidden.
    expect((await http('POST', '/needs-you/dismiss', { record: rows[0].record, episode: rows[0].episode })).status).toBe(200);
    expect(sub(coordA, [{ op: 'upsert', kind: 'release', key: 'REL-1.0', fields: { notes: 'Hotfix noted twice.' } }]).status).toBe('applied');
    expect(await aw()).toHaveLength(0);
  });

  it('counts only the last 30 days', async () => {
    app.db.prepare('DELETE FROM attention_dismissals WHERE record=?').run(`rules:${P}:${teamA}`);
    const aw = async () => ((await http('GET', '/needs-you')).json.awareness.items as any[]).filter((x) => x.kind === 'rules_applied');
    expect((await aw())[0].title).toBe('4 changes applied by rules');
    app.db.prepare('UPDATE bp_events SET created_at=created_at-864e5*31 WHERE project_id=? AND rule IS NOT NULL').run(P);
    expect(await aw()).toHaveLength(0);
    expect((await http('GET', `/projects/${P}/rules/applied?team_id=${teamA}`)).json.changes).toHaveLength(4);
  });
});

describe('superseding on accept (§4)', () => {
  it('accepting a decision moves the decisions it supersedes to superseded, in the same write', () => {
    put([{ op: 'upsert', kind: 'decision', key: 'ADR-901', title: 'Old choice', status: 'accepted', team_id: teamA }]);
    put([{ op: 'upsert', kind: 'decision', key: 'ADR-902', title: 'New choice', team_id: teamA }, { op: 'link', from: 'ADR-902', to: 'ADR-901', rel: 'supersedes' }]);
    expect(item('ADR-901')!.status).toBe('accepted');
    const w = put([{ op: 'upsert', kind: 'decision', key: 'ADR-902', status: 'accepted' }]);
    expect(item('ADR-901')).toMatchObject({ status: 'superseded', fields: { superseded_by: 'ADR-902' } });
    expect(w.moves.map((m) => [m.key, m.status])).toEqual(expect.arrayContaining([['ADR-902', 'accepted'], ['ADR-901', 'superseded']]));
    expect(notes('ADR-901').at(-1)!.n).toBe('superseded by ADR-902 (accepted)');
  });

  it('applying a proposal that accepts a superseding decision supersedes the old one', () => {
    const r = sub(coordA, [{ op: 'upsert', kind: 'decision', key: 'ADR-903', title: 'Newer choice', status: 'accepted', team_id: teamA }, { op: 'link', from: 'ADR-903', to: 'ADR-902', rel: 'supersedes' }]);
    expect(r.status).toBe('proposed');
    expect(item('ADR-902')!.status).toBe('accepted');
    app.blueprint.applyProposal((r as { proposal: { id: string } }).proposal.id, opr());
    expect(item('ADR-903')!.status).toBe('accepted');
    expect(item('ADR-902')).toMatchObject({ status: 'superseded', fields: { superseded_by: 'ADR-903' } });
  });

  it('a decision that is only proposed supersedes nothing', () => {
    put([{ op: 'upsert', kind: 'decision', key: 'ADR-904', title: 'Maybe', team_id: teamA }, { op: 'link', from: 'ADR-904', to: 'ADR-903', rel: 'supersedes' }]);
    expect(item('ADR-903')!.status).toBe('accepted');
  });
});

describe('bp_write under a rule', () => {
  it('answers applied and names the rule', async () => {
    const r = await C('bp_write', { version: v(), ops: [rel('REL-5.0', { fields: { notes: 'Written by the rule.' } })] });
    expect(r.structuredContent).toMatchObject({ status: 'applied', rule: 'release_notes' });
    expect(JSON.stringify(r.content)).toContain('Applied by the Release notes rule (team setting)');
  });
});
