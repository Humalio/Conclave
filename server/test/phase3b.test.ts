import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '', appKey = '', pcId = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
async function loginWith(key: string, secret: string): Promise<Call> {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any).structuredContent.session_token as string;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
}
const mk = (label: string) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${label} key` }, sys);
  return { id: agent.id, secret: k.secret, cred: k.credential, login: () => loginWith(appKey, k.secret) };
};
let n = 0;
const cid = () => `c${++n}`;

/** coordinator + 2 workers + reviewer + stakeholder; created, started and logged in. */
async function team(extra: Record<string, unknown> = {}, start = true) {
  const [c, w1, w2, r, s] = ['coord', 'w1', 'w2', 'rev', 'stake'].map(mk) as ReturnType<typeof mk>[];
  const res = await api('POST', '/teams', {
    name: `t${++n}`, goal: 'ship it', grant_messaging: true, ...extra,
    members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w1!.id, role: 'worker' }, { agent_id: w2!.id, role: 'worker' }, { agent_id: r!.id, role: 'reviewer' }, { agent_id: s!.id, role: 'stakeholder' }],
  });
  expect(res.status).toBe(201);
  const tid = res.body.team.id as string;
  if (start) expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
  const [C, W1, W2, R, S] = await Promise.all([c!, w1!, w2!, r!, s!].map((x) => x.login()));
  return { tid, c: c!, w1: w1!, w2: w2!, r: r!, s: s!, C: C!, W1: W1!, W2: W2!, R: R!, S: S!, room: res.body.team.room_id as string };
}
type T = Awaited<ReturnType<typeof team>>;
/** Ack everything pending so later assertions see a clean queue. */
async function drain(call: Call) {
  for (let i = 0; i < 30; i++) {
    const r = (await call('work_next')).structuredContent;
    if (r.status !== 'item') return;
    await call('work_ack', { item_id: r.item.item_id });
  }
}
const mkTask = async (X: T, over: Record<string, unknown> = {}) =>
  (await X.C('task_create', { team_id: X.tid, title: 'do it', reviewer: X.r.id, ...over })).structuredContent.task;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah3b-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
  };
  app = await buildApp(config);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await r.json()) as { csrf: string }).csrf;
  pcId = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 500 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('task workflow', () => {
  it('runs coordinator -> worker -> reviewer -> done', async () => {
    const X = await team();
    await Promise.all([X.C, X.W1, X.R, X.S].map(drain));
    const t = await mkTask(X);
    expect(t.status).toBe('open');
    expect((await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id })).structuredContent.task.status).toBe('assigned');
    const item = (await X.W1('work_next')).structuredContent.item;
    expect(item).toMatchObject({ kind: 'task_assigned', trust: 'L1' });
    expect(item.task.id).toBe(t.id);
    expect((await X.W1('work_ack', { item_id: item.item_id })).isError).toBeFalsy();
    expect((await X.W1('task_start', { task_id: t.id })).structuredContent.task.status).toBe('in_progress');
    expect((await X.W1('task_submit', { task_id: t.id, summary: 'finished' })).structuredContent.task.status).toBe('in_review');
    const rev = (await X.R('work_next')).structuredContent.item;
    expect(rev).toMatchObject({ kind: 'review_requested', trust: 'L1' });
    await X.R('work_ack', { item_id: rev.item_id });
    expect((await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'lgtm' })).structuredContent.task.status).toBe('approved');
    expect((await X.W1('task_complete', { task_id: t.id })).structuredContent.error).toBe('denied');
    expect((await X.C('task_complete', { task_id: t.id })).structuredContent.task.status).toBe('done');
    const d = await api('GET', `/teams/${X.tid}`);
    expect(d.body.team.counts.done).toBe(1);
    expect(d.body.team.progress).toMatchObject({ done: 1, total: 1, pct: 100 });
    expect(d.body.team.board[0].status).toBe('done');
    const m = await api('GET', '/metrics');
    expect(m.body.counts.tasks_done_24h).toBeGreaterThanOrEqual(1);
    expect(m.body.series.tasks_done).toHaveLength(24);
  });

  it('refuses self-review and role violations', async () => {
    const X = await team();
    const t = await mkTask(X);
    expect((await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id, reviewer: X.w1.id })).structuredContent.error).toBe('invalid_argument');
    expect((await X.C('task_assign', { task_id: t.id, agent_id: X.r.id })).structuredContent.error).toBe('invalid_argument');
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'x' });
    for (const c of [X.W1, X.W2, X.C]) expect((await c('task_review', { task_id: t.id, decision: 'approve', comments: 'self' })).structuredContent.error).toBe('denied');
    expect((await X.W1('task_create', { team_id: X.tid, title: 'x' })).structuredContent.error).toBe('denied');
    expect((await X.W2('task_submit', { task_id: t.id, summary: 'x' })).structuredContent.error).toBe('denied');
    expect((await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok' })).isError).toBeFalsy();
  });

  it('first claim wins, the others get conflict', async () => {
    const X = await team();
    const t = await mkTask(X, { claimable: true });
    const [a, b] = await Promise.all([X.W1('task_claim', { task_id: t.id, version: t.version }), X.W2('task_claim', { task_id: t.id, version: t.version })]);
    const codes = [a, b].map((x) => (x.isError ? x.structuredContent.error : 'ok')).sort();
    expect(codes).toEqual(['conflict', 'ok']);
    const winner = a.isError ? X.w2.id : X.w1.id;
    expect((await X.C('task_list', { team_id: X.tid })).structuredContent.tasks[0]).toMatchObject({ status: 'assigned', assignee: winner });
    const nc = await mkTask(X);
    expect((await X.W1('task_claim', { task_id: nc.id, version: nc.version })).structuredContent.error).toBe('invalid_state');
  });

  it('expires a lease back to open and tells the coordinator', async () => {
    const X = await team();
    await drain(X.C);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() - 1000, t.id);
    expect((await X.C('task_list', { team_id: X.tid })).structuredContent.tasks[0].status).toBe('open');
    const w = (await X.C('work_next')).structuredContent;
    expect(w.item).toMatchObject({ kind: 'notice', notice_kind: 'lease_expired' });
    expect((await X.W1('task_start', { task_id: t.id })).structuredContent.error).toBe('denied');
    const t2 = await mkTask(X);
    await X.C('task_assign', { task_id: t2.id, agent_id: X.w2.id });
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() + 1000, t2.id);
    await X.W2('session_whoami');
    expect(app.teams.task(t2.id)!.lease_expires_at!).toBeGreaterThan(Date.now() + 10 * 60_000);
  });

  it('blocks a task at the review round limit and raises an alert', async () => {
    const X = await team({ max_review_rounds: 2 });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'v1' });
    expect((await X.R('task_review', { task_id: t.id, decision: 'request_changes', comments: 'fix a' })).structuredContent.task.status).toBe('changes_requested');
    expect((await X.W1('task_start', { task_id: t.id })).structuredContent.task.status).toBe('in_progress');
    await X.W1('task_submit', { task_id: t.id, summary: 'v2' });
    const last = (await X.R('task_review', { task_id: t.id, decision: 'request_changes', comments: 'fix b' })).structuredContent.task;
    expect(last).toMatchObject({ status: 'blocked', review_rounds: 2 });
    const alerts = app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='task_blocked' AND subject=?").get(t.id) as { n: number };
    expect(alerts.n).toBe(1);
    expect((await mkTask(X)).status).toBe('open');
    expect(app.teams.team(X.tid)!.status).toBe('running');
  });

  it('checkpoint: coordinator completion waits for the administrator', async () => {
    const X = await team({ checkpoints: ['done'] });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'x' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok' });
    const r = (await X.C('task_complete', { task_id: t.id })).structuredContent;
    expect(r).toMatchObject({ awaiting_approval: true, task: { status: 'approved' } });
    const ap = await api('POST', `/teams/${X.tid}/tasks/${t.id}/approve`);
    expect(ap.body.task.status).toBe('done');
  });

  it('team status: the administrator asks, the coordinator is told, team_report becomes the status and closes the request', async () => {
    const X = await team();
    expect((await api('GET', `/teams/${X.tid}`)).body.team.status_report).toBeNull();
    const rq = await api('POST', `/teams/${X.tid}/status-request`, { note: 'Before Friday' });
    expect(rq.body.team.status_requested_at).toBeGreaterThan(0);
    const n = (await X.C('session_whoami', {})).structuredContent.notices as { kind: string; body: string }[];
    expect(n.some((x) => x.kind === 'status_request' && x.body.includes('team_report') && x.body.includes('Before Friday'))).toBe(true);
    await X.C('team_report', { team_id: X.tid, summary: '## Status\n- 2 done, 1 doing' });
    const t = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(t.status_report.body).toContain('2 done');
    expect(t.status_requested_at).toBeNull();
    await X.C('team_report', { team_id: X.tid, summary: 'second' });
    const st = (await api('GET', `/teams/${X.tid}/status`)).body;
    expect(st.reports.map((r: any) => r.body)).toEqual(['second', '## Status\n- 2 done, 1 doing']);
    expect((await X.W1('team_report', { team_id: X.tid, summary: 'not mine' })).structuredContent.error).toBe('denied');
  });

  it('the administrator can hide a finished task from the board; agents still see it and it can be shown again', async () => {
    const X = await team();
    const open = await mkTask(X);
    expect((await api('POST', `/teams/${X.tid}/tasks/${open.id}/dismiss`, { dismissed: true })).body.error).toBe('invalid_state');
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'result' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok' });
    await X.C('task_complete', { task_id: t.id });
    const hid = await api('POST', `/teams/${X.tid}/tasks/${t.id}/dismiss`, { dismissed: true });
    expect(hid.body.task.dismissed_at).toBeGreaterThan(0);
    expect((await api('GET', `/teams/${X.tid}`)).body.team.board.find((k: any) => k.id === t.id).dismissed_at).toBeGreaterThan(0);
    const listed = (await X.C('task_list', { team_id: X.tid })).structuredContent.tasks;
    expect(listed.some((k: any) => k.id === t.id && k.summary === 'result')).toBe(true);
    expect((await api('POST', `/teams/${X.tid}/tasks/${t.id}/dismiss`, { dismissed: false })).body.task.dismissed_at).toBeNull();
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action IN ('task.dismiss','task.restore') AND target_id=?").get(t.id)).toMatchObject({ n: 2 });
  });
});

describe('pause and guardrails', () => {
  it('a paused team refuses submits and team messages with "paused", and resumes', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    expect((await X.C('message_send', { room_id: X.room, body: 'hello', client_msg_id: cid() })).isError).toBeFalsy();
    await api('POST', `/teams/${X.tid}/pause`);
    expect((await X.W1('task_submit', { task_id: t.id, summary: 'x' })).structuredContent.error).toBe('paused');
    expect((await X.C('message_send', { room_id: X.room, body: 'hello', client_msg_id: cid() })).structuredContent.error).toBe('paused');
    expect((await X.C('message_send', { to: X.w1.id, body: 'hi', client_msg_id: cid() })).structuredContent.error).toBe('paused');
    expect((await X.C('task_create', { team_id: X.tid, title: 'n' })).structuredContent.error).toBe('paused');
    expect((await X.W1('task_list')).isError).toBeFalsy();
    expect((await X.W1('work_next')).structuredContent.item.kind).toBe('notice');
    await drain(X.W1);
    expect((await X.W1('work_next')).structuredContent.status).toBe('paused');
    await api('POST', `/teams/${X.tid}/resume`);
    expect((await X.W1('task_submit', { task_id: t.id, summary: 'x' })).isError).toBeFalsy();
    expect((await X.C('message_send', { room_id: X.room, body: 'again', client_msg_id: cid() })).isError).toBeFalsy();
  });

  it('pauses the team and alerts when an hourly limit is hit', async () => {
    const X = await team({ limits: { tasks_per_hour: 2 } });
    await mkTask(X); await mkTask(X);
    const third = await X.C('task_create', { team_id: X.tid, title: 'three' });
    expect(third.structuredContent.error).toBe('paused');
    const d = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(d).toMatchObject({ status: 'paused', paused_reason: 'limit:tasks' });
    expect(d.usage.tasks).toBe(3);
    expect((app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='quota_trip' AND subject=?").get(X.tid) as { n: number }).n).toBe(1);
    expect(d.board).toHaveLength(2);
  });

  it('counts team messages against the messages limit', async () => {
    const X = await team({ limits: { messages_per_hour: 1 } });
    expect((await X.C('message_send', { room_id: X.room, body: 'one', client_msg_id: cid() })).isError).toBeFalsy();
    expect((await X.C('message_send', { room_id: X.room, body: 'two', client_msg_id: cid() })).structuredContent.error).toBe('paused');
    expect(app.teams.team(X.tid)!.status).toBe('paused');
  });
});

describe('work_next', () => {
  it('orders by priority and redelivers the same item until it is acked', async () => {
    const [c, w, r] = ['pc', 'pw', 'pr'].map(mk) as ReturnType<typeof mk>[];
    const W = await w!.login();
    const res = await api('POST', '/teams', { name: 'prio', goal: 'g', grant_messaging: true, members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w!.id, role: 'worker' }, { agent_id: r!.id, role: 'reviewer' }] });
    const tid = res.body.team.id as string;
    await api('POST', `/teams/${tid}/start`);
    const [C, R] = await Promise.all([c!.login(), r!.login()]);
    await C('message_send', { to: w!.id, body: 'ping', client_msg_id: cid() });
    const t = (await C('task_create', { team_id: tid, title: 'x', reviewer: r!.id })).structuredContent.task;
    await C('task_assign', { task_id: t.id, agent_id: w!.id });
    const first = (await W('work_next')).structuredContent.item;
    const again = (await W('work_next')).structuredContent.item;
    expect(again.item_id).toBe(first.item_id);
    expect(again.delivery_count).toBe(2);
    expect(first.kind).toBe('notice');
    const kinds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const it = (await W('work_next')).structuredContent;
      if (it.status !== 'item') break;
      kinds.push(it.item.kind);
      await W('work_ack', { item_id: it.item.item_id });
    }
    expect(kinds).toContain('task_assigned');
    expect(kinds.indexOf('message')).toBeGreaterThan(kinds.indexOf('task_assigned'));
    expect(kinds.lastIndexOf('notice')).toBeLessThan(kinds.indexOf('task_assigned'));
    expect((await W('work_next')).structuredContent.status).toBe('idle');

    const t2 = (await C('task_create', { team_id: tid, title: 'y', reviewer: r!.id })).structuredContent.task;
    await C('message_send', { to: w!.id, body: 'second', client_msg_id: cid() });
    await C('task_assign', { task_id: t2.id, agent_id: w!.id });
    const a1 = (await W('work_next')).structuredContent.item;
    expect(a1).toMatchObject({ kind: 'task_assigned', trust: 'L1', source: { from: 'hub' } });
    await W('work_ack', { item_id: a1.item_id });
    const a2 = (await W('work_next')).structuredContent.item;
    expect(a2).toMatchObject({ kind: 'message', trust: 'L2', message: { content: 'second', trust: 'L2' } });
    const peek = await W('message_read');
    expect(peek.structuredContent.read_only).toBe(true);
    expect((await W('message_read')).structuredContent.messages.length).toBe(peek.structuredContent.messages.length);
    expect((await W('message_ack', { cursor: peek.structuredContent.next_cursor })).structuredContent.noop).toBe(true);

    await W('task_start', { task_id: t2.id }); await W('task_submit', { task_id: t2.id, summary: 's' });
    await C('message_send', { to: r!.id, body: 'hey', client_msg_id: cid() });
    expect((await R('work_next')).structuredContent.item.kind).toBe('review_requested');

    await drain(W);
    const waiting = W('work_next', { wait_seconds: 5 });
    setTimeout(() => void C('message_send', { to: w!.id, body: 'late', client_msg_id: cid() }), 150);
    const got = (await waiting).structuredContent;
    expect(got.item.message.content).toBe('late');
  });
});

describe('wiring', () => {
  it('creates room, links and tagged grants; removes them when a member leaves or the team stops', async () => {
    const X = await team();
    const rulesOf = (id: string) => (app.db.prepare('SELECT COUNT(*) n FROM permission_rules WHERE team_id=? AND policy_id=?').get(X.tid, app.keys.credential(id)!.policy_id) as { n: number }).n;
    expect(rulesOf(X.w1.cred.id)).toBeGreaterThan(0);
    const teamLinks = async () => (await api('GET', '/links')).body.links.filter((l: any) => l.kind === `team:${X.tid}`);
    expect(await teamLinks()).toHaveLength(5); // coord->w1,w2,stake; w1,w2->rev
    expect((await X.W1('message_send', { to: X.c.id, body: 'hi', client_msg_id: cid() })).isError).toBeFalsy();
    expect((await X.W1('message_send', { to: X.w2.id, body: 'no link', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    const before = rulesOf(X.w1.cred.id);
    app.keys.setRules(X.w1.cred.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_read' }], 'edit', sys);
    expect(rulesOf(X.w1.cred.id)).toBe(before);
    expect((await api('DELETE', `/teams/${X.tid}/members/${X.w1.id}`)).status).toBe(200);
    expect(rulesOf(X.w1.cred.id)).toBe(0);
    expect((await teamLinks()).filter((l: any) => l.from_agent_id === X.w1.id || l.to_agent_id === X.w1.id)).toHaveLength(0);
    expect((await X.W1('team_info')).structuredContent.teams).toHaveLength(0);
    expect((await X.W1('task_list')).isError).toBe(true); // team tool grants are gone
    expect((await X.C('message_send', { to: X.w1.id, body: 'gone', client_msg_id: cid() })).structuredContent.error).toBe('denied');
    await api('POST', `/teams/${X.tid}/stop`);
    expect((app.db.prepare('SELECT COUNT(*) n FROM permission_rules WHERE team_id=?').get(X.tid) as { n: number }).n).toBe(0);
    expect(await teamLinks()).toHaveLength(0);
    expect((await X.W2('work_next')).structuredContent.status).toBe('item');
    await drain(X.W2);
    expect((await X.W2('work_next')).structuredContent.status).toBe('team_done');
  });

  it('without grant_messaging there is no messaging; team_complete ends the team', async () => {
    const X = await team({ grant_messaging: false });
    expect((await X.C('message_send', { room_id: X.room, body: 'x', client_msg_id: cid() })).isError).toBe(true);
    expect((await X.C('team_report', { team_id: X.tid, summary: 'progress' })).isError).toBeFalsy();
    expect((await X.W1('team_complete', { team_id: X.tid, summary: 'x' })).structuredContent.error).toBe('denied');
    expect((await X.C('team_complete', { team_id: X.tid, summary: 'all done' })).structuredContent.status).toBe('done');
    expect((await X.C('task_create', { team_id: X.tid, title: 'late' })).isError).toBe(true);
  });

  it('team_info gives the role playbook (mentions the loop) and the admin can edit it', async () => {
    const X = await team();
    const info = (await X.W1('team_info')).structuredContent.teams[0];
    expect(info).toMatchObject({ trust: 'L0', my_role: 'worker', status: 'running' });
    expect(info.playbook).toContain('work_next');
    expect(info.playbook).toContain('work_ack');
    await api('PUT', `/teams/${X.tid}/roles/worker`, { playbook: 'custom worker text with work_next' });
    expect((await X.W1('team_info')).structuredContent.teams[0].playbook).toContain('custom worker text');
  });
});

describe('admin API', () => {
  it('lists teams with progress counts, builds the handoff and warns about Chat keys', async () => {
    const chatApp = app.keys.createAppKey({ machineId: pcId, appName: 'Claude Desktop Chat', maxLiveSessions: 50 }, sys).secret;
    const [c, w] = ['hc', 'hw'].map(mk) as ReturnType<typeof mk>[];
    await loginWith(chatApp, w!.secret);
    const res = await api('POST', '/teams', { name: 'ho', goal: 'g', members: [{ agent_id: c!.id, role: 'coordinator' }, { agent_id: w!.id, role: 'worker' }] });
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ agent_id: w!.id, role: 'worker', app_name: 'Claude Desktop Chat' });
    const tid = res.body.team.id as string;
    const list = (await api('GET', '/teams')).body.teams.find((t: any) => t.id === tid);
    expect(list).toMatchObject({ status: 'draft', members: 2, counts: { open: 0, done: 0 }, progress: { total: 0, pct: 0 } });
    const h = (await api('GET', `/teams/${tid}/handoff`)).body;
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]).toMatchObject({ agent_id: c!.id, role: 'coordinator', key_label: 'hc key' });
    for (const m of h.messages) {
      expect(m.text).toContain('work_next');
      expect(m.text).toContain('work_ack');
      expect(m.text).toContain(m.key_label);
      expect(m.text).not.toContain('ah_ses_');
    }
    expect((await api('POST', '/teams', { name: 'x', goal: 'g', members: [{ agent_id: w!.id, role: 'worker' }] })).status).toBe(400);
    const bare = app.keys.createAgent('bare', null, sys);
    expect((await api('POST', '/teams', { name: 'x', goal: 'g', members: [{ agent_id: bare.id, role: 'coordinator' }] })).status).toBe(400);
    const p = await api('PATCH', `/teams/${tid}`, { goal: 'new goal', limits: { tasks_per_hour: 5 } });
    expect(p.body.team).toMatchObject({ goal: 'new goal', limits: { tasks_per_hour: 5 } });
    expect((await api('POST', `/teams/${tid}/pause`)).status).toBe(409);
    expect((await api('POST', `/teams/${tid}/start`)).status).toBe(200);
    expect((await api('POST', `/teams/${tid}/stop`)).body.team.status).toBe('stopped');
  });
});

describe('workflow options from the BIRAZ trial', () => {
  const kinds = async (call: Call) => ((await call('session_whoami')).structuredContent.notices as { kind: string }[]).map((x) => x.kind);
  const runToReview = async (X: T, reviewer: string) => {
    const t = await mkTask(X, { reviewer });
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'result' });
    return t;
  };

  it('a task notice stops once its task moves on; unrelated notices stay', async () => {
    const X = await team();
    const t = await runToReview(X, X.r.id);
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok' });
    expect(await kinds(X.C)).toContain('task_approved');
    await api('POST', `/agents/${X.c.id}/notices`, { kind: 'directive', body: 'unrelated' });
    await X.C('task_complete', { task_id: t.id });
    const after = await kinds(X.C);
    expect(after).not.toContain('task_approved');
    expect(after).toContain('directive');
    // work_next does not deliver it either
    for (let i = 0; i < 20; i++) {
      const r = (await X.C('work_next')).structuredContent;
      if (r.status !== 'item') break;
      expect(r.item.notice_kind).not.toBe('task_approved');
      await X.C('work_ack', { item_id: r.item.item_id });
    }
  });

  it('coordinator review and close on approval: one call closes the task; self-review and an ineligible reviewer are refused', async () => {
    const X = await team();
    expect((await X.C('task_create', { team_id: X.tid, title: 'x', reviewer: X.c.id })).structuredContent.error).toBe('invalid_argument');
    const on = await api('PATCH', `/teams/${X.tid}`, { coordinator_reviews: true, close_on_approve: true });
    expect(on.body.team).toMatchObject({ coordinator_reviews: true, close_on_approve: true });
    const t = await runToReview(X, X.c.id);
    const r1 = (await X.C('task_review', { task_id: t.id, decision: 'approve', comments: 'good' })).structuredContent;
    expect(r1.task.status).toBe('done');
    const r2 = (await X.C('task_review', { task_id: t.id, decision: 'approve', comments: 'good' })).structuredContent;
    expect(r2.task.status).toBe('done');
    expect(app.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND to_status='approved'").get(t.id)).toMatchObject({ n: 1 });
    expect(await kinds(X.C)).not.toContain('task_approved');
    // the coordinator cannot review a task assigned to itself
    const own = (await X.C('task_create', { team_id: X.tid, title: 'mine', reviewer: X.c.id })).structuredContent.task;
    expect((await X.C('task_assign', { task_id: own.id, agent_id: X.c.id })).structuredContent.error).toBe('invalid_argument');
    // an independent reviewer still works, and also closes on approval
    const t2 = await runToReview(X, X.r.id);
    expect((await X.R('task_review', { task_id: t2.id, decision: 'approve', comments: 'ok' })).structuredContent.task.status).toBe('done');
    // a worker cannot review
    const t3 = await runToReview(X, X.r.id);
    expect((await X.W2('task_review', { task_id: t3.id, decision: 'approve', comments: 'x' })).structuredContent.error).toBe('denied');
  });

  it('close on approval keeps the operator checkpoint', async () => {
    const X = await team({ checkpoints: ['done'] });
    await api('PATCH', `/teams/${X.tid}`, { close_on_approve: true });
    const t = await runToReview(X, X.r.id);
    const r = (await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok' })).structuredContent.task;
    expect(r).toMatchObject({ status: 'approved', awaiting_approval: true });
    expect((await api('POST', `/teams/${X.tid}/tasks/${t.id}/approve`)).body.task.status).toBe('done');
  });

  it('on-demand: an overdue task keeps its assignee and alerts once; unrelated calls do not hide it; progress clears it', async () => {
    const X = await team({ lease_minutes: 30 });
    await X.C('message_send', { room_id: X.room, body: 'before the switch', client_msg_id: cid() });
    const sw = await api('PATCH', `/teams/${X.tid}`, { delivery_mode: 'on_demand' });
    expect(sw.body.team.delivery_mode).toBe('on_demand');
    expect(app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE team_id=? AND kind='message' AND acked_at IS NULL").get(X.tid)).toMatchObject({ n: 0 });
    const info = await X.W1('team_info');
    expect(info.content[0]!.text).toContain('on demand');
    expect(info.structuredContent.teams[0].playbook).toContain('do not poll');
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    app.db.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(Date.now() - 1000, t.id);
    app.teams.tick(true);
    app.teams.tick(true);
    const k = app.teams.task(t.id)!;
    expect(k).toMatchObject({ status: 'in_progress', assignee_agent_id: X.w1.id });
    expect(k.overdue_at).toBeGreaterThan(0);
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='task_overdue' AND subject=?").get(t.id)).toMatchObject({ n: 1 });
    const v = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(v.members.find((m: any) => m.agent_id === X.w1.id).stalled).toBe(true);
    expect(v.members.find((m: any) => m.agent_id === X.w2.id).stalled).toBe(false);
    await X.W1('session_whoami');
    expect(app.teams.task(t.id)!.overdue_at).toBeGreaterThan(0);
    await X.W1('task_progress', { task_id: t.id, note: 'running', until: Date.now() + 3 * 3600_000 });
    expect(app.teams.task(t.id)!.overdue_at).toBeNull();
    expect(app.teams.task(t.id)!.lease_expires_at!).toBeGreaterThan(Date.now() + 2 * 3600_000);
  });

  it('on-demand: the check-in time is the assignee\'s own until, also when a team switches over', async () => {
    const X = await team({ lease_minutes: 1440 });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const soon = Date.now() + 3600_000;
    await X.W1('task_progress', { task_id: t.id, note: 'run', until: soon });
    await api('PATCH', `/teams/${X.tid}`, { delivery_mode: 'on_demand', lease_minutes: 180 });
    expect(app.teams.task(t.id)!.lease_expires_at).toBe(soon);
    const sooner = Date.now() + 1800_000;
    await X.W1('task_progress', { task_id: t.id, note: 'still running', until: sooner });
    expect(app.teams.task(t.id)!.lease_expires_at).toBe(sooner);
    await X.W1('task_progress', { task_id: t.id, note: 'no estimate' });
    expect(Math.abs(app.teams.task(t.id)!.lease_expires_at! - (Date.now() + 180 * 60_000))).toBeLessThan(5000);
  });

  it('on-demand: pause and resume move the check-in deadline by the paused time', async () => {
    const X = await team();
    await api('PATCH', `/teams/${X.tid}`, { delivery_mode: 'on_demand' });
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    const before = app.teams.task(t.id)!.lease_expires_at!;
    await api('POST', `/teams/${X.tid}/pause`);
    app.db.prepare('UPDATE teams SET paused_at=paused_at-600000 WHERE id=?').run(X.tid);
    await api('POST', `/teams/${X.tid}/resume`);
    expect(app.teams.task(t.id)!.lease_expires_at!).toBeGreaterThanOrEqual(before + 600_000);
  });

  it('on-demand: room messages are read once with message_read, not queued; a polling team of the same agent still queues', async () => {
    const X = await team();
    await api('PATCH', `/teams/${X.tid}`, { delivery_mode: 'on_demand' });
    await drain(X.W2);
    await X.C('message_send', { room_id: X.room, body: 'on-demand hello', client_msg_id: cid() });
    expect(app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind='message' AND acked_at IS NULL").get(X.w2.id)).toMatchObject({ n: 0 });
    const first = (await X.W2('message_read', { room_id: X.room })).structuredContent;
    expect(first.messages.map((m: any) => m.content)).toContain('on-demand hello');
    expect(first.read_only).toBeUndefined();
    expect((await X.W2('message_read', { room_id: X.room })).structuredContent.messages).toHaveLength(0);
    // the same worker also joins a polling team: that room still arrives through work_next
    const pc = mk('pcoord');
    const p = await api('POST', '/teams', { name: `poll${++n}`, goal: 'g', grant_messaging: true, members: [{ agent_id: pc.id, role: 'coordinator' }, { agent_id: X.w2.id, role: 'worker' }] });
    await api('POST', `/teams/${p.body.team.id}/start`);
    const PC = await pc.login();
    await PC('message_send', { room_id: p.body.team.room_id, body: 'polling hello', client_msg_id: cid() });
    expect(app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND team_id=? AND kind='message' AND acked_at IS NULL").get(X.w2.id, p.body.team.id)).toMatchObject({ n: 1 });
    const mixed = (await X.W2('message_read', { room_id: p.body.team.room_id })).structuredContent;
    expect(mixed.read_only_rooms).toEqual([p.body.team.room_id]);
  });
});

describe('recruiting: a coordinator adds agents within the envelope', () => {
  const vaultRules = (X: T, path = '/vault/Proj/**') => app.keys.setRules(X.c.cred.policy_id, [
    { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
    { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search', 'fs.update', 'fs.create'], resource: `path:${path}` },
    { effect: 'deny', actions: ['fs.read'], resource: 'path:/vault/Proj/Secret/**' },
  ], 'test', sys);

  it('is refused while recruiting is off', async () => {
    const X = await team();
    expect((await X.C('team_recruit', { team_id: X.tid, label: 'R2', role: 'reviewer', purpose: 'p' })).structuredContent.error).toBe('denied');
  });

  it('auto: creates the agent with a read-only copy of the coordinator\'s access, hands the key to the coordinator, respects the limits', async () => {
    const X = await team();
    vaultRules(X);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_max: 1 });
    expect((await X.C('team_recruit', { team_id: X.tid, label: 'Boss', role: 'coordinator', purpose: 'p' })).structuredContent.error).toBe('invalid_argument');
    const r = await X.C('team_recruit', { team_id: X.tid, label: 'Second reviewer', role: 'reviewer', purpose: 'Check the statistics' });
    expect(r.structuredContent.status).toBe('created');
    const secret = /ah_ses_\S+/.exec(r.structuredContent.handoff)![0];
    const aid = r.structuredContent.agent_id as string;
    const agent = app.keys.agent(aid)!;
    expect(agent).toMatchObject({ recruited_team_id: X.tid, recruited_by: X.c.id, role: 'reviewer', role_detail: 'Check the statistics' });
    const cred = app.keys.credentials({ kind: 'session_key', agentId: aid })[0]!;
    expect(cred.expires_at!).toBeLessThan(Date.now() + 8 * 86_400_000);
    const rules = app.keys.rules(cred.policy_id, false);
    expect(rules.some((x) => x.actions.includes('fs.update'))).toBe(false);
    expect(rules.some((x) => x.effect === 'deny' && x.resource === 'path:/vault/Proj/Secret/**')).toBe(true);
    // the recruit can log in with the handoff and is a reviewer of the team
    const R2 = await loginWith(appKey, secret);
    expect((await R2('team_info')).structuredContent.teams[0].my_role).toBe('reviewer');
    expect((await X.C('team_recruit', { team_id: X.tid, label: 'Third', role: 'worker', purpose: 'p' })).structuredContent.error).toBe('invalid_state');
    const v = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(v.members.find((m: any) => m.agent_id === aid).recruited_by).toBe(X.c.id);
    // switching recruiting off revokes the recruit's key
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'off' });
    expect(app.keys.credential(cred.id)!.status).toBe('revoked');
  });

  it('a template that exceeds the coordinator\'s own access is refused', async () => {
    const X = await team();
    vaultRules(X);
    const tpl = await api('POST', '/templates', { name: `wide${++n}`, rules: [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }] });
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_template_id: tpl.body.id });
    const r = (await X.C('team_recruit', { team_id: X.tid, label: 'Wide', role: 'worker', purpose: 'p' })).structuredContent;
    expect(r.error).toBe('denied');
  });

  it('propose: the administrator approves, gets the handoff, and the coordinator is told', async () => {
    const X = await team();
    vaultRules(X);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'propose' });
    const r = (await X.C('team_recruit', { team_id: X.tid, label: 'Stake', role: 'stakeholder', purpose: 'Funder view' })).structuredContent;
    expect(r).toMatchObject({ status: 'pending' });
    const list = (await api('GET', '/recruits?status=pending')).body.requests;
    expect(list.some((q: any) => q.id === r.request_id)).toBe(true);
    const ok = await api('POST', `/recruits/${r.request_id}/approve`);
    expect(ok.body.handoff).toContain('ah_ses_');
    expect((await api('GET', `/teams/${X.tid}`)).body.team.members.some((m: any) => m.agent_id === ok.body.agent.id && m.role === 'stakeholder')).toBe(true);
    const notices = (await X.C('session_whoami')).structuredContent.notices as { kind: string; body: string }[];
    expect(notices.some((x) => x.kind === 'recruit_decision' && x.body.includes('approved'))).toBe(true);
    const r2 = (await X.C('team_recruit', { team_id: X.tid, label: 'Other', role: 'worker', purpose: 'p' })).structuredContent;
    expect((await api('POST', `/recruits/${r2.request_id}/deny`, { note: 'not now' })).body.denied).toBe(true);
    expect((await api('POST', `/recruits/${r2.request_id}/approve`)).status).toBe(409);
  });
});

describe('telemetry', () => {
  it('reports cycles, per-agent volume and estimated context from what the hub already records', async () => {
    const X = await team();
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'result' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok' });
    await X.C('task_complete', { task_id: t.id });
    const r = (await api('GET', `/telemetry?team=${X.tid}&days=1`)).body;
    const c = r.cycles.find((x: any) => x.task_id === t.id);
    expect(c).toMatchObject({ status: 'done' });
    expect(c.calls).toBeGreaterThan(0);
    expect(c.bookkeeping_calls).toBeGreaterThan(0);
    expect(c.est_tokens).toBeGreaterThan(0);
    expect(r.agents.some((a: any) => a.agent_id === X.w1.id && a.calls > 0)).toBe(true);
    expect(r.totals.measured_calls).toBeGreaterThan(0);
    expect((await api('PUT', '/telemetry/baseline', { label: 'Before the hub', calls_per_cycle: 4, tokens_per_cycle: 700000 })).status).toBe(200);
    expect((await api('GET', `/telemetry?team=${X.tid}&days=1`)).body.baseline).toMatchObject({ calls_per_cycle: 4 });
  });
});

describe('team plan: requirements and milestones', () => {
  it('the coordinator sets and updates the plan; members read it; tasks link to it; changes are announced only when items come or go', async () => {
    const X = await team();
    expect((await X.W1('team_plan_set', { team_id: X.tid, requirements: [{ key: 'R1', title: 'x' }] })).structuredContent.error).toBe('denied');
    const set = (await X.C('team_plan_set', { team_id: X.tid, version: 0,
      requirements: [{ key: 'R1', title: 'Certified bound', priority: 'must', criteria: 'proof checked', milestones: ['M1'] }, { key: 'R2', title: 'Open question', status: 'unclear' }],
      milestones: [{ key: 'M1', title: 'Draft proof', due_at: Date.now() + 86_400_000 }] })).structuredContent;
    expect(set.plan.version).toBe(1);
    expect(set.plan.requirements.map((r: any) => [r.key, r.status, r.links])).toEqual([['R1', 'open', ['M1']], ['R2', 'unclear', []]]);
    // stale version, unknown link and bad status are refused
    expect((await X.C('team_plan_set', { team_id: X.tid, version: 0, requirements: [] })).structuredContent.error).toBe('conflict');
    expect((await X.C('team_plan_update', { team_id: X.tid, requirements: [{ key: 'R3', title: 'y', milestones: ['M9'] }] })).structuredContent.error).toBe('invalid_argument');
    expect((await X.C('team_plan_update', { team_id: X.tid, requirements: [{ key: 'R1', status: 'done' }] })).structuredContent.error).toBe('invalid_argument');
    // members are told about new items, and can read the plan
    const n1 = (await X.W1('session_whoami')).structuredContent.notices as { kind: string; body: string }[];
    expect(n1.some((x) => x.kind === 'plan_changed' && x.body.includes('R1'))).toBe(true);
    expect((await X.W1('team_plan', { team_id: X.tid })).content[0]!.text).toContain('R1 [open, must] Certified bound -> M1');
    // a task links to a requirement; its progress shows on the requirement
    const t = (await X.C('task_create', { team_id: X.tid, title: 'prove it', reviewer: X.r.id, refs: ['R1'] })).structuredContent.task;
    expect(t.refs).toEqual(['R1']);
    expect((await X.C('task_create', { team_id: X.tid, title: 'bad', refs: ['R9'] })).structuredContent.error).toBe('invalid_argument');
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await X.W1('task_submit', { task_id: t.id, summary: 'ok' });
    await X.R('task_review', { task_id: t.id, decision: 'approve', comments: 'ok' });
    await X.C('task_complete', { task_id: t.id });
    // a status-only update keeps the other fields and does not notify
    await drain(X.W1);
    const up = (await X.C('team_plan_update', { team_id: X.tid, requirements: [{ key: 'R1', status: 'met', evidence: 'commit abc' }] })).structuredContent.plan;
    const r1 = up.requirements.find((r: any) => r.key === 'R1');
    expect(r1).toMatchObject({ status: 'met', evidence: 'commit abc', criteria: 'proof checked', links: ['M1'], tasks: { done: 1, total: 1 } });
    expect((((await X.W1('session_whoami')).structuredContent.notices ?? []) as { kind: string }[]).filter((x) => x.kind === 'plan_changed')).toHaveLength(0);
    // the operator sees it and can ask for a review
    const v = (await api('GET', `/teams/${X.tid}`)).body.team;
    expect(v.plan.requirements).toHaveLength(2);
    expect((await api('POST', `/teams/${X.tid}/plan-request`, { note: 'add milestones for R2' })).body.team.plan.requested_at).toBeGreaterThan(0);
    const n2 = (await X.C('session_whoami')).structuredContent.notices as { kind: string; body: string }[];
    expect(n2.some((x) => x.kind === 'plan_request' && x.body.includes('add milestones for R2'))).toBe(true);
    await X.C('team_plan_update', { team_id: X.tid, remove: ['R2'] });
    expect((await api('GET', `/teams/${X.tid}`)).body.team.plan).toMatchObject({ requested_at: null });
  });
});

describe('a new login continues where the agent left off', () => {
  it('delivers a directive sent before the first login, keeps unconfirmed notices across logins, and does not replay read messages', async () => {
    const X = await team({}, true);
    // directive to an agent that has never logged in
    const fresh = mk('fresh');
    await api('POST', `/agents/${fresh.id}/notices`, { kind: 'directive', body: 'cite every claim' });
    const F1 = await fresh.login();
    expect(((await F1('session_whoami')).structuredContent.notices as { body: string }[]).map((n) => n.body)).toContain('cite every claim');
    // an unconfirmed notice is still there after logging in again
    const F2 = await fresh.login();
    expect(((await F2('session_whoami')).structuredContent.notices as { body: string }[]).map((n) => n.body)).toContain('cite every claim');
    const seq = ((await F2('session_whoami')).structuredContent.notices as { seq: number; body: string }[]).find((n) => n.body === 'cite every claim')!.seq;
    await F2('session_ack', { notice_seq: seq });
    const F3 = await fresh.login();
    expect((((await F3('session_whoami')).structuredContent.notices ?? []) as { body: string }[]).map((n) => n.body)).not.toContain('cite every claim');
    // on-demand room messages read in one login are not replayed in the next
    await api('PATCH', `/teams/${X.tid}`, { delivery_mode: 'on_demand' });
    await X.C('message_send', { room_id: X.room, body: 'read me once', client_msg_id: cid() });
    expect((await X.W1('message_read', { room_id: X.room })).structuredContent.messages.map((m: any) => m.content)).toContain('read me once');
    const W1b = await X.w1.login();
    expect((await W1b('message_read', { room_id: X.room })).structuredContent.messages).toHaveLength(0);
  });
});

describe('session token in a header (credential helper login)', () => {
  const rpc = async (headers: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  it('works without session_login or session_token, refuses expired or conflicting tokens with the right status, and stops when the key is suspended', async () => {
    const a = mk('helperagent');
    const login = await rpc({ authorization: `Bearer ${appKey}` }, 'session_login', { session_key: a.secret });
    const token = login.body.result.structuredContent.session_token as string;
    const h = { authorization: `Bearer ${appKey}`, 'x-agent-hub-session': token };
    const who = await rpc(h, 'session_whoami');
    expect(who.status).toBe(200);
    expect(who.body.result.structuredContent.agent_id).toBe(a.id);
    // the server tells a header client not to log in
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: h } }));
    expect(c.getInstructions()).toContain('already logged in');
    // a different token in the arguments is refused
    expect((await rpc(h, 'session_whoami', { session_token: 'ah_tok_' + 'x'.repeat(40) })).body.result.structuredContent.error).toBe('invalid_argument');
    // an expired token is refused at HTTP level, so the client's helper logs in again
    app.db.prepare('UPDATE session_tokens SET expires_at=? WHERE app_credential_id IS NOT NULL AND token_hash IN (SELECT token_hash FROM session_tokens ORDER BY created_at DESC LIMIT 1)').run(Date.now() - 1000);
    const exp = await rpc(h, 'session_whoami');
    expect(exp.status).toBe(401);
    expect(exp.body.error).toBe('login_required');
    // a suspended key cannot log in again, and its token is refused
    const login2 = await rpc({ authorization: `Bearer ${appKey}` }, 'session_login', { session_key: a.secret });
    const h2 = { authorization: `Bearer ${appKey}`, 'x-agent-hub-session': login2.body.result.structuredContent.session_token as string };
    expect((await rpc(h2, 'session_whoami')).status).toBe(200);
    app.keys.setStatus(a.cred.id, 'suspended', 'test', sys);
    const sus = await rpc(h2, 'session_whoami');
    expect(sus.status).toBe(401);
    expect(['key_inactive', 'login_required']).toContain(sus.body.error);
  });
});

describe('code review fixes (10 Nov)', () => {
  const coordVault = (X: T, extra: { effect: 'allow' | 'deny'; actions: string[]; resource: string }[] = []) => app.keys.setRules(X.c.cred.policy_id, [
    { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
    { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search'], resource: 'path:/vault/**' },
    { effect: 'deny', actions: ['fs.read'], resource: 'path:/vault/HR/**' },
    ...extra,
  ], 'test', sys);
  const recruitArgs = (X: T, label: string) => ({ team_id: X.tid, label, role: 'worker', purpose: 'p' });

  it('a lockdown stops recruiting and plan writes; reads stay open', async () => {
    const X = await team();
    coordVault(X);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_max: 3 });
    app.lockdown.set('writes', undefined, true, null);
    try {
      expect((await X.C('team_recruit', recruitArgs(X, 'Locked'))).structuredContent.error).toBe('lockdown');
      expect((await X.C('team_plan_set', { team_id: X.tid, requirements: [{ key: 'R1', title: 'x' }] })).structuredContent.error).toBe('lockdown');
      expect((await X.C('team_plan', { team_id: X.tid })).isError).toBeFalsy();
    } finally { app.lockdown.set('writes', undefined, false, null); }
    app.lockdown.set('team', X.tid, true, null);
    try { expect((await X.C('team_recruit', recruitArgs(X, 'Team-locked'))).structuredContent.status).toBeUndefined(); }
    finally { app.lockdown.set('team', X.tid, false, null); }
    expect((await X.C('team_recruit', recruitArgs(X, 'Open again'))).structuredContent.status).toBe('created');
  });

  it('a recruit never inherits a temporary grant, and a template carries the coordinator\'s deny rules', async () => {
    const X = await team();
    coordVault(X);
    const admin = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id, now = Date.now();
    app.db.prepare("INSERT INTO temporary_grants(id,credential_id,actions,resource,resource_kind,not_before,not_after,granted_by,created_at) VALUES ('tgr_rv1',?,?,?,'path',?,?,?,?)")
      .run(X.c.cred.id, JSON.stringify(['fs.read']), 'path:/vault/HR/Pay/**', now, now + 3600_000, admin, now);
    await api('PATCH', `/teams/${X.tid}`, { recruiting: 'auto', recruit_max: 3 });
    const r1 = (await X.C('team_recruit', recruitArgs(X, 'Copy'))).structuredContent;
    const rules1 = app.keys.rules(app.keys.credentials({ kind: 'session_key', agentId: r1.agent_id })[0]!.policy_id, false);
    expect(rules1.some((x) => x.resource === 'path:/vault/HR/Pay/**')).toBe(false);
    expect(rules1.some((x) => x.effect === 'deny' && x.resource === 'path:/vault/HR/**')).toBe(true);
    // A template inside the coordinator's allow passes, but its deny comes along; one beyond it is refused.
    const ok = await api('POST', '/templates', { name: `inside${++n}`, rules: [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }] });
    await api('PATCH', `/teams/${X.tid}`, { recruit_template_id: ok.body.id });
    const r2 = (await X.C('team_recruit', recruitArgs(X, 'Templated'))).structuredContent;
    const rules2 = app.keys.rules(app.keys.credentials({ kind: 'session_key', agentId: r2.agent_id })[0]!.policy_id, false);
    expect(rules2.some((x) => x.effect === 'deny' && x.resource === 'path:/vault/HR/**')).toBe(true);
    const wide = await api('POST', '/templates', { name: `beyond${++n}`, rules: [{ effect: 'allow', actions: ['fs.update'], resource: 'path:/vault/**' }] });
    await api('PATCH', `/teams/${X.tid}`, { recruit_template_id: wide.body.id });
    expect((await X.C('team_recruit', recruitArgs(X, 'Too wide'))).structuredContent.error).toBe('denied');
  });

  it('a room member without read rights gets no message items', async () => {
    const X = await team();
    await Promise.all([X.W1, X.W2].map(drain));
    const own = app.keys.rules(X.w2.cred.policy_id, false).map(({ id: _i, ...r }) => r);
    app.keys.setRules(X.w2.cred.policy_id, [...own, { effect: 'deny', actions: ['room.read_history'], resource: `room:${X.room}` }], 'test', sys);
    expect((await X.C('message_send', { room_id: X.room, body: 'for readers only', client_msg_id: cid() })).isError).toBeFalsy();
    const w1 = (await X.W1('work_next')).structuredContent;
    expect(w1.item?.kind).toBe('message');
    const w2 = (await X.W2('work_next')).structuredContent;
    expect(w2.item?.message?.content).not.toBe('for readers only');
  });

  it('rotating a member\'s key keeps its team grants after the next membership change', async () => {
    const X = await team();
    const rot = await api('POST', `/keys/${X.w1.cred.id}/rotate`);
    expect(rot.status).toBe(200);
    const extra = mk('late');
    expect((await api('POST', `/teams/${X.tid}/members`, { agent_id: extra.id, role: 'worker' })).status).toBeLessThan(300);
    const W1 = await loginWith(appKey, rot.body.secret);
    expect((await W1('task_list', { team_id: X.tid })).isError).toBeFalsy();
  });

  it('session_ack cannot hide future notices', async () => {
    const X = await team();
    await X.W1('session_ack', { notice_seq: 1e12 });
    app.keys.notify(X.w1.id, 'directive', 'Please check the plan.');
    const notices = (await X.W1('session_whoami')).structuredContent.notices as { kind: string }[];
    expect(notices.some((x) => x.kind === 'directive')).toBe(true);
  });

  it('blob clean-up keeps a blob that was just reused and removes an unreferenced one', async () => {
    const reused = Buffer.from(`reused ${Date.now()}`), orphan = Buffer.from(`orphan ${Date.now()}`);
    const a = await app.store.putBlob(reused), b = await app.store.putBlob(orphan);
    app.db.prepare('UPDATE blobs SET created_at=1 WHERE hash IN (?,?)').run(a.hash, b.hash);
    await app.store.putBlob(reused); // reuse restarts the grace period
    await app.maintenance.gcBlobs(Date.now() - 60_000);
    expect(app.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(a.hash)).toBeTruthy();
    expect(app.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(b.hash)).toBeUndefined();
    expect(app.store.getBlobSync(a.hash)?.toString()).toBe(reused.toString());
  });
});

describe('code review fixes, second batch (11 Nov)', () => {
  it('pausing and resuming a polling team keeps a declared busy-until time', async () => {
    const X = await team();
    await drain(X.W1);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    const until = Date.now() + 5 * 3600_000;
    await X.W1('task_progress', { task_id: t.id, note: 'long run', until });
    await api('POST', `/teams/${X.tid}/pause`);
    await api('POST', `/teams/${X.tid}/resume`);
    expect(app.teams.task(t.id)!.lease_expires_at!).toBeGreaterThanOrEqual(until);
  });

  it('caps notices per response at 20 and says how many wait', async () => {
    const a = mk('busy-notices');
    const A = await a.login();
    for (let i = 0; i < 25; i++) app.keys.notify(a.id, 'directive', `note ${i}`);
    const r = (await A('session_whoami')).structuredContent;
    expect(r.notices).toHaveLength(20);
    expect(r.notices_more).toBe(5);
  });

  it('a list-only grant sees no content hash and no backlinks', async () => {
    const a = mk('lister');
    app.keys.setRules(a.cred.policy_id, [
      { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
      { effect: 'allow', actions: ['fs.list'], resource: 'path:/vault/**' },
    ], 'test', sys);
    writeFileSync(join(app.config.vaultDir, 'listed.md'), 'secret words');
    const A = await a.login();
    const st = (await A('file_stat', { path: '/vault/listed.md' })).structuredContent;
    expect(st.revision).toBeNull();
    expect(st.linked_from).toEqual([]);
    const ls = (await A('file_list', { path: '/vault' })).structuredContent.entries.find((e: any) => e.path === '/vault/listed.md');
    expect(ls.revision).toBeUndefined();
  });

  it('pruning keeps each agent\'s newest login and drops old dead ones', async () => {
    const a = mk('pruned');
    await a.login(); await a.login(); await a.login();
    const rows = () => app.db.prepare('SELECT token_hash FROM session_tokens WHERE session_credential_id=? ORDER BY created_at').all(a.cred.id) as { token_hash: string }[];
    const all = rows();
    app.db.prepare('UPDATE session_tokens SET expires_at=1, revoked_at=1 WHERE session_credential_id=?').run(a.cred.id);
    app.maintenance.prune(Date.now());
    expect(rows().map((r) => r.token_hash)).toEqual([all.at(-1)!.token_hash]);
  });
});

describe('decisions: agents ask the operator', () => {
  const notices = async (call: Call) => ((await call('session_whoami')).structuredContent.notices ?? []) as { seq: number; kind: string; body: string }[];
  const opts = [{ key: 'a', label: 'Run 23e', effect: 'about 6 h on h200' }, { key: 'b', label: 'Drop g0 from the equality rule', effect: 'no rerun' }];

  it('a worker asks with a task: the task waits, the operator answers, the task goes back and the log keeps it', async () => {
    const X = await team({}, true);
    await Promise.all([X.C, X.W1].map(drain));
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await X.W1('task_start', { task_id: t.id });
    await api('PUT', `/teams/${X.tid}/decision-log`, { path: '/vault/Decisions log.md' });
    const asked = (await X.W1('team_ask', { team_id: X.tid, question: 'Run 23e or drop g0?', context: 'ET-B11 stopped at 23d.', options: opts, recommended: 'a', task_id: t.id })).structuredContent;
    expect(asked).toMatchObject({ status: 'open', task_id: t.id, recommended: 'a' });
    expect(app.teams.task(t.id)).toMatchObject({ status: 'blocked' });
    expect(app.teams.task(t.id)!.blocked_reason).toContain('Run 23e or drop g0?');
    expect((await notices(X.C)).some((n) => n.kind === 'decision_asked' && n.body.includes(asked.decision_id))).toBe(true);
    // the console: open questions, counts, and the answer
    expect((await api('GET', '/decisions/counts')).body.by_team[X.tid]).toBe(1);
    const open = (await api('GET', `/decisions?team=${X.tid}&status=open`)).body.decisions;
    expect(open.map((d: any) => d.id)).toEqual([asked.decision_id]);
    const ans = await api('POST', `/decisions/${asked.decision_id}/answer`, { option: 'a', text: 'Keep g0; the claim needs it.' });
    expect(ans.status).toBe(200);
    expect(ans.body.decision).toMatchObject({ status: 'answered', answer_option: 'a', answer_label: 'Run 23e' });
    expect(app.teams.task(t.id)).toMatchObject({ status: 'assigned', assignee_agent_id: X.w1.id, blocked_reason: null });
    const n = await notices(X.W1);
    expect(n.some((x) => x.kind === 'decision' && x.body.includes('Run 23e') && x.body.includes('task_start'))).toBe(true);
    const log = (await X.W1('team_decisions', { team_id: X.tid })).structuredContent.decisions;
    expect(log[0]).toMatchObject({ decision_id: asked.decision_id, status: 'answered', answer: 'Run 23e', answer_text: 'Keep g0; the claim needs it.' });
    // the vault note got the entry
    const note = readFileSync(join(app.config.vaultDir, 'Decisions log.md'), 'utf8');
    expect(note).toContain('Run 23e or drop g0?');
    expect(note).toContain('**Decision:** Run 23e — Keep g0; the claim needs it.');
    expect((await api('POST', `/decisions/${asked.decision_id}/answer`, { option: 'b' })).status).toBe(409);
  });

  it('more information, decline and withdraw; the limits hold', async () => {
    const X = await team({}, true);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    // only the assignee (or a coordinator) may block a task with a question
    expect((await X.W2('team_ask', { team_id: X.tid, question: 'Not mine?', task_id: t.id })).structuredContent.error).toBe('denied');
    expect((await X.W1('team_ask', { team_id: X.tid, question: 'One option?', options: [opts[0]] })).structuredContent.error).toBe('invalid_argument');
    expect((await X.W1('team_ask', { team_id: X.tid, question: 'Bad pick?', options: opts, recommended: 'z' })).structuredContent.error).toBe('invalid_argument');
    const q = (await X.W1('team_ask', { team_id: X.tid, question: 'Which dataset?', task_id: t.id })).structuredContent;
    expect((await X.W1('team_ask', { team_id: X.tid, question: 'Again?', task_id: t.id })).structuredContent.error).toBe('invalid_state');
    await api('POST', `/decisions/${q.decision_id}/more-info`, { note: 'Which sizes are in each?' });
    expect((await notices(X.W1)).some((x) => x.kind === 'decision_needs_info' && x.body.includes('Which sizes'))).toBe(true);
    const upd = (await X.W1('team_ask_update', { decision_id: q.decision_id, context: 'A: 10 GB, B: 2 GB.' })).structuredContent;
    expect(upd.status).toBe('open');
    expect((await api('GET', `/decisions/${q.decision_id}`)).body.decision.context).toContain('A: 10 GB');
    await api('POST', `/decisions/${q.decision_id}/decline`, { note: 'Your call.' });
    expect(app.teams.task(t.id)!.status).toBe('assigned');
    // withdraw gives the task back too
    const w = (await X.W1('team_ask', { team_id: X.tid, question: 'Start over?', task_id: t.id })).structuredContent;
    expect((await X.W2('team_ask_update', { decision_id: w.decision_id, withdraw: true })).structuredContent.error).toBe('denied');
    expect((await X.W1('team_ask_update', { decision_id: w.decision_id, withdraw: true })).structuredContent.status).toBe('withdrawn');
    expect(app.teams.task(t.id)!.status).toBe('assigned');
    // at most five open questions per agent
    for (let i = 0; i < 5; i++) expect((await X.S('team_ask', { team_id: X.tid, question: `Q${i}?` })).structuredContent.status).toBe('open');
    expect((await X.S('team_ask', { team_id: X.tid, question: 'Sixth?' })).structuredContent.error).toBe('rate_limited');
    // a lockdown stops asking but not reading the log
    app.lockdown.set('writes', undefined, true, null);
    try {
      expect((await X.R('team_ask', { team_id: X.tid, question: 'Locked?' })).structuredContent.error).toBe('lockdown');
      expect((await X.R('team_decisions', { team_id: X.tid, status: 'open' })).structuredContent.decisions.length).toBe(5);
    } finally { app.lockdown.set('writes', undefined, false, null); }
    // agents outside the team cannot read its log
    const out = mk('outsider-dec'); const O = await out.login();
    expect((await O('team_decisions', { team_id: X.tid })).isError).toBeTruthy();
  });
});

describe('permission changes are explained', () => {
  it('a notice says what changed (none when nothing did), and a denied call is marked allowed once access is granted', async () => {
    const a = mk('perm-diff');
    const base = [{ effect: 'allow' as const, actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow' as const, actions: ['fs.list', 'fs.read'], resource: 'path:/vault/A/**' }];
    app.keys.setRules(a.cred.policy_id, base, 'start', sys);
    const A = await a.login();
    await A('session_ack', { notice_seq: 1e6 });
    expect((await A('file_read', { path: '/vault/B/x.md' })).structuredContent.error).toBe('denied');
    const denied = () => api('GET', `/invocations?credential=${a.cred.id}`).then((r) => r.body.invocations.find((i: any) => i.tool === 'file_read'));
    expect(await denied()).toMatchObject({ result: 'denied', now_allowed: false, denied_action: 'fs.read', denied_path: '/vault/B/x.md' });
    app.keys.setRules(a.cred.policy_id, [...base, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/B/**' }], 'let it read B', sys);
    const n = ((await A('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    const msg = n.find((x) => x.kind === 'permissions_changed')!.body;
    expect(msg).toContain('added fs.read on path:/vault/B/**');
    expect(msg).toContain('let it read B');
    expect(await denied()).toMatchObject({ result: 'denied', now_allowed: true });
    // the same rules again: no notice
    const count = () => (app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='permissions_changed'").get(a.id) as { n: number }).n;
    const before = count();
    app.keys.setRules(a.cred.policy_id, [...base, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/B/**' }], 'same again', sys);
    expect(count()).toBe(before);
  });
});

describe('decisions asked by the coordinator for a worker\'s task', () => {
  it('the worker also gets the answer, and the coordinator is told whose task it is', async () => {
    const X = await team({}, true);
    const t = await mkTask(X);
    await X.C('task_assign', { task_id: t.id, agent_id: X.w1.id });
    await Promise.all([X.C, X.W1].map((c) => c('session_ack', { notice_seq: 1e6 })));
    const q = (await X.C('team_ask', { team_id: X.tid, question: 'Rerun or park?', options: [{ key: 'a', label: 'Rerun' }, { key: 'b', label: 'Park' }], recommended: 'a', task_id: t.id })).structuredContent;
    await api('POST', `/decisions/${q.decision_id}/answer`, { option: 'a' });
    const w = ((await X.W1('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(w.some((n) => n.kind === 'decision' && n.body.includes('about your task') && n.body.includes('task_start'))).toBe(true);
    const c = ((await X.C('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(c.find((n) => n.kind === 'decision')!.body).toContain('assigned to w1 again');
  });
});

describe('directives: standing rules with scope, versions and read tracking', () => {
  it('agents see the directives in force, confirm the version they read, and the console sees who is behind', async () => {
    const X = await team();
    app.keys.updateAgent(X.w1.id, { project: 'Dir' }, sys);
    await Promise.all([X.C, X.W1, X.W2].map((c) => c('session_ack', { notice_seq: 1e6 })));
    const mk_ = (b: Record<string, unknown>) => api('POST', '/directives', b).then((r) => { expect(r.status).toBe(200); return r.body.directive; });
    const project = await mk_({ title: 'Token rules', body: 'Save as many tokens as possible.', scope: { kind: 'project', ref: 'Dir' } });
    const teamD = await mk_({ title: 'Report daily', body: 'Post a status every day.', scope: { kind: 'team', ref: X.tid } });
    const role = await mk_({ title: 'Workers cite sources', body: 'Cite the vault note for each claim.', scope: { kind: 'role', ref: `${X.tid}|worker` } });
    // w1 is in project Dir and a worker: three directives, most specific first; w2 only the team and role ones; the coordinator only the team one
    const l1 = (await X.W1('directives_list')).structuredContent.directives;
    expect(l1.map((d: any) => d.id)).toEqual([role.id, teamD.id, project.id]);
    expect(l1.every((d: any) => d.read === 'unread')).toBe(true);
    expect((await X.W2('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([role.id, teamD.id]);
    expect((await X.C('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([teamD.id]);
    // a new directive arrives once as a notice; whoami lists titles only
    const n = ((await X.W1('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(n.filter((x) => x.kind === 'directive_changed').length).toBe(3);
    expect((await X.W1('session_whoami')).content[0]!.text).toContain('Directives in force');
    // read and confirm; a stale version is refused
    expect((await X.W1('directives_read', { id: project.id })).structuredContent.directives[0].text).toBe('Save as many tokens as possible.');
    expect((await X.W1('directive_ack', { id: project.id, version: 2 })).structuredContent.error).toBe('invalid_argument');
    await X.W1('directive_ack', { id: project.id, version: 1 });
    let cov = (await api('GET', `/directives/${project.id}`)).body.coverage;
    expect(cov).toEqual([expect.objectContaining({ agent_id: X.w1.id, read: 'current' })]);
    // an edit bumps the version: w1 is now out of date and is told
    await api('PATCH', `/directives/${project.id}`, { body: 'Save tokens; slow down near the limit.', note: 'rule 10' });
    cov = (await api('GET', `/directives/${project.id}`)).body.coverage;
    expect(cov[0]).toMatchObject({ read: 'outdated', version: 1 });
    expect((await X.W1('directives_list')).structuredContent.directives.find((d: any) => d.id === project.id)).toMatchObject({ version: 2, read: 'outdated' });
    const list = (await api('GET', '/directives')).body.directives.find((d: any) => d.id === project.id);
    expect(list).toMatchObject({ agents: 1, outdated: 1, current: 0 });
    // retire: agents are told to stop, and it is no longer in force
    await api('POST', `/directives/${role.id}/retire`, { note: 'merged into the team rule' });
    expect((await X.W2('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([teamD.id]);
    const n2 = ((await X.W2('session_whoami')).structuredContent.notices ?? []) as { kind: string; body: string }[];
    expect(n2.some((x) => x.body.includes('retired') && x.body.includes('Stop following'))).toBe(true);
  });

  it('rules agents report are in force at once; the operator keeps, merges or edits them', async () => {
    const X = await team();
    await Promise.all([X.W1, X.W2].map((c) => c('session_ack', { notice_seq: 1e6 })));
    // registered at once, in force for the reporter and counted as read by it
    const r1 = (await X.W1('directives_report', { title: 'TOKEN-RULES.md', source: '/mnt/share/BIRAZ/AgentsRoom/TOKEN-RULES.md', summary: '10 rules on saving tokens.', text: '1. Save as many tokens as possible.' })).structuredContent;
    expect(r1).toMatchObject({ version: 1 });
    const l1 = (await X.W1('directives_list')).structuredContent.directives;
    expect(l1).toEqual([expect.objectContaining({ id: r1.directive_id, title: 'TOKEN-RULES.md', read: 'current' })]);
    // the same title again updates the agent's own directive (new text, new version, still read)
    const again = (await X.W1('directives_report', { title: 'token rules', summary: 'Updated.', text: '1. Save tokens.\n10. Slow down near the limit.' })).structuredContent;
    expect(again).toMatchObject({ directive_id: r1.directive_id, version: 2 });
    // the same rule from another agent: a second unreviewed directive, shown together
    const r2 = (await X.W2('directives_report', { title: 'Token rules', summary: 'Save tokens.', text: 'Save tokens.' })).structuredContent;
    const list = (await api('GET', '/directives')).body;
    const mine = list.unreviewed.filter((d: any) => [r1.directive_id, r2.directive_id].includes(d.id));
    expect(mine.map((d: any) => d.key)).toEqual(['token rules', 'token rules']);
    expect((await api('GET', '/directives/unreviewed-count')).body.count).toBeGreaterThanOrEqual(2);
    // merge into one team directive: both reporters follow it, the two retire
    const merged = (await api('POST', '/directives/merge', { ids: [r1.directive_id, r2.directive_id], title: 'Token rules', body: 'Save tokens; slow down near the limit.', scope: { kind: 'team', ref: X.tid } })).body.directive;
    expect(merged).toMatchObject({ scope_kind: 'team', status: 'active' });
    expect((await api('GET', `/directives/${merged.id}`)).body.directive.reviewed_at).toBeTruthy();
    expect((await X.W1('directives_list')).structuredContent.directives.map((d: any) => d.id)).toEqual([merged.id]);
    const n = ((await X.W2('session_whoami')).structuredContent.notices ?? []) as { body: string }[];
    expect(n.some((x) => x.body.includes('is merged into'))).toBe(true);
    // keep as is: a single report marked reviewed; review all
    const r3 = (await X.W1('directives_report', { title: 'Cite sources', summary: 'Cite the vault note.' })).structuredContent;
    expect((await api('GET', `/directives/${r3.directive_id}`)).body.directive).toMatchObject({ reviewed_at: null, reported_by: X.w1.id, body: 'Cite the vault note.' });
    await api('POST', `/directives/${r3.directive_id}/review`);
    expect((await api('GET', `/directives/${r3.directive_id}`)).body.directive.reviewed_at).toBeTruthy();
    await X.W2('directives_report', { title: 'Old habit', summary: 'Re-read every file.' });
    expect((await api('POST', '/directives/review-all', {})).body.reviewed).toBeGreaterThanOrEqual(1);
    expect((await api('GET', '/directives/unreviewed-count')).body.count).toBe(0);
    // an edit by the operator counts as a review and reaches the agent as a change
    await api('PATCH', `/directives/${r3.directive_id}`, { scope: { kind: 'team', ref: X.tid }, note: 'for the whole team' });
    expect((await X.W2('directives_list')).structuredContent.directives.some((d: any) => d.id === r3.directive_id)).toBe(true);
  });
});
