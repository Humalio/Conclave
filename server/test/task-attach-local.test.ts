/**
 * Task files from the PC (docs/transfers.md, "Task files from the PC"): task_create, task_update and task_submit take local
 * paths; the PC's connector uploads the files through the bridge routes with the PC's app key, reading only from the
 * calling agent's own folder by its real path, and the hub writes them into the task's set with the inline rules. These
 * tests run the connector's real transfer loop against the hub.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig } from './hub.js';
import { runLoop } from '../../deploy/client/connector/transfers.mjs';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, root: string, connHome: string;
const clients: Client[] = [];
const loop = new AbortController();
/** Each agent's folder on the PC, as the connector registered it. */
const folders = new Map<string, string>();

/** A PC whose connector checked in (or not), with its app key. */
function pc(name: string, connector: boolean) {
  const m = app.keys.createMachine(name, null, sys);
  if (connector) app.db.prepare("INSERT INTO connector_reports(machine_id, agents, first_check_in_at, last_check_in_at) VALUES (?, '[]', ?, ?)").run(m.id, Date.now(), Date.now());
  return { id: m.id, key: app.keys.createAppKey({ machineId: m.id, appName: 'conclave-connector', maxLiveSessions: 50 }, sys).secret };
}
let home: { id: string; key: string };

