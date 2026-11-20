/**
 * Record past work as done, and link a fix to a done task (docs/mcp.md, "Record past work" and "A task that fixes a done
 * task"). The operator always records; a coordinator only where the team's setting allows it (off by default); a worker
 * never. A recorded task is done with no review round, marked "recorded by <name>, not reviewed", audited, never counted
 * toward a requirement and never evidence. A fix names a done task of the same project, and both tasks show the link.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const code = (r: Res) => (r.isError ? r.structuredContent?.error ?? /^(\w+)/.exec(text(r))?.[1] : 'ok');
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
/** A running team (coordinator and worker) in its own project, with one requirement FR-RD-01 in its module. */
async function team(name: string) {
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent(`${name}-coord`), w = agent(`${name}-worker`);
  const id = app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }] }, sys).id;
  app.teams.start(id, sys);
  const p = app.blueprint.ensureTeamProject(id);
  app.blueprint.write(p.id, { version: app.blueprint.project(p.id)!.version, ops: [{ op: 'upsert', kind: 'module', key: 'RD', title: 'Records', team_id: id },
    { op: 'upsert', kind: 'fr', key: 'FR-RD-01', parent_key: 'RD', title: 'Past work is on record' }] }, { kind: 'operator', id: null });
  return { id, project: p.id, c: { ...c, call: await session(c.secret) }, w: { ...w, call: await session(w.secret) } };
}
type T = Awaited<ReturnType<typeof team>>;
const record = (X: T, b: Record<string, unknown> = {}) => api('POST', `/teams/${X.id}/tasks/record`, { title: 'Shipped the exporter last month', summary: 'Merged as abc123; docs in docs/export.md.', ...b });
const audits = (action: string, id: string) => app.db.prepare('SELECT actor_kind, actor_id FROM audit_events WHERE action=? AND target_id=?').all(action, id) as { actor_kind: string; actor_id: string | null }[];
const events = (id: string) => app.db.prepare('SELECT tool, from_status, to_status, note FROM task_events WHERE task_id=? ORDER BY id').all(id) as { tool: string; from_status: string | null; to_status: string; note: string | null }[];
const view = async (X: T, id: string) => (await api('GET', `/teams/${X.id}/tasks/${id}`)).body.task;
const setting = (X: T, on: boolean) => api('PATCH', `/teams/${X.id}`, { coordinator_records_done: on });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrd-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 40 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('record past work as done', () => {
  it('the operator records past work: done at once, marked not reviewed, audited, with no review round, assignee or files', async () => {
    const X = await team('Rec Op');
    const r = await record(X, { refs: ['FR-RD-01'] });
    expect(r.status).toBe(200);
    const k = r.body.task;
    expect(k).toMatchObject({ status: 'done', assignee: null, reviewer: null, review_rounds: 0, review: 'none', summary: 'Merged as abc123; docs in docs/export.md.', refs: ['FR-RD-01'], share_id: null });
    expect(k.recorded).toMatchObject({ by_kind: 'admin', reviewed: false });
    expect(k.recorded.label).toMatch(/^recorded by .+, not reviewed$/);
    expect(events(k.id)).toEqual([{ tool: 'task_record_done', from_status: null, to_status: 'done', note: 'recorded as done, not reviewed' }]);
    expect(audits('task.record_done', k.id)).toEqual([expect.objectContaining({ actor_kind: 'admin' })]);
    // The console's task screen reads the same view.
    expect((await view(X, k.id)).recorded.label).toBe(k.recorded.label);
    // A summary is required.
    expect((await record(X, { summary: ' ' })).status).toBe(400);
  });

  it('a coordinator is refused while the team setting is off (the default), and records once the operator turns it on', async () => {
    const X = await team('Rec Coord');
    expect((await api('GET', `/teams/${X.id}`)).body.team.coordinator_records_done).toBe(false);
    const args = { team_id: X.id, title: 'Wrote the importer before the hub', record_done: { summary: 'In tools/import.ts, used since spring.' } };
    const off = await X.c.call('task_create', args);
    expect(code(off)).toBe('denied');
    expect(text(off)).toContain('Coordinator records past work');
    expect(app.db.prepare("SELECT COUNT(*) n FROM tasks WHERE team_id=? AND recorded_at IS NOT NULL").get(X.id)).toEqual({ n: 0 });
    expect((await setting(X, true)).status).toBe(200);
    expect((await api('GET', `/teams/${X.id}`)).body.team.coordinator_records_done).toBe(true);
    const k = ok(await X.c.call('task_create', args)).task;
    expect(k).toMatchObject({ status: 'done', review_rounds: 0, summary: 'In tools/import.ts, used since spring.' });
    expect(k.recorded).toMatchObject({ by_kind: 'agent', by: X.c.id, label: `recorded by ${'Rec Coord-coord'}, not reviewed` });
    expect(audits('task.record_done', k.id)).toEqual([{ actor_kind: 'agent', actor_id: X.c.id }]);
    // Turned off again, it is refused again.
    await setting(X, false);
    expect(code(await X.c.call('task_create', args))).toBe('denied');
  });

  it('a worker is always refused, also with the team setting on', async () => {
    const X = await team('Rec Worker');
    await setting(X, true);
    const r = await X.w.call('task_create', { team_id: X.id, title: 'Mine', record_done: { summary: 'done' } });
    expect(code(r)).toBe('denied');
    expect(app.db.prepare('SELECT COUNT(*) n FROM tasks WHERE team_id=?').get(X.id)).toEqual({ n: 0 });
  });

  it('record_done carries no review, reviewer or files: those options are refused with it', async () => {
    const X = await team('Rec Opts');
    await setting(X, true);
    for (const extra of [{ reviewer: X.w.id }, { review: 'required' }, { claimable: true }, { attachments: [{ path: 'a.txt', content: 'x' }] }]) {
      const r = await X.c.call('task_create', { team_id: X.id, title: 'x', record_done: { summary: 's' }, ...extra });
      expect(code(r)).toBe('invalid_argument');
    }
    expect(app.db.prepare('SELECT COUNT(*) n FROM tasks WHERE team_id=?').get(X.id)).toEqual({ n: 0 });
  });

  it('a recorded task linked to a requirement never counts toward it, and cannot be its evidence', async () => {
    const X = await team('Rec Met');
    const k = (await record(X, { refs: ['FR-RD-01'] })).body.task;
    const req = (await api('GET', `/teams/${X.id}`)).body.team.plan.requirements.find((r: any) => r.key === 'FR-RD-01');
    expect(req.tasks).toEqual({ done: 0, total: 0 });
    const v = app.blueprint.project(X.project)!.version;
    expect(() => app.blueprint.write(X.project, { version: v, ops: [{ op: 'upsert', kind: 'fr', key: 'FR-RD-01', fields: { evidence: `task:${k.id}` } }] }, { kind: 'operator', id: null }))
      .toThrow(/recorded as done without review/);
    // Feedback and progress read its review as none: it is never reviewed work.
    expect(app.teams.effectiveReview(app.teams.task(k.id)!)).toBe('none');
  });
});

