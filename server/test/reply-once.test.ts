/**
 * Hub replies send each thing once (docs/mcp.md, "Replies and notices"):
 * - compact replies, opt-in per login (session_login {compact: true}) or per connection (X-Agent-Hub-Compact): the one
 *   text block is the structured JSON, with no prose that repeats it;
 * - full once, then short: in a compact login a task's long texts go out in full once, then are named in `unchanged`;
 *   a new login starts over, and task_list with a task_id always sends the task in full;
 * - notices inline once, for every client: each rides inline on one reply, 5 per reply, notices_pending counts the
 *   unacknowledged ones on every reply, session_whoami lists them, and the console Inbox sees delivered apart from acked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { type: string; text: string }[] };
type Call = ((name: string, args?: Record<string, unknown>) => Promise<Res>) & { login?: Res };
let app: App, base = '', cookie = '', csrf = '', appKey = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function session(secret: string, o: { compact?: boolean; header?: string } = {}): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  const headers: Record<string, string> = { Authorization: `Bearer ${appKey}`, ...(o.header ? { 'X-Agent-Hub-Compact': o.header } : {}) };
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  const login = (await c.callTool({ name: 'session_login', arguments: { session_key: secret, ...(o.compact ? { compact: true } : {}) } })) as Res;
  const token = ok(login).session_token;
  const call: Call = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
  call.login = login;
  return call;
}
const BRIEF = 'The brief of the measured task, long enough to matter. '.repeat(20);
let n = 0;
function agent(label: string) {
  const a = app.keys.createAgent(`RO${++n}-${label}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, cred: k.credential.id, secret: k.secret };
}
async function team() {
  const c = agent('coord'), w = agent('worker'), r = agent('rev');
  const id = app.teams.create({ name: `RO${++n}`, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }, { agent_id: r.id, role: 'reviewer', credential_id: r.cred }] }, sys).id;
  app.teams.start(id, sys);
  app.blueprint.ensureTeamProject(id);
  return { id, c, w, r };
}
/** work_next until an item of this kind, confirming the others. */
async function next(call: Call, kind: string): Promise<Res> {
  for (let i = 0; i < 20; i++) { const r = await call('work_next', { wait_seconds: 0 }); const it = ok(r).item; if (!it) throw new Error(`no ${kind}: ${text(r)}`); if (it.kind === kind) return r; ok(await call('work_ack', { item_id: it.item_id })); }
  throw new Error(`no ${kind}`);
}
/** Acknowledge everything pending, so a test starts from a quiet login. */
async function quiet(call: Call) {
  const all = ok(await call('session_whoami')).notices ?? [];
  if (all.length) ok(await call('session_ack', { notice_seq: Math.max(...all.map((x: { seq: number }) => x.seq)) }));
}
const isJsonText = (r: Res) => r.content!.length === 1 && r.content![0]!.text === JSON.stringify(r.structuredContent);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahro-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 60 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('compact replies', () => {
  it('a compact login gets the structured JSON alone as text, on task_list, work_next, errors and the login itself', async () => {
    const X = await team();
    const coord = await session(X.c.secret);
    ok(await coord('task_create', { team_id: X.id, title: 'Compact task', description: BRIEF, operator_request: { source: 'test' } }));
    const w = await session(X.w.secret, { compact: true });
    for (const r of [await w('task_list'), await w('work_next', { wait_seconds: 0 }), await w('task_list', { detail: 'full' }), await w('task_start', { task_id: 'task_nope' })]) {
      expect(isJsonText(r), text(r)).toBe(true);
      expect(text(r)).not.toMatch(/Confirm with work_ack|Notices \(confirm/);
    }
    // Null and empty fields are left out; false stays.
    const t = ok(await w('task_list', { detail: 'full' })).tasks[0];
    expect(Object.values(t).some((v) => v === null)).toBe(false);
    expect(t.claimable).toBe(false);
  });

  it('the X-Agent-Hub-Compact header turns it on for a connection; a plain login is unchanged', async () => {
    const X = await team();
    const h = await session(X.w.secret, { header: '1' });
    expect(isJsonText(await h('task_list'))).toBe(true);
    const plain = await session(X.r.secret);
    const r = await plain('task_list');
    expect(isJsonText(r)).toBe(false);
    expect(text(r)).toBe('No tasks.');
  });
});

describe('full once, then short (compact)', () => {
  it('a task delivered again unchanged is named by id and version; a new login and task_list with its id get it in full', async () => {
    const X = await team();
    const coord = await session(X.c.secret), rev = await session(X.r.secret);
    const w = await session(X.w.secret, { compact: true });
    const t = ok(await coord('task_create', { team_id: X.id, title: 'Once task', description: BRIEF, reviewer: X.r.id, operator_request: { source: 'test' } })).task;
    ok(await coord('task_assign', { task_id: t.id, agent_id: X.w.id }));
    const first = ok(await next(w, 'task_assigned')).item;
    expect(first.task.description).toBe(BRIEF);
    // The same item again (not confirmed): named by id and version, the brief left out.
    const again = ok(await w('work_next', { wait_seconds: 0 })).item;
    expect(again).toMatchObject({ repeat: true, task: { id: t.id, version: first.task.version, unchanged: expect.arrayContaining(['description']) } });
    expect(again.task.description).toBeUndefined();
    ok(await w('work_ack', { item_id: again.item_id }));
    // A list in full leaves it out too; task_list with the task's id always sends it.
    const listed = ok(await w('task_list', { detail: 'full' })).tasks.find((x: { id: string }) => x.id === t.id);
    expect(listed.description).toBeUndefined();
    expect(listed.unchanged).toContain('description');
    expect(ok(await w('task_list', { task_id: t.id })).tasks[0].description).toBe(BRIEF);
    // Review delivery: the new comments in full, the brief and the submission (sent before) left out, never twice in one reply.
    ok(await w('task_start', { task_id: t.id }));
    const summary = 'Built and checked. '.repeat(8);
    ok(await w('task_submit', { task_id: t.id, summary }));
    ok(await rev('work_ack', { item_id: ok(await next(rev, 'review_requested')).item.item_id }));
    const comments = 'Fix the second step, please. '.repeat(5);
    ok(await rev('task_review', { task_id: t.id, version: app.teams.task(t.id)!.version, decision: 'request_changes', comments }));
    const back = ok(await next(w, 'changes_requested')).item;
    expect(back.task.review_comments).toBe(comments);
    expect(back.task.description).toBeUndefined();
    expect(back.task.summary).toBeUndefined();
    expect(back.task.unchanged).toEqual(expect.arrayContaining(['description', 'summary']));
    expect(back.review.comments).toBeUndefined();
    expect(back.review.unchanged).toEqual(expect.arrayContaining(['summary', 'comments']));
    // A new login starts over: the brief comes in full again.
    const w2 = await session(X.w.secret, { compact: true });
    expect(ok(await w2('task_list', { detail: 'full' })).tasks.find((x: { id: string }) => x.id === t.id).description).toBe(BRIEF);
  });

  it('a login without compact mode always gets every text in full', async () => {
    const X = await team();
    const coord = await session(X.c.secret), w = await session(X.w.secret);
    const t = ok(await coord('task_create', { team_id: X.id, title: 'Plain task', description: BRIEF, operator_request: { source: 'test' } })).task;
    for (let i = 0; i < 2; i++) {
      const r = await w('task_list', { detail: 'full' });
      expect(r.structuredContent.tasks.find((x: { id: string }) => x.id === t.id)).toMatchObject({ description: BRIEF });
      expect(r.structuredContent.tasks[0].unchanged).toBeUndefined();
      expect(text(r)).toContain(BRIEF.trim());
    }
  });
});

describe('notices inline once', () => {
  it('a notice rides inline on one reply; every reply counts it pending; session_whoami still lists it', async () => {
    const a = agent('one');
    const A = await session(a.secret);
    await quiet(A);
    app.keys.notify(a.id, 'test_info', 'Read me once.');
    const replies = [await A('task_list'), await A('task_list'), await A('session_describe', { status_text: 'x' }), await A('task_list')];
    const inline = replies.map((r) => (r.structuredContent.notices ?? []).map((x: { body: string }) => x.body));
    expect(inline).toEqual([['Read me once.'], [], [], []]);
    for (const r of replies) expect(r.structuredContent.notices_pending).toBe(1);
    expect(text(replies[0]!)).toContain('Read me once.');
    expect(text(replies[1]!)).not.toContain('Read me once.');
    expect(text(replies[1]!)).toContain('Notices (confirm with session_ack): 1 pending, shown before');
    expect(ok(await A('session_whoami')).notices.map((x: { body: string }) => x.body)).toEqual(['Read me once.']);
    // Acknowledged: no count any more.
    const seq = ok(await A('session_whoami')).notices[0].seq;
    ok(await A('session_ack', { notice_seq: seq }));
    expect((await A('task_list')).structuredContent.notices_pending).toBeUndefined();
  });

  it('more than 5 arrive 5 per reply until all are delivered', async () => {
    const a = agent('many');
    const A = await session(a.secret);
    await quiet(A);
    for (let i = 0; i < 12; i++) app.keys.notify(a.id, 'test_info', `note ${i}`);
    const got: number[] = [], more: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) { const r = (await A('task_list')).structuredContent; got.push((r.notices ?? []).length); more.push(r.notices_more); expect(r.notices_pending).toBe(12); }
    expect(got).toEqual([5, 5, 2, 0]);
    expect(more).toEqual([7, 2, undefined, undefined]);
  });

  it('a new login is shown its pending notices once again', async () => {
    const a = agent('relog');
    const A = await session(a.secret);
    await quiet(A);
    app.keys.notify(a.id, 'test_info', 'Still pending.');
    expect(ok(await A('task_list')).notices).toHaveLength(1);
    const B = await session(a.secret);
    expect(B.login!.structuredContent.notices.map((x: { body: string }) => x.body)).toEqual(['Still pending.']);
    expect(B.login!.structuredContent.notices_pending).toBe(1);
    const r = ok(await B('task_list'));
    expect(r.notices).toBeUndefined();
    expect(r.notices_pending).toBe(1);
  });

  it('the console Inbox sees delivered and acknowledged apart', async () => {
    const a = agent('inbox');
    const A = await session(a.secret);
    await quiet(A);
    app.keys.notify(a.id, 'test_info', 'Inbox line.');
    const row = async () => {
      const d = (await api('GET', `/sessions/${a.id}`)).body;
      const nt = d.notices.find((x: { body: string }) => x.body === 'Inbox line.');
      return { delivered: nt.delivered_at !== null, acked: nt.seq <= d.notices_acked_seq, seq: nt.seq as number };
    };
    expect(await row()).toMatchObject({ delivered: false, acked: false });
    await A('task_list');
    const r = await row();
    expect(r).toMatchObject({ delivered: true, acked: false });
    ok(await A('session_ack', { notice_seq: r.seq }));
    expect(await row()).toMatchObject({ delivered: true, acked: true });
  });
});
