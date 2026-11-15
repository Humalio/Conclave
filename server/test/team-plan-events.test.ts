/** The plan's history on the team page: blueprint changes in the team's part and the operator's review requests (docs/blueprint.md §5). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', teamId = '';
type Res = { isError?: boolean; structuredContent?: any };
let C: (name: string, args?: Record<string, unknown>) => Promise<Res>, W: typeof C, coordId = '';
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie, 'x-csrf-token': csrf }) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const events = async () => (await api('GET', `/teams/${teamId}`)).body.team.plan_events as any[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahpe-'));
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
  teamId = app.teams.create({ name: 'Integration', goal: 'Bring the parts together.', members: [{ agent_id: coord.id, role: 'coordinator', credential_id: coord.cred }, { agent_id: worker.id, role: 'worker', credential_id: worker.cred }] }, sys).id;
  app.teams.start(teamId, sys);
});
afterAll(async () => { await app?.close(); });

describe('plan events', () => {
  const version = () => app.blueprint.projectOfTeam(teamId)!.version;
  it('a fresh team has none', async () => {
    expect(await events()).toEqual([]);
  });

  it('records each change to the team\'s part with what was added and changed, and who did it', async () => {
    const p = app.blueprint.projectOfTeam(teamId)!;
    app.blueprint.write(p.id, { version: p.version, ops: [{ op: 'upsert', kind: 'module', key: 'INT', title: 'Integration', team_id: teamId }, { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Field model frozen', team_id: teamId }], team_id: teamId }, { kind: 'operator', id: null });
    expect((await C('bp_write', { team_id: teamId, version: version(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-INT-01', parent_key: 'INT', title: 'Fold and return', fields: { priority: 'must' } }, { op: 'upsert', kind: 'fr', key: 'FR-INT-02', parent_key: 'INT', title: 'Field model frozen', fields: { priority: 'must' } }] })).structuredContent.status).toBe('applied');
    const ask = (await C('team_ask', { team_id: teamId, question: 'What is FR-INT-02 about?', refs: ['FR-INT-02'] })).structuredContent.decision_id;
    expect((await C('bp_write', { team_id: teamId, version: version(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-INT-02', fields: { unclear: true, unclear_ask: ask } }, { op: 'upsert', kind: 'fr', key: 'FR-INT-03', parent_key: 'INT', title: 'Quench margin', fields: { priority: 'must' } }] })).structuredContent.status).toBe('applied');
    const [u2, u1, u0] = await events();
    expect(u0).toMatchObject({ kind: 'update', added: ['INT', 'M1'] });
    expect(u1).toMatchObject({ kind: 'update', actor: { kind: 'agent', id: coordId }, added: ['FR-INT-01', 'FR-INT-02'], removed: [], changed: [] });
    expect(u2).toMatchObject({ kind: 'update', added: ['FR-INT-03'], changed: ['FR-INT-02'] });
    expect(u2.at).toBeGreaterThanOrEqual(u1.at);
    expect((await api('GET', `/teams/${teamId}`)).body.team.plan.requirements.map((r: any) => [r.key, r.status])).toEqual([['FR-INT-01', 'open'], ['FR-INT-02', 'unclear'], ['FR-INT-03', 'open']]);
  });

  it('records the operator\'s review request with its note; the coordinator\'s next change answers it', async () => {
    expect((await api('POST', `/teams/${teamId}/plan-request`, { note: 'Is FR-INT-02 still unclear after the field model v2?' }, { cookie })).status).toBe(403);
    expect((await api('POST', `/teams/${teamId}/plan-request`, { note: 'Is FR-INT-02 still unclear after the field model v2?' })).status).toBe(200);
    const [req] = await events();
    expect(req).toMatchObject({ kind: 'review_request', actor: { kind: 'operator' }, version: version(), note: 'Is FR-INT-02 still unclear after the field model v2?', added: [], removed: [], changed: [] });
    expect((await api('GET', `/teams/${teamId}`)).body.team.plan.requested_at).toBe(req.at);
    await C('bp_write', { team_id: teamId, version: version(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-INT-02', fields: { unclear: null, evidence: 'Field model v2 frozen.' } }] });
    const [answer, again] = await events();
    expect(answer).toMatchObject({ kind: 'update', changed: ['FR-INT-02'] });
    expect(again.kind).toBe('review_request');
    expect((await api('GET', `/teams/${teamId}`)).body.team.plan.requested_at).toBeNull();
  });

  it('a refused change records nothing', async () => {
    const before = (await events()).length;
    expect((await W('bp_write', { team_id: teamId, version: version(), ops: [{ op: 'upsert', kind: 'milestone', key: 'M1', status: 'reached' }] })).structuredContent.error).toBe('denied');
    expect((await C('bp_write', { team_id: teamId, version: version(), ops: [{ op: 'link', from: 'M9', to: 'FR-INT-01', rel: 'delivers' }] })).isError).toBe(true);
    expect((await events()).length).toBe(before);
  });
});
