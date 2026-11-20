/**
 * Task read access (specification, "Task read access"): the assignee and reviewer of a live task read the task's attachments, the vault notes it names and the share the assignee handed in, as a live check with no access request; read only, audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

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
const grant = (a: Agent, ...rules: { effect: 'allow' | 'deny'; actions: string[]; resource: string }[]) => app.keys.setRules(a.policy, [...app.keys.rules(a.policy), ...rules] as never, 'test', sys);
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
  const dir = mkdtempSync(join(tmpdir(), 'ah-taskread-'));
  const vaultDir = join(dir, 'vault'); mkdirSync(join(vaultDir, 'Notes'), { recursive: true }); writeFileSync(join(vaultDir, 'Notes', 'plan.md'), '# Plan\nthe input'); writeFileSync(join(vaultDir, 'Notes', 'secret.md'), '# Secret');
  app = await buildApp(testConfig(dir, { dbFile: join(dir, 'data', 'test.db'), vaultDir, pepper: 'test', publicUrl: 'http://fixture.test', adminPassword: 'fixture password' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const pc = app.keys.createMachine('fixture', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'test', maxLiveSessions: 200 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });


const rmsg = async (a: Agent, p: string) => { const r = await a.call('file_read', { path: p }); return r.error ? msg(r) : 'ok'; };
const alias = () => (app as unknown as { vault: { alias: string } }).vault.alias;
/** The file tools are theirs to call (tool grant); what they may read is the question. */
const fileTools = (...as: Agent[]) => as.forEach((a) => grant(a, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:share_*' }));
/** A path rule the team gave (team_id set) on one agent's policy: the team's own path rules. */
let ruleN = 0;
const teamPath = (f: Team, on: Agent, resource: string) => app.db.prepare('INSERT INTO permission_rules(id,policy_id,position,effect,actions,resource,from_template,note,team_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('rule_tr' + (++ruleN), on.policy, 900 + ruleN, 'allow', JSON.stringify(['fs.read']), 'path:' + resource, null, 'test', f.t.id, Date.now());
const ver = (id: string) => app.teams.task(id)!.version;
const note = (n: string) => `/${alias()}/Notes/${n}`;
const auditCount = (action: string) => (app.db.prepare('SELECT COUNT(*) c FROM audit_events WHERE action=?').get(action) as { c: number }).c;

describe('task read access', () => {
  it('the reviewer opens the attachment and a named note with no access request, read only', async () => {
    const f = await team('Read ok');
    grant(f.coord, { effect: 'allow', actions: ['fs.read'], resource: `path:/${alias()}/Notes/**` });
    teamPath(f, f.other, note('plan.md'));
    fileTools(f.worker, f.reviewer, f.backup, f.other);
    const id = await briefed(f, [{ path: 'shot.png', content: PNG, encoding: 'base64' }]);
    const brief = setOf(id, 'brief')!;
    const before = auditCount('task.note_read');
    expect((await f.reviewer.call('file_read', { path: note('plan.md') })).error, 'not named yet').toBe(true);
    const u = await f.coord.call('task_update', { task_id: id, version: ver(id), notes: [note('plan.md')] });
    expect(u.error, msg(u)).toBe(false);
    for (const a of [f.reviewer, f.worker]) {
      const r = await a.call('file_read', { path: note('plan.md') });
      expect(r.error, a.label + msg(r)).toBe(false);
      expect(r.data.content).toContain('the input');
      expect((await a.call('file_stat', { path: note('plan.md') })).error).toBe(false);
    }
    expect(await reads(f.reviewer, brief.id)).toBe(true);
    expect(auditCount('task.note_read')).toBe(before + 2);
    expect(auditCount('task.notes')).toBeGreaterThan(0);
    // Only the named note, and read only.
    expect((await f.reviewer.call('file_read', { path: note('secret.md') })).error).toBe(true);
    expect((await f.reviewer.call('file_update', { path: note('plan.md'), content: 'x' })).error).toBe(true);
    expect((await f.creator.call('file_read', { path: note('plan.md') })).error, 'a member who is neither').toBe(true);
  });

  it('a note its namer cannot read is refused when named, and a hand-set one is still refused to the assignee', async () => {
    const f = await team('Read refused');
    grant(f.coord, { effect: 'allow', actions: ['fs.read'], resource: `path:/${alias()}/Notes/**` });
    teamPath(f, f.other, note('plan.md'));
    fileTools(f.worker, f.reviewer, f.backup, f.other);
    const id = await briefed(f);
    const v = ver(id);
    const r = await f.coord.call('task_update', { task_id: id, version: v, notes: [note('secret.md')] });
    expect(r.error).toBe(true);
    expect(code(r)).toBe('denied');
    expect((await f.worker.call('file_read', { path: note('secret.md') })).error).toBe(true);
    // Outside the team's own paths is refused even though the namer can read it (secret.md); inside them it is accepted.
    expect(msg(r)).toContain('outside the paths this team is given');
    expect((await f.coord.call('task_update', { task_id: id, version: ver(id), notes: [note('plan.md')] })).error).toBe(false);
  });

  it('an operator deny or a lost team path stops the read; a reserved folder is never opened this way', async () => {
    const f = await team('Read deny');
    fileTools(f.worker, f.reviewer, f.backup, f.other);
    grant(f.coord, { effect: 'allow', actions: ['fs.read'], resource: `path:/${alias()}/Notes/**` });
    teamPath(f, f.other, note('plan.md'));
    const id = await briefed(f);
    expect((await f.coord.call('task_update', { task_id: id, version: ver(id), notes: [note('plan.md')] })).error).toBe(false);
    expect(await rmsg(f.worker, note('plan.md'))).toBe('ok');
    grant(f.worker, { effect: 'deny', actions: ['fs.read'], resource: `path:${note('plan.md')}` } as never);
    expect((await f.worker.call('file_read', { path: note('plan.md') })).error, 'explicit deny wins').toBe(true);
    expect((await f.worker.call('file_stat', { path: note('plan.md') })).error, 'explicit deny wins for stat').toBe(true);
    expect(await rmsg(f.reviewer, note('plan.md'))).toBe('ok');
    app.db.prepare('DELETE FROM permission_rules WHERE team_id=?').run(f.t.id);
    expect((await f.reviewer.call('file_read', { path: note('plan.md') })).error, 'the team no longer covers it').toBe(true);
  });

  it('access ends with the reviewer change and with the task', async () => {
    const f = await team('Read ends');
    grant(f.coord, { effect: 'allow', actions: ['fs.read'], resource: `path:/${alias()}/Notes/**` });
    teamPath(f, f.other, note('plan.md'));
    fileTools(f.worker, f.reviewer, f.backup, f.other);
    const id = await briefed(f);
    let v = ver(id);
    const brief = setOf(id, 'brief')!;
    expect((await f.coord.call('task_update', { task_id: id, version: v, notes: [note('plan.md')] })).error).toBe(false);
    expect(await rmsg(f.reviewer, note('plan.md'))).toBe('ok');
    expect((await f.reviewer.call('file_read', { path: note('plan.md') })).error).toBe(false);
    v = ver(id);
    expect((await f.coord.call('task_update', { task_id: id, version: v, reviewer: f.backup.id })).error).toBe(false);
    expect((await f.reviewer.call('file_read', { path: note('plan.md') })).error, 'old reviewer').toBe(true);
    expect(await reads(f.reviewer, brief.id), 'old reviewer, attachment').toBe(false);
    expect((await f.backup.call('file_read', { path: note('plan.md') })).error, 'new reviewer').toBe(false);
    app.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);
    for (const a of [f.worker, f.backup]) {
      expect((await a.call('file_read', { path: note('plan.md') })).error, a.label).toBe(true);
      expect(await reads(a, brief.id), a.label + ' attachment').toBe(false);
    }
  });

  it('the reviewer reads the submitted evidence while the task lives, every read is audited, and a share the submitter cannot read is not copied in', async () => {
    const f = await team('Read share');
    fileTools(f.worker, f.reviewer, f.backup, f.other);
    const id = await briefed(f);
    const own = await ownShare(f.worker, [{ path: 'ev.md', content: 'evidence' }], [f.coord.id]);
    const s = await f.worker.call('task_submit', { task_id: id, summary: 'done', share_id: own });
    expect(s.error, msg(s)).toBe(false);
    const set = app.teams.task(id)!.share_id!;
    const before = auditCount('task.share_read');
    const r = await f.reviewer.call('share_read', { share_id: set, version: 1, path: 'ev.md' });
    expect(r.error, msg(r)).toBe(false);
    expect(auditCount('task.share_read')).toBe(before + 1);
    app.db.prepare("UPDATE tasks SET status='changes_requested' WHERE id=?").run(id);
    expect((await f.reviewer.call('share_read', { share_id: set, version: 1, path: 'ev.md' })).error).toBe(false);
    expect((await f.reviewer.call('share_comment', { share_id: set, text: 'hi' })).error, 'read only').toBe(true);
    const theirs = await ownShare(f.other, [{ path: 'x.md', content: 'x' }], [f.coord.id]);
    const again = await f.worker.call('task_submit', { task_id: id, summary: 'again', share_id: theirs });
    expect(again.error, 'a share the submitter cannot read is refused').toBe(true);
  });
});
