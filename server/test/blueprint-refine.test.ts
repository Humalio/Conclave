/** Refine requirements with the coordinator (docs/blueprint.md §2.6): scope and checks, the enforced proposal, partial apply. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { plainNotice } from '../src/notices/l2.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', teamId = '';
type Res = { isError?: boolean; structuredContent?: any; content?: any };
let C: (name: string, args?: Record<string, unknown>) => Promise<Res>, W: typeof C, coordId = '';
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie, 'x-csrf-token': csrf }) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrf-'));
  mkdirSync(join(dir, 'vault'));
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const seat = async (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
    const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as Res).structuredContent.session_token;
    return { id: a.id, cred: k.credential.id, S: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res };
  };
  const coord = await seat('coord'), worker = await seat('worker');
  C = coord.S; W = worker.S; coordId = coord.id;
  teamId = app.teams.create({ name: 'Integration', goal: 'Bring the parts together.', members: [{ agent_id: coord.id, role: 'coordinator', credential_id: coord.cred }, { agent_id: worker.id, role: 'worker', credential_id: worker.cred }] } as any, sys).id;
  app.teams.start(teamId, sys);
});
afterAll(async () => { await app?.close(); });

describe('refine requirements with the coordinator', () => {
  const p = () => app.blueprint.projectOfTeam(teamId)!;
  const ver = () => p().version;
  const fr = (n: number) => ({ op: 'upsert', kind: 'fr', key: 'FR-INT-0' + n, parent_key: 'INT', title: 'Requirement ' + n, fields: { priority: 'must' } });
  const notice = (kind: string, agent: string) => (app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND kind=? ORDER BY seq DESC LIMIT 1').get(agent, kind) as { body: string } | undefined)?.body ?? '';
  const text = (r: Res) => JSON.stringify(r);
  const pid = (r: Res) => r.structuredContent.proposal_id ?? r.structuredContent.proposal?.id ?? r.structuredContent.id;
  let reqId = 0, propId = '';
  const scope5 = ['FR-INT-01', 'FR-INT-02', 'FR-INT-03', 'FR-INT-04', 'FR-INT-05'];

  it('sends the scope, checks and note to the coordinator, and shows the request as waiting', async () => {
    app.blueprint.write(p().id, { version: ver(), ops: [{ op: 'upsert', kind: 'module', key: 'INT', title: 'Integration', team_id: teamId }, fr(1), fr(2), fr(3), fr(4), fr(5), fr(6)] } as any, { kind: 'operator', id: 'admin' } as any);
    expect((await api('POST', `/teams/${teamId}/plan-request`, { note: 'x', scope: scope5 }, { cookie })).status).toBe(403);
    const r = await api('POST', `/teams/${teamId}/plan-request`, { note: 'Tighten the wording of FR-INT-01 to FR-INT-05.', scope: scope5, checks: { missing_ac: true } });
    expect(r.status).toBe(200);
    reqId = r.body.request_id;
    const n = notice('plan_request', coordId);
    expect(n).toContain('FR-INT-01, FR-INT-02, FR-INT-03, FR-INT-04, FR-INT-05');
    expect(n).toContain('Tighten the wording');
    expect(n).toContain('consistency, duplicates, missing acceptance criteria');
    expect(text(await api('GET', '/needs-you'))).toContain('Refining requirements');
  });

  it('asking again edits the open request instead of opening a second one', async () => {
    const r = await api('POST', `/teams/${teamId}/plan-request`, { note: 'Tighten FR-INT-01 to FR-INT-05, and merge duplicates.', scope: scope5, checks: { missing_ac: true } });
    expect(r.body.request_id).toBe(reqId);
    expect((app.db.prepare("SELECT COUNT(*) n FROM bp_report_requests WHERE kind='plan' AND scope_keys IS NOT NULL AND answered_at IS NULL").get() as { n: number }).n).toBe(1);
  });

  it('refuses a delete, an op outside the scope, an op without a reason and a worker', async () => {
    const w = (ops: unknown[]) => C('bp_write', { team_id: teamId, version: ver(), request_id: reqId, ops });
    const del = await w([{ op: 'remove', key: 'FR-INT-01', reason: 'gone' }]);
    expect(del.isError).toBe(true);
    expect(text(del)).toContain('never deletes');
    const out = await w([{ op: 'upsert', kind: 'fr', key: 'FR-INT-06', title: 'Changed', reason: 'tighter' }]);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('outside the requirements');
    const none = await w([{ op: 'upsert', kind: 'fr', key: 'FR-INT-01', title: 'No reason' }]);
    expect(none.isError).toBe(true);
    expect(text(none)).toContain('reason on every op');
    const wk = await W('bp_write', { team_id: teamId, version: ver(), request_id: reqId, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-INT-01', title: 'x', reason: 'x' }] });
    expect(wk.isError).toBe(true);
  });

  it('files the write as ONE proposal even though a direct write would apply; the hub works out what each op needs', async () => {
    const r = await C('bp_write', { team_id: teamId, version: ver(), request_id: reqId, ops: [
      { op: 'upsert', kind: 'fr', key: 'FR-INT-01', title: 'Requirement 1, tighter', reason: 'Clearer wording', group: 'merge' },
      { op: 'upsert', kind: 'fr', key: 'FR-INT-07', parent_key: 'INT', title: 'Merged requirement', status: 'agreed', reason: 'Adds the merged text', group: 'merge' },
      { op: 'upsert', kind: 'fr', key: 'FR-INT-02', status: 'dropped', reason: 'Merged into FR-INT-07', group: 'merge' },
      { op: 'upsert', kind: 'ac', key: 'FR-INT-07/AC1', parent_key: 'FR-INT-07', title: 'Merged text is checked', reason: 'FR-INT-07 had no criterion' },
      { op: 'upsert', kind: 'fr', key: 'FR-INT-03', title: 'Requirement 3, tighter', reason: 'Clearer wording' },
    ] });
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.structuredContent.status).toBe('proposed');
    propId = pid(r);
    const pr = app.blueprint.proposal(propId)!;
    expect(pr.request_id).toBe(reqId);
    expect(pr.needs).toEqual([[1, 2], [0, 2], [0, 1], [1], []]);
    // While it is open: a second proposal and a new ask are both refused.
    const again = await C('bp_write', { team_id: teamId, version: ver(), request_id: reqId, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-INT-04', title: 'x', reason: 'x' }] });
    expect(again.isError).toBe(true);
    expect((await api('POST', `/teams/${teamId}/plan-request`, { note: 'More', scope: ['FR-INT-01'] })).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a choice that leaves out an op it needs; applies exactly the chosen set in one batch (4 of 5)', async () => {
    const need = await api('POST', `/proposals/${propId}/apply`, { ops: [4] });
    expect(need.status).toBe(400);
    expect(JSON.stringify(need.body)).toContain('need');
    const before = ver();
    const ok = await api('POST', `/proposals/${propId}/apply`, { ops: [1, 2, 3, 4] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ver()).toBe(before + 1);
    expect(app.blueprint.proposal(propId)).toMatchObject({ status: 'applied', applied_ops: 4, declined: [{ index: 5, key: 'FR-INT-03' }] });
    expect(app.blueprint.item(p().id, 'FR-INT-03')!.title).toBe('Requirement 3');
    expect(app.blueprint.item(p().id, 'FR-INT-02')!.status).toBe('dropped');
    const told = notice('bp_proposal', coordId);
    expect(told).toContain('4 of 5 ops');
    expect(plainNotice(told)).toContain('op 5 ("FR-INT-03")');
    expect((app.db.prepare('SELECT note FROM bp_events WHERE proposal_id=?').get(propId) as { note: string }).note).toContain('4 of 5 applied');
    expect((app.db.prepare('SELECT answered_by FROM bp_report_requests WHERE id=?').get(reqId) as { answered_by: string }).answered_by).toBe('refine');
  });

  it('send back keeps the request open; the operator can ask again', async () => {
    const q = await api('POST', `/teams/${teamId}/plan-request`, { note: 'Look at FR-INT-04 again.', scope: ['FR-INT-04'] });
    const id2 = q.body.request_id;
    const r = await C('bp_write', { team_id: teamId, version: ver(), request_id: id2, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-INT-04', title: 'Requirement 4, tighter', reason: 'Clearer' }] });
    expect(r.isError, text(r)).toBeFalsy();
    expect((await api('POST', `/proposals/${pid(r)}/reject`, { note: 'Not this wording.' })).status).toBe(200);
    expect(app.db.prepare('SELECT answered_at, proposal_id FROM bp_report_requests WHERE id=?').get(id2)).toEqual({ answered_at: null, proposal_id: null });
    expect((await api('POST', `/teams/${teamId}/plan-request`, { note: 'Try again.', scope: ['FR-INT-04'] })).body.request_id).toBe(id2);
  });

  it('a withdrawn proposal frees the request, so the coordinator can file again', async () => {
    const q = await api('POST', `/teams/${teamId}/plan-request`, { note: 'Look at FR-INT-03 again.', scope: ['FR-INT-03'] });
    const id3 = q.body.request_id;
    const op = { op: 'upsert', kind: 'fr', key: 'FR-INT-03', title: 'Requirement 3, v2', reason: 'Clearer' };
    const a = await C('bp_write', { team_id: teamId, version: ver(), request_id: id3, ops: [op] });
    expect(a.isError, text(a)).toBeFalsy();
    expect((await C('bp_proposals', { withdraw: pid(a) })).isError).toBeFalsy();
    expect(app.db.prepare('SELECT answered_at, proposal_id FROM bp_report_requests WHERE id=?').get(id3)).toEqual({ answered_at: null, proposal_id: null });
    const b = await C('bp_write', { team_id: teamId, version: ver(), request_id: id3, ops: [{ ...op, title: 'Requirement 3, v3' }] });
    expect(b.isError, text(b)).toBeFalsy();
    expect((await C('bp_proposals', { withdraw: pid(b) })).isError).toBeFalsy();
    const ac = await C('bp_write', { team_id: teamId, version: ver(), request_id: id3, ops: [{ op: 'upsert', kind: 'ac', key: 'FR-INT-03', reason: 'x' }] });
    expect(ac.isError).toBe(true);
    expect(text(ac)).toContain('acceptance criterion');
  });

  it('an ordinary plan request and an ordinary coordinator write are unchanged', async () => {
    const r = await C('bp_write', { team_id: teamId, version: ver(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-INT-05', title: 'Requirement 5, direct' }] });
    expect(r.structuredContent.status).toBe('applied');
  });

  it('a re-plan proposal is never applied in part', async () => {
    app.db.prepare("INSERT INTO bp_proposals(id,project_id,team_id,agent_id,ops,base_version,reason,status,created_at,type) VALUES ('bpp_rp',?,?,?,'[]',?,'x','open',?,'replan')").run(p().id, teamId, coordId, ver(), Date.now());
    expect((await api('POST', '/proposals/bpp_rp/apply', { ops: [1] })).status).toBe(400);
  });
});
