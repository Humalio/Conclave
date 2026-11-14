/**
 * Share uploads publish only with current authority and their own snapshot, and abandoned transfers release their staging
 * and their slot (docs/transfers.md; next release, order 1, proposal issues P1 to P3).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { frameHeader, FRAME_END } from '../src/util/frames.js';
import { buildApp, type App } from '../src/app.js';
import type { ChannelRow } from '../src/channels/channels.js';
import { NOT_ALLOWED, type Rule } from '../src/policy/engine.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahpub-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
});
afterAll(async () => { await app.close(); });

type NewRule = Omit<Rule, 'id'>;
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
/** An agent with a PC, an app key and a share of its own; `upload(false)` takes share.upload on the share away. */
const uploader = (label: string) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  const pc = app.keys.createMachine(`${label}-pc`, null, sys);
  const ak = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys);
  const sh = app.shares.create({ agentId: agent.id, credId: k.credential.id }, `${label} notes`, null, []);
  const upload = (on: boolean) => app.keys.setRules(k.credential.policy_id, [
    { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' },
    ...(on ? [{ effect: 'allow', actions: ['share.upload'], resource: `share:${sh.id}` } as NewRule] : []),
  ], 'test', sys);
  upload(true);
  return { agent, k, pc, ak, sh, upload };
};
type Uploader = ReturnType<typeof uploader>;
const versions = (u: Uploader) => app.shares.versions(u.sh.id, true).map((v) => ({ version: v.version, status: v.status, files: app.shares.manifestOf(v).map((e) => e.path) }));
const denials = (u: Uploader) => app.db.prepare("SELECT action, path FROM resource_access_events WHERE credential_id=? AND decision='deny'").all(u.k.credential.id);
const denied = (u: Uploader, n: number) => Array.from({ length: n }, () => ({ action: 'share.upload', path: `share:${u.sh.id}` }));
const part = (id: string) => (app.channels as any).part(id) as string;
/** The bytes charged to the key's share upload quota, all windows together. */
const charged = (u: { k: { credential: { id: string } } }) => (app.db.prepare("SELECT COALESCE(SUM(count),0) n FROM usage_counters WHERE scope=? AND metric='share_bytes'").get(`key:${u.k.credential.id}`) as { n: number }).n;

/** Run `fn` once, the first time a blob is staged: a change "during staging". */
const duringStaging = async <T>(fn: () => void, run: () => Promise<T>): Promise<T> => {
  const store = app.store as unknown as { putBlob: (...a: unknown[]) => Promise<unknown> };
  const putBlob = store.putBlob;
  let calls = 0;
  store.putBlob = async (...a: unknown[]) => { if (calls++ === 0) fn(); return putBlob.apply(app.store, a); };
  try { return await run(); } finally { store.putBlob = putBlob; }
};

// Bridge: a share_upload through the PC's bridge, driven as the bridge drives it (chunk PUTs, then the sender's done).
const framed = (files: [string, string][]) => Buffer.concat([...files.flatMap(([p, t]) => [frameHeader(p, Buffer.byteLength(t)), Buffer.from(t)]), FRAME_END]);
const openBridge = (u: Uploader) => app.channels.open({
  from: { agentId: u.agent.id, credId: u.k.credential.id, machineId: u.pc.id, appId: u.ak.credential.id }, openedWith: 'share_upload',
  targetKind: 'share', target: u.sh.id, direction: 'send', mode: 'bridge', fromLocalPath: 'C:/work/notes', framing: 'tar', purpose: 'bridge upload',
});
const put = (u: Uploader, c: ChannelRow, offset: number, bytes: Buffer, total: number) => app.channels.put(u.pc.id, c.id, offset, bytes, total);
const finish = async (u: Uploader, c: ChannelRow, stream: Buffer) => {
  await app.channels.done(u.pc.id, c.id, 'send', { sha256: sha(stream) });
  return app.channels.get(c.id)!;
};
const bridgeUpload = async (u: Uploader, files: [string, string][]) => {
  const c = openBridge(u), s = framed(files);
  expect((await put(u, c, 0, s, s.length)).status).toBe(200);
  return finish(u, c, s);
};
// Inline channel: channel_open into the share, then channel_send.
const openInline = (u: Uploader, b: Buffer) => app.channels.open({
  from: { agentId: u.agent.id, credId: u.k.credential.id, machineId: u.pc.id, appId: u.ak.credential.id }, openedWith: 'channel_open',
  targetKind: 'share', target: u.sh.id, direction: 'send', mode: 'inline', framing: 'tar', sharePath: 'notes.md', size: b.length, sha256: sha(b), purpose: 'x',
});
const send = (u: Uploader, c: ChannelRow, seq: number, b: Buffer, final: boolean) => app.channels.send(u.agent.id, c.id, seq, b.toString('base64'), final);

