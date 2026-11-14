/**
 * Codex preparation (docs/checkout.md §6 step 7, §9 F4): deploy/client/codex-bridge.mjs against a real hub on
 * 127.0.0.1, driven by codex.mjs's doctor handshake the way Codex would drive it over stdio. No Codex CLI is involved.
 * Also checks that the client's permission mapping matches the hub's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { PERMISSIONS, codexPermission } from '../src/checkout/fields.js';
import { testConfig, adminLogin } from './hub.js';

const CLIENT = resolve('../deploy/client');
const sys = { kind: 'system' as const, id: null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let codex: any;
let app: App, dir = '', mcp = '', home = '', agentDir = '', keysFile = '', agentId = '', appKeySecret = '';
const VAR = 'CODEX_DEV_SESSION_KEY';

beforeAll(async () => {
  codex = await import(pathToFileURL(join(CLIENT, 'codex.mjs')).href);
  dir = mkdtempSync(join(tmpdir(), 'ahcdx-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  mcp = `${base}/mcp`;
  const { cookie, csrf } = await adminLogin(base);
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as { pc: { id: string } }).pc.id;
  const appKey = app.keys.createAppKey({ machineId: pc, appName: 'codex', maxLiveSessions: 20 }, sys).secret;
  appKeySecret = appKey;
  const a = app.keys.createAgent('codex-dev', null, sys);
  agentId = a.id;
  const k = app.keys.createSessionKey({ agentId: a.id, label: 'codex-dev' }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  home = join(dir, 'home');
  const conf = join(home, '.config', 'conclave');
  mkdirSync(conf, { recursive: true });
  keysFile = join(conf, 'keys.env');
  writeFileSync(keysFile, `AGENT_HUB_APP_KEY=${appKey}\n${VAR}=${k.secret}\nAGENT_HUB_URL=${mcp}\n`, { mode: 0o600 });
  agentDir = join(dir, 'agents', 'dev');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, '.agent-hub.json'), JSON.stringify({ session_var: VAR }));
});
const clients: Client[] = [];
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app?.close(); });

/** Run these JSON-RPC messages through one bridge process; the replies by id. */
async function bridge(messages: unknown[]): Promise<Map<number, any>> {
  const c = spawn(process.execPath, [join(CLIENT, 'codex-bridge.mjs'), agentDir, '--keys-file', keysFile], { env: env() });
  let out = '';
  c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // One message at a time, each after the previous reply, the way a model retries after seeing the first answer.
  const replied = (id: number) => new Promise<void>((r) => { const t = setInterval(() => { if (lines().some((m) => m.id === id)) { clearInterval(t); r(); } }, 20); });
  for (const m of messages) { c.stdin.write(JSON.stringify(m) + '\n'); const id = (m as { id?: number }).id; if (id !== undefined) await replied(id); }
  c.stdin.end();
  await new Promise((r) => c.on('exit', r));
  return new Map(lines().filter((m) => m.id != null).map((m) => [m.id, m]));
}

const env = () => ({ ...process.env, HOME: home, USERPROFILE: home });

