/**
 * Slice 1b of the next release (docs/transfers.md, docs/vault.md):
 * 1. A download rechecks, at every chunk it delivers, the app key the login came through and that key's cap: an app key
 *    revoked or capped between the request and the delivery gets nothing more, inline or over the bridge.
 * 2. Vault recovery brings the graph in line with the committed revision of each file it finds a write intent for,
 *    renames and deletes included, and running it twice gives the same result with no second index job.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { BRIDGE_CHUNK } from '../src/channels/channels.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', vaultDir = '', pc = '';
type Res = { isError?: boolean; structuredContent?: any };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const CHAN: Rules = [{ effect: 'allow', actions: ['channel.use'], resource: 'channel:*' }];
const FS_DOCS: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.download'], resource: 'path:/vault/Docs/**' }];
/** A cap that still lets the login work and read, but no longer download. */
const NO_DOWNLOAD_CAP: Rules = [...TOOLS, ...CHAN, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/**' }];

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const bigText = (n: number) => Buffer.from('0123456789abcdef\n'.repeat(Math.ceil(n / 17)).slice(0, n));

/** A reader with its own app key, so the test can revoke or cap that key alone. */
async function reader(label: string) {
  const appCred = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', label: `${label} app`, maxLiveSessions: 10 }, sys);
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [...TOOLS, ...CHAN, ...FS_DOCS], 'test', sys);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appCred.secret}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as any).structuredContent.session_token as string;
  const call: Call = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
  return { id: agent.id, cred: k.credential, app: appCred.credential, call };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahdr-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'Docs'), { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, maintenanceSeconds: undefined, graph: { debounceMs: 0 } });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
});
afterAll(async () => { await app.close(); });