describe('a task that fixes a done task', () => {
  it('task_create fixes names a done task; both tasks show the link, and each gets an event', async () => {
    const X = await team('Fix Link');
    const done = (await record(X)).body.task;
    const fix = ok(await X.c.call('task_create', { team_id: X.id, title: 'Fix the exporter crash', fixes: done.id })).task;
    expect(fix.fixes).toEqual({ id: done.id, title: done.title, status: 'done' });
    const d = await view(X, done.id);
    expect(d.fixed_by).toEqual([{ id: fix.id, title: 'Fix the exporter crash', status: fix.status }]);
    expect(events(done.id).at(-1)).toMatchObject({ tool: 'task_fixed_by', note: fix.id });
    expect(events(fix.id)[0]!.note).toContain(`fixes ${done.id}`);
  });

  it('task_update sets and clears the link; a task that is not done, itself, or of another project is refused', async () => {
    const X = await team('Fix Upd'), Y = await team('Fix Other');
    const done = (await record(X)).body.task;
    const open = ok(await X.c.call('task_create', { team_id: X.id, title: 'Still open' })).task;
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'x', fixes: open.id }))).toBe('invalid_argument');
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'x', fixes: 'task_nope' }))).toBe('invalid_argument');
    const elsewhere = (await record(Y)).body.task;
    expect(code(await X.c.call('task_create', { team_id: X.id, title: 'x', fixes: elsewhere.id }))).toBe('invalid_argument');
    expect(code(await X.c.call('task_update', { task_id: open.id, version: open.version, fixes: open.id }))).toBe('invalid_argument');
    const set = ok(await X.c.call('task_update', { task_id: open.id, version: open.version, fixes: done.id })).task;
    expect(set.fixes).toMatchObject({ id: done.id });
    expect((await view(X, done.id)).fixed_by.map((x: any) => x.id)).toEqual([open.id]);
    const cleared = ok(await X.c.call('task_update', { task_id: open.id, version: set.version, fixes: null })).task;
    expect(cleared.fixes).toBeNull();
    expect((await view(X, done.id)).fixed_by).toEqual([]);
    // The operator records a fix of past work in one step too.
    const rec = (await record(X, { title: 'Hotfix shipped', fixes: done.id })).body.task;
    expect(rec.fixes).toMatchObject({ id: done.id });
  });
});