describe('P1: every share upload is authorized again at publication', () => {
  it('a bridge upload revoked between chunks stops at the next chunk, deletes its staging and publishes nothing', async () => {
    const u = uploader('pub-bridge-chunks');
    const s = framed([['a.md', 'first file'], ['b.md', 'second file']]), half = Math.floor(s.length / 2);
    const c = openBridge(u);
    expect((await put(u, c, 0, s.subarray(0, half), s.length)).status).toBe(200);
    expect(existsSync(part(c.id))).toBe(true);
    u.upload(false);
    expect(await put(u, c, half, s.subarray(half), s.length)).toMatchObject({ status: 410, body: { status: 'failed', failure_reason: 'denied' } });
    expect(app.channels.get(c.id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    expect(existsSync(part(c.id))).toBe(false);
    // The bridge's last report changes nothing: the channel is over.
    expect((await finish(u, c, s)).status).toBe('failed');
    expect(versions(u)).toEqual([]);
    expect(denials(u)).toEqual(denied(u, 1));
  });

  it('an inline channel revoked between chunks fails at the next chunk; revoked or closed during staging, it publishes nothing', async () => {
    const u = uploader('pub-inline');
    const b = Buffer.alloc(100 * 1024, 'x'), first = b.subarray(0, 60 * 1024), rest = b.subarray(60 * 1024);
    // Between chunks.
    const c1 = openInline(u, b);
    expect(await send(u, c1, 0, first, false)).toMatchObject({ ok: true });
    u.upload(false);
    await expect(send(u, c1, 1, rest, true)).rejects.toMatchObject({ code: 'denied' });
    expect(app.channels.get(c1.id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    u.upload(true);
    // During staging: the blob is stored, the grant goes, then the version would be written.
    const small = Buffer.from('notes');
    const c2 = openInline(u, small);
    const r2 = await duringStaging(() => u.upload(false), () => send(u, c2, 0, small, true));
    expect(r2).toMatchObject({ status: 'failed', failure_reason: 'denied', result: { message: NOT_ALLOWED } });
    expect(app.channels.get(c2.id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    u.upload(true);
    // Closed by the sender during staging.
    const c3 = openInline(u, small);
    await duringStaging(() => app.channels.close(u.agent.id, c3.id), () => send(u, c3, 0, small, true));
    expect(app.channels.get(c3.id)).toMatchObject({ status: 'closed' });
    expect(versions(u)).toEqual([]);
    expect(denials(u)).toEqual(denied(u, 2));
    // Still allowed: published.
    const c4 = openInline(u, small);
    expect(await send(u, c4, 0, small, true)).toMatchObject({ status: 'done' });
    expect(versions(u)).toEqual([{ version: 1, status: 'published', files: ['notes.md'] }]);
  });

  it('share_upload with inline files is checked after its files are staged, against the key\'s current grant', async () => {
    const u = uploader('pub-tool');
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${u.ak.secret}` } } }));
    const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: u.k.secret } })) as any).structuredContent.session_token as string;
    const call = async (args: Record<string, unknown>) => ((await c.callTool({ name: 'share_upload', arguments: { session_token: token, share_id: u.sh.id, ...args } })) as any).structuredContent;
    const files = [{ path: 'plan.md', content: '# Plan' }];
    // The grant goes while the file is staged: refused, no draft and no version.
    expect(await duringStaging(() => u.upload(false), () => call({ files, final: true }))).toMatchObject({ error: 'denied' });
    expect(versions(u)).toEqual([]);
    expect(denials(u)).toEqual(denied(u, 1));
    // A lockdown during staging stops it too.
    u.upload(true);
    const locked = await duringStaging(() => app.lockdown.set('agent', u.agent.id, true, null), () => call({ files, final: true }));
    app.lockdown.set('agent', u.agent.id, false, null);
    expect(locked).toMatchObject({ error: 'lockdown' });
    expect(versions(u)).toEqual([]);
    // Allowed: published, and only this upload is charged to the key's quota: the refused ones were refunded.
    expect(await call({ files, final: true })).toMatchObject({ version: 1, status: 'published' });
    expect(charged(u)).toBe(Buffer.byteLength('# Plan'));
    await c.close();
  });
});

describe('P2: a bridge upload publishes only its own snapshot', () => {
  it('keeps an unrelated draft as it was, after the published version, and the draft still publishes later', async () => {
    const u = uploader('pub-draft');
    await app.shares.addFiles(u.sh.id, [{ path: 'draft.md', bytes: Buffer.from('half done') }], { note: 'work in progress', final: false, kind: 'inline' });
    expect(versions(u)).toEqual([{ version: 1, status: 'draft', files: ['draft.md'] }]);
    const done = await bridgeUpload(u, [['a.md', 'first file'], ['b.md', 'second file']]);
    expect(done).toMatchObject({ status: 'done' });
    expect(JSON.parse(done.result!)).toMatchObject({ version: 1, files: 2 });
    // The snapshot has only the bridge's files; the draft keeps its files and note and moves to version 2.
    expect(versions(u)).toEqual([{ version: 1, status: 'published', files: ['a.md', 'b.md'] }, { version: 2, status: 'draft', files: ['draft.md'] }]);
    expect(app.shares.version(u.sh.id, 2)!.note).toBe('work in progress');
    expect(app.shares.latest(u.sh.id)).toBe(1);
    // An inline channel save leaves the draft alone too.
    const b = Buffer.from('notes'), c = openInline(u, b);
    expect(await send(u, c, 0, b, true)).toMatchObject({ status: 'done', result: { version: 2 } });
    expect(versions(u).map((v) => [v.version, v.status, v.files])).toEqual([[1, 'published', ['a.md', 'b.md']], [2, 'published', ['notes.md']], [3, 'draft', ['draft.md']]]);
    // Publishing the draft later gives the next version, with the draft's files only.
    expect(await app.shares.addFiles(u.sh.id, [], { final: true, kind: 'inline' })).toMatchObject({ version: 3, status: 'published', files: 1 });
    expect(app.shares.latest(u.sh.id)).toBe(3);
  });
});

describe('P3: an abandoned transfer releases its staging and its slot', () => {
  it('an idle upload expires, deletes its staging and frees its slot; reopening works, with one job per live transfer', async () => {
    const u = uploader('pub-idle');
    const perKey = app.channels.cfg.perKey;
    const s = framed([['a.md', 'first file']]);
    const open = Array.from({ length: perKey }, () => openBridge(u));
    expect((await put(u, open[0]!, 0, s.subarray(0, 4), s.length)).status).toBe(200);
    expect(existsSync(part(open[0]!.id))).toBe(true);
    // Every call on the channel restarts its idle window.
    expect(app.channels.get(open[0]!.id)!.expires_at).toBeGreaterThan(Date.now() + app.channels.cfg.idleMs! - 60_000);
    expect(() => openBridge(u)).toThrow(/At most \d+ channels may be open per key/);
    // No one touches the first transfer for the idle window (its clock is moved past it).
    app.db.prepare('UPDATE data_channels SET expires_at=? WHERE id=?').run(Date.now() - 1, open[0]!.id);
    const again = openBridge(u);
    expect(app.channels.get(open[0]!.id)).toMatchObject({ status: 'expired', failure_reason: 'idle' });
    expect(existsSync(part(open[0]!.id))).toBe(false);
    // The bridge gets one send job per live transfer, and none for the abandoned one.
    const jobs = app.channels.jobsFor(u.pc.id, []).map((j) => j.channel_id).sort();
    expect(jobs).toEqual([again.id, ...open.slice(1).map((c) => c.id)].sort());
    // A late chunk for the abandoned transfer is refused; the new one publishes.
    expect((await put(u, open[0]!, 4, s.subarray(4), s.length)).status).toBe(410);
    expect((await put(u, again, 0, s, s.length)).status).toBe(200);
    expect(await finish(u, again, s)).toMatchObject({ status: 'done' });
    expect(versions(u)).toEqual([{ version: 1, status: 'published', files: ['a.md'] }]);
    for (const c of open.slice(1)) app.channels.close(u.agent.id, c.id);
    expect(app.channels.jobsFor(u.pc.id, [])).toEqual([]);
  });

  it('at startup, staging files of channels that are no longer open are deleted; a live channel keeps its own', async () => {
    const u = uploader('pub-restart');
    const live = openBridge(u), gone = openBridge(u);
    app.channels.close(u.agent.id, gone.id);
    for (const c of [live, gone]) { mkdirSync(dirname(part(c.id)), { recursive: true }); writeFileSync(part(c.id), 'staged'); }
    (app.channels as any).recover();
    expect(existsSync(part(live.id))).toBe(true);
    expect(existsSync(part(gone.id))).toBe(false);
    expect(app.channels.get(live.id)).toMatchObject({ status: 'open', received_offset: 6 });
    app.channels.close(u.agent.id, live.id);
  });

  it('a bridge transfer open at a restart gets a fresh idle window, so the first sweep does not expire it', async () => {
    const u = uploader('pub-resume');
    const s = framed([['r.md', 'resumed after a restart']]);
    const ch = openBridge(u);
    expect((await put(u, ch, 0, s.subarray(0, 4), s.length)).status).toBe(200);
    // The hub was down for longer than the idle window: the channel's clock is past it when the hub starts again.
    app.db.prepare('UPDATE data_channels SET expires_at=? WHERE id=?').run(Date.now() - 1, ch.id);
    (app.channels as any).recover();
    app.channels.sweep();
    expect(app.channels.get(ch.id)).toMatchObject({ status: 'open' });
    expect(app.channels.get(ch.id)!.expires_at).toBeGreaterThan(Date.now() + app.channels.cfg.idleMs! - 60_000);
    // The transfer resumes where it stopped and publishes.
    expect((await put(u, ch, 4, s.subarray(4), s.length)).status).toBe(200);
    expect(await finish(u, ch, s)).toMatchObject({ status: 'done' });
    expect(versions(u)).toEqual([{ version: 1, status: 'published', files: ['r.md'] }]);
  });
});
