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
  const s = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Completed with evidence' });
  expect(s.data.task.status).toBe('in_review');
  // A polling reviewer: the result names the hand-off, with no wake text (docs/proposals/console-systems.md §8.4, 8.A9).
  expect(s.data.handoff).toEqual({ to: f.reviewer.id, to_label: 'reviewer', phase: 'review', on_demand: false, seen: false });
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
  const dir = mkdtempSync(join(tmpdir(), 'ah-workflow-review-'));
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

describe('authenticated multi-agent workflow regressions', () => {
  it('claims and starts atomically: concurrent worker loses, submitter cannot approve', async () => {
    const f = await fixture();
    const results = await Promise.all([f.worker, f.rival].map((a) => a.call('task_claim', { task_id: f.task.id, version: f.task.version, start: true })));
    expect(results.map((r) => r.error ? r.data.error : r.data.task.status).sort()).toEqual(['conflict', 'in_progress']);
    const winner = results[0]!.error ? f.rival : f.worker;
    expect((await winner.call('task_submit', { task_id: f.task.id, summary: 'Done' })).data.task.status).toBe('in_review');
    expect((await winner.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Self approval', version: 1000 })).data.error).toBe('denied');
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Independent approval', version: 1000 })).data.task.status).toBe('approved');
  });

  it('hands a departed reviewer submission to the remaining independent reviewer', async () => {
    const f = await fixture(); await submitted(f);
    app.teams.removeMember(f.team.id, f.reviewer.id, sys);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'in_review', reviewer_agent_id: f.backup.id, summary: 'Completed with evidence' });
    const work = await nextNonNotice(f.backup);
    expect(work.data.item).toMatchObject({ kind: 'review_requested', task: { id: f.task.id } });
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Late approval', version: 1000 })).error).toBeTruthy();
    expect((await f.backup.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Checked', version: 1000 })).data.task.status).toBe('approved');
  });

  it('hands the review to an independent coordinator when the only reviewer leaves and coordinators review', async () => {
    const f = await fixture(false);
    app.teams.update(f.team.id, { coordinator_reviews: true }, sys);
    await submitted(f);
    const before = app.teams.task(f.task.id)!;
    app.teams.removeMember(f.team.id, f.reviewer.id, sys);
    const after = app.teams.task(f.task.id)!;
    expect(after).toMatchObject({ status: 'in_review', assignee_agent_id: f.worker.id, reviewer_agent_id: f.coord.id, summary: 'Completed with evidence', submitted_version: before.submitted_version });
    const work = await nextNonNotice(f.coord);
    expect(work.data.item).toMatchObject({ kind: 'review_requested', task: { id: f.task.id } });
    expect((await f.coord.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Checked', version: 1000 })).data.task.status).toBe('approved');
  });

  it('waits in review when the only coordinator who could review is the task\'s own assignee', async () => {
    // A coordinator holds work only as a hub-raised task (a knowledge flag goes to its owner); it may not review its own submission.
    const f = await fixture(false);
    app.teams.update(f.team.id, { coordinator_reviews: true }, sys);
    await submitted(f);
    app.db.prepare('UPDATE tasks SET assignee_agent_id=? WHERE id=?').run(f.coord.id, f.task.id);
    app.teams.removeMember(f.team.id, f.reviewer.id, sys);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'in_review', assignee_agent_id: f.coord.id, reviewer_agent_id: null });
  });

  it('waits in review with its author when the only reviewer leaves, and goes on once the coordinator names a new one', async () => {
    const f = await fixture(false); await submitted(f);
    const before = app.teams.task(f.task.id)!;
    app.teams.removeMember(f.team.id, f.reviewer.id, sys);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'in_review', assignee_agent_id: f.worker.id, reviewer_agent_id: null, summary: before.summary, submitted_version: before.submitted_version });
    app.teams.addMember(f.team.id, { agent_id: f.backup.id, role: 'reviewer' }, sys);
    const named = await f.coord.call('task_update', { task_id: f.task.id, version: app.teams.task(f.task.id)!.version, reviewer: f.backup.id });
    expect(named.error).toBeFalsy();
    expect((await f.backup.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Checked', version: 1000 })).data.task.status).toBe('approved');
  });

  it('keeps approval and graph-side validation atomic when a hook rejects', async () => {
    const f = await fixture(); await submitted(f);
    const priorHook = app.teams.onTaskApproved;
    const before = app.teams.taskEvents(f.task.id).length;
    app.teams.onTaskApproved = () => {
      app.db.prepare('UPDATE tasks SET description=? WHERE id=?').run('must roll back', f.task.id);
      throw new KeyError('invalid_state', 'The flagged section has not changed.');
    };
    try {
      const r = await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Premature', version: 1000 });
      expect(r.data.error).toBe('invalid_state');
      expect(app.teams.task(f.task.id)).toMatchObject({ status: 'in_review', description: null });
      expect(app.teams.taskEvents(f.task.id)).toHaveLength(before);
    } finally { app.teams.onTaskApproved = priorHook; }
  });

  it('does not claim/start while paused, and preserves legacy claim-only behavior', async () => {
    const f = await fixture();
    app.teams.pause(f.team.id, 'Fixture pause', sys);
    expect((await f.worker.call('task_claim', { task_id: f.task.id, version: f.task.version, start: true })).data.error).toBe('paused');
    expect(app.teams.task(f.task.id)!.status).toBe('open');
    app.teams.resume(f.team.id, sys);
    expect((await f.worker.call('task_claim', { task_id: f.task.id, version: f.task.version })).data.task.status).toBe('assigned');
  });
});
