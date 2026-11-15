/**
 * Who may message whom in a team (docs/specification.md; docs/mcp.md, "Interpret results"): two workers, or two reviewers,
 * are refused with the reason and what to use instead; an agent outside the team keeps the generic refusal; the coordinator
 * and the curator may message each other; with messaging off, every message is refused as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const GENERIC = 'Not allowed, or does not exist.';
let app: App, base: string, appKey: string;
const clients: Client[] = [];

let n = 0;
async function agent(label: string) {
  const a = app.keys.createAgent(`${label} ${++n}`, null, sys);
  const key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  const client = new Client({ name: label, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = (await client.callTool({ name: 'session_login', arguments: { session_key: key.secret } })).structuredContent!.session_token;
  return {
    id: a.id,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: { session_token: token, ...args } });
      return { error: r.isError, text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join(' '), data: r.structuredContent as Record<string, any> };
    },
  };
}
type Agent = Awaited<ReturnType<typeof agent>>;
const send = (from: Agent, to: Agent, body: string) => from.call('message_send', { to: to.id, body, client_msg_id: `cid_${++n}` });

async function team(messaging = true) {
  const roles = ['coordinator', 'worker', 'worker', 'reviewer', 'reviewer', 'curator'];
  const [coord, w1, w2, r1, r2, cur] = await Promise.all(roles.map(agent));
  const t = app.teams.create({ name: `Messages ${++n}`, goal: 'Talk to the right people', grant_messaging: messaging,
    members: [coord, w1, w2, r1, r2, cur].map((a, i) => ({ agent_id: a!.id, role: roles[i]! })) }, sys);
  app.teams.start(t.id, sys);
  return { t, coord: coord!, w1: w1!, w2: w2!, r1: r1!, r2: r2!, cur: cur! };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-role-msg-'));
  const vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp(testConfig(dir, { dbFile: join(dir, 'data', 'test.db'), vaultDir, pepper: 'test', publicUrl: 'http://fixture.test', adminPassword: 'fixture password' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const pc = app.keys.createMachine('fixture', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'test', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('a refused message says why when the reason is the roles', () => {
  it('a worker messaging another worker is refused with the role text', async () => {
    const f = await team();
    const r = await send(f.w1, f.w2, 'Can you look at my branch?');
    expect(r.error).toBeTruthy();
    expect(r.text).toContain("Workers don't message one another: post in the team room or message the coordinator.");
    expect(r.text).not.toContain(GENERIC);
  });
  it('two reviewers get the same kind of text', async () => {
    const f = await team();
    const r = await send(f.r1, f.r2, 'Did you take task X?');
    expect(r.error).toBeTruthy();
    expect(r.text).toContain("Reviewers don't message one another: post in the team room or message the coordinator.");
  });
  it('an agent outside the team keeps the generic text', async () => {
    const f = await team();
    const outsider = await agent('outsider');
    for (const [from, to] of [[outsider, f.w1], [f.w1, outsider]] as const) {
      const r = await send(from, to, 'Hello.');
      expect(r.error).toBeTruthy();
      expect(r.text).not.toMatch(/message one another/);
    }
    // A worker writing to a worker of another team is an outsider there too.
    const g = await team();
    const r = await send(f.w1, g.w1, 'Hello.');
    expect(r.error).toBeTruthy();
    expect(r.text).not.toMatch(/message one another/);
  });
});

describe('the coordinator and the curator', () => {
  it('may message each other, both ways', async () => {
    const f = await team();
    const out = await send(f.coord, f.cur, 'Please file the meeting notes.');
    expect(out.error, out.text).toBeFalsy();
    expect(JSON.stringify((await f.cur.call('message_read', {})).data)).toContain('Please file the meeting notes.');
    const back = await send(f.cur, f.coord, 'Filed.');
    expect(back.error, back.text).toBeFalsy();
    expect(JSON.stringify((await f.coord.call('message_read', {})).data)).toContain('Filed.');
  });
  it('a team built before the pair gets it on start', async () => {
    const f = await team();
    app.db.prepare('UPDATE agent_links SET removed_at=? WHERE kind=? AND from_agent_id=? AND to_agent_id=?').run(Date.now(), `team:${f.t.id}`, f.coord.id, f.cur.id);
    expect(app.teams.refreshGrants()).toBeGreaterThanOrEqual(1);
    expect((await send(f.coord, f.cur, 'Back again.')).error).toBeFalsy();
  });
});

describe('messaging off', () => {
  it('every direct message is refused as before, with no role text', async () => {
    const f = await team(false);
    for (const [from, to] of [[f.w1, f.w2], [f.coord, f.cur], [f.coord, f.w1], [f.w1, f.r1]] as const) {
      const r = await send(from, to, 'Hello.');
      expect(r.error).toBeTruthy();
      expect(r.text).not.toMatch(/message one another/);
    }
  });
});
