/**
 * message_ack must take its own next_cursor however many rooms the agent is in (code review 10 Nov, P2
 * "Unbounded growth"): the cursor stays inline while short, becomes a login-bound snapshot id otherwise,
 * and cursors in the old inline format keep working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { encodeCursor, INLINE_CURSOR_MAX, SNAPSHOTS_KEPT } from '../src/messaging/messaging.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey = '';
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const RULES: Rules = [
  { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:message_*' },
  { effect: 'allow', actions: ['room.read_history', 'room.post'], resource: 'room:*' },
];

async function login(secret: string) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any };
  const token = (await call('session_login', { session_key: secret })).structuredContent.session_token as string;
  return (name: string, args: Record<string, unknown> = {}) => call(name, { session_token: token, ...args });
}
const mk = (label: string) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, RULES, 'test', sys);
  return { id: agent.id, cred: k.credential.id, secret: k.secret };
};
let n = 0;
const post = (room: string, from: { id: string; cred: string }) =>
  app.messaging.insert({ roomId: room, agentId: from.id, credId: from.cred, kind: 'text', body: `m${++n}`, replyTo: null, clientMsgId: `c${n}` });
const acked = (agentId: string) => app.db.prepare('SELECT room_id, MAX(acked_seq) a FROM message_delivery_cursors WHERE agent_id=? GROUP BY room_id').all(agentId) as { room_id: string; a: number }[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahcur-'));
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
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!, csrf = ((await r.json()) as { csrf: string }).csrf;
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('message cursors with many rooms', () => {
  it('message_ack accepts its own next_cursor with 150 rooms, and acknowledges every room', async () => {
    const sender = mk('sender'), reader = mk('reader');
    const rooms: string[] = [];
    for (let i = 0; i < 150; i++) {
      const r = app.messaging.createGroup(`room ${i}`, sender.id);
      app.messaging.addMember(r.id, reader.id, 'member', sender.id);
      post(r.id, sender);
      rooms.push(r.id);
    }
    // The old inline cursor for these positions would not fit message_ack's argument.
    expect(encodeCursor(Object.fromEntries(rooms.map((r) => [r, 1]))).length).toBeGreaterThan(4000);
    const R = await login(reader.secret);
    const read = (await R('message_read', { limit: 200 })).structuredContent;
    expect(read.messages.length).toBe(150);
    expect(read.next_cursor.length).toBeLessThanOrEqual(INLINE_CURSOR_MAX);
    const ack = await R('message_ack', { cursor: read.next_cursor });
    expect(ack.isError).toBeFalsy();
    expect(ack.structuredContent.acked_rooms).toBe(150);
    expect(acked(reader.id).filter((r) => rooms.includes(r.room_id)).every((r) => r.a === 1)).toBe(true);

    // Acknowledged rooms drop out, so the next cursor is short and inline again.
    post(rooms[0]!, sender);
    const again = (await R('message_read')).structuredContent;
    expect(again.messages.length).toBe(1);
    expect(again.next_cursor.startsWith('s1.')).toBe(false);
    expect((await R('message_ack', { cursor: again.next_cursor })).structuredContent.acked_rooms).toBe(1);
    expect((await R('message_ack', { cursor: (await R('message_read')).structuredContent.next_cursor })).structuredContent).toMatchObject({ acked_rooms: 0, noop: true });
  });

  it('a snapshot cursor acknowledges exactly what was delivered when it was issued, and only for its own login', async () => {
    const sender = mk('sender2'), reader = mk('reader2');
    const rooms: string[] = [];
    for (let i = 0; i < 120; i++) {
      const r = app.messaging.createGroup(`r2 ${i}`, sender.id);
      app.messaging.addMember(r.id, reader.id, 'member', sender.id);
      post(r.id, sender);
      rooms.push(r.id);
    }
    const R = await login(reader.secret), other = await login(reader.secret);
    const first = (await R('message_read', { limit: 200 })).structuredContent;
    expect(first.next_cursor).toMatch(/^s1\.\d+$/);
    // Another login of the same agent cannot use this login's snapshot.
    expect((await other('message_ack', { cursor: first.next_cursor })).structuredContent.error).toBe('invalid_argument');
    // A later read delivers more; acking the earlier cursor confirms only its own positions.
    post(rooms[5]!, sender);
    expect((await R('message_read')).structuredContent.messages.length).toBe(1);
    await R('message_ack', { cursor: first.next_cursor });
    expect(acked(reader.id).find((r) => r.room_id === rooms[5])!.a).toBe(1);
    expect(acked(reader.id).find((r) => r.room_id === rooms[6])!.a).toBe(1);
    // Malformed and unknown snapshot ids are refused.
    for (const bad of ['s1.', 's1.0', 's1.abc', 's1.99999999']) expect((await R('message_ack', { cursor: bad })).structuredContent.error).toBe('invalid_argument');
  });

  it('keeps only the newest snapshots per login', async () => {
    const sender = mk('sender3'), reader = mk('reader3');
    const rooms: string[] = [];
    for (let i = 0; i < 120; i++) {
      const r = app.messaging.createGroup(`r3 ${i}`, sender.id);
      app.messaging.addMember(r.id, reader.id, 'member', sender.id);
      rooms.push(r.id);
    }
    const R = await login(reader.secret);
    const cursors: string[] = [];
    for (let i = 0; i < SNAPSHOTS_KEPT + 2; i++) {
      post(rooms[i % rooms.length]!, sender);
      if (i === 0) for (const r of rooms) post(r, sender);
      cursors.push((await R('message_read', { limit: 200 })).structuredContent.next_cursor);
    }
    expect(cursors.every((c) => c.startsWith('s1.'))).toBe(true);
    expect((await R('message_ack', { cursor: cursors[0] })).structuredContent.error).toBe('invalid_argument');
    expect((await R('message_ack', { cursor: cursors.at(-1) })).isError).toBeFalsy();
    const kept = () => (app.db.prepare('SELECT COUNT(*) n FROM message_ack_snapshots s JOIN session_tokens t ON t.token_hash=s.token_hash WHERE t.session_credential_id=?').get(reader.cred) as { n: number }).n;
    expect(kept()).toBe(SNAPSHOTS_KEPT);
    // Retention drops a dead login together with its snapshots (the newest login stays).
    await login(reader.secret);
    app.db.prepare('UPDATE session_tokens SET expires_at=1, revoked_at=1 WHERE session_credential_id=?').run(reader.cred);
    app.maintenance.prune(Date.now());
    expect(kept()).toBe(0);
    expect((app.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE session_credential_id=?').get(reader.cred) as { n: number }).n).toBe(1);
  });

  it('still accepts a cursor in the old inline format listing every room', async () => {
    const sender = mk('sender4'), reader = mk('reader4');
    const r = app.messaging.createGroup('old', sender.id);
    app.messaging.addMember(r.id, reader.id, 'member', sender.id);
    post(r.id, sender); post(r.id, sender);
    const R = await login(reader.secret);
    expect((await R('message_read')).structuredContent.messages.length).toBe(2);
    expect((await R('message_ack', { cursor: encodeCursor({ [r.id]: 1 }) })).structuredContent.acked_rooms).toBe(1);
    expect(acked(reader.id).find((x) => x.room_id === r.id)!.a).toBe(1);
  });
});
