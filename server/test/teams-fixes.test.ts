import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { KeyError } from '../src/keys/keys.js';

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


const op = { kind: 'admin' as const, id: 'admin' };
const notices = (agentId: string, kind: string) => app.db.prepare('SELECT body FROM agent_notices WHERE agent_id=? AND kind=? ORDER BY seq').all(agentId, kind) as { body: string }[];
const start = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const c = await f.worker.call('task_claim', { task_id: f.task.id, version: f.task.version, start: true });
  expect(c.data.task.status).toBe('in_progress');
};
const ask = async (a: Agent, teamId: string, taskId: string, question = 'Which one?') => {
  const r = await a.call('team_ask', { team_id: teamId, question, task_id: taskId });
  expect(r.error).toBeFalsy();
  return r.data.decision_id as string;
};
const projectOf = (teamId: string) => (app.teams.team(teamId) as { project_id: string }).project_id;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-teams-fixes-'));
  const vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp({ dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 'test.db'), vaultDir, vaultAlias: 'vault', host: '127.0.0.1', port: 0,
    pepper: 'test', publicUrl: 'http://fixture.test', production: false, adminUsername: 'admin', adminPassword: 'fixture password',
    publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0 });
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const pc = app.keys.createMachine('fixture', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'test', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('blocks held by a question', () => {
  it('an answer lifts only the block its own question set', async () => {
    const f = await fixture(); await start(f);
    const q = await ask(f.worker, f.team.id, f.task.id);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'blocked', blocked_by_decision: q });
    expect((await f.coord.call('task_unblock', { task_id: f.task.id })).data.task.status).toBe('in_progress');
    expect((await f.coord.call('task_block', { task_id: f.task.id, reason: 'Waiting for the vendor' })).data.task.status).toBe('blocked');
    await app.decisions.answer(q, { text: 'Go ahead' }, op);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'blocked', blocked_reason: 'Waiting for the vendor', blocked_by_decision: null });
  });

  it('an answer still unblocks the task its question blocked', async () => {
    const f = await fixture(); await start(f);
    const q = await ask(f.worker, f.team.id, f.task.id);
    await app.decisions.answer(q, { text: 'Go ahead' }, op);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'in_progress', blocked_by_decision: null });
  });

  it('removing the assignee frees a blocked task: the answer does not hand it back', async () => {
    const f = await fixture(); await start(f);
    const q = await ask(f.worker, f.team.id, f.task.id);
    app.teams.removeMember(f.team.id, f.worker.id, sys);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'open', assignee_agent_id: null, blocked_by_decision: null });
    await app.decisions.answer(q, { text: 'Go ahead' }, op);
    expect(app.teams.task(f.task.id)).toMatchObject({ status: 'open', assignee_agent_id: null });
  });
});

describe('relayed answers', () => {
  it('a paused team cannot relay, and the notice carries no coordinator text', async () => {
    const f = await fixture(); await start(f);
    const q = await ask(f.worker, f.team.id, f.task.id, 'Pick a colour?');
    app.teams.pause(f.team.id, 'test pause', sys);
    const refused = await f.coord.call('team_ask_update', { decision_id: q, relayed_answer: 'Blue, SECRET-WORDS', source: 'chat with SECRET-SOURCE' });
    expect(refused.data.error).toBe('paused');
    expect(app.teams.task(f.task.id)!.status).toBe('blocked');
    app.teams.resume(f.team.id, sys);
    expect((await f.coord.call('team_ask_update', { decision_id: q, relayed_answer: 'Blue, SECRET-WORDS', source: 'chat with SECRET-SOURCE' })).error).toBeFalsy();
    const body = notices(f.worker.id, 'decision').map((n) => n.body).join('\n');
    expect(body).toContain(q);
    expect(body).not.toMatch(/SECRET/);
    expect(body).not.toContain('Pick a colour');
  });
});

