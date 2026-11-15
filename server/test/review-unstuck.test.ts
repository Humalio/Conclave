/**
 * Reviews that get stuck on tooling (docs/specification.md, "Review rounds", "Evidence the reviewer cannot open",
 * "Sending approved work back"; docs/decisions.md, "Correcting the options"): an unreadable share the hub confirms costs
 * no round and raises an alert; the round limit allows exactly the rounds its label says; a coordinator sends approved
 * work back as a counted, audited round, never a done task; an open question's options are corrected by its asker or
 * coordinator only, with every version kept, audited and noticed, and the console reloads a question whose options changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const admin = { kind: 'admin' as const, id: 'adm_fixture' };
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
      const text = (result.content as { type: string; text?: string }[] | undefined)?.map((c) => c.text ?? '').join(' ') ?? '';
      return { error: result.isError, data: result.structuredContent as Record<string, any>, text };
    },
  };
}
type Agent = Awaited<ReturnType<typeof agent>>;

let n = 0;
async function fixture(maxRounds = 3) {
  const [coord, worker, rival, reviewer] = await Promise.all(['coordinator', 'worker', 'rival', 'reviewer'].map((r) => agent(`${r} ${++n}`)));
  const team = app.teams.create({ name: `Unstuck ${n}`, goal: 'Reviews that do not get stuck', max_review_rounds: maxRounds, members: [
    { agent_id: coord!.id, role: 'coordinator' }, { agent_id: worker!.id, role: 'worker' }, { agent_id: rival!.id, role: 'worker' }, { agent_id: reviewer!.id, role: 'reviewer' }] }, sys);
  app.teams.start(team.id, sys);
  const made = await coord!.call('task_create', { team_id: team.id, title: 'Ship the change', claimable: true, reviewer: reviewer!.id });
  expect(made.error, made.text).toBeFalsy();
  const task = made.data.task;
  const claim = await worker!.call('task_claim', { task_id: task.id, version: task.version, start: true });
  expect(claim.error, claim.text).toBeFalsy();
  return { team, coord: coord!, worker: worker!, rival: rival!, reviewer: reviewer!, task };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** A share by this agent with one published version. */
