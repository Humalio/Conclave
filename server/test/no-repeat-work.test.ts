/**
 * The hub never hands out the same work twice, and a retry after a lost reply records nothing again (docs/mcp.md,
 * work_next, task_submit, task_review):
 * - an item delivered and not confirmed comes back to the same login first, as the same item marked repeat with
 *   delivered_at, while the delivery is younger than the team's lease; a new login or an older delivery gets it fresh;
 * - task_submit and task_review take a request_id: a retry with the same id returns the first result while the task is
 *   at the version that call left it at, and runs as usual (no replay) once the task moved on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { REQUEST_KEEP_MS } from '../src/teams/teams.js';
import { intakeOpen } from './intake.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey: string;
const clients: Client[] = [];

async function login(secret: string, label: string) {
  const client = new Client({ name: label, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = (await client.callTool({ name: 'session_login', arguments: { session_key: secret } })).structuredContent!.session_token;
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: { session_token: token, ...args } });
    return { error: r.isError, text: (r.content as { text: string }[])[0]?.text ?? '', data: r.structuredContent as Record<string, any> };
  };
}
async function agent(label: string) {
  const a = app.keys.createAgent(label, null, sys);
  const key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  return { id: a.id, call: await login(key.secret, label), relogin: () => login(key.secret, label) };
}
type Call = Awaited<ReturnType<typeof login>>;

let n = 0;
async function fixture() {
  const i = ++n;
  const [coord, worker, reviewer] = await Promise.all([`coord-${i}`, `worker-${i}`, `reviewer-${i}`].map(agent));
  const team = app.teams.create({ name: `No repeat ${i}`, goal: 'Do each piece of work once', members: [
    { agent_id: coord!.id, role: 'coordinator' }, { agent_id: worker!.id, role: 'worker' }, { agent_id: reviewer!.id, role: 'reviewer' }] }, sys);
  app.teams.start(team.id, sys);
  const task = (await coord!.call('task_create', { team_id: team.id, title: 'One piece of work', reviewer: reviewer!.id })).data.task;
  return { team, coord: coord!, worker: worker!, reviewer: reviewer!, task };
}
/** Confirm the notices queued so far, so the next item is the work. */
async function drain(call: Call) {
  for (let i = 0; i < 30; i++) {
    const r = await call('work_next', { wait_seconds: 0 });
    if (r.data.status !== 'item' || r.data.item.kind !== 'notice') return r;
    await call('work_ack', { item_id: r.data.item.item_id });
  }
  throw new Error('the notice queue did not drain');
}
async function inProgress(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await f.coord.call('task_assign', { task_id: f.task.id, agent_id: f.worker.id })).error).toBeFalsy();
  expect((await f.worker.call('task_start', { task_id: f.task.id })).data.task.status).toBe('in_progress');
}
const events = (taskId: string, tool: string) => (app.db.prepare('SELECT COUNT(*) n FROM task_events WHERE task_id=? AND tool=?').get(taskId, tool) as { n: number }).n;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-norepeat-'));
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

describe('work_next: an unconfirmed item comes back as a repeat', () => {
  it('delivered and not confirmed, inside the lease: the same item again, marked repeat with delivered_at, ahead of newer work', async () => {
    const f = await fixture();
    await f.coord.call('task_assign', { task_id: f.task.id, agent_id: f.worker.id });
    const first = await drain(f.worker.call);
    expect(first.data.item.kind).toBe('task_assigned');
    expect(first.data.item.repeat).toBe(false);
    // A notice queued since would come first by priority; the unconfirmed item still comes back first to this login.
    app.keys.notify(f.worker.id, 'status_report', 'Something new for the worker.');
    const again = await f.worker.call('work_next', { wait_seconds: 0 });
    expect(again.data.item.item_id).toBe(first.data.item.item_id);
    expect(again.data.item.repeat).toBe(true);
    expect(again.data.item.delivered_at).toBe(first.data.item.delivered_at);
    expect(again.data.item.task.id).toBe(f.task.id);
    expect(again.text).toMatch(/^Repeat: you were handed this item at .* do not do the work twice\./);
    // Once confirmed, the queue moves on to the notice.
    await f.worker.call('work_ack', { item_id: first.data.item.item_id });
    expect((await f.worker.call('work_next', { wait_seconds: 0 })).data.item.kind).toBe('notice');
  });

  it('a new login gets the item as a fresh delivery', async () => {
    const f = await fixture();
    await f.coord.call('task_assign', { task_id: f.task.id, agent_id: f.worker.id });
    const first = await drain(f.worker.call);
    expect(first.data.item.kind).toBe('task_assigned');
    const fresh = await drain(await f.worker.relogin());
    expect(fresh.data.item.item_id).toBe(first.data.item.item_id);
    expect(fresh.data.item.repeat).toBe(false);
    expect(fresh.data.item.delivered_at).toBeGreaterThanOrEqual(first.data.item.delivered_at);
    expect(fresh.text).not.toMatch(/^Repeat:/);
  });

  it('a delivery older than the lease is delivered as before, fresh and in priority order', async () => {
    const f = await fixture();
    await f.coord.call('task_assign', { task_id: f.task.id, agent_id: f.worker.id });
    const first = await drain(f.worker.call);
    const lease = f.team.lease_minutes * 60_000;
    app.db.prepare('UPDATE work_items SET last_delivered_at=last_delivered_at-? WHERE id=?').run(lease + 1000, first.data.item.item_id);
    app.keys.notify(f.worker.id, 'status_report', 'Something new for the worker.');
    // As today: the notice comes first by priority, and the task item after it is a fresh delivery.
    const next = await f.worker.call('work_next', { wait_seconds: 0 });
    expect(next.data.item.kind).toBe('notice');
    expect(next.data.item.repeat).toBe(false);
    await f.worker.call('work_ack', { item_id: next.data.item.item_id });
    const task = await f.worker.call('work_next', { wait_seconds: 0 });
    expect(task.data.item.item_id).toBe(first.data.item.item_id);
    expect(task.data.item.repeat).toBe(false);
  });

  it('a repeat that went stale (the task moved on) is dropped, not repeated', async () => {
    const f = await fixture();
    await f.coord.call('task_assign', { task_id: f.task.id, agent_id: f.worker.id });
    const first = await drain(f.worker.call);
    expect(first.data.item.kind).toBe('task_assigned');
    await f.worker.call('task_start', { task_id: f.task.id });
    const next = await f.worker.call('work_next', { wait_seconds: 0 });
    expect(next.data.status === 'idle' || next.data.item?.item_id !== first.data.item.item_id).toBe(true);
  });
});