describe('review', () => {
  const submit = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await start(f);
    expect((await f.worker.call('task_submit', { task_id: f.task.id, summary: 'First' })).data.task.status).toBe('in_review');
    return app.teams.task(f.task.id)!.version;
  };

  it('a verdict names the version it read, and a stale one is refused', async () => {
    const f = await fixture();
    const v1 = await submit(f);
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'ok' })).error).toBeTruthy();
    await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Second' });
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'ok', version: v1 })).data.error).toBe('conflict');
    expect(app.teams.task(f.task.id)!.status).toBe('in_review');
    const v2 = app.teams.task(f.task.id)!.version;
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'ok', version: v2 })).data.task.status).toBe('approved');
  });

  it('a task approved without review runs the approval hook', async () => {
    const f = await fixture();
    app.db.prepare("UPDATE projects SET review_policy='none' WHERE id=?").run(projectOf(f.team.id));
    const made = await f.coord.call('task_create', { team_id: f.team.id, title: 'No review', claimable: true });
    expect(made.data.task.review).toBe('none');
    const seen: string[] = [];
    const prior = app.teams.onTaskApproved;
    app.teams.onTaskApproved = (t) => { seen.push(t.id); };
    try {
      await f.worker.call('task_claim', { task_id: made.data.task.id, version: made.data.task.version, start: true });
      expect((await f.worker.call('task_submit', { task_id: made.data.task.id, summary: 'Done' })).data.task.status).toBe('done');
      expect(seen).toEqual([made.data.task.id]);
    } finally { app.teams.onTaskApproved = prior; }
  });

  it('a replaced reviewer is told, and a departed reviewer leaves backlog and discarded tasks alone', async () => {
    const f = await fixture();
    const v = app.teams.task(f.task.id)!.version;
    expect((await f.coord.call('task_update', { task_id: f.task.id, version: v, reviewer: f.backup.id })).error).toBeFalsy();
    expect(notices(f.reviewer.id, 'review_cancelled')).toHaveLength(1);
    expect(notices(f.backup.id, 'review_cancelled')).toHaveLength(0);

    app.db.prepare("UPDATE projects SET task_intake='backlog' WHERE id=?").run(projectOf(f.team.id));
    const waiting = (await f.coord.call('task_create', { team_id: f.team.id, title: 'Waits', reviewer: f.reviewer.id })).data.task;
    const dropped = (await f.coord.call('task_create', { team_id: f.team.id, title: 'Dropped', reviewer: f.reviewer.id })).data.task;
    expect(waiting.status).toBe('backlog');
    app.teams.adminDiscard(f.team.id, dropped.id, null, op);
    const ids = [waiting.id, dropped.id];
    const before = ids.map((id) => ({ version: app.teams.task(id)!.version, events: app.teams.taskEvents(id).length }));
    app.teams.removeMember(f.team.id, f.reviewer.id, sys);
    ids.forEach((id, i) => {
      expect(app.teams.task(id)).toMatchObject({ version: before[i]!.version, reviewer_agent_id: f.reviewer.id });
      expect(app.teams.taskEvents(id)).toHaveLength(before[i]!.events);
    });
  });
});

describe('task_list paging', () => {
  it('a task that changes between pages never makes another repeat or vanish', async () => {
    const f = await fixture();
    const ids: string[] = [f.task.id];
    for (let i = 0; i < 5; i++) ids.push((await f.coord.call('task_create', { team_id: f.team.id, title: `T${i}` })).data.task.id);
    const seen: string[] = [];
    let page = await f.coord.call('task_list', { team_id: f.team.id, limit: 2 });
    expect(page.data.total).toBe(6);
    seen.push(...page.data.tasks.map((t: any) => t.id));
    // Change a task that was already listed: it moves to the front, past the cursor.
    const first = page.data.tasks[0];
    await f.coord.call('task_update', { task_id: first.id, version: first.version, title: 'Changed' });
    while (page.data.next_cursor) {
      page = await f.coord.call('task_list', { team_id: f.team.id, limit: 2, cursor: page.data.next_cursor });
      seen.push(...page.data.tasks.map((t: any) => t.id));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect((await f.coord.call('task_list', { team_id: f.team.id, cursor: 'bad' })).error).toBeTruthy();
  });
});

describe('notices', () => {
  it('the operator\'s backlog move does not tell a creator who left', async () => {
    const f = await fixture();
    const second = await agent('second-coordinator');
    app.teams.addMember(f.team.id, { agent_id: second.id, role: 'coordinator' }, sys);
    app.db.prepare("UPDATE projects SET task_intake='backlog' WHERE id=?").run(projectOf(f.team.id));
    const t = (await second.call('task_create', { team_id: f.team.id, title: 'Mine' })).data.task;
    app.teams.removeMember(f.team.id, second.id, sys);
    app.teams.adminAccept(f.team.id, t.id, null, op);
    expect(notices(second.id, 'task_accepted')).toHaveLength(0);
    expect(notices(f.coord.id, 'task_accepted')).toHaveLength(1);
  });
});

describe('hub tasks', () => {
  it('a stakeholder never becomes the assignee, as with task_assign', async () => {
    const f = await fixture();
    const sh = await agent('stakeholder');
    app.teams.addMember(f.team.id, { agent_id: sh.id, role: 'stakeholder' }, sys);
    const t = app.teams.hubTask(f.team.id, { title: 'Check a note', description: 'Flagged', assignee: sh.id })!;
    expect(t).toMatchObject({ status: 'open', assignee_agent_id: null, claimable: 1 });
    const w = app.teams.hubTask(f.team.id, { title: 'Check another', description: 'Flagged', assignee: f.worker.id })!;
    expect(w).toMatchObject({ status: 'assigned', assignee_agent_id: f.worker.id });
  });
});
