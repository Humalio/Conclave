/**
 * Acceptance gap 14 (docs/transfers.md, "Shares, channels and the bridge"): a share download and a chunked upload into the
 * vault are authorized again while they are under way. When access is revoked, the share closes or the task is cancelled
 * between two chunks, no further chunk moves, the channel fails as `denied`, and an upload's staging file is deleted.
 * (A file download and the final save have their own tests: delivery-recheck-recovery and share-publication.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { BRIDGE_CHUNK, INLINE_CHUNK, type ChannelRow } from '../src/channels/channels.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', vaultDir = '', pc = '', pcKey = '';
const clients: Client[] = [];
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const BASE_RULES: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' },
  { effect: 'allow', actions: ['message.send', 'message.receive'], resource: 'agent:*' }];
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const bigText = (n: number) => Buffer.from('0123456789abcdef\n'.repeat(Math.ceil(n / 17)).slice(0, n));
const part = (id: string) => (app.channels as any).part(id) as string;
/** fail() deletes the staging file without waiting for it. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/** An agent with its own session key, signed in through the PC's app key. `rules` replaces its grants. */
async function agent(label: string, extra: Rules = []) {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  const rules = (more: Rules) => app.keys.setRules(k.credential.policy_id, [...BASE_RULES, ...more], 'test', sys);
  rules(extra);
  const c = new Client({ name: label, version: '1' });
  clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${pcKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as any).structuredContent.session_token as string;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: { session_token: token, ...args } })) as any;
    return { error: !!r.isError, data: r.structuredContent as Record<string, any>, text: (r.content as { text?: string }[]).map((x) => x.text ?? '').join(' ') };
  };
  return { id: a.id, cred: k.credential, from: { agentId: a.id, credId: k.credential.id, machineId: pc, appId: app.keys.credentials({ kind: 'app_key' }).find((x) => x.machine_id === pc)!.id }, rules, call };
}
type Agent = Awaited<ReturnType<typeof agent>>;

