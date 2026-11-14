import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { KeyError } from '../src/keys/keys.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey: string;
const clients: Client[] = [];

async function agent(label: string) {
  const a = app.keys.createAgent(label, null, sys);
  const key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  const client = new Client({ name: label, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const login = await client.callTool({ name: 'session_login', arguments: { session_key: key.secret } });
  const token = login.structuredContent!.session_token;
  return {
    id: a.id,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { session_token: token, ...args } });
      return { error: result.isError, data: result.structuredContent as Record<string, any> };
    },
  };
}
type Agent = Awaited<ReturnType<typeof agent>>;

async function fixture(extraReviewer = true) {
  const [coord, worker, rival, reviewer, backup] = await Promise.all(['coordinator', 'worker', 'rival', 'reviewer', 'backup'].map(agent));
  const members = [
    { agent_id: coord!.id, role: 'coordinator' }, { agent_id: worker!.id, role: 'worker' },
    { agent_id: rival!.id, role: 'worker' }, { agent_id: reviewer!.id, role: 'reviewer' },
    ...(extraReviewer ? [{ agent_id: backup!.id, role: 'reviewer' }] : []),
  ];
  const team = app.teams.create({ name: 'Workflow regression', goal: 'Independent review', members }, sys);
  app.teams.start(team.id, sys);
  const result = await coord!.call('task_create', { team_id: team.id, title: 'Review this change', claimable: true, reviewer: reviewer!.id });
  expect(result.error).toBeFalsy();
  return { team, coord: coord!, worker: worker!, rival: rival!, reviewer: reviewer!, backup: backup!, task: result.data.task };
}

