/**
 * Two items of the 10 Nov code review's "Unverified" list:
 * 1. A download in progress stops when the reader's grant is revoked or its key suspended, and ends with a clear status.
 * 2. A fellow member's direct message to a member of a polling team in draft or paused is held as that team's work item
 *    until it runs (read-only in message_read meanwhile; nothing is lost if it never starts). An outsider's direct message
 *    is never held: message_read delivers it (decision dec_j4guppnimlpv3mo5).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { BRIDGE_CHUNK } from '../src/channels/channels.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '', vaultDir = '', pc = '';
type Res = { isError?: boolean; structuredContent?: any };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const CHAN: Rules = [{ effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }];
const FS_DOCS: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.download'], resource: 'path:/vault/Docs/**' }];
const MSG: Rules = [{ effect: 'allow', actions: ['message.send', 'message.receive'], resource: 'agent:*' }];

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
async function loginWith(secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
const mk = async (label: string, rules: Rules) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, rules, 'test', sys);
  return { id: agent.id, cred: k.credential, policy: k.credential.policy_id, call: await loginWith(k.secret) };
};
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const bigText = (n: number) => Buffer.from('0123456789abcdef\n'.repeat(Math.ceil(n / 17)).slice(0, n));
let cid = 0;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrv-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'Docs'), { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false,
  };
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await r.json()) as { csrf: string }).csrf;
  pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('1. downloads after a permission revoke', () => {
  it('an inline download stops at the next channel_receive once the reader loses fs.read', async () => {
    writeFileSync(join(vaultDir, 'Docs', 'inline.txt'), bigText(200_000));
    const D = await mk('dl-inline', [...TOOLS, ...CHAN, ...FS_DOCS]);
    const ch = (await D.call('file_download', { path: '/vault/Docs/inline.txt' })).structuredContent.channel_id as string;
    const first = (await D.call('channel_receive', { channel_id: ch })).structuredContent;
    expect(first).toMatchObject({ status: 'open', final: false });
    expect(first.chunks.length).toBeGreaterThan(0);
    app.keys.setRules(D.policy, [...TOOLS, ...CHAN], 'revoked', sys);
    const next = (await D.call('channel_receive', { channel_id: ch })).structuredContent;
    expect(next).toMatchObject({ status: 'failed', failure_reason: 'denied', chunks: [] });
    expect(app.channels.get(ch)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('an inline download of a suspended key ends as failed (denied) instead of waiting to expire', async () => {
    writeFileSync(join(vaultDir, 'Docs', 'suspend.txt'), bigText(200_000));
    const D = await mk('dl-suspend', [...TOOLS, ...CHAN, ...FS_DOCS]);
    const ch = (await D.call('file_download', { path: '/vault/Docs/suspend.txt' })).structuredContent.channel_id as string;
    expect((await D.call('channel_receive', { channel_id: ch })).structuredContent.status).toBe('open');
    app.keys.setStatus(D.cred.id, 'suspended', 'test', sys);
    expect((await D.call('channel_receive', { channel_id: ch })).isError).toBe(true);
    app.channels.sweep();
    expect(app.channels.get(ch)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  const bridgeDownload = async (label: string, file: string) => {
    const bytes = bigText(BRIDGE_CHUNK + 300_000);
    writeFileSync(join(vaultDir, 'Docs', file), bytes);
    const D = await mk(label, [...TOOLS, ...CHAN, ...FS_DOCS]);
    const c = app.channels.open({ from: { agentId: D.id, credId: D.cred.id, machineId: pc }, targetKind: 'vault', target: `/vault/Docs/${file}`, direction: 'download', mode: 'bridge', toLocalPath: `C:/dl/${file}`, framing: 'raw', size: bytes.length, sha256: sha(bytes), purpose: 'test' });
    const first = await app.channels.get_chunk(pc, c.id, 0);
    expect(first.status).toBe(200);
    expect(first.data!.length).toBe(BRIDGE_CHUNK);
    return { D, id: c.id };
  };

  it('a bridge download of a vault file serves no further chunk once the grant is revoked', async () => {
    const { D, id } = await bridgeDownload('dl-bridge', 'bridge.txt');
    app.keys.setRules(D.policy, [...TOOLS, ...CHAN, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Docs/**' }], 'no download', sys);
    const next = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
    expect(next.status).toBe(410);
    expect(next.data).toBeUndefined();
    expect(app.channels.get(id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    expect(app.channels.state(pc, id).body).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('a bridge download serves no further chunk once the key is suspended', async () => {
    const { D, id } = await bridgeDownload('dl-bridge-susp', 'bridge2.txt');
    app.keys.setStatus(D.cred.id, 'suspended', 'test', sys);
    const next = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
    expect(next.status).toBe(410);
    expect(next.data).toBeUndefined();
    expect(app.channels.get(id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('a bridge download with access intact still completes', async () => {
    const { id } = await bridgeDownload('dl-bridge-ok', 'bridge3.txt');
    const second = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
    expect(second.status).toBe(200);
    expect(second.data!.length).toBe(300_000);
  });
});

describe('2. direct messages to a member of a draft or paused polling team', () => {
  /** Next work item that is not a notice (notices are acked on the way), or the status when there is none. */
  async function next(W: Call): Promise<any> {
    for (let i = 0; i < 30; i++) {
      const r = (await W('work_next')).structuredContent;
      if (r.status === 'item' && r.item.kind === 'notice') { await W('work_ack', { item_id: r.item.item_id }); continue; }
      return r;
    }
    throw new Error('too many notices');
  }
  const send = (S: Call, to: string, body: string) => S('message_send', { to, body, client_msg_id: `c${++cid}` });
  const queued = (agentId: string) => app.db.prepare("SELECT team_id FROM work_items WHERE agent_id=? AND kind='message' AND acked_at IS NULL").all(agentId) as { team_id: string | null }[];
  async function pollTeam(label: string) {
    const c = await mk(`${label}-coord`, [...TOOLS, ...MSG]), w = await mk(`${label}-worker`, [...TOOLS, ...MSG]), o = await mk(`${label}-outsider`, [...TOOLS, ...MSG]);
    const res = await api('POST', '/teams', { name: label, goal: 'g', grant_messaging: true, members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: w.id, role: 'worker' }] });
    expect(res.body.team).toMatchObject({ status: 'draft', delivery_mode: 'poll' });
    return { c, w, o, tid: res.body.team.id as string };
  }
  /** message_read delivers it (consumed, not read-only), it acknowledges, and a second read is empty. */
  async function readsOutsider(w: Awaited<ReturnType<typeof mk>>, body: string) {
    const r = (await w.call('message_read')).structuredContent;
    expect(r.read_only).toBeUndefined();
    expect(r.messages.map((m: any) => m.content)).toEqual([body]);
    expect((await w.call('message_ack', { cursor: r.next_cursor })).structuredContent.acked_rooms).toBe(1);
    expect((await w.call('message_read')).structuredContent.messages).toEqual([]);
  }

  it('a team member\'s DM is held until the team runs, read-only in message_read meanwhile, and held again while paused', async () => {
    const { c, w, tid } = await pollTeam('held');
    await send(c.call, w.id, 'from the coordinator');
    expect(queued(w.id)).toEqual([{ team_id: tid }]);
    expect(await next(w.call)).toMatchObject({ status: 'idle', note: 'The team has not started yet.' });
    const peek = (await w.call('message_read')).structuredContent;
    expect(peek.read_only).toBe(true);
    expect(peek.messages.map((m: any) => m.content)).toEqual(['from the coordinator']);
    expect((await w.call('message_read')).structuredContent.messages.length).toBe(1);

    await api('POST', `/teams/${tid}/start`);
    const it1 = await next(w.call);
    expect(it1.item.message.content).toBe('from the coordinator');
    await w.call('work_ack', { item_id: it1.item.item_id });
    expect((await next(w.call)).status).toBe('idle');

    await api('POST', `/teams/${tid}/pause`);
    await send(c.call, w.id, 'while paused');
    expect((await next(w.call)).status).toBe('paused');
    await api('POST', `/teams/${tid}/resume`);
    expect((await next(w.call)).item.message.content).toBe('while paused');
  });

  it('an outsider\'s DM to a member of a draft team flows through message_read and never appears in work_next', async () => {
    const { w, o, tid } = await pollTeam('draft-out');
    await send(o.call, w.id, 'from outside, draft');
    expect(queued(w.id)).toEqual([]);
    await readsOutsider(w, 'from outside, draft');
    await api('POST', `/teams/${tid}/start`);
    expect((await next(w.call)).status).toBe('idle');
  });

  it('an outsider\'s DM to a member of a paused team flows through message_read and never appears in work_next', async () => {
    const { w, o, tid } = await pollTeam('paused-out');
    await api('POST', `/teams/${tid}/start`);
    await api('POST', `/teams/${tid}/pause`);
    await send(o.call, w.id, 'from outside, paused');
    expect(queued(w.id)).toEqual([]);
    await readsOutsider(w, 'from outside, paused');
    await api('POST', `/teams/${tid}/resume`);
    expect((await next(w.call)).status).toBe('idle');
  });

  it('while the team runs, an outsider\'s DM reaches a work_next loop too, and is delivered once whichever reads it first', async () => {
    const { w, o, tid } = await pollTeam('running-out');
    await api('POST', `/teams/${tid}/start`);
    // work_next first: message_read does not repeat it.
    await send(o.call, w.id, 'via work_next');
    expect(queued(w.id)).toEqual([{ team_id: null }]);
    const it1 = await next(w.call);
    expect(it1.item.message.content).toBe('via work_next');
    await w.call('work_ack', { item_id: it1.item.item_id });
    expect((await w.call('message_read')).structuredContent.messages).toEqual([]);
    // message_read first: work_next skips it.
    await send(o.call, w.id, 'via message_read');
    await readsOutsider(w, 'via message_read');
    expect((await next(w.call)).status).toBe('idle');
  });

  it('with two polling teams, a DM is held only for the team the sender shares with the recipient', async () => {
    const a = await pollTeam('two-a');
    const bc = await mk('two-b-coord', [...TOOLS, ...MSG]);
    const b = (await api('POST', '/teams', { name: 'two-b', goal: 'g', grant_messaging: true, members: [{ agent_id: bc.id, role: 'coordinator' }, { agent_id: a.w.id, role: 'worker' }] })).body.team.id as string;
    await api('POST', `/teams/${b}/start`);
    await send(a.c.call, a.w.id, 'from team A');
    expect(queued(a.w.id)).toEqual([{ team_id: a.tid }]); // held: team A is still in draft
    await send(bc.call, a.w.id, 'from team B');
    expect(queued(a.w.id).map((q) => q.team_id).sort()).toEqual([a.tid, b].sort());
    expect((await next(a.w.call)).item.message.content).toBe('from team B');
  });

  it('a team member\'s DMs are not lost when a draft team is stopped without starting: message_read then delivers them', async () => {
    const { c, w, tid } = await pollTeam('never');
    await send(c.call, w.id, 'before the stop');
    expect((await w.call('message_read')).structuredContent.read_only).toBe(true);
    await api('POST', `/teams/${tid}/stop`);
    const after = (await w.call('message_read')).structuredContent;
    expect(after.read_only).toBeUndefined();
    expect(after.messages.map((m: any) => m.content)).toEqual(['before the stop']);
    expect((await w.call('message_read')).structuredContent.messages).toEqual([]);
  });
});