/** A bridge download of share version `target` for `who`, with its first chunk served. */
async function downloading(who: Agent, target: string) {
  const vs = await app.channels.shareStream({ id: 'tmp_size', target });
  const c = app.channels.open({ from: who.from, openedWith: 'share_download', targetKind: 'share', target, direction: 'download', mode: 'bridge', toLocalPath: 'C:/dl/share', framing: 'tar', size: vs.size, sha256: await app.channels.hashStream(vs), purpose: 'test' });
  const first = await app.channels.get_chunk(pc, c.id, 0);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.data!.length).toBe(BRIDGE_CHUNK);
  return c.id;
}
const nextChunkRefused = async (id: string) => {
  const next = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
  expect(next.status).toBe(410);
  expect(next.data).toBeUndefined();
  expect(app.channels.get(id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahinflight-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'Docs'), { recursive: true });
  app = await buildApp(testConfig(dir, { vaultDir, maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const m = app.keys.createMachine('inflight-pc', null, sys);
  pc = m.id;
  pcKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 50 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('a share download is rechecked at every chunk', () => {
  /** A share by its author, listed for the reader, with one published version larger than one bridge chunk. */
  async function shared(name: string) {
    const author = await agent(`${name}-author`);
    const reader = await agent(`${name}-reader`);
    const sh = app.shares.create({ agentId: author.id, credId: author.cred.id }, `${name} notes`, null, [`agent:${reader.id}`]);
    reader.rules([{ effect: 'allow', actions: ['share.read'], resource: `share:${sh.id}` }]);
    await app.shares.addFiles(sh.id, [{ path: 'big.txt', bytes: bigText(BRIDGE_CHUNK + 200_000) }], { final: true, kind: 'inline' });
    return { author, reader, sh, target: `${sh.id}@1` };
  }

  it('the share closes between chunks: no further chunk, the channel fails as denied', async () => {
    const { reader, sh, target } = await shared('dl-closed');
    const id = await downloading(reader, target);
    app.shares.close(sh.id);
    await nextChunkRefused(id);
  });

  it('the reader\'s share.read is revoked between chunks: no further chunk, denied', async () => {
    const { reader, target } = await shared('dl-grant');
    const id = await downloading(reader, target);
    reader.rules([]);
    await nextChunkRefused(id);
  });

  it('the reader\'s session key is revoked between chunks: no further chunk, denied', async () => {
    const { reader, target } = await shared('dl-key');
    const id = await downloading(reader, target);
    app.keys.setStatus(reader.cred.id, 'revoked', 'test', sys);
    await nextChunkRefused(id);
  });

  it('with nothing changed the download completes', async () => {
    const { reader, target } = await shared('dl-ok');
    const id = await downloading(reader, target);
    const next = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
    expect(next.status).toBe(200);
    expect(next.data!.length).toBeGreaterThan(0);
  });
});

describe('a task\'s submitted files, downloaded by its reviewer, stop when the task is cancelled', () => {
  async function inReview(name: string) {
    const [coord, worker, reviewer] = await Promise.all(['coord', 'worker', 'reviewer'].map((r) => agent(`${name}-${r}`)));
    const t = app.teams.create({ name, goal: 'In-flight checks', grant_messaging: true, members: [
      { agent_id: coord!.id, role: 'coordinator' }, { agent_id: worker!.id, role: 'worker' }, { agent_id: reviewer!.id, role: 'reviewer' },
    ] }, sys);
    app.teams.start(t.id, sys);
    const created = await coord!.call('task_create', { team_id: t.id, title: 'Write the notes', reviewer: reviewer!.id, operator_request: { source: 'test' } });
    expect(created.error, created.text).toBe(false);
    const task = created.data.task.id as string;
    expect((await coord!.call('task_assign', { task_id: task, agent_id: worker!.id })).error).toBe(false);
    expect((await worker!.call('task_start', { task_id: task })).error).toBe(false);
    const own = app.shares.create({ agentId: worker!.id, credId: worker!.cred.id }, `${name} work`, null, []);
    await app.shares.addFiles(own.id, [{ path: 'big.txt', bytes: bigText(BRIDGE_CHUNK + 200_000) }], { final: true, kind: 'inline' });
    const sub = await worker!.call('task_submit', { task_id: task, summary: 'Done, see the notes.', share_id: own.id });
    expect(sub.error, sub.text).toBe(false);
    const set = app.taskAttachments.setOf(task, 'submission')!;
    expect(set).toBeTruthy();
    const v = app.shares.latest(set.id);
    return { coord: coord!, reviewer: reviewer!, task, target: `${set.id}@${v}` };
  }

  it('the reviewer gets the first chunk under the task rule alone, and nothing more once the task is cancelled', async () => {
    const f = await inReview('dl-task');
    const id = await downloading(f.reviewer, f.target);
    const c = await f.coord.call('task_cancel', { task_id: f.task, reason: 'No longer needed.' });
    expect(c.error, c.text).toBe(false);
    await nextChunkRefused(id);
  });
});

describe('a chunked upload into the vault is rechecked before each chunk is staged', () => {
  const WRITE: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.create', 'fs.update'], resource: 'path:/vault/Docs/**' }];
  const openBridge = (who: Agent, file: string, bytes: Buffer) => app.channels.open({ from: who.from, openedWith: 'channel_open', targetKind: 'vault', target: `/vault/Docs/${file}`, direction: 'send', mode: 'bridge', fromLocalPath: `C:/work/${file}`, framing: 'raw', size: bytes.length, sha256: sha(bytes), baseRevision: 'absent', purpose: 'test' });
  const openInline = (who: Agent, file: string, bytes: Buffer) => app.channels.open({ from: who.from, openedWith: 'channel_open', targetKind: 'vault', target: `/vault/Docs/${file}`, direction: 'send', mode: 'inline', framing: 'raw', size: bytes.length, sha256: sha(bytes), baseRevision: 'absent', purpose: 'test' });
  const put = (c: ChannelRow, offset: number, b: Buffer, total: number) => app.channels.put(pc, c.id, offset, b, total);

  async function bridgeHalf(label: string, file: string) {
    const who = await agent(label, WRITE);
    const bytes = bigText(BRIDGE_CHUNK + 300_000);
    const c = openBridge(who, file, bytes);
    expect((await put(c, 0, bytes.subarray(0, BRIDGE_CHUNK), bytes.length)).status).toBe(200);
    expect(existsSync(part(c.id))).toBe(true);
    return { who, c, bytes };
  }
  const stopped = async (c: ChannelRow, bytes: Buffer, file: string, reason = 'denied') => {
    expect(await put(c, BRIDGE_CHUNK, bytes.subarray(BRIDGE_CHUNK), bytes.length)).toMatchObject({ status: 410, body: { status: 'failed', failure_reason: reason } });
    expect(app.channels.get(c.id)).toMatchObject({ status: 'failed', failure_reason: reason, received_offset: BRIDGE_CHUNK });
    await settle();
    expect(existsSync(part(c.id))).toBe(false);
    expect(existsSync(join(vaultDir, 'Docs', file))).toBe(false);
  };

  it('a bridge upload whose write grant is revoked between chunks stops, fails as denied and deletes its staging', async () => {
    const { who, c, bytes } = await bridgeHalf('up-grant', 'grant.txt');
    who.rules([{ effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Docs/**' }]);
    await stopped(c, bytes, 'grant.txt');
  });

  it('a bridge upload whose session key is revoked between chunks stops, fails as denied and deletes its staging', async () => {
    const { who, c, bytes } = await bridgeHalf('up-key', 'key.txt');
    app.keys.setStatus(who.cred.id, 'revoked', 'test', sys);
    await stopped(c, bytes, 'key.txt');
  });

  it('a bridge upload whose app key is capped between chunks stops, fails as denied and deletes its staging', async () => {
    const { who, c, bytes } = await bridgeHalf('up-cap', 'cap.txt');
    const appCred = app.keys.credential(who.from.appId)!;
    const before = app.keys.rulesFor(appCred.id);
    app.keys.setRules(appCred.policy_id, [...BASE_RULES, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/**' }], 'capped', sys);
    try { await stopped(c, bytes, 'cap.txt'); } finally { app.keys.setRules(appCred.policy_id, before.map(({ effect, actions, resource }) => ({ effect, actions, resource })), 'restored', sys); }
  });

  it('with nothing changed the bridge upload lands', async () => {
    const { c, bytes } = await bridgeHalf('up-ok', 'ok.txt');
    expect((await put(c, BRIDGE_CHUNK, bytes.subarray(BRIDGE_CHUNK), bytes.length)).status).toBe(200);
    await app.channels.done(pc, c.id, 'send', { sha256: sha(bytes) });
    expect(app.channels.get(c.id)).toMatchObject({ status: 'done' });
    expect(existsSync(join(vaultDir, 'Docs', 'ok.txt'))).toBe(true);
  });

  it('an inline upload whose write grant is revoked between chunks fails as denied and writes nothing', async () => {
    const who = await agent('up-inline', WRITE);
    const bytes = bigText(INLINE_CHUNK + 10_000);
    const c = openInline(who, 'inline.txt', bytes);
    expect(await app.channels.send(who.id, c.id, 0, bytes.subarray(0, INLINE_CHUNK).toString('base64'), false)).toMatchObject({ ok: true });
    who.rules([]);
    await expect(app.channels.send(who.id, c.id, 1, bytes.subarray(INLINE_CHUNK).toString('base64'), true)).rejects.toMatchObject({ code: 'denied' });
    expect(app.channels.get(c.id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    expect(existsSync(join(vaultDir, 'Docs', 'inline.txt'))).toBe(false);
  });
});
