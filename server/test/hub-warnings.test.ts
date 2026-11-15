/**
 * Hub warnings (docs/onboarding.md "Alerts", docs/checkout.md "What it waits for" and "Refused starts", docs/dashboard-ux.md
 * "Agent status"): the unknown-key alert fires on a key the hub never issued that keeps being retried (the robot_stack
 * pattern) and not on one typo; a checkout says what it waits for; refused team changes and checkout starts are audited;
 * Connected and Last active come from the agent's own calls, never the helper's sign-in check.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { clientHint } from '../src/mcp/tools.js';
import { testConfig, adminLogin } from './hub.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', pcA = '', appA = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const client = async (headers: Record<string, string> = {}) => {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appA}`, ...headers } } }));
  return c;
};
const helperHeaders = { 'X-Agent-Hub-Folder': encodeURIComponent('C:\\agents\\robot_stack\\coordinator'), 'X-Agent-Hub-Session-Var': 'ROBOT_STACK_COORDINATOR_SESSION_KEY' };
const login = async (secret: string, headers: Record<string, string> = helperHeaders) =>
  (await (await client(headers)).callTool({ name: 'session_login', arguments: { session_key: secret } })) as { isError?: boolean; structuredContent?: any };
const unknownAlerts = () => app.db.prepare("SELECT subject, details FROM security_alerts WHERE type='unknown_session_key'").all() as { subject: string; details: string }[];
/** A new app key on the PC: the hub limits failed logins per app key (10 in 10 minutes), and these tests fail on purpose. */
const freshApp = () => { appA = app.keys.createAppKey({ machineId: pcA, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret; };
const agentWithKey = (label: string) => {
  const a = app.keys.createAgent(label, null, sys);
  return { agent: a, key: app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys) };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahwarn-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir, { maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pcA = (await api('POST', '/pcs', { name: 'xlin2' })).body.pc.id;
  appA = app.keys.createAppKey({ machineId: pcA, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('unknown session key alert', () => {
  beforeEach(freshApp);
  it('one mistyped key raises nothing', async () => {
    expect((await login('ah_ses_typotypotypo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).isError).toBe(true);
    expect(unknownAlerts()).toHaveLength(0);
  });

  it('the robot_stack pattern (one unknown key id retried from one PC) raises one alert naming the PC, its team and the folder', async () => {
    // A team whose keys are bound to the PC, as after onboarding.
    const lead = agentWithKey('robot lead');
    app.keys.setBinding(lead.key.credential.id, pcA, sys);
    const t = app.teams.create({ name: 'robot_stack', goal: 'Stack robots.', members: [{ agent_id: lead.agent.id, role: 'coordinator' }] }, sys);
    const stale = 'ah_ses_zwonwcoalsz7_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect((await login(stale)).isError).toBe(true);
    expect((await login(stale)).isError).toBe(true);
    expect(unknownAlerts()).toHaveLength(0); // two is still a retry, not a pattern
    for (let i = 0; i < 5; i++) expect((await login(stale)).isError).toBe(true);
    const a = unknownAlerts();
    expect(a).toHaveLength(1); // seven refusals, one alert (repeats bump it)
    expect(a[0]!.subject).toBe(`${pcA}/zwonwcoalsz7`);
    const d = JSON.parse(a[0]!.details);
    expect(d).toMatchObject({ presented_id: 'zwonwcoalsz7', count: 3, window_minutes: 10, pc: { id: pcA, name: 'xlin2' }, teams: [{ id: t.id, name: 'robot_stack' }],
      folder: 'C:\\agents\\robot_stack\\coordinator', session_var: 'ROBOT_STACK_COORDINATOR_SESSION_KEY' });
    expect(d.repeats).toBe(5);
    expect(a[0]!.details).not.toContain('bbbbbbbb'); // never the key
  });

  it('refusals outside the window do not add up', async () => {
    const id = 'ah_ses_oldoldoldold_cccccccccccccccccccccccccccccccc';
    for (let i = 0; i < 2; i++) await login(id);
    app.db.prepare("UPDATE authentication_events SET created_at=created_at-11*60000 WHERE key_id_presented='oldoldoldold'").run();
    await login(id);
    expect(unknownAlerts().filter((x) => x.subject.endsWith('/oldoldoldold'))).toHaveLength(0);
  });

  it('a known key id retried with a wrong secret raises the same alert', async () => {
    const k = agentWithKey('known');
    const wrong = k.key.secret.slice(0, -4) + 'zzzz';
    for (let i = 0; i < 4; i++) await login(wrong);
    expect(unknownAlerts().filter((x) => x.subject.endsWith('/' + k.key.credential.key_id))).toHaveLength(1);
  });

  it('the helper headers are trimmed to plain text, and a bad variable name is dropped', () => {
    expect(clientHint(encodeURIComponent('/home/a/b\u0007c'), 'NOT A VAR')).toEqual({ folder: '/home/a/bc', sessionVar: null });
    expect(clientHint(undefined, undefined)).toBeNull();
    expect(clientHint('%E0%A4%A', 'X_KEY')).toEqual({ folder: '%E0%A4%A', sessionVar: 'X_KEY' });
  });
});

describe('refused changes leave an audit record', () => {
  const refused = (action: string, target: string) => app.db.prepare('SELECT actor_kind, actor_id, details FROM audit_events WHERE action=? AND target_id=? ORDER BY created_at DESC').get(action, target) as { actor_kind: string; actor_id: string; details: string } | undefined;

  it('a refused team update records who, what and why; an accepted one records none', async () => {
    const m = agentWithKey('mode lead');
    const t = app.teams.create({ name: 'Refusal team', goal: 'Refuse.', members: [{ agent_id: m.agent.id, role: 'coordinator' }] }, sys);
    const r = await api('PATCH', `/teams/${t.id}`, { recruit_roles: ['coordinator'] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const ev = refused('team.update_refused', t.id);
    expect(ev).toBeTruthy();
    expect(ev!.actor_kind).toBe('admin');
    expect(JSON.parse(ev!.details)).toMatchObject({ status: r.status, error: r.body.error, fields: ['recruit_roles'] });
    expect((await api('PATCH', `/teams/${t.id}`, { delivery_mode: 'poll' })).status).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='team.update_refused' AND target_id=?").get(t.id)).toEqual({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='team.update' AND target_id=?").get(t.id)).toEqual({ n: 1 });
  });

  it('a refused checkout start is recorded with the reason', async () => {
    const m = agentWithKey('draft lead');
    const t = app.teams.create({ name: 'Draft team', goal: 'Not started.', members: [{ agent_id: m.agent.id, role: 'coordinator' }] }, sys);
    const r = await api('POST', `/teams/${t.id}/checkout`, {});
    expect(r.status).toBe(409);
    const ev = refused('checkout.start_refused', t.id);
    expect(JSON.parse(ev!.details)).toMatchObject({ status: 409, error: 'invalid_state' });
    expect(JSON.parse(ev!.details).message).toMatch(/cannot be checked out/);
  });

  it('a caller without a console session leaves no record', async () => {
    const r = await fetch(`${base}/api/teams/nope/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(refused('checkout.start_refused', 'nope')).toBeUndefined();
  });
});

describe('checkout card: what it waits for', () => {
  it('names the agents that have not written their handout, then the operator', async () => {
    const lead = agentWithKey('mover lead'), w = agentWithKey('mover worker');
    const t = app.teams.create({ name: 'Mover team', goal: 'Move.', members: [{ agent_id: lead.agent.id, role: 'coordinator' }, { agent_id: w.agent.id, role: 'worker' }] }, sys);
    app.teams.start(t.id, sys);
    const s = await api('POST', `/teams/${t.id}/checkout`, {});
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const g = await api('GET', `/teams/${t.id}/checkout`);
    expect(g.body.checkout.waiting_for).toEqual({ on: 'agents', text: '2 of 2 agents have not written their handout yet.', agents: expect.arrayContaining([lead.agent.id, w.agent.id]) });
    // Every handout in (the hub builds the missing ones on Go on): the operator creates the prompt next.
    app.checkouts.proceed(s.body.checkout.id, sys);
    const r = await api('GET', `/teams/${t.id}/checkout`);
    expect(r.body.checkout.waiting_for).toMatchObject({ on: 'operator', text: 'Every handout is in. Create the restore prompt.' });
    app.checkouts.cancel(s.body.checkout.id, null, sys);
    expect(app.checkouts.view(s.body.checkout.id).waiting_for).toBeNull();
  });
});

describe('agent status from the hub records', () => {
  beforeEach(freshApp);
  it('the helper sign-in check does not make an agent Connected; its first real call does', async () => {
    const k = agentWithKey('status agent');
    const r = await login(k.key.secret);
    expect(r.isError).toBeFalsy();
    const tok = r.structuredContent.session_token as string;
    const c = await client({ 'X-Agent-Hub-Session': tok });
    await c.callTool({ name: 'session_whoami', arguments: {} }); // what the helper does with a cached token
    let v = (await api('GET', `/sessions/${k.agent.id}`)).body;
    expect(v.agent).toMatchObject({ connected_at: null, last_active_at: null });
    expect((await api('GET', '/pcs')).body.pcs.find((p: { id: string }) => p.id === pcA).agents.some((a: { id: string }) => a.id === k.agent.id)).toBe(false);
    await c.callTool({ name: 'session_describe', arguments: { status_text: 'working' } });
    v = (await api('GET', `/sessions/${k.agent.id}`)).body;
    expect(v.agent.connected_at).toBeGreaterThan(0);
    expect(v.agent.last_active_at).toBeGreaterThanOrEqual(v.agent.connected_at);
    const first = v.agent.connected_at;
    await new Promise((res) => setTimeout(res, 5));
    await c.callTool({ name: 'task_list', arguments: {} });
    v = (await api('GET', `/sessions/${k.agent.id}`)).body;
    expect(v.agent.connected_at).toBe(first);
    expect(v.agent.last_active_at).toBeGreaterThan(first);
    const pcRow = (await api('GET', '/pcs')).body.pcs.find((p: { id: string }) => p.id === pcA).agents.find((a: { id: string }) => a.id === k.agent.id);
    expect(pcRow).toMatchObject({ connected_at: first, last_active_at: v.agent.last_active_at });
  });
});
