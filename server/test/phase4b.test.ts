import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { mapLine } from '../src/shares/shares.js';
import { LeakGuard } from '../src/guard/leakGuard.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '', vaultDir = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];

const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const MSG: Rules = [{ effect: 'allow', actions: ['message.send', 'message.receive'], resource: 'agent:*' }];
const SHARE: Rules = [{ effect: 'allow', actions: ['share.create', 'share.upload', 'share.read', 'share.comment', 'share.suggest', 'share.promote'], resource: 'share:*' }];
const FS: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.history', 'fs.download'], resource: 'path:/vault/**' }];
const CHAN: Rules = [{ effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }, { effect: 'allow', actions: ['channel.open', 'channel.accept'], resource: 'agent:*' }];
const BASE_RULES = [...TOOLS, ...MSG, ...SHARE, ...FS];

async function loginWith(key: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const mk = async (label: string, rules: Rules = BASE_RULES) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, rules, 'test', sys);
  return { id: agent.id, cred: k.credential, call: await loginWith(appKey, k.secret) };
};
type P = Awaited<ReturnType<typeof mk>>;
const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const b64 = (b: Buffer) => b.toString('base64');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah4b-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('anchor mapping', () => {
  it('maps a line through a diff and reports changed lines as gone', () => {
    expect(mapLine('a\nb\nc\nd\n', 'x\na\nb\nc\nd\n', 4)).toBe(5);
    expect(mapLine('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 2)).toBeNull();
    expect(mapLine('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 3)).toBe(3);
  });
});

describe('shares', () => {
  it('create, upload, read, comment, suggest, feedback via work_next, v2 anchors, resolve, promote with conflict, revoked access', async () => {
    const A = await mk('author'), R = await mk('reviewer'), O = await mk('outsider');
    const v1 = 'l1\nl2\nl3\nl4\n';
    const created = await A.call('share_create', { name: 'auth-service', with: [R.id] });
    expect(created.isError).toBeFalsy();
    const sid = created.structuredContent.share_id as string;
    // an agent the author may not message cannot be a recipient
    const lone = await mk('lone', [...TOOLS, ...SHARE]);
    expect((await A.call('share_create', { name: 'x', with: [lone.id] })).structuredContent.error).toBe('denied');

    // draft is invisible to the recipient
    const d = await A.call('share_upload', { share_id: sid, files: [{ path: 'src/a.txt', content: v1 }, { path: 'README.md', content: '# hi\n' }, { path: 'bin/x.dat', content: b64(Buffer.from([0, 1, 2, 3])), encoding: 'base64' }], note: 'first' });
    expect(d.structuredContent).toMatchObject({ version: 1, status: 'draft' });
    expect((await R.call('share_info', { share_id: sid })).isError).toBe(true);
    expect((await R.call('share_info', { share_id: sid, version: 1 })).isError).toBe(true);
    const pub = await A.call('share_upload', { share_id: sid, files: [], final: true });
    expect(pub.structuredContent).toMatchObject({ version: 1, status: 'published', files: 3 });

    const info = await R.call('share_info', { share_id: sid });
    expect(info.structuredContent.files.map((f: any) => f.path)).toEqual(['README.md', 'bin/x.dat', 'src/a.txt']);
    expect((await R.call('share_list')).structuredContent.shares[0]).toMatchObject({ share_id: sid, latest_version: 1 });
    const rd = await R.call('share_read', { share_id: sid, version: 1, path: 'src/a.txt' });
    expect(rd.structuredContent.content).toBe(v1);
    expect((await R.call('share_read', { share_id: sid, version: 1, path: 'bin/x.dat' })).structuredContent).toMatchObject({ encoding: 'base64', content: 'AAECAw==' });
    // the outsider and a key without share.read are refused
    expect((await O.call('share_read', { share_id: sid, version: 1, path: 'src/a.txt' })).structuredContent.error).toBe('denied');

    // feedback on v1
    const c4 = (await R.call('share_comment', { share_id: sid, version: 1, path: 'src/a.txt', line: 4, body: 'rename l4' })).structuredContent.comment_id;
    const c2 = (await R.call('share_comment', { share_id: sid, version: 1, path: 'src/a.txt', line: 2, body: 'l2 is wrong' })).structuredContent.comment_id;
    const patch = '--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,4 +1,4 @@\n l1\n-l2\n+L2\n l3\n l4\n';
    const sg = (await R.call('share_suggest', { share_id: sid, version: 1, path: 'src/a.txt', patch, note: 'fix' })).structuredContent.suggestion_id;
    expect((await R.call('share_suggest', { share_id: sid, version: 1, patch: 'nope' })).structuredContent.error).toBe('invalid_argument');
    expect((await R.call('share_resolve', { feedback_id: c4, status: 'applied' })).structuredContent.error).toBe('denied');

    // the author gets the feedback as work items
    const w = (await A.call('work_next', { wait_seconds: 0 })).structuredContent;
    expect(w.status).toBe('item');
    expect(w.item.kind).toBe('share_feedback');
    expect(w.item.feedback.share_id).toBe(sid);
    expect(w.item.trust).toBe('L2');
    const seen = new Set<string>([w.item.feedback.feedback_id]);
    await A.call('work_ack', { item_id: w.item.item_id });
    for (let i = 0; i < 2; i++) {
      const n = (await A.call('work_next', { wait_seconds: 0 })).structuredContent;
      seen.add(n.item.feedback.feedback_id);
      await A.call('work_ack', { item_id: n.item.item_id });
    }
    expect([...seen].sort()).toEqual([c4, c2, sg].sort());

    // v2: a line inserted on top, l2 changed
    const v2 = 'new\nl1\nL2\nl3\nl4\n';
    const up2 = await A.call('share_upload', { share_id: sid, from_version: 1, files: [{ path: 'src/a.txt', content: v2 }], final: true, note: 'second' });
    expect(up2.structuredContent).toMatchObject({ version: 2, status: 'published', files: 3 });
    const diff = await R.call('share_diff', { share_id: sid, from_version: 1, to_version: 2, path: 'src/a.txt' });
    expect(diff.structuredContent.diff).toContain('+new');
    expect(diff.structuredContent.diff).toContain('-l2');
    expect((await R.call('share_diff', { share_id: sid, from_version: 1, to_version: 2 })).structuredContent.changed).toEqual([{ path: 'src/a.txt', change: 'modified' }]);

    const fb = (await A.call('share_feedback', { share_id: sid })).structuredContent.feedback as any[];
    const by = (id: string) => fb.find((f) => f.feedback_id === id);
    expect(by(c4)).toMatchObject({ line: 4, mapped_version: 2, mapped_line: 5, outdated: false });
    expect(by(c2)).toMatchObject({ outdated: true });
    expect(by(sg)).toMatchObject({ outdated: true, kind: 'suggestion' });
    // a recipient sees only their own feedback
    expect(((await R.call('share_feedback', { share_id: sid })).structuredContent.feedback as any[])).toHaveLength(3);
    expect(((await A.call('share_download', { share_id: sid, suggestion_id: sg })).structuredContent.patch)).toBe(patch);
    expect((await A.call('share_resolve', { feedback_id: c4, status: 'applied', note: 'done' })).isError).toBeFalsy();
    expect(((await A.call('share_feedback', { share_id: sid })).structuredContent.feedback as any[]).find((f) => f.feedback_id === c4).status).toBe('applied');

    // inline download
    const dl = await R.call('share_download', { share_id: sid, version: 2 });
    expect(dl.structuredContent.files).toHaveLength(3);

    // promote: create-only, then conflict, then explicit base revision
    const p1 = await R.call('share_promote', { share_id: sid, version: 1, to: '/vault/Imported' });
    expect(p1.isError).toBeFalsy();
    expect(p1.structuredContent.results.map((r: any) => r.result)).toEqual(['created', 'created', 'created']);
    expect(readFileSync(join(vaultDir, 'Imported', 'src', 'a.txt'), 'utf8')).toBe(v1);
    expect(p1.structuredContent).toMatchObject({ author: A.id, promoted_by: R.id });
    const p2 = await R.call('share_promote', { share_id: sid, version: 2, to: '/vault/Imported' });
    const a2 = p2.structuredContent.results.find((r: any) => r.path === 'src/a.txt');
    expect(a2.result).toBe('conflict');
    expect(a2.current_revision).toBe(sha(v1));
    expect(readFileSync(join(vaultDir, 'Imported', 'src', 'a.txt'), 'utf8')).toBe(v1);
    const p3 = await R.call('share_promote', { share_id: sid, version: 2, to: '/vault/Imported', base_revisions: { 'src/a.txt': sha(v1) } });
    expect(p3.structuredContent.results.find((r: any) => r.path === 'src/a.txt').result).toBe('updated');
    expect(readFileSync(join(vaultDir, 'Imported', 'src', 'a.txt'), 'utf8')).toBe(v2);
    expect(app.db.prepare('SELECT COUNT(*) n FROM share_promotions WHERE promoted_by_agent_id=? AND author_agent_id=?').get(R.id, A.id)).toMatchObject({ n: 9 });
    // no vault write permission on the target: denied per file
    const NW = await mk('nowrite', [...TOOLS, ...MSG, ...SHARE]);
    await A.call('share_create', { name: 'tmp', with: [NW.id] });
    const ns = (await NW.call('share_list')).structuredContent.shares[0].share_id;
    await A.call('share_upload', { share_id: ns, files: [{ path: 'f', content: 'x' }], final: true });
    expect((await NW.call('share_promote', { share_id: ns, version: 1, to: '/vault/Imported' })).structuredContent.results[0].result).toBe('denied');

    // access is re-checked at every read: take away the right to receive from the author
    app.keys.setRules(R.cred.policy_id, [...BASE_RULES, { effect: 'deny', actions: ['message.receive'], resource: `agent:${A.id}` }], 'test', sys);
    expect((await R.call('share_read', { share_id: sid, version: 1, path: 'src/a.txt' })).structuredContent.error).toBe('denied');
    expect((await R.call('share_list')).structuredContent.shares).toHaveLength(0);
    app.keys.setRules(R.cred.policy_id, BASE_RULES, 'test', sys);
    expect((await R.call('share_read', { share_id: sid, version: 1, path: 'src/a.txt' })).isError).toBeFalsy();
    // closing a share removes access
    expect((await R.call('share_close', { share_id: sid })).structuredContent.error).toBe('denied');
    expect((await A.call('share_close', { share_id: sid })).isError).toBeFalsy();
    expect((await R.call('share_read', { share_id: sid, version: 1, path: 'src/a.txt' })).structuredContent.error).toBe('denied');
  });

  it('refuses oversized inline uploads and bad paths, and enforces the per-key quota', async () => {
    const A = await mk('author2'), R = await mk('rev2');
    const sid = (await A.call('share_create', { name: 's', with: [R.id] })).structuredContent.share_id;
    expect((await A.call('share_upload', { share_id: sid, files: [{ path: 'big', content: 'x'.repeat(1024 * 1024 + 1) }] })).structuredContent.error).toBe('too_large');
    expect((await A.call('share_upload', { share_id: sid, files: [{ path: '../evil', content: 'x' }] })).structuredContent.error).toBe('invalid_argument');
    expect((await A.call('share_upload', { share_id: sid, files: [{ path: 'a', content: 'x' }], local_folder: 'C:\\x' })).structuredContent.error).toBe('invalid_argument');
    const old = app.shares.bytesPerHour;
    app.shares.bytesPerHour = 10;
    expect((await A.call('share_upload', { share_id: sid, files: [{ path: 'a', content: 'x'.repeat(11) }] })).structuredContent.error).toBe('rate_limited');
    app.shares.bytesPerHour = old;
  });
});

describe('inline channels', () => {
  it('denies channels while channel.use is off', async () => {
    const A = await mk('nochan-a', BASE_RULES), R = await mk('nochan-r', [...BASE_RULES, ...CHAN]);
    const data = Buffer.from('hello');
    expect((await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: data.length, sha256: sha(data) })).structuredContent.error).toBe('denied');
    expect((await A.call('channel_list')).structuredContent.error).toBe('denied');
    // the receiving side needs channel.accept for the sender
    const A2 = await mk('chan-a2', [...BASE_RULES, { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }, { effect: 'allow', actions: ['channel.open'], resource: 'agent:*' }]);
    const R2 = await mk('chan-r2', [...BASE_RULES, { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }]);
    expect((await A2.call('channel_open', { to: `agent:${R2.id}`, purpose: 'x', size: data.length, sha256: sha(data) })).structuredContent.error).toBe('denied');
    // channel.use withdrawn mid-way takes effect at once
    const A3 = await mk('chan-a3', [...BASE_RULES, ...CHAN]);
    expect((await A3.call('channel_list')).isError).toBeFalsy();
    app.keys.setRules(A3.cred.policy_id, BASE_RULES, 'test', sys);
    expect((await A3.call('channel_list')).structuredContent.error).toBe('denied');
  });

  it('agent to agent with a window of 4, backpressure and hash check', async () => {
    const A = await mk('sender', [...BASE_RULES, ...CHAN]), R = await mk('receiver', [...BASE_RULES, ...CHAN]);
    const data = randomBytes(64 * 1024 * 5 + 123);
    const chunks: Buffer[] = [];
    for (let i = 0; i < data.length; i += 64 * 1024) chunks.push(data.subarray(i, i + 64 * 1024));
    const o = await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'build output', size: data.length, sha256: sha(data) });
    expect(o.structuredContent).toMatchObject({ mode: 'inline', status: 'offered' });
    const cid = o.structuredContent.channel_id as string;
    // not accepted yet
    expect((await A.call('channel_send', { channel_id: cid, seq: 0, data: b64(chunks[0]!) })).structuredContent.error).toBe('invalid_state');
    // the offer arrives as a work item
    const w = (await R.call('work_next', { wait_seconds: 0 })).structuredContent;
    expect(w.item).toMatchObject({ kind: 'channel_offer', trust: 'L2' });
    expect(w.item.channel.channel_id).toBe(cid);
    expect((await A.call('channel_accept', { channel_id: cid })).structuredContent.error).toBe('invalid_state');
    expect((await R.call('channel_accept', { channel_id: cid })).structuredContent.status).toBe('open');
    await R.call('work_ack', { item_id: w.item.item_id });
    // four chunks fit, the fifth waits
    for (let i = 0; i < 4; i++) expect((await A.call('channel_send', { channel_id: cid, seq: i, data: b64(chunks[i]!) })).structuredContent.ok).toBe(true);
    const full = await A.call('channel_send', { channel_id: cid, seq: 4, data: b64(chunks[4]!) });
    expect(full.structuredContent).toMatchObject({ wait: true });
    expect(full.structuredContent.retry_after_ms).toBeGreaterThan(0);
    // a repeated seq is harmless; skipping one is refused
    expect((await A.call('channel_send', { channel_id: cid, seq: 3, data: b64(chunks[3]!) })).structuredContent.duplicate).toBe(true);
    expect((await A.call('channel_send', { channel_id: cid, seq: 9, data: b64(chunks[4]!) })).structuredContent.error).toBe('out_of_order');
    const got: Buffer[] = [];
    let r = (await R.call('channel_receive', { channel_id: cid })).structuredContent;
    for (const c of r.chunks) got.push(Buffer.from(c.data, 'base64'));
    expect(got).toHaveLength(1); // responses stay under the 100 000 character cap
    expect((await A.call('channel_send', { channel_id: cid, seq: 4, data: b64(chunks[4]!) })).structuredContent.ok).toBe(true);
    expect((await A.call('channel_send', { channel_id: cid, seq: 5, data: b64(chunks[5]!), final: true })).structuredContent.wait).toBe(true);
    let nextSend = 5;
    for (let i = 0; i < 40 && !r.final; i++) {
      r = (await R.call('channel_receive', { channel_id: cid, wait_seconds: 1 })).structuredContent;
      for (const c of r.chunks) got.push(Buffer.from(c.data, 'base64'));
      if (nextSend < chunks.length) {
        const res = await A.call('channel_send', { channel_id: cid, seq: nextSend, data: b64(chunks[nextSend]!), final: nextSend === chunks.length - 1 });
        expect(res.isError).toBeFalsy();
        if (res.structuredContent.ok) nextSend++;
      }
    }
    expect(r.final).toBe(true);
    expect(r.verified).toBe(true);
    expect(Buffer.concat(got).equals(data)).toBe(true);
    expect(r.sha256).toBe(sha(data));
    const st = (await A.call('channel_status', { channel_id: cid })).structuredContent;
    expect(st.status).toBe('done');
    // nothing was written to the disk for this channel
    expect(existsSync(join(app.config.dataDir, 'tmp', `chan-${cid}.part`))).toBe(false);
    // a third agent cannot see it
    const X = await mk('snoop', [...BASE_RULES, ...CHAN]);
    expect((await X.call('channel_status', { channel_id: cid })).structuredContent.error).toBe('denied');
    // both sides learn the result
    const events: string[] = [];
    for (let i = 0; i < 3; i++) { const n = (await A.call('work_next', { wait_seconds: 0 })).structuredContent; if (n.status !== 'item') break; events.push(n.item.content); await A.call('work_ack', { item_id: n.item.item_id }); }
    expect(events.some((e) => e.includes('done') && e.includes('sha256 ok'))).toBe(true);
  });

  it('fails on a hash mismatch, expires unaccepted offers and fails inline channels on restart', async () => {
    const A = await mk('hs-a', [...BASE_RULES, ...CHAN]), R = await mk('hs-r', [...BASE_RULES, ...CHAN]);
    const data = Buffer.from('some text');
    const cid = (await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: data.length, sha256: sha('different') })).structuredContent.channel_id;
    await R.call('channel_accept', { channel_id: cid });
    expect((await A.call('channel_send', { channel_id: cid, seq: 0, data: b64(data), final: true })).structuredContent.error).toBe('hash_mismatch');
    expect((await A.call('channel_status', { channel_id: cid })).structuredContent).toMatchObject({ status: 'failed', failure_reason: 'hash_mismatch' });
    expect((await R.call('channel_receive', { channel_id: cid })).structuredContent.status).toBe('failed');

    // an offer nobody accepts expires after 10 minutes
    const c2 = (await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: 1, sha256: sha('y') })).structuredContent.channel_id;
    app.db.prepare('UPDATE data_channels SET expires_at=? WHERE id=?').run(Date.now() - 1, c2);
    expect((await R.call('channel_accept', { channel_id: c2 })).structuredContent.error).toBe('expired');
    expect((await A.call('channel_status', { channel_id: c2 })).structuredContent.status).toBe('expired');

    // closing tells the other side
    const c3 = (await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: 1, sha256: sha('y') })).structuredContent.channel_id;
    await R.call('channel_accept', { channel_id: c3 });
    await R.call('channel_close', { channel_id: c3, reason: 'no thanks' });
    expect((await A.call('channel_send', { channel_id: c3, seq: 0, data: b64(Buffer.from('y')), final: true })).structuredContent).toMatchObject({ ok: false, status: 'closed' });

    // size cap and a per-key concurrency cap
    expect((await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: 2 * 1024 * 1024, sha256: sha('y') })).structuredContent.error).toBe('too_large');
    const open: string[] = [];
    for (let i = 0; i < 4; i++) open.push((await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: 1, sha256: sha('y') })).structuredContent.channel_id);
    expect((await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: 1, sha256: sha('y') })).structuredContent.error).toBe('rate_limited');
    for (const id of open) await A.call('channel_close', { channel_id: id });

    // restart: inline channels fail, "restart"
    const c4 = (await A.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', size: 1, sha256: sha('y') })).structuredContent.channel_id;
    await R.call('channel_accept', { channel_id: c4 });
    const { Channels } = await import('../src/channels/channels.js');
    new Channels(app.db, app.keys, app.teams, app.setup, app.store, app.vault, app.shares, new LeakGuard({ isIssued: (k, id, s) => app.keys.isIssued(k, id, s) }), app.audit, app.channels.cfg);
    expect((await A.call('channel_status', { channel_id: c4 })).structuredContent).toMatchObject({ status: 'failed', failure_reason: 'restart' });
  });

  it('vault target through an inline channel commits a revision with the CAS check', async () => {
    const A = await mk('vault-a', [...BASE_RULES, ...CHAN]);
    const text = '# Imported\nvia channel\n';
    const o = await A.call('channel_open', { to: 'vault:/vault/Inbox/chan.md', purpose: 'note', size: Buffer.byteLength(text), sha256: sha(text) });
    expect(o.structuredContent.status).toBe('open');
    const sent = await A.call('channel_send', { channel_id: o.structuredContent.channel_id, seq: 0, data: b64(Buffer.from(text)), final: true });
    expect(sent.structuredContent).toMatchObject({ final: true, status: 'done' });
    const rev = sent.structuredContent.result.revision as string;
    expect(rev).toBe(sha(text));
    expect(readFileSync(join(vaultDir, 'Inbox', 'chan.md'), 'utf8')).toBe(text);
    const hist = (await A.call('file_history', { path: '/vault/Inbox/chan.md' })).structuredContent;
    expect(hist.revisions[0]).toMatchObject({ revision: rev, op: 'create', by: { agent_id: A.id } });
    // creating again conflicts and nothing is overwritten
    const o2 = await A.call('channel_open', { to: 'vault:/vault/Inbox/chan.md', purpose: 'note', size: 2, sha256: sha('zz') });
    const s2 = await A.call('channel_send', { channel_id: o2.structuredContent.channel_id, seq: 0, data: b64(Buffer.from('zz')), final: true });
    expect(s2.structuredContent).toMatchObject({ status: 'failed', failure_reason: 'conflict' });
    expect(readFileSync(join(vaultDir, 'Inbox', 'chan.md'), 'utf8')).toBe(text);
    // with the right base revision it updates
    const t3 = 'second\n';
    const o3 = await A.call('channel_open', { to: 'vault:/vault/Inbox/chan.md', purpose: 'note', size: 7, sha256: sha(t3), base_revision: rev });
    const s3 = await A.call('channel_send', { channel_id: o3.structuredContent.channel_id, seq: 0, data: b64(Buffer.from(t3)), final: true });
    expect(s3.structuredContent.result).toMatchObject({ previous_revision: rev, revision: sha(t3) });
    // no write permission: denied
    const RO = await mk('vault-ro', [...TOOLS, ...MSG, ...CHAN, { effect: 'allow', actions: ['fs.read', 'fs.download'], resource: 'path:/vault/**' }]);
    expect((await RO.call('channel_open', { to: 'vault:/vault/Inbox/ro.md', purpose: 'x', size: 1, sha256: sha('a') })).structuredContent.error).toBe('denied');
    // a key in the data fails the channel and suspends the key
    const K = await mk('vault-k', [...BASE_RULES, ...CHAN]);
    const leak = `note ${app.keys.createSessionKey({ agentId: A.id, label: 'leaked' }, sys).secret}`;
    const o4 = await K.call('channel_open', { to: 'vault:/vault/Inbox/leak.md', purpose: 'x', size: Buffer.byteLength(leak), sha256: sha(leak) });
    const s4 = await K.call('channel_send', { channel_id: o4.structuredContent.channel_id, seq: 0, data: b64(Buffer.from(leak)), final: true });
    expect(s4.isError).toBe(true);
    expect(existsSync(join(vaultDir, 'Inbox', 'leak.md'))).toBe(false);
  });

  it('file_download delivers a vault file through an inline channel', async () => {
    const A = await mk('dl-a', [...BASE_RULES, ...CHAN]);
    await A.call('file_create', { path: '/vault/Docs/dl.md', content: 'download me\n' });
    const d = await A.call('file_download', { path: '/vault/Docs/dl.md' });
    expect(d.structuredContent).toMatchObject({ mode: 'inline', size: 12, sha256: sha('download me\n') });
    const r = (await A.call('channel_receive', { channel_id: d.structuredContent.channel_id })).structuredContent;
    expect(Buffer.from(r.chunks[0].data, 'base64').toString()).toBe('download me\n');
    expect(r).toMatchObject({ final: true, verified: true });
    expect((await A.call('file_download', { path: '/vault/Docs/nope.md' })).isError).toBe(true);
    const noDl = await mk('dl-no', [...TOOLS, ...CHAN, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }]);
    expect((await noDl.call('file_download', { path: '/vault/Docs/dl.md' })).structuredContent.error).toBe('denied');
  });
});

describe('team guardrails on file writes', () => {
  const team = async (limits: Record<string, number> = {}) => {
    const rules = [...BASE_RULES];
    const [c, w] = await Promise.all([mk('coord', rules), mk('worker', rules)]);
    const res = await api('POST', '/teams', { name: `t${Math.random()}`, goal: 'g', grant_messaging: true, limits, members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: w.id, role: 'worker' }] });
    expect(res.status).toBe(201);
    await api('POST', `/teams/${res.body.team.id}/start`);
    return { tid: res.body.team.id as string, c, w };
  };
  it('a paused team cannot write vault files, and can again after resume', async () => {
    const X = await team();
    expect((await X.w.call('file_create', { path: '/vault/Team/a.md', content: 'a' })).isError).toBeFalsy();
    await api('POST', `/teams/${X.tid}/pause`);
    expect((await X.w.call('file_create', { path: '/vault/Team/b.md', content: 'b' })).structuredContent.error).toBe('paused');
    expect(existsSync(join(vaultDir, 'Team', 'b.md'))).toBe(false);
    expect((await X.c.call('share_create', { name: 's', with: [X.w.id] })).isError).toBeFalsy();
    const sid = (await X.c.call('share_list', { mine: true })).structuredContent.shares[0].share_id;
    expect((await X.c.call('share_upload', { share_id: sid, files: [{ path: 'f', content: 'x' }] })).structuredContent.error).toBe('paused');
    await api('POST', `/teams/${X.tid}/resume`);
    expect((await X.w.call('file_create', { path: '/vault/Team/b.md', content: 'b' })).isError).toBeFalsy();
  });
  it('writes_per_hour pauses the team when exceeded', async () => {
    const X = await team({ writes_per_hour: 2 });
    expect((await X.w.call('file_create', { path: '/vault/Team2/a.md', content: 'a' })).isError).toBeFalsy();
    expect((await X.c.call('file_create', { path: '/vault/Team2/b.md', content: 'b' })).isError).toBeFalsy();
    const third = await X.w.call('file_create', { path: '/vault/Team2/c.md', content: 'c' });
    expect(third.structuredContent.error).toBe('paused');
    expect(existsSync(join(vaultDir, 'Team2', 'c.md'))).toBe(false);
    const t = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(t).toMatchObject({ status: 'paused', paused_reason: 'limit:writes' });
  });
});
