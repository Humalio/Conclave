import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
async function connect() {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
}
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:message_*' }, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:room_*' }, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:agent_list' }];
const send = (to: string): Rules => [{ effect: 'allow', actions: ['message.send'], resource: `agent:${to}` }];
const recv = (from: string): Rules => [{ effect: 'allow', actions: ['message.receive'], resource: `agent:${from}` }];
const mk = (label: string, rules: Rules = []) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [...TOOLS, ...rules], 'test', sys);
  return { agent, id: agent.id, secret: k.secret, cred: k.credential };
};
type P = ReturnType<typeof mk>;
/** Log in a person on a fresh MCP connection; returns call() with the token filled in. */
async function login(p: P) {
  const call = await connect();
  const token = (await call('session_login', { session_key: p.secret })).structuredContent.session_token as string;
  return (name: string, args: Record<string, unknown> = {}) => call(name, { session_token: token, ...args });
}
let n = 0;
const cid = () => `c${++n}`;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah3-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
  };
  app = await buildApp(config);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await r.json()) as { csrf: string }).csrf;
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code' }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('direct messages and permissions', () => {
  it('allowed pair can message; unauthorised pairs are denied in both directions', async () => {
    const a = mk('alice'), b = mk('bob'), c = mk('carol');
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id), ...recv(b.id)], 't', sys);
    app.keys.setRules(b.cred.policy_id, [...TOOLS, ...recv(a.id)], 't', sys); // bob may receive from alice, not send
    const A = await login(a), B = await login(b), C = await login(c);
    const ok = await A('message_send', { to: b.id, body: 'hello bob', client_msg_id: cid() });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.seq).toBe(1);
    // bob has no message.send to alice: denied. alice->carol: no rights at all.
    expect((await B('message_send', { to: a.id, body: 'x', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    expect((await A('message_send', { to: c.id, body: 'x', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    // carol -> alice: carol cannot send; and alice (receive from bob only) has no receive from carol either
    expect((await C('message_send', { to: a.id, body: 'x', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    // receiver rights are required too: give carol send only
    app.keys.setRules(c.cred.policy_id, [...TOOLS, ...send(a.id)], 't', sys);
    expect((await C('message_send', { to: a.id, body: 'x', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    // agent_list shows only mutual partners
    expect((await A('agent_list')).structuredContent.agents.map((x: any) => x.id)).toEqual([b.id]);
    expect((await C('agent_list')).structuredContent.agents).toEqual([]);
    // bob receives it as an L2 envelope
    const r = (await B('message_read')).structuredContent;
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ trust: 'L2', from: a.id, kind: 'text', content: 'hello bob', seq: 1 });
    // the leak guard still applies
    const key = (await A('session_whoami')).structuredContent.key as string;
    expect(key).toContain('ah_ses_');
  });

  it('a link with grants_messaging enables messaging both ways, and removal disables it', async () => {
    const d = mk('dora'), e = mk('eli');
    const D = await login(d), E = await login(e);
    expect((await D('message_send', { to: e.id, body: 'hi', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    const l = await api('POST', '/links', { from_agent_id: d.id, to_agent_id: e.id, kind: 'works_with', grants_messaging: true });
    expect((await D('message_send', { to: e.id, body: 'hi', client_msg_id: cid() })).isError).toBeFalsy();
    expect((await E('message_send', { to: d.id, body: 'hi back', client_msg_id: cid() })).isError).toBeFalsy();
    expect((await D('agent_list')).structuredContent.agents[0]).toMatchObject({ id: e.id, links: [{ kind: 'works_with' }] });
    // decision is tagged with source 'link'
    const { authorize } = await import('../src/policy/engine.js');
    expect(authorize(app.messaging.linkRules(d.id), [], 'message.send', `agent:${e.id}`).source).toBe('link');
    await api('PATCH', `/links/${l.body.link.id}`, { grants_messaging: false });
    expect((await D('message_send', { to: e.id, body: 'again', client_msg_id: cid() })).structuredContent.error).toBe('denied');
  });

  it('a deny rule beats a link grant', async () => {
    const x = mk('xena', [{ effect: 'deny', actions: ['message.send'], resource: 'agent:*' }]), y = mk('yuri');
    await api('POST', '/links', { from_agent_id: x.id, to_agent_id: y.id, kind: 'works_with', grants_messaging: true });
    const X = await login(x);
    expect((await X('message_send', { to: y.id, body: 'no', client_msg_id: cid() })).structuredContent.error).toBe('denied');
  });

  it('is idempotent per client_msg_id and ordered by seq', async () => {
    const a = mk('ida'), b = mk('ben');
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id)], 't', sys);
    app.keys.setRules(b.cred.policy_id, [...TOOLS, ...recv(a.id), ...send(a.id)], 't', sys);
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id), ...recv(b.id)], 't', sys);
    const A = await login(a), B = await login(b);
    const first = await A('message_send', { to: b.id, body: 'one', client_msg_id: 'same' });
    const again = await A('message_send', { to: b.id, body: 'one', client_msg_id: 'same' });
    expect(first.structuredContent.deduplicated).toBe(false);
    expect(again.structuredContent).toMatchObject({ deduplicated: true, message_id: first.structuredContent.message_id, seq: 1 });
    for (const t of ['two', 'three']) await A('message_send', { to: b.id, body: t, client_msg_id: cid(), kind: 'proposal' });
    await B('message_send', { to: a.id, body: 'reply', client_msg_id: cid(), reply_to: first.structuredContent.message_id });
    const r = (await B('message_read')).structuredContent;
    expect(r.messages.map((m: any) => [m.seq, m.content, m.kind])).toEqual([[1, 'one', 'text'], [2, 'two', 'proposal'], [3, 'three', 'proposal']]);
    // delivered once; ack accepted; history shows all four in order
    expect((await B('message_read')).structuredContent.messages).toEqual([]);
    expect((await B('message_ack', { cursor: r.next_cursor })).isError).toBeFalsy();
    expect((await B('message_ack', { cursor: 'bogus' })).structuredContent.error).toBe('invalid_argument');
    const h = (await B('message_history', { with: a.id })).structuredContent;
    expect(h.messages.map((m: any) => m.content)).toEqual(['one', 'two', 'three', 'reply']);
    expect((await B('message_history', { room_id: h.room_id, before: 3, limit: 1 })).structuredContent.messages.map((m: any) => m.content)).toEqual(['two']);
    expect((await A('message_send', { to: b.id, body: 'x', client_msg_id: cid(), reply_to: 'msg_nope' })).structuredContent.error).toBe('invalid_argument');
  });

  it('keeps a cursor per login: two logins of the same key each get every message', async () => {
    const a = mk('sender'), b = mk('reader');
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id), ...recv(b.id)], 't', sys);
    app.keys.setRules(b.cred.policy_id, [...TOOLS, ...recv(a.id), ...send(a.id)], 't', sys);
    const A = await login(a), B1 = await login(b), B2 = await login(b);
    for (const t of ['m1', 'm2']) await A('message_send', { to: b.id, body: t, client_msg_id: cid() });
    expect((await B1('message_read')).structuredContent.messages.map((m: any) => m.content)).toEqual(['m1', 'm2']);
    expect((await B2('message_read', { limit: 1 })).structuredContent).toMatchObject({ more: true });
    expect((await B2('message_read')).structuredContent.messages.map((m: any) => m.content)).toEqual(['m2']);
    expect((await B1('message_read')).structuredContent.messages).toEqual([]);
  });

  it('bounded wait returns quickly on a new message and times out cleanly', async () => {
    const a = mk('w-a'), b = mk('w-b');
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id), ...recv(b.id)], 't', sys);
    app.keys.setRules(b.cred.policy_id, [...TOOLS, ...recv(a.id), ...send(a.id)], 't', sys);
    const A = await login(a), B = await login(b);
    const t0 = Date.now();
    const pending = B('message_read', { wait_seconds: 30 });
    await new Promise((r) => setTimeout(r, 200));
    await A('message_send', { to: b.id, body: 'wake', client_msg_id: cid() });
    const r = await pending;
    expect(r.structuredContent.messages.map((m: any) => m.content)).toEqual(['wake']);
    expect(Date.now() - t0).toBeLessThan(1000);
    const t1 = Date.now();
    const empty = await B('message_read', { wait_seconds: 1 });
    expect(empty.isError).toBeFalsy();
    expect(empty.structuredContent.messages).toEqual([]);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(900);
    expect((await B('message_read', { wait_seconds: 46 })).isError).toBe(true); // bound enforced by the schema
  });

  it('rejects oversize bodies with too_large and exposes the 64 KB limit exactly', async () => {
    const a = mk('big-a'), b = mk('big-b');
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id)], 't', sys);
    app.keys.setRules(b.cred.policy_id, [...TOOLS, ...recv(a.id)], 't', sys);
    const A = await login(a);
    expect((await A('message_send', { to: b.id, body: 'x'.repeat(65537), client_msg_id: cid() })).structuredContent.error).toBe('too_large');
    expect((await A('message_send', { to: b.id, body: 'x'.repeat(65536), client_msg_id: cid() })).isError).toBeFalsy();
  });

  it('rate limits messages per key', async () => {
    const a = mk('rl-a'), b = mk('rl-b');
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id)], 't', sys);
    app.keys.setRules(b.cred.policy_id, [...TOOLS, ...recv(a.id)], 't', sys);
    const A = await login(a);
    for (let i = 0; i < 120; i++) {
      const r = await A('message_send', { to: b.id, body: `m${i}`, client_msg_id: `rl${i}` });
      if (r.isError) throw new Error(`message ${i} failed: ${r.content[0]!.text}`);
    }
    const over = await A('message_send', { to: b.id, body: 'one too many', client_msg_id: 'rl-over' });
    expect(over.structuredContent.error).toBe('rate_limited');
    expect(over.structuredContent.retry_after_s).toBeGreaterThan(0);
    // a retry of an already-sent message is still answered (dedupe does not consume allowance)
    expect((await A('message_send', { to: b.id, body: 'm0', client_msg_id: 'rl0' })).structuredContent.deduplicated).toBe(true);
  }, 60_000);
});