describe('task_submit with a request id', () => {
  it('a submit whose reply was lost, retried with the same id: one submitted version and one review round', async () => {
    const f = await fixture();
    await inProgress(f);
    const a = { task_id: f.task.id, summary: 'Done, commit abc123', request_id: 'req-submit-1' };
    const first = await f.worker.call('task_submit', a);
    expect(first.error).toBeFalsy();
    expect(first.data.task.status).toBe('in_review');
    const retry = await f.worker.call('task_submit', a);
    expect(retry.error).toBeFalsy();
    expect(retry.data.replayed).toBe(true);
    expect(retry.text).toContain('Repeat of request req-submit-1');
    expect(retry.data.task.version).toBe(first.data.task.version);
    expect(retry.data.handoff).toEqual(first.data.handoff);
    const t = app.teams.task(f.task.id)!;
    expect([t.version, t.submitted_version]).toEqual([first.data.task.version, first.data.task.version]);
    expect(events(f.task.id, 'task_submit')).toBe(1);
    expect(t.review_rounds).toBe(0);
    // The reviewer was told once: no submission_updated notice for a retry.
    expect((app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='submission_updated'").get(f.reviewer.id) as { n: number }).n).toBe(0);
  });

  it('without a request id, or with another one, a second submit still replaces the submission as before', async () => {
    const f = await fixture();
    await inProgress(f);
    await f.worker.call('task_submit', { task_id: f.task.id, summary: 'First', request_id: 'req-a' });
    const other = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Second', request_id: 'req-b' });
    expect(other.data.replayed).toBeUndefined();
    expect(other.text).toMatch(/^Submission replaced/);
    await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Third' });
    expect(events(f.task.id, 'task_submit')).toBe(3);
  });

  it('a retry after the task moved on is not replayed', async () => {
    const f = await fixture();
    await inProgress(f);
    const a = { task_id: f.task.id, summary: 'Done', request_id: 'req-moved' };
    const first = await f.worker.call('task_submit', a);
    await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'request_changes', comments: 'Fix the test.', version: first.data.task.version });
    // The task is changes_requested now: the retry runs as a new call and is refused, it does not return the old result.
    const retry = await f.worker.call('task_submit', a);
    expect(retry.error).toBe(true);
    expect(retry.data.replayed).toBeUndefined();
    expect(retry.data.error).toBe('invalid_state');
    expect(events(f.task.id, 'task_submit')).toBe(1);
  });

  it('a request id is kept per agent and for about 24 hours', async () => {
    const f = await fixture();
    await inProgress(f);
    const a = { task_id: f.task.id, summary: 'Done', request_id: 'req-old' };
    await f.worker.call('task_submit', a);
    app.db.prepare('UPDATE task_requests SET created_at=created_at-? WHERE request_id=?').run(REQUEST_KEEP_MS + 1000, 'req-old');
    const late = await f.worker.call('task_submit', a);
    expect(late.data.replayed).toBeUndefined();
    expect(late.text).toMatch(/^Submission replaced/);
    expect(app.teams.replayRequest(f.reviewer.id, f.task.id, 'submit', 'req-old')).toBeNull();
  });
});

describe('task_review with a request id', () => {
  it('a review whose reply was lost, retried with the same id: one review is recorded', async () => {
    const f = await fixture();
    await inProgress(f);
    const s = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Done' });
    const a = { task_id: f.task.id, decision: 'request_changes', comments: 'Add a test.', version: s.data.task.version, request_id: 'req-review-1' };
    const first = await f.reviewer.call('task_review', a);
    expect(first.error).toBeFalsy();
    const retry = await f.reviewer.call('task_review', a);
    expect(retry.error).toBeFalsy();
    expect(retry.data.replayed).toBe(true);
    expect(retry.data.task.status).toBe('changes_requested');
    expect(events(f.task.id, 'task_review')).toBe(1);
    expect(app.teams.task(f.task.id)!.review_rounds).toBe(1);
  });

  it('a review retried after the task moved on is not replayed', async () => {
    const f = await fixture();
    await inProgress(f);
    const s = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Done' });
    const a = { task_id: f.task.id, decision: 'request_changes', comments: 'Add a test.', version: s.data.task.version, request_id: 'req-review-2' };
    await f.reviewer.call('task_review', a);
    await f.worker.call('task_start', { task_id: f.task.id });
    await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Test added' });
    const retry = await f.reviewer.call('task_review', a);
    expect(retry.error).toBe(true);
    expect(retry.data.replayed).toBeUndefined();
    expect(retry.data.error).toBe('conflict');
    expect(events(f.task.id, 'task_review')).toBe(1);
  });
});
