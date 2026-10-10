import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