describe('rooms', () => {
  const room = (id = '*'): Rules => [{ effect: 'allow', actions: ['room.post', 'room.read_history'], resource: `room:${id}` }];
  it('create, join, post, history, invite and leave follow the grants', async () => {
    const h = mk('host', [{ effect: 'allow', actions: ['room.create', 'room.invite', 'room.join'], resource: 'room:*' }, ...room()]);
    const k = mk('member', room());
    const i = mk('joiner', [{ effect: 'allow', actions: ['room.join'], resource: 'room:*' }]);
    const j = mk('outsider');
    const H = await login(h), K = await login(k), I = await login(i), J = await login(j);
    expect((await K('room_create', { name: 'nope' })).structuredContent.error).toBe('denied');
    const created = (await H('room_create', { name: 'design', members: [k.id] })).structuredContent;
    const rid = created.room_id as string;
    expect(created.members.sort()).toEqual([h.id, k.id].sort());
    expect((await H('message_send', { room_id: rid, body: 'welcome', client_msg_id: cid() })).isError).toBeFalsy();
    // member with rights reads it
    expect((await K('message_read')).structuredContent.messages[0]).toMatchObject({ content: 'welcome', room_id: rid, from: h.id, trust: 'L2' });
    expect((await K('message_send', { room_id: rid, body: 'thanks', client_msg_id: cid() })).isError).toBeFalsy();
    // joiner: may join but has no post/read rights
    expect((await I('room_list')).structuredContent.rooms.find((r: any) => r.room_id === rid)).toMatchObject({ joined: false, can_join: true });
    expect((await J('room_list')).structuredContent.rooms).toEqual([]);
    expect((await J('room_join', { room_id: rid })).structuredContent.error).toBe('denied');
    expect((await I('room_join', { room_id: rid })).isError).toBeFalsy();
    expect((await I('message_send', { room_id: rid, body: 'hi', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    expect((await I('message_history', { room_id: rid })).structuredContent.error).toBe('denied');
    // invite never grants rights; only those holding room.invite may invite
    expect((await K('room_invite', { room_id: rid, agent_id: j.id })).structuredContent.error).toBe('denied');
    expect((await H('room_invite', { room_id: rid, agent_id: j.id })).structuredContent.added).toBe(true);
    expect((await J('message_send', { room_id: rid, body: 'hi', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    expect((await J('message_history', { room_id: rid })).structuredContent.error).toBe('denied');
    // history for a member with rights
    expect((await K('message_history', { room_id: rid })).structuredContent.messages.map((m: any) => m.content)).toEqual(['welcome', 'thanks']);
    // leaving removes access
    expect((await K('room_leave', { room_id: rid })).isError).toBeFalsy();
    expect((await K('message_history', { room_id: rid })).structuredContent.error).toBe('denied');
    // a deny on one room does not affect another
    expect((await H('message_send', { room_id: 'room_missing', body: 'x', client_msg_id: cid() })).structuredContent.error).toBe('denied');
  });
});

describe('admin conversation monitor', () => {
  it('lists conversations, pages messages, searches, exports, and feeds topology and metrics', async () => {
    const a = mk('mon-a'), b = mk('mon-b');
    app.keys.setRules(a.cred.policy_id, [...TOOLS, ...send(b.id)], 't', sys);
    app.keys.setRules(b.cred.policy_id, [...TOOLS, ...recv(a.id)], 't', sys);
    const A = await login(a);
    for (let i = 1; i <= 5; i++) await A('message_send', { to: b.id, body: `needle-${i} 100%_sure`, client_msg_id: cid() });

    const list = await api('GET', '/conversations');
    expect(list.status).toBe(200);
    const conv = list.body.conversations.find((c: any) => c.participants?.includes(a.id));
    expect(conv).toMatchObject({ kind: 'direct', message_count: 5, last_message: { seq: 5, from: a.id } });
    expect(conv.members.map((m: any) => m.agent_id).sort()).toEqual([a.id, b.id].sort());

    const page1 = await api('GET', `/conversations/${conv.id}/messages?limit=2`);
    expect(page1.body.messages.map((m: any) => m.seq)).toEqual([4, 5]);
    expect(page1.body.more).toBe(true);
    expect(page1.body.messages[1].content).toContain('needle-5');
    const page2 = await api('GET', `/conversations/${conv.id}/messages?limit=10&before=${page1.body.next_before}`);
    expect(page2.body.messages.map((m: any) => m.seq)).toEqual([1, 2, 3]);
    expect(page2.body.more).toBe(false);
    expect((await api('GET', '/conversations/room_nope/messages')).status).toBe(404);

    const s = await api('GET', '/messages/search?q=needle-3');
    expect(s.body.messages).toHaveLength(1);
    expect((await api('GET', '/messages/search?q=100%25_sure')).body.messages.length).toBeGreaterThanOrEqual(5);
    expect((await api('GET', '/messages/search?q=%25')).body.messages.length).toBeGreaterThanOrEqual(5); // % is literal, not a wildcard
    expect((await api('GET', '/messages/search')).status).toBe(400);

    const ex = await fetch(`${base}/api/conversations/${conv.id}/export`, { headers: { cookie, 'x-csrf-token': csrf } });
    expect(ex.headers.get('content-disposition')).toContain(conv.id);
    const exb = (await ex.json()) as any;
    expect(exb.messages).toHaveLength(5);

    const topo = (await api('GET', '/topology')).body;
    expect(topo.message_edges).toContainEqual({ from: a.id, to: b.id, room_id: conv.id, room_kind: 'direct', count: 5 });
    const comm = topo.comm_edges.find((e: { from: string; room_id: string }) => e.from === a.id && e.room_id === conv.id);
    expect(comm).toMatchObject({ to: b.id, room_kind: 'direct', count: 5 });
    expect(Date.now() - comm.last_at).toBeLessThan(60_000);
    const m = (await api('GET', '/metrics')).body;
    expect(m.series.messages).toHaveLength(24);
    expect(m.counts.messages_24h).toBeGreaterThanOrEqual(5);
    expect((await fetch(`${base}/api/conversations`)).status).toBe(401);
  });
});