describe('codex-bridge.mjs against the hub', () => {
  it('initialize, tools/list and session_whoami work through the stdio bridge (project variant)', async () => {
    const r = await codex.handshake({ folder: agentDir, keysFile, env: env() });
    expect(r.ok, r.error).toBe(true);
    expect(r.tools).toBeGreaterThan(20);
    expect(r.agent).toBe(agentId);
  });
  it('the global variant reads .agent-hub.json from the working folder', async () => {
    const r = await codex.handshake({ folder: agentDir, keysFile, env: env(), global: true });
    expect(r.ok, r.error).toBe(true);
    expect(r.agent).toBe(agentId);
  });
  it('a tool call needs no session_token: the bridge logged in outside the model', async () => {
    const c = spawn(process.execPath, [join(CLIENT, 'codex-bridge.mjs'), agentDir, '--keys-file', keysFile], { env: env() });
    let out = '';
    c.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    const send = (m: unknown) => c.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_list', arguments: {} } });
    c.stdin.end();
    await new Promise((r) => c.on('exit', r));
    const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const call = msgs.find((m) => m.id === 2);
    expect(call.result.isError ?? false, JSON.stringify(call)).toBe(false);
    expect(out).not.toMatch(/ah_(app|ses)_/);
  });
  it('refuses without .agent-hub.json or without a valid keys file', async () => {
    const empty = join(dir, 'agents', 'none');
    mkdirSync(empty, { recursive: true });
    const r1 = await codex.handshake({ folder: empty, keysFile, env: env() });
    expect(r1).toMatchObject({ ok: false });
    expect(r1.error).toMatch(/refusing to start: cannot read \.agent-hub\.json/);
    const bad = join(dir, 'bad.env');
    writeFileSync(bad, `AGENT_HUB_URL=${mcp}\n`, { mode: 0o600 });
    const r2 = await codex.handshake({ folder: agentDir, keysFile: bad, env: env() });
    expect(r2.error).toMatch(/lacks the app key/);
    const r3 = await codex.handshake({ folder: agentDir, keysFile: join(dir, 'missing.env'), env: env() });
    expect(r3.error).toMatch(/keys file not found/);
  });
});

describe('codex-bridge.mjs and lost replies', () => {
  it('task_submit (like task_review) gets a request id from its arguments, so the same call repeated returns the first result', async () => {
    const coordAgent = app.keys.createAgent('codex-coord', null, sys), revAgent = app.keys.createAgent('codex-rev', null, sys);
    const ck = app.keys.createSessionKey({ agentId: coordAgent.id, label: 'codex-coord' }, sys);
    app.keys.createSessionKey({ agentId: revAgent.id, label: 'codex-rev' }, sys);
    const team = app.teams.create({ name: 'Codex lost replies', goal: 'Submit once', members: [
      { agent_id: coordAgent.id, role: 'coordinator' }, { agent_id: agentId, role: 'worker' }, { agent_id: revAgent.id, role: 'reviewer' }] }, sys);
    app.teams.start(team.id, sys);
    app.db.prepare("UPDATE projects SET task_intake='open'").run();
    const client = new Client({ name: 'coord', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp), { requestInit: { headers: { Authorization: `Bearer ${appKeySecret}` } } }));
    const token = (await client.callTool({ name: 'session_login', arguments: { session_key: ck.secret } })).structuredContent!.session_token;
    const coord = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: { session_token: token, ...args } })).structuredContent as any;
    const task = (await coord('task_create', { team_id: team.id, title: 'Submit once', reviewer: revAgent.id })).task;
    expect((await coord('task_assign', { task_id: task.id, agent_id: agentId })).task.status).toBe('assigned');
    const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const submit = { task_id: task.id, summary: 'Done through the bridge' };
    const r = await bridge([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      call(2, 'task_start', { task_id: task.id }),
      call(3, 'task_submit', submit),
      // The same call again, its keys in another order: Codex retrying after a lost reply.
      call(4, 'task_submit', { summary: submit.summary, task_id: task.id }),
    ]);
    expect(r.get(3)?.result?.isError ?? false, JSON.stringify(r.get(3))).toBe(false);
    expect(r.get(3).result.structuredContent.replayed).toBeUndefined();
    expect(r.get(4).result.structuredContent.replayed).toBe(true);
    expect((app.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND tool='task_submit'").get(task.id) as { n: number }).n).toBe(1);
    const kept = app.db.prepare('SELECT request_id FROM task_requests WHERE task_id=?').all(task.id) as { request_id: string }[];
    expect(kept).toHaveLength(1);
    expect(kept[0]!.request_id).toMatch(/^cb-[0-9a-f]{32}$/);
  });
});

describe('permission mapping', () => {
  it('the client copy in codex.mjs matches fields.ts for every level', () => {
    for (const p of PERMISSIONS) expect(codex.codexPermission(p)).toEqual(codexPermission(p));
  });
});