async function agent(label: string, via = home) {
  const a = app.keys.createAgent(label, null, sys);
  const key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  const client = new Client({ name: label, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${via.key}` } } }));
  const login = await client.callTool({ name: 'session_login', arguments: { session_key: key.secret } });
  const token = login.structuredContent!.session_token;
  const folder = join(root, label);
  mkdirSync(folder, { recursive: true });
  folders.set(label, folder);
  return {
    id: a.id, label, folder,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { session_token: token, ...args } });
      return { error: !!result.isError, data: result.structuredContent as Record<string, any>, text: (result.content as { text?: string }[]).map((c) => c.text ?? '').join(' ') };
    },
  };
}
type Agent = Awaited<ReturnType<typeof agent>>;

async function team(name: string, via = home) {
  const [coord, worker, reviewer] = await Promise.all(['coord', 'worker', 'reviewer'].map((l) => agent(`${name}-${l}`, via)));
  const t = app.teams.create({ name, goal: 'Local files', grant_messaging: true, members: [
    { agent_id: coord!.id, role: 'coordinator' }, { agent_id: worker!.id, role: 'worker' }, { agent_id: reviewer!.id, role: 'reviewer' },
  ] }, sys);
  app.teams.start(t.id, sys);
  return { t, coord: coord!, worker: worker!, reviewer: reviewer! };
}
type Team = Awaited<ReturnType<typeof team>>;
async function started(f: Team) {
  const c = await f.coord.call('task_create', { team_id: f.t.id, title: 'Show the screen', reviewer: f.reviewer.id });
  expect(c.error, c.text).toBe(false);
  const id = c.data.task.id as string;
  expect((await f.coord.call('task_assign', { task_id: id, agent_id: f.worker.id })).error).toBe(false);
  expect((await f.worker.call('task_start', { task_id: id })).error).toBe(false);
  return id;
}
/** A PNG of about `kb` KB: the signature, then noise. */
function png(path: string, kb: number) {
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(kb * 1024 - 8)]));
  return path;
}
const channel = (id: string) => app.db.prepare('SELECT status, failure_reason, result FROM data_channels WHERE id=?').get(id) as { status: string; failure_reason: string | null; result: string | null };
async function settled(id: string) {
  for (let i = 0; i < 300; i++) {
    const c = channel(id);
    if (!['offered', 'open'].includes(c.status)) return { ...c, result: c.result ? JSON.parse(c.result) as Record<string, any> : null };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`channel ${id} did not end`);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-attachlocal-'));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-attachlocal-pc-')));
  connHome = join(root, 'connector-home');
  mkdirSync(connHome);
  const vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp(testConfig(dir, { dbFile: join(dir, 'data', 'test.db'), vaultDir, pepper: 'test', publicUrl: 'http://fixture.test', adminPassword: 'fixture password' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  home = pc('attach-pc', true);
  // The connector's service on that PC: its transfer loop, with the agents' registered folders and its own folder.
  void runLoop({ hub: base, key: home.key, signal: loop.signal, log: () => {}, agentFolders: (label: string) => (folders.has(label) ? [folders.get(label)!] : []), refusedDirs: [connHome] });
});
afterAll(async () => { loop.abort(); await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('task files from the PC', () => {
  it('a 300 KB screenshot by local_path on task_submit lands in the submission, shows in the console and is audited', async () => {
    const f = await team('Shots');
    const id = await started(f);
    const shot = png(join(f.worker.folder, 'screen.png'), 300);
    const s = await f.worker.call('task_submit', { task_id: id, summary: 'Done, see the screenshot.', local_path: shot });
    expect(s.error, s.text).toBe(false);
    expect(s.text).toContain('connector is uploading the file');
    const chn = s.data.upload.channel_id as string;
    const done = await settled(chn);
    expect(done.status, JSON.stringify(done)).toBe('done');
    expect(done.result).toMatchObject({ task_id: id, role: 'submission', files: 1 });
    // The console shows it as the submission's round, typed from its bytes.
    const view = app.taskAttachments.consoleView(id);
    expect(view.rounds).toHaveLength(1);
    expect(view.rounds[0]!.files).toEqual([{ path: 'screen.png', size: 300 * 1024, type: 'image/png' }]);
    expect(app.taskAttachments.entry(id, 'submission', 'screen.png')?.entry.type).toBe('image/png');
    // The submission names that round; the task's version did not move under the reviewer.
    const t = app.teams.task(id)!;
    expect(t.status).toBe('in_review');
    expect([t.share_id, t.share_version]).toEqual([done.result!.share_id, done.result!.version]);
    expect(t.version).toBe(s.data.task.version);
    // One agent, one call, audited at the call and as the files land.
    const ev = (action: string) => app.db.prepare("SELECT actor_id, details FROM audit_events WHERE action=? AND target_id=?").all(action, id) as { actor_id: string; details: string }[];
    expect(ev('task.attach_local')).toHaveLength(1);
    expect(ev('task.attach_local')[0]!.actor_id).toBe(f.worker.id);
    expect(JSON.parse(ev('task.attach_local')[0]!.details)).toMatchObject({ role: 'submission', channel: chn, paths: 1 });
    expect(ev('task.attach_local')[0]!.details).not.toContain('screen.png'); // the count of paths, never the paths
    expect(JSON.parse(ev('task.attach')[0]!.details)).toMatchObject({ role: 'submission', channel: chn, files: ['screen.png'] });
  });

  it('a brief gets files from the coordinator\'s own folder with task_create and task_update', async () => {
    const f = await team('Briefs');
    writeFileSync(join(f.coord.folder, 'notes.md'), '# What to build\n');
    const c = await f.coord.call('task_create', { team_id: f.t.id, title: 'Build it', local_paths: [join(f.coord.folder, 'notes.md')] });
    expect(c.error, c.text).toBe(false);
    expect((await settled(c.data.upload.channel_id)).status).toBe('done');
    const id = c.data.task.id as string;
    const mock = join(f.coord.folder, 'mock.html');
    writeFileSync(mock, '<!doctype html><p>Mockup</p>');
    const u = await f.coord.call('task_update', { task_id: id, version: app.teams.task(id)!.version, local_path: mock });
    expect(u.error, u.text).toBe(false);
    expect((await settled(u.data.upload.channel_id)).status).toBe('done');
    expect(app.taskAttachments.consoleView(id).brief!.files.map((x) => [x.path, x.type])).toEqual([['mock.html', 'text/html'], ['notes.md', 'text/plain']]);
  });

  it('a path outside the agent\'s folder, or a link pointing out of it, fails the upload and says where files may come from', async () => {
    const f = await team('Outside');
    const id = await started(f);
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    png(join(elsewhere, 'other.png'), 2);
    symlinkSync(elsewhere, join(f.worker.folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const p of [join(elsewhere, 'other.png'), join(f.worker.folder, 'linked', 'other.png'), join(folders.get('Shots-worker') ?? elsewhere, 'screen.png')]) {
      const s = await f.worker.call('task_submit', { task_id: id, summary: 'Try', local_path: p });
      expect(s.error, s.text).toBe(false);
      const done = await settled(s.data.upload.channel_id);
      expect(done.status, p).toBe('failed');
      expect(done.failure_reason).toBe('bridge_error');
      expect(done.result!.message).toContain('outside your own folder');
      expect(done.result!.message).toContain('Files may come only from inside your own folder on this PC');
    }
    expect(app.taskAttachments.consoleView(id).rounds).toHaveLength(0);
  });

  it('refuses .git, .codex, the role file and the connector\'s folder: by name at once, by real path on the PC', async () => {
    const f = await team('Refused');
    const id = await started(f);
    for (const p of [join(f.worker.folder, '.git', 'config'), join(f.worker.folder, '.codex', 'config.toml'), join(f.worker.folder, 'CLAUDE.md'), join(f.worker.folder, 'AGENTS.override.md'), join(root, '.config', 'conclave', 'keys.json'), 'relative/shot.png']) {
      const s = await f.worker.call('task_submit', { task_id: id, summary: 'Try', local_path: p });
      expect(s.error, p).toBe(true);
      expect(s.data.error, p).toBe('denied');
      expect(s.text).toContain('Files may come only from inside your own folder');
    }
    // A link whose name passes reaches .git on the PC; a file in the connector's own folder; neither is sent.
    mkdirSync(join(f.worker.folder, '.git'), { recursive: true });
    writeFileSync(join(f.worker.folder, '.git', 'config'), '[core]\n');
    symlinkSync(join(f.worker.folder, '.git'), join(f.worker.folder, 'gitlink'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(connHome, 'hubs.json'), '{}');
    for (const [p, why] of [[join(f.worker.folder, 'gitlink', 'config'), 'inside .git or .codex'], [join(connHome, 'hubs.json'), 'inside the connector\'s own folder']] as const) {
      const s = await f.worker.call('task_submit', { task_id: id, summary: 'Try', local_path: p });
      expect(s.error, s.text).toBe(false);
      const done = await settled(s.data.upload.channel_id);
      expect(done.status).toBe('failed');
      expect(done.result!.message).toContain(why);
    }
  });

  it('applies the inline limits as the files land: a 9 MB file is refused and nothing is attached', async () => {
    const f = await team('Large');
    const id = await started(f);
    const s = await f.worker.call('task_submit', { task_id: id, summary: 'Big', local_path: png(join(f.worker.folder, 'big.png'), 9 * 1024) });
    expect(s.error, s.text).toBe(false);
    const done = await settled(s.data.upload.channel_id);
    expect([done.status, done.failure_reason]).toEqual(['failed', 'too_large']);
    expect(done.result!.message).toContain('one attachment is at most');
    expect(app.taskAttachments.consoleView(id).rounds).toHaveLength(0);
  });

  it('only the assignee sends a submission\'s files, and local paths go alone', async () => {
    const f = await team('Rules');
    const id = await started(f);
    const shot = png(join(f.worker.folder, 'a.png'), 1);
    const both = await f.worker.call('task_submit', { task_id: id, summary: 'x', local_path: shot, attachments: [{ path: 'b.md', content: 'b' }] });
    expect([both.error, both.data.error]).toEqual([true, 'invalid_argument']);
    const other = await f.coord.call('task_update', { task_id: id, version: app.teams.task(id)!.version, local_path: join(f.coord.folder, 'missing.png') });
    // The coordinator may change the brief: the upload starts, and the connector finds no such file.
    expect(other.error, other.text).toBe(false);
    expect((await settled(other.data.upload.channel_id)).status).toBe('failed');
  });

  it('with no connector or bridge on the PC, says to use the connector or inline attachments', async () => {
    const bare = pc('bare-pc', false);
    const f = await team('Bare', bare);
    const id = await started(f);
    const s = await f.worker.call('task_submit', { task_id: id, summary: 'x', local_path: png(join(f.worker.folder, 'a.png'), 1) });
    expect([s.error, s.data.error]).toEqual([true, 'bridge_required']);
    expect(s.text).toContain('Conclave connector');
    expect(s.text).toContain('inline');
    // Nothing changed: the task is still in progress.
    expect(app.teams.task(id)!.status).toBe('in_progress');
  });
});

describe('the hub refuses names at once', () => {
  it('on Windows and POSIX paths alike', async () => {
    const { refusedLocalName } = await import('../src/util/paths.js');
    for (const [p, os] of [['/home/u/agent/shot.png', 'posix'], [String.raw`C:\Users\u\agent\shot.png`, 'win32'], ['C:/Users/u/agent/docs/CLAUDE.md.bak', 'win32']] as const) expect(refusedLocalName(p, os), p).toBeNull();
    for (const [p, os] of [['/home/u/agent/.git/config', 'posix'], [String.raw`C:\Users\u\agent\.GIT\config`, 'win32'], ['/home/u/agent/.codex/x', 'posix'], ['/home/u/.config/conclave/k.json', 'posix'],
      [String.raw`C:\Users\u\.config\conclave\k.json`, 'win32'], ['/home/u/.agent-hub/bridge.json', 'posix'], ['/home/u/agent/AGENTS.md', 'posix'], [String.raw`C:\Users\u\agent\claude.md`, 'win32'],
      ['agent/shot.png', 'posix'], ['/home/u/a\0b', 'posix']] as const) expect(refusedLocalName(p, os), p).not.toBeNull();
  });
});