function share(author: string): string {
  const id = `shr_t${Math.random().toString(36).slice(2, 12)}`, now = Date.now();
  const cred = app.keys.credentials({ kind: 'session_key', agentId: author })[0]!.id;
  app.db.prepare('INSERT INTO shares(id,author_agent_id,author_credential_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, author, cred, 'Evidence', now, now);
  app.db.prepare("INSERT INTO share_versions(share_id,version,manifest,upload_kind,status,created_at) VALUES (?,1,'[]','inline','published',?)").run(id, now);
  return id;
}
const status = (id: string) => app.teams.task(id)!;
async function submit(f: F, shareId?: string) {
  if (status(f.task.id).status !== 'in_progress') expect((await f.worker.call('task_start', { task_id: f.task.id })).error).toBeFalsy();
  const r = await f.worker.call('task_submit', { task_id: f.task.id, summary: 'Done, with evidence', ...(shareId ? { share_id: shareId } : {}) });
  expect(r.error, r.text).toBeFalsy();
  return r.data.task.version as number;
}
const ask = (f: F, args: Record<string, unknown>) => f.reviewer.call('task_review', { task_id: f.task.id, decision: 'request_changes', comments: 'Cannot check this yet.', ...args });
const alerts = (type: string, subject: string) => (app.db.prepare('SELECT COUNT(*) n FROM security_alerts WHERE type=? AND subject=?').get(type, subject) as { n: number }).n;
const audits = (action: string, id: string) => app.db.prepare('SELECT details FROM audit_events WHERE action=? AND target_id=? ORDER BY rowid').all(action, id) as { details: string }[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-unstuck-'));
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

describe('evidence the reviewer cannot open', () => {
  it('a share the task names that the hub confirms unreadable costs no round and alerts the operator', async () => {
    const f = await fixture();
    const sh = share(f.worker.id);
    const v = await submit(f, sh);
    // A fault in the hub's read rules: the task's copy of the share is closed, so even its reviewer is refused.
    app.db.prepare("UPDATE shares SET status='closed' WHERE id=?").run(status(f.task.id).share_id);
    const r = await ask(f, { version: v, reason: 'evidence_unreadable' });
    expect(r.error, r.text).toBeFalsy();
    expect(status(f.task.id)).toMatchObject({ status: 'changes_requested', review_rounds: 0 });
    expect(alerts('review_evidence_unreadable', f.task.id)).toBe(1);
    const ev = app.db.prepare("SELECT note FROM task_events WHERE task_id=? AND to_status='changes_requested' ORDER BY id DESC LIMIT 1").get(f.task.id) as { note: string };
    expect(ev.note).toMatch(/^Not counted as a round: the reviewer cannot read the submitted share /);
  });
  it('a readable share counts as an ordinary round, reason or not', async () => {
    const f = await fixture();
    const v = await submit(f, share(f.worker.id));
    expect((await ask(f, { version: v, reason: 'evidence_unreadable' })).error).toBeFalsy();
    expect(status(f.task.id)).toMatchObject({ status: 'changes_requested', review_rounds: 1 });
    expect(alerts('review_evidence_unreadable', f.task.id)).toBe(0);
  });
});

describe('the round limit', () => {
  it('a limit of 3 allows exactly 3 rounds: two requests send the task back, the third blocks it', async () => {
    const f = await fixture(3);
    for (const round of [1, 2]) {
      expect((await ask(f, { version: await submit(f) })).error).toBeFalsy();
      expect(status(f.task.id)).toMatchObject({ status: 'changes_requested', review_rounds: round });
    }
    expect((await ask(f, { version: await submit(f) })).error).toBeFalsy();
    expect(status(f.task.id)).toMatchObject({ status: 'blocked', review_rounds: 3, blocked_reason: 'Review round limit reached (3 of 3).' });
  });
  it('the console labels the setting as the code applies it', () => {
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    expect(js).toContain("twRow('Review rounds', 'Most review rounds per task. The request for changes that reaches it blocks the task and tells you.'");
  });
});

describe('sending approved work back', () => {
  it('the coordinator sends an approved task back with a reason: a counted, audited round, handed to the assignee', async () => {
    const f = await fixture();
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Good.', version: await submit(f) })).error).toBeFalsy();
    expect(status(f.task.id).status).toBe('approved');
    expect((await f.worker.call('task_reopen', { task_id: f.task.id, reason: 'x' })).error).toBeTruthy(); // coordinator only
    const r = await f.coord.call('task_reopen', { task_id: f.task.id, reason: 'The release test failed on Windows.' });
    expect(r.error, r.text).toBeFalsy();
    expect(status(f.task.id)).toMatchObject({ status: 'changes_requested', review_rounds: 1, review_comments: 'The release test failed on Windows.' });
    expect(app.teams.turnOf?.(f.task.id)?.holder ?? f.worker.id).toBe(f.worker.id);
    const a = audits('task.reopen', f.task.id);
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]!.details)).toMatchObject({ reason: 'The release test failed on Windows.', round: 1 });
    // Back to work, then in review again: the ordinary flow.
    expect((await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Fixed.', version: await submit(f) })).error).toBeFalsy();
  });
  it('a done task stays ended', async () => {
    const f = await fixture();
    await f.reviewer.call('task_review', { task_id: f.task.id, decision: 'approve', comments: 'Good.', version: await submit(f) });
    expect((await f.coord.call('task_complete', { task_id: f.task.id })).error).toBeFalsy();
    const r = await f.coord.call('task_reopen', { task_id: f.task.id, reason: 'Merge failed.' });
    expect(r.error).toBeTruthy();
    expect(r.text).toMatch(/done and stays ended\. Create a new task/);
    expect(status(f.task.id).status).toBe('done');
  });
});

describe('correcting an open question', () => {
  const opts = [{ key: 'a', label: 'Keep it' }, { key: 'b', label: 'Drop it' }];
  it('the asker and the coordinator change the options while it is open; every version is kept, audited and noticed', async () => {
    const f = await fixture();
    const asked = await f.worker.call('team_ask', { team_id: f.team.id, question: 'Keep the old route?', options: opts, recommended: 'a' });
    const id = asked.data.decision_id as string;
    expect(asked.data.options_version).toBe(1);
    // Anyone else is refused.
    expect((await f.rival.call('team_ask_update', { decision_id: id, recommended: 'b' })).error).toBeTruthy();
    // The asker adds an option and moves the recommendation.
    const mine = await f.worker.call('team_ask_update', { decision_id: id, options: [...opts, { key: 'c', label: 'Move it', effect: 'One more release' }], recommended: 'c' });
    expect(mine.error, mine.text).toBeFalsy();
    expect(mine.data).toMatchObject({ options_version: 2, recommended: 'c' });
    // The coordinator removes the recommended option: the recommendation goes with it.
    const co = await f.coord.call('team_ask_update', { decision_id: id, options: opts });
    expect(co.error, co.text).toBeFalsy();
    const d = app.decisions.get(id);
    expect(d).toMatchObject({ options_version: 3, recommended: null });
    expect(d.option_history.map((h) => [h.version, h.options.map((o) => o.key).join(''), h.recommended, h.changed_by])).toEqual([
      [1, 'ab', 'a', f.worker.id], [2, 'abc', 'c', f.worker.id], [3, 'ab', null, f.coord.id]]);
    expect(audits('decision.options', id).map((a) => JSON.parse(a.details).version)).toEqual([2, 3]);
    const notes = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND body LIKE ?").all(f.worker.id, `%options changed%`) as { body: string }[];
    expect(notes.length).toBeGreaterThanOrEqual(1); // the coordinator's change reached the asker
    // Nothing changed is refused.
    expect((await f.coord.call('team_ask_update', { decision_id: id, options: opts })).error).toBeTruthy();
    // An answer from the version before is refused, so the console reloads; the current version answers.
    await expect(app.decisions.answer(id, { option: 'a', options_version: 2 }, admin)).rejects.toMatchObject({ code: 'conflict' });
    expect((await app.decisions.answer(id, { option: 'a', options_version: 3 }, admin)).status).toBe('answered');
    // Answered: no more changes.
    const late = await f.worker.call('team_ask_update', { decision_id: id, recommended: 'b' });
    expect(late.error).toBeTruthy();
    expect(late.text).toMatch(/already answered/);
  });
  it('withdraw and added context are audited', async () => {
    const f = await fixture();
    const id = (await f.worker.call('team_ask', { team_id: f.team.id, question: 'Which port?', options: opts })).data.decision_id as string;
    expect((await f.worker.call('team_ask_update', { decision_id: id, context: 'The old one is taken.' })).error).toBeFalsy();
    expect((await f.worker.call('team_ask_update', { decision_id: id, withdraw: true })).error).toBeFalsy();
    expect(audits('decision.context', id)).toHaveLength(1);
    expect(audits('decision.withdraw', id)).toHaveLength(1);
  });
  it('the console sends the version it showed and reloads the question when the options changed', () => {
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    expect(js).toContain("await post(dp + '/answer', { option, text: text.value.trim() || null, options_version: version ?? null });");
    expect(js).toContain("if (e.code === 'conflict') { await reload('The options changed. Read them again.'); return; }");
    expect(js).toContain('if (open) decBind(dp, re, d.options_version);');
    expect(js).toContain("decBind(dp, done, d.options_version, async (msg) => { toast(msg); muGo('dec', id); });");
  });
});
