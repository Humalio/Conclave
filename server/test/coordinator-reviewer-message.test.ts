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

describe('the coordinator and a reviewer can message each other', () => {
  it('a new team pairs its coordinator with its reviewer, and the message arrives', async () => {
    const f = await team('Pair new');
    expect(links(f.t.id)).toContain(`${f.coord.id}>${f.reviewer.id}`);
    const out = await send(f.coord, f.reviewer, 'Please review task X.');
    expect(JSON.stringify(out.data)).not.toContain('denied');
    const inbox = await f.reviewer.call('message_read', {});
    expect(JSON.stringify(inbox.data)).toContain('Please review task X.');
    const back = await send(f.reviewer, f.coord, 'Reviewed.');
    expect(back.error).toBeFalsy();
    expect(JSON.stringify((await f.coord.call('message_read', {})).data)).toContain('Reviewed.');
  });

  it('an existing team without the pair gets it on start, in place', async () => {
    const f = await team('Pair upgrade');
    // As a team built before the fix: no link between the coordinator and the reviewer.
    app.db.prepare("UPDATE agent_links SET removed_at=? WHERE kind=? AND from_agent_id=? AND to_agent_id=?").run(Date.now(), `team:${f.t.id}`, f.coord.id, f.reviewer.id);
    app.teams.rewire(f.t.id); // would restore it, so take it away again to model the old state
    app.db.prepare("UPDATE agent_links SET removed_at=? WHERE kind=? AND from_agent_id=? AND to_agent_id=?").run(Date.now(), `team:${f.t.id}`, f.coord.id, f.reviewer.id);
    expect(links(f.t.id)).not.toContain(`${f.coord.id}>${f.reviewer.id}`);
    const before = links(f.t.id).length, teamsBefore = app.teams.teams().length;
    expect(app.teams.refreshGrants()).toBeGreaterThanOrEqual(1);
    expect(links(f.t.id)).toContain(`${f.coord.id}>${f.reviewer.id}`);
    expect(links(f.t.id).length).toBe(before + 1);
    expect(app.teams.teams().length).toBe(teamsBefore);
    expect((await send(f.coord, f.reviewer, 'After the upgrade.')).error).toBeFalsy();
  });

  it('does not open a path between a worker and the coordinator that was not there, or between reviewers and strangers', async () => {
    const f = await team('Pair scope');
    const stranger = await agent('stranger');
    expect((await send(stranger, f.reviewer, 'hi')).data.error).toBe('denied');
    expect((await send(f.reviewer, stranger, 'hi')).data.error).toBe('denied');
  });
});