describe('1. a download rechecks its app key and cap at delivery', () => {
  const inline = async (label: string, file: string) => {
    writeFileSync(join(vaultDir, 'Docs', file), bigText(200_000));
    const R = await reader(label);
    const opened = await R.call('file_download', { path: `/vault/Docs/${file}` });
    expect(opened.isError).toBeFalsy();
    const ch = opened.structuredContent.channel_id as string;
    expect(app.channels.get(ch)).toMatchObject({ from_app_credential_id: R.app.id });
    const first = (await R.call('channel_receive', { channel_id: ch })).structuredContent;
    expect(first).toMatchObject({ status: 'open', final: false });
    expect(first.chunks.length).toBeGreaterThan(0);
    return { R, ch };
  };

  it('an inline download gets no further chunk once its app key is capped', async () => {
    const { R, ch } = await inline('dl-cap', 'cap.txt');
    app.keys.setRules(R.app.policy_id, NO_DOWNLOAD_CAP, 'capped', sys);
    const next = (await R.call('channel_receive', { channel_id: ch })).structuredContent;
    expect(next).toMatchObject({ status: 'failed', failure_reason: 'denied', chunks: [] });
    expect(app.channels.get(ch)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('an inline download gets no further chunk once its app key is revoked', async () => {
    const { R, ch } = await inline('dl-app-revoked', 'revoked.txt');
    app.keys.setStatus(R.app.id, 'revoked', 'test', sys);
    // The hub refuses the revoked app key at the door; the channel itself fails at the next sweep instead of waiting to expire.
    const next = await R.call('channel_receive', { channel_id: ch }).catch((e: Error) => e);
    expect(next).toBeInstanceOf(Error);
    expect((next as Error).message).toMatch(/app key/i);
    app.channels.sweep();
    expect(app.channels.get(ch)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('a cap that still allows downloading lets the inline download go on', async () => {
    const { R, ch } = await inline('dl-cap-ok', 'cap-ok.txt');
    app.keys.setRules(R.app.policy_id, [...NO_DOWNLOAD_CAP, { effect: 'allow', actions: ['fs.download'], resource: 'path:/vault/Docs/**' }], 'still allowed', sys);
    const next = (await R.call('channel_receive', { channel_id: ch })).structuredContent;
    expect(next.status).not.toBe('failed');
    expect(next.chunks.length).toBeGreaterThan(0);
  });

  const bridge = async (label: string, file: string) => {
    const bytes = bigText(BRIDGE_CHUNK + 300_000);
    writeFileSync(join(vaultDir, 'Docs', file), bytes);
    const R = await reader(label);
    const c = app.channels.open({ from: { agentId: R.id, credId: R.cred.id, machineId: pc, appId: R.app.id }, targetKind: 'vault', target: `/vault/Docs/${file}`, direction: 'download', mode: 'bridge', toLocalPath: `C:/dl/${file}`, framing: 'raw', size: bytes.length, sha256: sha(bytes), purpose: 'test' });
    const first = await app.channels.get_chunk(pc, c.id, 0);
    expect(first.status).toBe(200);
    expect(first.data!.length).toBe(BRIDGE_CHUNK);
    return { R, id: c.id };
  };

  it('a bridge download serves no further chunk once its app key is capped', async () => {
    const { R, id } = await bridge('br-cap', 'br-cap.txt');
    app.keys.setRules(R.app.policy_id, NO_DOWNLOAD_CAP, 'capped', sys);
    const next = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
    expect(next.status).toBe(410);
    expect(next.data).toBeUndefined();
    expect(app.channels.get(id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('a bridge download serves no further chunk once its app key is revoked', async () => {
    const { R, id } = await bridge('br-revoked', 'br-revoked.txt');
    app.keys.setStatus(R.app.id, 'revoked', 'test', sys);
    const next = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
    expect(next.status).toBe(410);
    expect(next.data).toBeUndefined();
    expect(app.channels.get(id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
  });

  it('a bridge download whose app key is untouched still completes', async () => {
    const { id } = await bridge('br-ok', 'br-ok.txt');
    const second = await app.channels.get_chunk(pc, id, BRIDGE_CHUNK);
    expect(second.status).toBe(200);
    expect(second.data!.length).toBe(300_000);
  });
});

describe('2. recovery reconciles the graph with the committed revision', () => {
  const who = {};
  const rev = (path: string) => app.store.fileByPath(path)!.current_revision!;
  const fileId = (path: string) => app.store.fileByPath(path, true)!.id;
  const create = (path: string, text: string) => app.store.write(path.split('/'), Buffer.from(text), 'absent', 'create', who);
  const update = (path: string, text: string) => app.store.write(path.split('/'), Buffer.from(text), rev(path), 'update', who);
  const GRAPH = ['kg_sections', 'kg_signals'] as const;
  type Snap = Record<(typeof GRAPH)[number], Record<string, unknown>[]>;
  /** The graph's rows, without the time a signal was last seen (a later pass may touch it). */
  const snap = (): Snap => Object.fromEntries(GRAPH.map((t) => [t, (app.db.prepare(`SELECT * FROM ${t} ORDER BY 1,2,3`).all() as Record<string, unknown>[]).map(({ seen_at: _s, ...r }) => r)])) as Snap;
  /** Put the graph back as it was: the change reached the files table, but the graph never heard of it (a crash). */
  const rollBack = (s: Record<string, Record<string, unknown>[]>) => {
    for (const t of GRAPH) {
      app.db.prepare(`DELETE FROM ${t}`).run();
      for (const r of s[t]) {
        const row = t === 'kg_signals' ? { ...r, seen_at: 0 } : r;
        const cols = Object.keys(row);
        app.db.prepare(`INSERT INTO ${t}(${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
      }
    }
  };
  const rawSnap = () => Object.fromEntries(GRAPH.map((t) => [t, app.db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]]));
  /** The intent a crash after the commit but before the graph heard of it leaves behind. */
  const intent = (op: 'write' | 'delete' | 'rename', path: string, extra: { new_path?: string; new_revision?: string; base_revision?: string } = {}) =>
    app.db.prepare('INSERT INTO write_intents(id,op,path,new_path,base_revision,new_revision,origin,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(`wi_${randomUUID()}`, op, path, extra.new_path ?? null, extra.base_revision ?? null, extra.new_revision ?? null, 'platform', Date.now());
  const signals = (src: string) => app.db.prepare('SELECT dst_file, kind FROM kg_signals WHERE src_file=? ORDER BY dst_file').all(src) as { dst_file: string; kind: string }[];
  const touching = (id: string) => (app.db.prepare('SELECT (SELECT COUNT(*) FROM kg_sections WHERE file_id=?) + (SELECT COUNT(*) FROM kg_signals WHERE src_file=? OR dst_file=?) n').get(id, id, id) as { n: number }).n;
  const indexJobs = (id: string) => (app.db.prepare("SELECT COUNT(*) n FROM kg_jobs WHERE dedupe_key=? AND state='queued'").get(`index_note:${id}`) as { n: number }).n;
  /** Recovery twice: the first pass reconciles, the second changes nothing and adds no job. */
  const recoverTwice = async (ids: string[]) => {
    await app.store.recover();
    const once = snap(), jobs = ids.map(indexJobs);
    expect(app.db.prepare('SELECT COUNT(*) n FROM write_intents').get()).toEqual({ n: 0 });
    await app.store.recover();
    expect(snap()).toEqual(once);
    expect(ids.map(indexJobs)).toEqual(jobs);
    for (const n of jobs) expect(n).toBeLessThanOrEqual(1);
  };

  it('a write the graph missed is indexed from the committed revision, once', async () => {
    await create('Docs/Write.md', '# Write\n\nThe first text.\n');
    const before = rawSnap();
    await update('Docs/Write.md', '# Write\n\nThe second text.\n\n## More\n\nLinks to [[Target]].\n');
    const after = snap();
    rollBack(before);
    intent('write', 'Docs/Write.md', { new_revision: rev('Docs/Write.md') });
    await recoverTwice([fileId('Docs/Write.md')]);
    expect(snap()).toEqual(after);
    expect(indexJobs(fileId('Docs/Write.md'))).toBe(1);
  });

  it('a delete the graph missed leaves no sections or links of the deleted note', async () => {
    await create('Docs/Gone.md', '# Gone\n\nA note that will be deleted. See [[Keep]].\n');
    await create('Docs/Keep.md', '# Keep\n\nPoints at [[Gone]].\n');
    const gone = fileId('Docs/Gone.md');
    expect(touching(gone)).toBeGreaterThan(0);
    const before = rawSnap();
    await app.store.delete(['Docs', 'Gone.md'], rev('Docs/Gone.md'), who);
    expect(touching(gone)).toBe(0);
    rollBack(before);
    expect(touching(gone)).toBeGreaterThan(0);
    intent('delete', 'Docs/Gone.md');
    await recoverTwice([gone, fileId('Docs/Keep.md')]);
    expect(touching(gone)).toBe(0);
    expect(indexJobs(gone)).toBe(0);
  });

  it('a rename the graph missed moves links to the new name in both directions', async () => {
    await create('Docs/Old.md', '# Old\n\nThe note to rename. It links to [[Keep]].\n');
    await create('Docs/ByOld.md', '# By old\n\nLinks to [[Old]].\n');
    await create('Docs/ByNew.md', '# By new\n\nLinks to [[New]].\n');
    const moved = fileId('Docs/Old.md'), byOld = fileId('Docs/ByOld.md'), byNew = fileId('Docs/ByNew.md'), keep = fileId('Docs/Keep.md');
    expect(signals(byOld).map((s) => s.dst_file)).toContain(moved);
    expect(signals(byNew).map((s) => s.dst_file)).toContain('name:new');
    const before = rawSnap();
    await app.store.rename(['Docs', 'Old.md'], ['Docs', 'New.md'], rev('Docs/Old.md'), who);
    const after = snap();
    rollBack(before);
    intent('rename', 'Docs/Old.md', { new_path: 'Docs/New.md' });
    await recoverTwice([moved, byOld, byNew]);
    expect(snap()).toEqual(after);
    // No stale content: a link by the old name no longer reaches the note, a link by its new name does.
    expect(signals(byOld).map((s) => s.dst_file)).not.toContain(moved);
    expect(signals(byOld).map((s) => s.dst_file)).toContain('name:old');
    expect(signals(byNew).map((s) => s.dst_file)).toContain(moved);
    expect(signals(moved).map((s) => s.dst_file)).toContain(keep);
    expect(indexJobs(moved)).toBeLessThanOrEqual(1);
  });

  it('a live rename updates the graph without recovery', async () => {
    await create('Docs/Live.md', '# Live\n\nThe note to rename.\n');
    await create('Docs/ByLive.md', '# By live\n\nLinks to [[Live]] and [[Renamed]].\n');
    const live = fileId('Docs/Live.md'), by = fileId('Docs/ByLive.md');
    expect(signals(by).map((s) => s.dst_file)).toEqual(expect.arrayContaining([live, 'name:renamed']));
    await app.store.rename(['Docs', 'Live.md'], ['Docs', 'Renamed.md'], rev('Docs/Live.md'), who);
    const dst = signals(by).map((s) => s.dst_file);
    expect(dst).toEqual(expect.arrayContaining([live, 'name:live']));
    expect(dst).not.toContain('name:renamed');
  });

  it('a note renamed out of Markdown leaves the graph', async () => {
    await create('Docs/Leaves.md', '# Leaves\n\nThis becomes plain text.\n');
    const id = fileId('Docs/Leaves.md');
    expect(touching(id)).toBeGreaterThan(0);
    await app.store.rename(['Docs', 'Leaves.md'], ['Docs', 'Leaves.txt'], rev('Docs/Leaves.md'), who);
    expect(touching(id)).toBe(0);
    expect(indexJobs(id)).toBe(0);
  });

  it('a rename whose old path was reused since reports the renamed file at its new path, not the new file', async () => {
    await create('Docs/Reused.md', '# Reused\n\nThe note to rename.\n');
    const moved = fileId('Docs/Reused.md'), base = rev('Docs/Reused.md');
    await app.store.rename(['Docs', 'Reused.md'], ['Docs', 'Moved.md'], base, who);
    await create('Docs/Reused.md', '# Reused\n\nA new note at the old name.\n');
    const fresh = fileId('Docs/Reused.md');
    expect(fresh).not.toBe(moved);
    intent('rename', 'Docs/Reused.md', { new_path: 'Docs/Moved.md', base_revision: base });
    const seen: { fileId: string; path: string }[] = [];
    const spy = (e: { fileId: string; path: string }) => { seen.push({ fileId: e.fileId, path: e.path }); };
    app.store.listeners.push(spy);
    try { await app.store.recover(); } finally { app.store.listeners.splice(app.store.listeners.indexOf(spy), 1); }
    expect(seen).toEqual([{ fileId: moved, path: 'Docs/Moved.md' }]);
    expect(app.db.prepare('SELECT COUNT(*) n FROM write_intents').get()).toEqual({ n: 0 });
    // Neither file moved: the renamed note stays at its new name, the new note at the old one.
    expect(app.store.fileByPath('Docs/Moved.md')!.id).toBe(moved);
    expect(app.store.fileByPath('Docs/Reused.md')!.id).toBe(fresh);
  });

  it('a change the graph failed to take keeps its intent, and the next scan gives it to the graph', async () => {
    await create('Docs/Retry.md', '# Retry\n\nThe first text.\n');
    const id = fileId('Docs/Retry.md');
    const graph = app.graph as unknown as { onRevision: (e: unknown) => void };
    const onRevision = graph.onRevision;
    graph.onRevision = () => { throw new Error('graph down'); };
    try { await update('Docs/Retry.md', '# Retry\n\nThe second text links to [[Keep]].\n'); } finally { graph.onRevision = onRevision; }
    // The write is committed, but the graph has not seen it: the intent stays.
    expect(app.db.prepare("SELECT op, path FROM write_intents WHERE path='Docs/Retry.md'").all()).toEqual([{ op: 'write', path: 'Docs/Retry.md' }]);
    expect(signals(id).map((s) => s.dst_file)).not.toContain(fileId('Docs/Keep.md'));
    await app.store.scan();
    expect(app.db.prepare('SELECT COUNT(*) n FROM write_intents').get()).toEqual({ n: 0 });
    expect(signals(id).map((s) => s.dst_file)).toContain(fileId('Docs/Keep.md'));
    // A failure on the retry keeps it again; it is not lost.
    graph.onRevision = () => { throw new Error('graph down'); };
    try { await update('Docs/Retry.md', '# Retry\n\nThe third text.\n'); await app.store.scan(); } finally { graph.onRevision = onRevision; }
    expect(app.db.prepare("SELECT COUNT(*) n FROM write_intents WHERE path='Docs/Retry.md'").get()).toEqual({ n: 1 });
    await app.store.scan();
    expect(app.db.prepare('SELECT COUNT(*) n FROM write_intents').get()).toEqual({ n: 0 });
    expect(signals(id).map((s) => s.dst_file)).not.toContain(fileId('Docs/Keep.md'));
  });

  it('recovery with nothing to recover leaves the graph as it is', async () => {
    const s = snap();
    await app.store.recover();
    expect(snap()).toEqual(s);
  });
});
