/**
 * Task attachments, part 1 (task-attachments design §2–4, §7–8): a task's brief and submission are task-bound shares. The
 * task's people read them under the task rule (current team member who is the coordinator, the creator, the assignee or
 * the reviewer; never once the task is cancelled or discarded); nobody changes them through the share tools; a copy into
 * a task takes only a share the caller made, and leaves that share's readers as they were; a cancelled or discarded
 * task's attachments are deleted 30 days after it closes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';
import { ATTACH_DELETE_AFTER_MS, MB } from '../src/shares/taskAttachments.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey: string;
const clients: Client[] = [];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function agent(label: string) {
  const a = app.keys.createAgent(label, null, sys);
  const key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  const client = new Client({ name: label, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const login = await client.callTool({ name: 'session_login', arguments: { session_key: key.secret } });
  const token = login.structuredContent!.session_token;
  return {
    id: a.id, label, policy: key.credential.policy_id as string,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { session_token: token, ...args } });
      return { error: !!result.isError, data: result.structuredContent as Record<string, any>, content: result.content as { type: string; text?: string; data?: string; mimeType?: string }[] };
    },
  };
}
type Agent = Awaited<ReturnType<typeof agent>>;
const code = (r: { data: Record<string, any> }) => r.data?.error as string | undefined;
const msg = (r: { data: Record<string, any>; content: { text?: string }[] }) => `${r.data?.message ?? ''} ${r.content.map((c) => c.text ?? '').join(' ')}`;

async function team(name: string) {
  const [coord, worker, creator, reviewer, backup, other] = await Promise.all(['coordinator', 'worker', 'creator', 'reviewer', 'backup', 'other'].map((l) => agent(`${name} ${l}`)));
  const t = app.teams.create({ name, goal: 'Attachments', grant_messaging: true, members: [
    { agent_id: coord!.id, role: 'coordinator' }, { agent_id: worker!.id, role: 'worker' }, { agent_id: creator!.id, role: 'worker' },
    { agent_id: reviewer!.id, role: 'reviewer' }, { agent_id: backup!.id, role: 'reviewer' }, { agent_id: other!.id, role: 'worker' },
  ] }, sys);
  app.teams.start(t.id, sys);
  return { t, coord: coord!, worker: worker!, creator: creator!, reviewer: reviewer!, backup: backup!, other: other! };
}
type Team = Awaited<ReturnType<typeof team>>;

/** A task with a brief, created for the creator (a worker), assigned to the worker, who starts it. */
async function briefed(f: Team, files: { path: string; content: string; encoding?: string }[] = [{ path: 'brief.md', content: '# Do the thing' }]) {
  const c = await f.coord.call('task_create', { team_id: f.t.id, title: 'Attach task', reviewer: f.reviewer.id, attachments: files });
  expect(c.error, msg(c)).toBe(false);
  const id = c.data.task.id as string;
  // Only a coordinator creates tasks; the creator rule reads the task's creator, which here is a worker of the team
  // (a coordinator who has since moved to another role, say).
  app.db.prepare('UPDATE tasks SET created_by_agent=? WHERE id=?').run(f.creator.id, id);
  expect((await f.coord.call('task_assign', { task_id: id, agent_id: f.worker.id })).error).toBe(false);
  expect((await f.worker.call('task_start', { task_id: id })).error).toBe(false);
  return id;
}
const setOf = (taskId: string, role: 'brief' | 'submission') => (app.db.prepare('SELECT * FROM shares WHERE task_id=? AND task_role=?').get(taskId, role) as { id: string; status: string; author_agent_id: string } | undefined);
/** Add rules to the agent's key, keeping those its team gave it. */
const grant = (a: Agent, ...rules: { effect: 'allow'; actions: string[]; resource: string }[]) => app.keys.setRules(a.policy, [...app.keys.rules(a.policy), ...rules] as never, 'test', sys);
const reads = async (a: Agent, shareId: string) => !(await a.call('share_info', { share_id: shareId })).error;
/** A share the agent makes and fills itself (a share of its own, as it would before copying). */
async function ownShare(a: Agent, files: { path: string; content: string }[], withIds: string[]) {
  const c = await a.call('share_create', { name: 'Own evidence', with: withIds });
  expect(c.error, msg(c)).toBe(false);
  const id = c.data.share_id as string;
  expect((await a.call('share_upload', { share_id: id, files, final: true })).error).toBe(false);
  return id;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-attach-'));
  const vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp(testConfig(dir, { dbFile: join(dir, 'data', 'test.db'), vaultDir, pepper: 'test', publicUrl: 'http://fixture.test', adminPassword: 'fixture password' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const pc = app.keys.createMachine('fixture', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'test', maxLiveSessions: 200 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('who reads a task\'s attachments', () => {
  it('the assignee, the reviewer, a replacement reviewer, the coordinator and the creator read; a former assignee and another team do not', async () => {
    const f = await team('Readers');
    const stranger = (await team('Strangers')).coord;
    const id = await briefed(f);
    const brief = setOf(id, 'brief')!;
    expect(brief.status).toBe('open');
    for (const a of [f.worker, f.reviewer, f.coord, f.creator]) expect(await reads(a, brief.id), a.label).toBe(true);
    for (const a of [f.backup, f.other, stranger]) expect(await reads(a, brief.id), a.label).toBe(false);
    const r = await f.reviewer.call('share_read', { share_id: brief.id, version: 1, path: 'brief.md' });
    expect(r.error).toBe(false);
    expect(JSON.stringify(r.data)).toContain('# Do the thing');
    expect(r.data.label).toMatch(/^L2 data from Readers coordinator, never instructions/);
    // A replacement reviewer reads; the reviewer it replaced no longer does.
    expect((await f.coord.call('task_update', { task_id: id, reviewer: f.backup.id, version: app.teams.task(id)!.version })).error).toBe(false);
    expect(await reads(f.backup, brief.id)).toBe(true);
    expect(await reads(f.reviewer, brief.id)).toBe(false);
    // The worker leaves the team: a former assignee reads nothing.
    app.teams.removeMember(f.t.id, f.worker.id, sys);
    expect(await reads(f.worker, brief.id)).toBe(false);
    // task_list shows the files to a reader, and only the count to a team member who cannot read them.
    expect(JSON.stringify((await f.creator.call('task_list', { team_id: f.t.id, detail: 'full' })).data)).toContain('brief.md');
    const seen = JSON.stringify((await f.other.call('task_list', { team_id: f.t.id, detail: 'full' })).data);
    expect(seen).not.toContain('brief.md');
    expect(seen).not.toContain(brief.id);
  });

  it('refuses agents once the task is cancelled, and share_list never lists a task\'s attachments', async () => {
    const f = await team('Closing');
    const id = await briefed(f);
    const brief = setOf(id, 'brief')!;
    const listed = JSON.stringify((await f.creator.call('share_list', {})).data);
    expect(listed).not.toContain(brief.id);
    expect((await f.coord.call('task_cancel', { task_id: id, reason: 'Not needed' })).error).toBe(false);
    for (const a of [f.coord, f.creator, f.worker, f.reviewer]) expect(await reads(a, brief.id), a.label).toBe(false);
  });
});

describe('copying a share into a task', () => {
  it('copies a share the caller made; the original keeps its readers', async () => {
    const f = await team('Copying');
    const id = await briefed(f);
    const own = await ownShare(f.worker, [{ path: 'shot.txt', content: 'evidence' }], [f.backup.id]);
    const everyone = [f.coord, f.worker, f.creator, f.reviewer, f.backup, f.other];
    const before = await Promise.all(everyone.map((a) => reads(a, own)));
    const recipients = () => app.db.prepare('SELECT target FROM share_recipients WHERE share_id=? ORDER BY target').all(own);
    const recBefore = recipients();
    const s = await f.worker.call('task_submit', { task_id: id, summary: 'Evidence attached', share_id: `share:${own}@v1`, attachments: [{ path: 'notes.md', content: 'how I checked' }] });
    expect(s.error, msg(s)).toBe(false);
    const sub = setOf(id, 'submission')!;
    expect(s.data.task).toMatchObject({ share_id: sub.id, share_version: 1 });
    const v = app.db.prepare('SELECT manifest, added_by, copied_from, note FROM share_versions WHERE share_id=? AND version=1').get(sub.id) as { manifest: string; added_by: string; copied_from: string; note: string };
    expect(v).toMatchObject({ added_by: f.worker.id, copied_from: `share:${own}@v1` });
    expect((JSON.parse(v.manifest) as { path: string }[]).map((e) => e.path).sort()).toEqual(['notes.md', 'shot.txt']);
    expect(await reads(f.reviewer, sub.id)).toBe(true);
    // The original share keeps exactly its readers and recipients: the reviewer reads the copy, not the original.
    expect(await Promise.all(everyone.map((a) => reads(a, own)))).toEqual(before);
    expect(before[3]).toBe(false);
    expect(recipients()).toEqual(recBefore);
    const audit = app.db.prepare("SELECT details FROM audit_events WHERE action='task.attach' AND target_id=? ORDER BY id").all(id) as { details: string }[];
    expect(JSON.parse(audit.at(-1)!.details)).toMatchObject({ role: 'submission', version: 1, copied_from: `share:${own}@v1`, share: sub.id });
  });

  it('refuses a share the caller did not make, through attachments_from and through task_submit', async () => {
    const f = await team('Refusing');
    const id = await briefed(f);
    // The coordinator shares a file with the worker and the creator, who hold the grant to read it; it is still not theirs to copy.
    for (const a of [f.worker, f.creator]) grant(a, { effect: 'allow', actions: ['share.read'], resource: 'share:*' });
    const theirs = await ownShare(f.coord, [{ path: 'secret.txt', content: 'for the two of them' }], [f.worker.id, f.creator.id]);
    expect(await reads(f.worker, theirs)).toBe(true);
    expect(await reads(f.creator, theirs)).toBe(true);
    const viaSubmit = await f.worker.call('task_submit', { task_id: id, summary: 'x', share_id: theirs });
    expect(code(viaSubmit)).toBe('invalid_argument');
    expect(msg(viaSubmit)).toMatch(/only a share you made yourself/);
    const viaUpdate = await f.creator.call('task_update', { task_id: id, version: app.teams.task(id)!.version, attachments_from: `share:${theirs}@v1` });
    expect(code(viaUpdate)).toBe('invalid_argument');
    const viaCreate = await f.coord.call('task_create', { team_id: f.t.id, title: 'Leak', attachments_from: `share:${await ownShare(f.worker, [{ path: 'w.txt', content: 'w' }], [`team:${f.t.id}`])}` });
    expect(code(viaCreate)).toBe('invalid_argument');
    expect(setOf(id, 'submission')).toBeUndefined();
    expect(app.teams.task(id)!.status).toBe('in_progress');
    // A task's own attachments cannot be copied into another task either.
    const brief = setOf(id, 'brief')!;
    expect(code(await f.coord.call('task_create', { team_id: f.t.id, title: 'Copy of a set', attachments_from: brief.id }))).toBe('invalid_argument');
  });
});

describe('the share tools leave a task\'s attachments alone', () => {
  it('refuses upload, close, comment, suggest, promote, feedback and resolve on a task-bound share', async () => {
    const f = await team('Tools');
    const id = await briefed(f);
    const brief = setOf(id, 'brief')!;
    // Even with every share grant, the task rule refuses: the refusal is the task-bound one, not a missing grant.
    for (const a of [f.creator, f.reviewer]) grant(a, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:share_*' }, { effect: 'allow', actions: ['share.*'], resource: 'share:*' });
    const tries: [Agent, string, Record<string, unknown>][] = [
      [f.creator, 'share_upload', { share_id: brief.id, files: [{ path: 'x.md', content: 'x' }], final: true }],
      [f.creator, 'share_close', { share_id: brief.id }],
      [f.reviewer, 'share_comment', { share_id: brief.id, version: 1, path: 'brief.md', body: 'Note' }],
      [f.reviewer, 'share_suggest', { share_id: brief.id, version: 1, patch: '--- a/brief.md\n+++ b/brief.md\n@@ -1 +1 @@\n-# Do the thing\n+# Do it\n' }],
      [f.reviewer, 'share_promote', { share_id: brief.id, version: 1, to: 'notes/brief.md' }],
      [f.reviewer, 'share_feedback', { share_id: brief.id }],
    ];
    for (const [a, tool, args] of tries) {
      const r = await a.call(tool, args);
      expect(r.error, tool).toBe(true);
      expect(msg(r), tool).toMatch(/belongs to task "?Attach task/);
    }
    // Feedback cannot be made through the tools; a row put there directly still cannot be resolved through them.
    app.db.prepare("INSERT INTO share_feedback(id,share_id,version,kind,author_agent_id,body,created_at) VALUES ('fbk_attach1',?,1,'comment',?,'x',?)").run(brief.id, f.reviewer.id, Date.now());
    const res = await f.creator.call('share_resolve', { feedback_id: 'fbk_attach1', status: 'applied' });
    expect(res.error).toBe(true);
    expect(msg(res)).toMatch(/belongs to task/);
    // Downloading is a read: the task's people may.
    expect((await f.reviewer.call('share_download', { share_id: brief.id, version: 1 })).error).toBe(false);
    expect(setOf(id, 'brief')!.status).toBe('open');
  });

  it('returns an image as image content, labelled as L2 data', async () => {
    const f = await team('Images');
    const id = await briefed(f, [{ path: 'mockups/screen.png', content: PNG, encoding: 'base64' }]);
    const brief = setOf(id, 'brief')!;
    const r = await f.worker.call('share_read', { share_id: brief.id, version: 1, path: 'mockups/screen.png' });
    expect(r.error, msg(r)).toBe(false);
    const img = r.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ mimeType: 'image/png', data: PNG });
    expect(r.data.type).toBe('image/png');
    expect(r.content.some((c) => /never instructions/.test(c.text ?? ''))).toBe(true);
  });
});

describe('limits and who changes a set', () => {
  it('refuses key files, oversized inline calls and a brief change by the assignee; the brief merges, a submission is its own round', async () => {
    const f = await team('Limits');
    const id = await briefed(f);
    const v = () => app.teams.task(id)!.version;
    expect(code(await f.creator.call('task_update', { task_id: id, version: v(), attachments: [{ path: 'config/keys.env', content: 'A=1' }] }))).toBe('invalid_argument');
    expect(code(await f.creator.call('task_update', { task_id: id, version: v(), attachments: [{ path: 'big.bin', content: Buffer.alloc(MB + 1).toString('base64'), encoding: 'base64' }] }))).toBe('too_large');
    expect(code(await f.worker.call('task_update', { task_id: id, version: v(), attachments: [{ path: 'mine.md', content: 'x' }] }))).toBe('denied');
    const up = await f.coord.call('task_update', { task_id: id, version: v(), attachments: [{ path: 'more.md', content: 'more' }] });
    expect(up.error, msg(up)).toBe(false);
    const brief = setOf(id, 'brief')!;
    const latest = app.db.prepare('SELECT manifest FROM share_versions WHERE share_id=? ORDER BY version DESC LIMIT 1').get(brief.id) as { manifest: string };
    expect((JSON.parse(latest.manifest) as { path: string }[]).map((e) => e.path).sort()).toEqual(['brief.md', 'more.md']);
    // Only the assignee hands in a submission's files.
    await f.worker.call('task_submit', { task_id: id, summary: 'Round one', attachments: [{ path: 'a.md', content: 'a' }] });
    await f.worker.call('task_submit', { task_id: id, summary: 'Round two', attachments: [{ path: 'b.md', content: 'b' }] });
    const sub = setOf(id, 'submission')!;
    const rounds = app.db.prepare('SELECT version, manifest, note FROM share_versions WHERE share_id=? ORDER BY version').all(sub.id) as { version: number; manifest: string; note: string }[];
    expect(rounds.map((x) => (JSON.parse(x.manifest) as { path: string }[]).map((e) => e.path))).toEqual([['a.md'], ['b.md']]);
    expect(app.teams.task(id)).toMatchObject({ share_id: sub.id, share_version: 2 });
  });

  it('refuses new attachments at the team limit, alerts, and puts a Needs-you row before it at 80%', async () => {
    const f = await team('Quota');
    const id = await briefed(f);
    const used = app.taskAttachments.teamBytes(f.t.id);
    // A tiny limit: the team is past 80% of it, and the next file goes over it.
    expect(used).toBeGreaterThan(8);
    app.db.prepare('UPDATE teams SET limits=? WHERE id=?').run(JSON.stringify({ attachment_bytes: used + 2 }), f.t.id);
    expect(app.taskAttachments.nearFull().some((n) => n.team.id === f.t.id)).toBe(true);
    const op = await adminLogin(base, undefined, 'fixture password');
    const needs = await (await fetch(`${base}/api/needs-you`, { headers: { cookie: op.cookie } })).text();
    expect(needs).toContain(`attachments:${f.t.id}`);
    expect(needs).toContain("Quota's attachments use");
    const r = await f.coord.call('task_update', { task_id: id, version: app.teams.task(id)!.version, attachments: [{ path: 'over.md', content: 'x'.repeat(100) }] });
    expect(r.error).toBe(true);
    expect(msg(r)).toMatch(/attachments are full/);
    expect((app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='quota_trip' AND subject=?").get(f.t.id) as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('deleting the attachments of a cancelled or discarded task', () => {
  it('closes them when the task ends and deletes them 30 days later; a done task keeps its own', async () => {
    const f = await team('Sweep');
    const cancelled = await briefed(f);
    const done = await briefed(f);
    const discarded = await briefed(f);
    // A discarded task (the status is set directly; discarding a backlog task is tested elsewhere).
    app.db.prepare("UPDATE tasks SET status='discarded' WHERE id=?").run(discarded);
    expect((await f.coord.call('task_cancel', { task_id: cancelled, reason: 'Dropped' })).error).toBe(false);
    // Finish the other task: submit, approve, complete.
    expect((await f.worker.call('task_submit', { task_id: done, summary: 'Done', attachments: [{ path: 'out.md', content: 'out' }] })).error).toBe(false);
    expect((await f.reviewer.call('task_review', { task_id: done, decision: 'approve', comments: 'Good', version: app.teams.task(done)!.version })).error).toBe(false);
    expect((await f.coord.call('task_complete', { task_id: done })).error).toBe(false);
    expect(app.teams.task(done)!.status).toBe('done');
    const gone = setOf(cancelled, 'brief')!.id;
    const now = Date.now();
    app.taskAttachments.sweep(now);
    expect(setOf(cancelled, 'brief')!.status).toBe('closed');
    expect(setOf(discarded, 'brief')!.status).toBe('closed');
    expect(setOf(done, 'brief')!.status).toBe('open');
    // Not yet: 29 days after closing.
    app.taskAttachments.sweep(now + ATTACH_DELETE_AFTER_MS - 24 * 3600_000);
    expect(setOf(cancelled, 'brief')).toBeDefined();
    const r = app.taskAttachments.sweep(now + ATTACH_DELETE_AFTER_MS + 1000);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(setOf(cancelled, 'brief')).toBeUndefined();
    expect(setOf(discarded, 'brief')).toBeUndefined();
    expect((app.db.prepare('SELECT COUNT(*) n FROM share_versions WHERE share_id=?').get(gone) as { n: number }).n).toBe(0);
    expect(setOf(done, 'brief')).toBeDefined();
    expect(setOf(done, 'submission')).toBeDefined();
    const audit = app.db.prepare("SELECT details FROM audit_events WHERE action='task.attachments_deleted' AND target_id=?").all(cancelled) as { details: string }[];
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]!.details)).toMatchObject({ share: gone, after_days: 30 });
    expect(app.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