async function submitted(f: Awaited<ReturnType<typeof fixture>>) {
  const claim = await f.worker.call('task_claim', { task_id: f.task.id, version: f.task.version, start: true });
  expect(claim.data.task.status).toBe('in_progress');
  expect((await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Completed with evidence' })).data.task.status).toBe('in_review');
}

/** A share by this agent with published versions 1..n (the tools' upload path is covered elsewhere). */
function share(author: string, versions = 2): string {
  const id = `shr_t${Math.random().toString(36).slice(2, 12)}`, now = Date.now();
  const cred = app.keys.credentials({ kind: 'session_key', agentId: author })[0]!.id;
  app.db.prepare('INSERT INTO shares(id,author_agent_id,author_credential_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, author, cred, 'Evidence', now, now);
  for (let v = 1; v <= versions; v++) app.db.prepare("INSERT INTO share_versions(share_id,version,manifest,upload_kind,status,created_at) VALUES (?,?,'[]','inline','published',?)").run(id, v, now);
  return id;
}

async function nextNonNotice(a: Agent) {
  for (let i = 0; i < 20; i++) {
    const r = await a.call('work_next', { wait_seconds: 0 });
    if (r.data.status !== 'item' || r.data.item.kind !== 'notice') return r;
    await a.call('work_ack', { item_id: r.data.item.item_id });
  }
  throw new Error('Notice queue did not drain');
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-resubmit-'));
  const vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp(testConfig(dir, { dbFile: join(dir, 'data', 'test.db'), vaultDir, pepper: 'test', publicUrl: 'http://fixture.test', adminPassword: 'fixture password' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const pc = app.keys.createMachine('fixture', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'test', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

const notices = (agentId: string, kind: string) => (app.db.prepare('SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind=?').get(agentId, kind) as { n: number }).n;
const pendingReviews = (agentId: string, taskId: string) => (app.db.prepare("SELECT COUNT(*) n FROM work_items WHERE agent_id=? AND kind='review_requested' AND ref_id=? AND acked_at IS NULL").get(agentId, taskId) as { n: number }).n;
async function inReview() {
  const f = await fixture(false);
  expect((await f.worker.call('task_claim', { task_id: f.task.id, version: f.task.version, start: true })).data.task.status).toBe('in_progress');
  const r = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'First round: commit aaa111' });
  expect(r.data.task.status).toBe('in_review');
  return { ...f, v1: r.data.task.version as number };
}

describe('replacing a pending submission (task_submit in review)', () => {
  it('replaces the summary, bumps the version, keeps the old summary in the history, one notice for the reviewer', async () => {
    const f = await inReview();
    // A review request is still pending: the replacement adds nothing (one item, which shows the new submission).
    const sx = share(f.worker.id);
    const r1 = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Second round: commit bbb222', share_id: sx, share_version: 2 });
    expect(r1.error).toBeFalsy();
    // The named share version is copied into the task's submission set, whose first round the task now names.
    expect(r1.data.task).toMatchObject({ status: 'in_review', reviewer: f.reviewer.id, summary: 'Second round: commit bbb222', share_version: 1, version: f.v1 + 1, submitted_version: f.v1 + 1, review_rounds: 0 });
    expect(r1.data.task.share_id).not.toBe(sx);
    expect((app.db.prepare('SELECT copied_from FROM share_versions WHERE share_id=? AND version=1').get(r1.data.task.share_id) as { copied_from: string }).copied_from).toBe(`share:${sx}@v2`);
    expect(pendingReviews(f.reviewer.id, f.task.id)).toBe(1);
    expect(notices(f.reviewer.id, 'submission_updated')).toBe(0);
    // The replacement re-opens the review turn: the reviewer has not seen the new submission (§8.4).
    expect(r1.data.handoff).toEqual({ to: f.reviewer.id, to_label: 'reviewer', phase: 'review', on_demand: false, seen: false });
    const item = await nextNonNotice(f.reviewer);
    expect(item.data.item).toMatchObject({ kind: 'review_requested', trust: 'L1' });
    expect(item.data.item.review.summary).toBe('Second round: commit bbb222');
    await f.reviewer.call('work_ack', { item_id: item.data.item.item_id });
    // The reviewer has the request already: the next replacement sends exactly one notice, written by the hub.
    const r2 = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Third round: commit ccc333' });
    expect(r2.data.task.version).toBe(f.v1 + 2);
    expect(notices(f.reviewer.id, 'submission_updated')).toBe(1);
    const body = (app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='submission_updated'").get(f.reviewer.id) as { body: string }).body;
    expect(body).toMatch(/^Submission updated for "Review this change"/);
    expect(body).not.toContain('ccc333');
    const hist = app.db.prepare("SELECT from_status, to_status, note FROM task_events WHERE task_id=? AND tool='task_submit' ORDER BY id").all(f.task.id) as { from_status: string; to_status: string; note: string }[];
    expect(hist.map((h) => `${h.from_status}>${h.to_status}`)).toEqual(['in_progress>in_review', 'in_review>in_review', 'in_review>in_review']);
    expect(hist.map((h) => h.note)).toEqual(['First round: commit aaa111', 'Second round: commit bbb222', 'Third round: commit ccc333']);
  });

  it('checks the submitted share, lets the reviewer read and comment while in review, and shows the share in the item (F-19)', async () => {
    const f = await fixture(false);
    await f.worker.call('task_claim', { task_id: f.task.id, version: f.task.version, start: true });
    expect((await f.worker.call('task_submit', { task_id: f.task.id, summary: 'x', share_id: 'shr_nothere00' })).data.error).toBe('invalid_argument');
    const sx = share(f.worker.id, 2);
    expect((await f.worker.call('task_submit', { task_id: f.task.id, summary: 'x', share_id: sx, share_version: 3 })).data.error).toBe('invalid_argument');
    expect((await f.worker.call('task_submit', { task_id: f.task.id, summary: 'x', share_version: 1 })).data.error).toBe('invalid_argument');
    const someone = share(f.rival.id, 1); // not listed for the worker: not the worker's to submit
    expect((await f.worker.call('task_submit', { task_id: f.task.id, summary: 'x', share_id: someone })).data.error).toBe('invalid_argument');
    expect((await f.reviewer.call('share_info', { share_id: sx })).error).toBeTruthy(); // not before the review
    const r = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Evidence attached', share_id: sx });
    // The latest published version (v2) is copied into the submission set; the task names the set's first round.
    const set = r.data.task.share_id as string;
    expect(r.data.task).toMatchObject({ status: 'in_review', share_version: 1 });
    expect(set).not.toBe(sx);
    expect((app.db.prepare('SELECT copied_from FROM share_versions WHERE share_id=? AND version=1').get(set) as { copied_from: string }).copied_from).toBe(`share:${sx}@v2`);
    expect((await f.reviewer.call('share_info', { share_id: set })).error).toBeFalsy();
    expect((await f.reviewer.call('share_info', { share_id: sx })).error).toBeTruthy(); // the original's readers are unchanged
    expect((await f.rival.call('share_info', { share_id: set })).error).toBeTruthy();
    const item = await nextNonNotice(f.reviewer);
    expect(item.data.item.review).toMatchObject({ share_id: set, share_version: 1 });
    await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Seen the share', version: 1000 });
    expect((await f.reviewer.call('share_info', { share_id: set })).error).toBeFalsy(); // the task's reviewer keeps reading its attachments
  });

  it('task_unblock restores the status from before the block; the assignee lifts only a block they set (F-34)', async () => {
    const f = await inReview();
    // A coordinator blocks a task in review; unblocking puts it back in review, and the reviewer is asked again.
    expect((await f.coord.call('task_block', { task_id: f.task.id, reason: 'Hold for the audit' })).data.task).toMatchObject({ status: 'blocked', blocked_from: 'in_review' });
    expect((await f.worker.call('task_unblock', { task_id: f.task.id })).data.error).toBe('denied');
    const ub = await f.coord.call('task_unblock', { task_id: f.task.id, note: 'Audit done' });
    expect(ub.data.task).toMatchObject({ status: 'in_review', reviewer: f.reviewer.id, blocked_reason: null, blocked_from: null });
    expect(ub.data.handoff).toMatchObject({ to: f.reviewer.id, phase: 'review', on_demand: false, seen: false });
    expect((await f.coord.call('task_unblock', { task_id: f.task.id })).data.error).toBe('invalid_state');
    expect(pendingReviews(f.reviewer.id, f.task.id)).toBeGreaterThanOrEqual(1);
    // A team_ask from in review no longer resets the task to assigned: the answer brings it back to review.
    const q = await f.worker.call('team_ask', { team_id: f.team.id, question: 'Keep the old API?', options: [{ key: 'a', label: 'Keep' }, { key: 'b', label: 'Drop' }], recommended: 'a', task_id: f.task.id });
    expect(q.error).toBeFalsy();
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'blocked', blocked_from: 'in_review' });
    await app.decisions.answer(q.data.decision_id, { option: 'a' }, { kind: 'admin', id: null });
    expect(app.teams.task(f.task.id)!.status).toBe('in_review');
    // The assignee lifts a block they set themselves (their own team_ask); the question stays open.
    await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'request_changes', comments: 'One more test', version: 1000 });
    await f.worker.call('task_start', { task_id: f.task.id });
    const q2 = await f.worker.call('team_ask', { team_id: f.team.id, question: 'Which test?', options: [{ key: 'a', label: 'Unit' }, { key: 'b', label: 'Story' }], recommended: 'a', task_id: f.task.id });
    expect((await f.worker.call('task_unblock', { task_id: f.task.id })).data.task).toMatchObject({ status: 'in_progress' });
    expect(app.decisions.get(q2.data.decision_id)).toMatchObject({ status: 'open' });
    // The operator lifts a block through the console route's service call.
    await f.coord.call('task_block', { task_id: f.task.id, reason: 'Waiting' });
    expect(app.teams.adminUnblock(f.team.id, f.task.id, 'Go on', { kind: 'admin', id: null })).toMatchObject({ status: 'in_progress', blocked_from: null });
    expect(() => app.teams.adminUnblock(f.team.id, f.task.id, null, { kind: 'admin', id: null })).toThrow(/not blocked/);
  });

  it('refuses a stale verdict with conflict; the current version and a verdict without a version still work', async () => {
    const f = await inReview();
    const v2 = (await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Replaced' })).data.task.version;
    const stale = await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Looks good', version: f.v1 });
    expect(stale.data.error).toBe('conflict');
    expect(JSON.stringify(stale.data)).toContain('The submission changed; re-read it with task_list.');
    const ok = await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'request_changes', comments: 'One more test', version: v2 });
    expect(ok.data.task).toMatchObject({ status: 'changes_requested', review_rounds: 1 });
    expect(ok.data.handoff).toMatchObject({ to: f.worker.id, phase: 'queued', on_demand: false });
    // Round two, a reviewer that passes no version: as before.
    await f.worker.call('task_start', { task_id: f.task.id });
    await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Fixed' });
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Fine', version: 1000 })).data.task.status).toBe('approved');
  });

  it('only the assignee can replace, and not while the team is paused', async () => {
    const f = await inReview();
    expect((await f.rival.call('task_submit', { task_id: f.task.id, summary: 'Hijack' })).data.error).toBe('denied');
    expect((await f.coord.call('task_submit', { task_id: f.task.id, summary: 'Hijack' })).data.error).toBe('denied');
    app.teams.pause(f.team.id, 'test', sys);
    expect((await f.worker.call('task_submit', { task_id: f.task.id, summary: 'While paused' })).data.error).toBe('paused');
    expect((await f.worker.call('task_withdraw', { task_id: f.task.id })).data.error).toBe('paused');
    app.teams.resume(f.team.id, sys);
    expect(app.teams.task(f.task.id)!.summary).toBe('First round: commit aaa111');
  });

  it('task_withdraw takes the submission back to in_progress and tells the reviewer', async () => {
    const f = await inReview();
    expect((await f.rival.call('task_withdraw', { task_id: f.task.id })).data.error).toBe('denied');
    const w = await f.worker.call('task_withdraw', { task_id: f.task.id, note: 'Found a bug' });
    expect(w.data.task).toMatchObject({ status: 'in_progress', submitted_version: null, review_rounds: 0 });
    expect(w.data.handoff).toBeUndefined(); // the assignee's own move hands nothing over
    expect(notices(f.reviewer.id, 'submission_withdrawn')).toBe(1);
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Too late', version: 1000 })).data.error).toBe('invalid_state');
    expect((await f.worker.call('task_withdraw', { task_id: f.task.id })).data.error).toBe('invalid_state');
    // The stale review request is dropped, and a new submission asks for a review again.
    const r = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Fixed the bug' });
    expect(r.data.task.status).toBe('in_review');
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Good', version: r.data.task.version })).data.task.status).toBe('approved');
  });
});
