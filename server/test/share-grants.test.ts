import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { KeyError } from '../src/keys/keys.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey: string;
const clients: Client[] = [];

async function agent(label: string) {
  const a = app.keys.createAgent(label, null, sys);
  const key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  const client = new Client({ name: label, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const login = await client.callTool({ name: 'session_login', arguments: { session_key: key.secret } });
  const token = login.structuredContent!.session_token;
  return {
    id: a.id,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { session_token: token, ...args } });
      return { error: result.isError, data: result.structuredContent as Record<string, any> };
    },
  };
}
type Agent = Awaited<ReturnType<typeof agent>>;

async function team(name: string) {
  const [coord, worker, reviewer] = await Promise.all(['coordinator', 'worker', 'reviewer'].map(agent));
  const t = app.teams.create({ name, goal: 'Reviewers reachable', grant_messaging: true, members: [
    { agent_id: coord!.id, role: 'coordinator' }, { agent_id: worker!.id, role: 'worker' }, { agent_id: reviewer!.id, role: 'reviewer' }] }, sys);
  app.teams.start(t.id, sys);
  return { t, coord: coord!, worker: worker!, reviewer: reviewer! };
}
const links = (teamId: string) => (app.db.prepare('SELECT from_agent_id f, to_agent_id t FROM agent_links WHERE removed_at IS NULL AND kind=?').all(`team:${teamId}`) as { f: string; t: string }[]).map((l) => `${l.f}>${l.t}`);
let n = 0;
const send = (from: Agent, to: Agent, body: string) => from.call('message_send', { to: to.id, body, client_msg_id: `cid_${++n}_${Math.random().toString(36).slice(2)}` });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-coord-reviewer-'));
  const vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp({ dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 'test.db'), vaultDir, vaultAlias: 'vault', host: '127.0.0.1', port: 0,
    pepper: 'test', publicUrl: 'http://fixture.test', production: false, adminUsername: 'admin', adminPassword: 'fixture password',
    publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0 });
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const pc = app.keys.createMachine('fixture', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'test', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('workers and the coordinator hand files over as a hub share', () => {
  const shots = [{ path: 'shots/board.txt', content: 'before and after' }];
  it('a worker shares evidence with its reviewer, who reads it; the share is linked to the submitted task', async () => {
    const f = await team('Share evidence');
    const made = await f.worker.call('share_create', { name: 'Review evidence', with: [f.reviewer.id] });
    expect(made.error).toBeFalsy();
    const id = made.data.share_id as string;
    const up = await f.worker.call('share_upload', { share_id: id, files: shots, final: true });
    expect(up.error).toBeFalsy();
    const read = await f.reviewer.call('share_read', { share_id: id, version: 1, path: 'shots/board.txt' });
    expect(JSON.stringify(read.data)).toContain('before and after');
    const dl = await f.reviewer.call('share_download', { share_id: id, version: 1 });
    expect(dl.error).toBeFalsy();
    const task = await f.coord.call('task_create', { team_id: f.t.id, title: 'Evidence task', claimable: true, reviewer: f.reviewer.id });
    expect(task.error).toBeFalsy();
    const claim = await f.worker.call('task_claim', { task_id: task.data.task.id, version: task.data.task.version, start: true });
    expect(claim.data.task.status).toBe('in_progress');
    const sub = await f.worker.call('task_submit', { task_id: task.data.task.id, summary: 'Done, evidence attached.', share_id: id });
    expect(sub.error).toBeFalsy();
    // The share is copied into the task's submission set: the task names the set, the reviewer reads the copy.
    const set = (app.db.prepare('SELECT share_id FROM tasks WHERE id=?').get(task.data.task.id) as { share_id: string }).share_id;
    expect(set).not.toBe(id);
    expect(app.db.prepare('SELECT task_id, task_role FROM shares WHERE id=?').get(set)).toEqual({ task_id: task.data.task.id, task_role: 'submission' });
    expect((app.db.prepare('SELECT copied_from FROM share_versions WHERE share_id=? AND version=1').get(set) as { copied_from: string }).copied_from).toBe(`share:${id}@v1`);
    expect(JSON.stringify((await f.reviewer.call('share_read', { share_id: set, version: 1, path: 'shots/board.txt' })).data)).toContain('before and after');
    expect((await f.worker.call('share_close', { share_id: id })).error).toBeFalsy();
  });

  it('the coordinator can share too, but nobody can share with an agent they may not message', async () => {
    const f = await team('Share scope');
    const stranger = await agent('stranger');
    expect((await f.coord.call('share_create', { name: 'Plan', with: [f.reviewer.id] })).error).toBeFalsy();
    const refused = await f.worker.call('share_create', { name: 'Leak', with: [stranger.id] });
    expect(refused.error).toBe(true);
    expect(JSON.stringify(refused.data)).toContain('denied');
    // The reviewer keeps read-only share rights: it cannot create a share.
    expect((await f.reviewer.call('share_create', { name: 'x', with: [f.coord.id] })).error).toBe(true);
  });

  it('a team built before the grant gets it on start, in place', async () => {
    const f = await team('Share upgrade');
    app.db.prepare("DELETE FROM permission_rules WHERE team_id=? AND (resource IN ('tool:share_create','tool:share_upload','tool:share_close','share:new','share:*'))").run(f.t.id);
    expect((await f.worker.call('share_create', { name: 'x', with: [f.reviewer.id] })).error).toBe(true);
    const teamsBefore = app.teams.teams().length;
    expect(app.teams.refreshGrants()).toBeGreaterThanOrEqual(1);
    expect(app.teams.teams().length).toBe(teamsBefore);
    expect((await f.worker.call('share_create', { name: 'x', with: [f.reviewer.id] })).error).toBeFalsy();
  });
});
