import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { sha256Hex } from '../src/util/crypto.js';
import { hashFile } from '../src/channels/channels.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const BRIDGE = join(process.cwd(), '..', 'bridge', 'agent-hub-bridge.mjs');
let app: App, base = '', cookie = '', csrf = '', root = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
const RULES = [
  { effect: 'allow' as const, actions: ['tool.invoke'], resource: 'tool:*' },
  { effect: 'allow' as const, actions: ['message.send', 'message.receive'], resource: 'agent:*' },
  { effect: 'allow' as const, actions: ['channel.use'], resource: 'channel:*' },
  { effect: 'allow' as const, actions: ['channel.open', 'channel.accept'], resource: 'agent:*' },
  { effect: 'allow' as const, actions: ['share.create', 'share.upload', 'share.read', 'share.promote'], resource: 'share:*' },
  { effect: 'allow' as const, actions: ['fs.list', 'fs.read', 'fs.create', 'fs.update', 'fs.download', 'fs.history'], resource: 'path:/vault/**' },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, ms = 60_000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}
PC1 log: ${PC1?.log.join('').slice(-1500)}
PC2 log: ${PC2?.log.join('').slice(-1500)}`);
    await sleep(40);
  }
}

interface Pc { id: string; appKey: string; home: string; dir: string; proc?: ChildProcess; log: string[] }
async function makePc(name: string): Promise<Pc> {
  const id = (await api('POST', '/pcs', { name })).body.pc.id as string;
  const appKey = app.keys.createAppKey({ machineId: id, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
  const dir = join(root, name), home = join(root, `${name}-home`);
  mkdirSync(dir, { recursive: true });
  app.db.prepare("INSERT INTO machine_folders(machine_id,path,status,proposed_at,decided_at) VALUES (?,?,'approved',?,?)").run(id, dir, Date.now(), Date.now());
  const letters = 'abcdefghijklmnopqrstuvwxyz234567';
  const code = Array.from(randomBytes(12), (b) => letters[b % 32]).join('');
  const now = Date.now();
  app.db.prepare('INSERT INTO setup_keys(id,machine_id,key_id,verifier,created_at,expires_at,pairing_hash,pairing_expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(`stp_${name}`, id, `kid${name}`, 'x', now, now + 3600_000, sha256Hex(code), now + 900_000);
  await promisify(execFile)(process.execPath, [BRIDGE, 'pair', base, code.toUpperCase()], { env: { ...process.env, AGENT_HUB_HOME: home } });
  return { id, appKey, home, dir, log: [] };
}
function startBridge(pc: Pc, throttleMs = 0) {
  const p = spawn(process.execPath, [BRIDGE, 'run'], { env: { ...process.env, AGENT_HUB_HOME: pc.home, AGENT_HUB_THROTTLE_MS: String(throttleMs) }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.on('data', (d) => pc.log.push(String(d)));
  p.stderr!.on('data', (d) => pc.log.push(String(d)));
  pc.proc = p;
}
async function stopBridge(pc: Pc) {
  const p = pc.proc;
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.kill('SIGKILL');
  await new Promise((r) => p.once('exit', r));
}
async function login(pc: Pc, label: string) {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, RULES, 'test', sys);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${pc.appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as any).structuredContent.session_token as string;
  const call: Call = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
  return { id: agent.id, call };
}
function listFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.startsWith('.ah-')) out.set(relative(dir, p).split(sep).join('/'), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}
const row = (id: string) => app.channels.get(id)!;
/** The receiving bridge unpacks right after the hub says done: wait until the part file is gone. */
const unpacked = (dst: string) => until(() => existsSync(dst) && !readdirSync(dst).some((n) => n.startsWith('.ah-')) && readdirSync(dst).length > 0, 20_000, 'files unpacked');

let PC1: Pc, PC2: Pc, S: Awaited<ReturnType<typeof login>>, R: Awaited<ReturnType<typeof login>>;
let src = '';
let holdCommitFor = '';
let commitReached = false;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ah4bb-'));
  const vaultDir = join(root, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(root, { vaultDir, channelBufferBytes: 4 * 1024 * 1024, maintenanceSeconds: undefined });
  app = await buildApp(config);
  app.fastify.addHook('preHandler', async (req, reply) => {
    if (holdCommitFor && req.url === `/bridge/channels/${holdCommitFor}/done` &&
        (req.body as { committed?: boolean } | undefined)?.committed) {
      commitReached = true;
      return reply.code(503).send({ error: 'test_interruption' });
    }
  });
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  PC1 = await makePc('pc1');
  PC2 = await makePc('pc2');
  S = await login(PC1, 'sender');
  R = await login(PC2, 'receiver');
  // ~20 MB project with things the bridge must skip
  src = join(PC1.dir, 'project');
  const w = (rel: string, data: Buffer | string) => { const p = join(src, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); };
  w('big.bin', randomBytes(12 * 1024 * 1024));
  w('mid/data.bin', randomBytes(7 * 1024 * 1024 + 11));
  w('mid/sub/a.txt', 'alpha\n');
  w('notes.md', '# notes\n');
  w('keep.log', 'kept\n');
  w('debug.log', 'ignored by .gitignore\n');
  w('build/out.js', 'ignored dir\n');
  w('.gitignore', '*.log\n!keep.log\nbuild/\n');
  w('.git/config', '[core]\n');
  w('node_modules/pkg/index.js', 'x\n');
  w('.env', 'SECRET=1\n');
  w('.env.local', 'SECRET=2\n');
}, 60_000);
afterAll(async () => { await stopBridge(PC1); await stopBridge(PC2); await app.close(); });

const EXPECT = ['.gitignore', 'big.bin', 'keep.log', 'mid/data.bin', 'mid/sub/a.txt', 'notes.md'];
async function offer(save_to: string, local = src) {
  const o = await S.call('channel_open', { to: `agent:${R.id}`, purpose: 'project', local_path: local });
  expect(o.isError, JSON.stringify(o.structuredContent)).toBeFalsy();
  const cid = o.structuredContent.channel_id as string;
  for (let i = 0; i < 20; i++) {
    const w = (await R.call('work_next', { wait_seconds: 0 })).structuredContent;
    expect(w.status).toBe('item');
    await R.call('work_ack', { item_id: w.item.item_id });
    if (w.item.kind === 'channel_offer' && w.item.channel.channel_id === cid) break;
  }
  const a = await R.call('channel_accept', { channel_id: cid, save_to });
  return { cid, a };
}

describe('bridge mode', () => {
  it('refuses paths outside the approved folders at the hub', async () => {
    const outside = join(root, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    expect((await S.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', local_path: outside })).structuredContent.error).toBe('denied');
    expect((await S.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', local_path: join(PC1.dir, '..', 'elsewhere') })).structuredContent.error).toBe('denied');
    const ok = await S.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', local_path: src });
    expect(ok.structuredContent.mode).toBe('bridge');
    const cid = ok.structuredContent.channel_id;
    expect((await R.call('channel_accept', { channel_id: cid, save_to: outside })).structuredContent.error).toBe('denied');
    // a session of PC2 cannot send from PC1's folders: the path is checked against the session's own PC
    expect((await R.call('channel_open', { to: `agent:${S.id}`, purpose: 'x', local_path: src })).structuredContent.error).toBe('denied');
    await S.call('channel_close', { channel_id: cid });
    // no bridge, no bridge mode
    const lone = app.keys.createMachine('nobridge', null, sys);
    const k = app.keys.createAppKey({ machineId: lone.id, appName: 'x' }, sys).secret;
    const L = await login({ ...PC1, appKey: k }, 'lone');
    expect((await L.call('channel_open', { to: `agent:${S.id}`, purpose: 'x', local_path: src })).structuredContent.error).toBe('bridge_required');
  });

  it('streams a ~20 MB folder agent to agent through two real bridges, in memory only, bytes identical', async () => {
    startBridge(PC1); startBridge(PC2);
    const dst = join(PC2.dir, 'inbox', 'one');
    const { cid, a } = await offer(dst);
    expect(a.structuredContent).toMatchObject({ status: 'open', save_to: dst });
    const done = await until(() => row(cid).status === 'done' && row(cid), 60_000, 'channel done');
    await unpacked(dst);
    expect(done.failure_reason).toBeNull();
    const got = listFiles(dst), want = listFiles(src);
    expect([...got.keys()].sort()).toEqual(EXPECT);
    for (const k of EXPECT) expect(got.get(k), k).toBe(want.get(k));
    // the hub only ever held a bounded window, and wrote nothing to disk
    expect(app.channels.peakBuffered).toBeGreaterThan(0);
    expect(app.channels.peakBuffered).toBeLessThanOrEqual(4 * 1024 * 1024 + 1024 * 1024);
    expect(app.channels.buffered).toBe(0);
    expect(existsSync(join(app.config.dataDir, 'tmp', `chan-${cid}.part`))).toBe(false);
    expect(readdirSync(dst).filter((n) => n.startsWith('.ah-'))).toEqual([]);
    const st = (await S.call('channel_status', { channel_id: cid })).structuredContent;
    expect(st).toMatchObject({ status: 'done', bytes_moved: st.size, result: { path: dst, size: st.size } });
    expect(st.result.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // both sessions are told through work_next
    for (const who of [S, R]) {
      const msgs: string[] = [];
      for (let i = 0; i < 4; i++) { const n = (await who.call('work_next', { wait_seconds: 0 })).structuredContent; if (n.status !== 'item') break; msgs.push(n.item.content); await who.call('work_ack', { item_id: n.item.item_id }); }
      expect(msgs.some((m) => m.includes('done') && m.includes('sha256 ok'))).toBe(true);
    }
  }, 90_000);

  it('resumes after the receiving bridge is killed mid-transfer', async () => {
    await stopBridge(PC1); await stopBridge(PC2);
    startBridge(PC1, 80); startBridge(PC2, 80);
    const dst = join(PC2.dir, 'inbox', 'two');
    const { cid } = await offer(dst);
    await until(() => row(cid).confirmed_offset > 3 * 1024 * 1024, 60_000, 'receiver progress');
    await stopBridge(PC2);
    const at = row(cid).confirmed_offset;
    expect(row(cid).status).toBe('open');
    expect(at).toBeLessThan(row(cid).size ?? Infinity);
    await sleep(500);
    expect(row(cid).status).toBe('open');
    startBridge(PC2, 0);
    await until(() => row(cid).status === 'done', 60_000, 'resumed transfer');
    await unpacked(dst);
    const got = listFiles(dst), want = listFiles(src);
    expect([...got.keys()].sort()).toEqual(EXPECT);
    for (const k of EXPECT) expect(got.get(k), k).toBe(want.get(k));
    expect(PC2.log.join('')).not.toContain('crashed');
  }, 120_000);

  it('resumes after the sending bridge is killed mid-transfer', async () => {
    await stopBridge(PC1); await stopBridge(PC2);
    startBridge(PC1, 80); startBridge(PC2, 0);
    const dst = join(PC2.dir, 'inbox', 'three');
    const { cid } = await offer(dst);
    await until(() => row(cid).received_offset > 3 * 1024 * 1024, 60_000, 'sender progress');
    await stopBridge(PC1);
    expect(row(cid).status).toBe('open');
    startBridge(PC1, 0);
    await until(() => row(cid).status === 'done', 60_000, 'resumed transfer');
    await unpacked(dst);
    const got = listFiles(dst), want = listFiles(src);
    for (const k of EXPECT) expect(got.get(k), k).toBe(want.get(k));
    expect([...got.keys()].sort()).toEqual(EXPECT);
  }, 120_000);

  it('reoffers a verified receive after restart before commit was acknowledged', async () => {
    await stopBridge(PC1); await stopBridge(PC2);
    const srcFile = join(PC1.dir, 'commit-test.txt');
    writeFileSync(srcFile, 'verify, publish, acknowledge');
    const dst = join(PC2.dir, 'commit-test');
    const { cid } = await offer(dst, srcFile);
    holdCommitFor = cid;
    commitReached = false;
    try {
      startBridge(PC1); startBridge(PC2);
      await until(() => commitReached, 20_000, 'first commit attempt');
      expect(row(cid)).toMatchObject({ status: 'open', receiver_done: 1, receiver_committed: 0 });
      await stopBridge(PC2);
    } finally { holdCommitFor = ''; }
    startBridge(PC2);
    await until(() => row(cid).status === 'done', 20_000, 'commit after receiver restart');
    await unpacked(dst);
    expect(readFileSync(join(dst, 'commit-test.txt'), 'utf8')).toBe('verify, publish, acknowledge');
  }, 50_000);

  it('the bridge itself refuses paths outside its allowed folders, even when the hub asks', async () => {
    await stopBridge(PC1); await stopBridge(PC2);
    startBridge(PC1, 0);
    const outside = join(root, 'elsewhere2');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    // sender side: the hub row is tampered to point outside
    const o = await S.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', local_path: src });
    const cid = o.structuredContent.channel_id as string;
    app.db.prepare('UPDATE data_channels SET from_local_path=? WHERE id=?').run(outside, cid);
    await R.call('channel_accept', { channel_id: cid, save_to: join(PC2.dir, 'inbox', 'four') });
    await until(() => row(cid).status === 'failed', 20_000, 'bridge refusal');
    expect(row(cid).failure_reason).toBe('bridge_error');
    expect(JSON.parse(row(cid).result!).message).toContain('outside the allowed folders');
    expect(existsSync(join(PC2.dir, 'inbox', 'four', 'secret.txt'))).toBe(false);
    // receiver side: the hub row is tampered after the hub's own check
    await stopBridge(PC2);
    const o2 = await S.call('channel_open', { to: `agent:${R.id}`, purpose: 'x', local_path: src });
    const c2 = o2.structuredContent.channel_id as string;
    await R.call('channel_accept', { channel_id: c2, save_to: join(PC2.dir, 'inbox', 'five') });
    const evil = join(root, 'evil-target');
    app.db.prepare('UPDATE data_channels SET to_local_path=? WHERE id=?').run(evil, c2);
    startBridge(PC2, 0);
    await until(() => row(c2).status === 'failed', 20_000, 'receiver refusal');
    expect(JSON.parse(row(c2).result!).message).toContain('allowed folders');
    expect(existsSync(evil)).toBe(false);
  }, 60_000);

  it('uploads a local file into the vault with the CAS check, and downloads it back with file_download', async () => {
    await stopBridge(PC1); await stopBridge(PC2);
    startBridge(PC1, 0);
    const file = join(PC1.dir, 'attach.bin');
    const bytes = randomBytes(3 * 1024 * 1024 + 5);
    writeFileSync(file, bytes);
    const o = await S.call('channel_open', { to: 'vault:/vault/Attachments/attach.bin', purpose: 'attachment', local_path: file });
    expect(o.structuredContent).toMatchObject({ mode: 'bridge', status: 'open' });
    const cid = o.structuredContent.channel_id as string;
    await until(() => ['done', 'failed'].includes(row(cid).status), 30_000, 'upload');
    expect(row(cid).status, row(cid).failure_reason ?? '').toBe('done');
    const rev = JSON.parse(row(cid).result!).revision as string;
    expect(rev).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(readFileSync(join(app.config.vaultDir, 'Attachments', 'attach.bin')).equals(bytes)).toBe(true);
    expect(existsSync(join(app.config.dataDir, 'tmp', `chan-${cid}.part`))).toBe(false);
    expect(app.db.prepare("SELECT op, agent_id FROM file_revisions WHERE revision=?").get(rev)).toMatchObject({ op: 'create', agent_id: S.id });
    // creating again: conflict, nothing overwritten
    const o2 = await S.call('channel_open', { to: 'vault:/vault/Attachments/attach.bin', purpose: 'again', local_path: file });
    await until(() => ['done', 'failed'].includes(row(o2.structuredContent.channel_id).status), 30_000, 'second upload');
    expect(row(o2.structuredContent.channel_id)).toMatchObject({ status: 'failed', failure_reason: 'conflict' });

    // download to the PC
    const target = join(PC1.dir, 'downloads', 'copy.bin');
    const d = await S.call('file_download', { path: '/vault/Attachments/attach.bin', local_path: target });
    expect(d.isError, JSON.stringify(d.structuredContent)).toBeFalsy();
    await until(() => ['done', 'failed'].includes(row(d.structuredContent.channel_id).status), 30_000, 'download');
    expect(row(d.structuredContent.channel_id).status).toBe('done');
    await until(() => existsSync(target), 10_000, 'download renamed');
    expect(readFileSync(target).equals(bytes)).toBe(true);
    expect(await hashFile(target)).toBe(rev);
    expect((await S.call('file_download', { path: '/vault/Attachments/attach.bin', local_path: join(root, 'nowhere', 'x.bin') })).structuredContent.error).toBe('denied');
  }, 90_000);

  it('uploads a folder as a share version through the bridge, and downloads a version back', async () => {
    await stopBridge(PC1); await stopBridge(PC2);
    startBridge(PC1, 0); startBridge(PC2, 0);
    const folder = join(PC1.dir, 'sharedir');
    mkdirSync(join(folder, 'sub'), { recursive: true });
    mkdirSync(join(folder, 'node_modules'), { recursive: true });
    writeFileSync(join(folder, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(folder, 'sub', 'b.bin'), Buffer.from([0, 255, 1, 2]));
    writeFileSync(join(folder, 'node_modules', 'x.js'), 'no');
    writeFileSync(join(folder, '.env'), 'KEY=v');
    const sid = (await S.call('share_create', { name: 'folder', with: [R.id] })).structuredContent.share_id as string;
    const up = await S.call('share_upload', { share_id: sid, local_folder: folder, note: 'v1 from disk' });
    expect(up.isError, JSON.stringify(up.structuredContent)).toBeFalsy();
    const cid = up.structuredContent.channel_id as string;
    await until(() => ['done', 'failed'].includes(row(cid).status), 30_000, 'share upload');
    expect(row(cid).status, row(cid).failure_reason ?? '').toBe('done');
    const info = (await R.call('share_info', { share_id: sid })).structuredContent;
    expect(info).toMatchObject({ version: 1, note: 'v1 from disk' });
    expect(info.files.map((f: any) => f.path)).toEqual(['a.txt', 'sub/b.bin']);
    expect((await R.call('share_read', { share_id: sid, version: 1, path: 'a.txt' })).structuredContent.content).toBe('one\ntwo\n');
    // download the version to the receiver's PC
    const dl = join(PC2.dir, 'got-share');
    const d = await R.call('share_download', { share_id: sid, version: 1, local_path: dl });
    expect(d.isError, JSON.stringify(d.structuredContent)).toBeFalsy();
    await until(() => ['done', 'failed'].includes(row(d.structuredContent.channel_id).status), 30_000, 'share download');
    expect(row(d.structuredContent.channel_id).status).toBe('done');
    expect(readFileSync(join(dl, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect([...readFileSync(join(dl, 'sub', 'b.bin'))]).toEqual([0, 255, 1, 2]);
    expect(statSync(dl).isDirectory()).toBe(true);
  }, 90_000);
});
