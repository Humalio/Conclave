/**
 * Small server fixes and the report archive (features round P5): R28 the operator's approve-without-review closes a
 * knowledge flag, R29 work_next waits by default, R30 directives_read {unread, ack}, R26 the feedback nudge, R27 a key
 * made from a PC page is bound, R9 the status-report archive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { BlueprintViews } from '../src/blueprint/views.js';
import { FEEDBACK_NUDGE } from '../src/mcp/writing.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const admin = { kind: 'admin' as const, id: 'adm_test' };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
type Rule = { effect: 'allow' | 'deny'; actions: string[]; resource: string };
const ALL: Rule[] = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'allow', actions: ['fs.*'], resource: 'path:/vault/**' }, { effect: 'allow', actions: ['graph.*'], resource: 'graph:vault' }];
let app: App, base = '', cookie = '', csrf = '', appKey = '', pcId = '';
const clients: Client[] = [];
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' }); clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
async function agent(label: string) {
  const a = app.keys.createAgent(label, null, sys), k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, ALL, 'test', sys);
  return { id: a.id, cred: k.credential.id, key: k, call: await session(k.secret) };
}
type Agent = Awaited<ReturnType<typeof agent>>;
/** A running team (coordinator, worker, reviewer, optionally a curator) in its own project. */
async function team(name: string, curator = false) {
  const c = await agent(`${name}-coord`), w = await agent(`${name}-worker`), r = await agent(`${name}-reviewer`), k = curator ? await agent(`${name}-curator`) : null;
  const id = app.teams.create({ name, goal: 'g', members: [
    { agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }, { agent_id: r.id, role: 'reviewer', credential_id: r.cred },
    ...(k ? [{ agent_id: k.id, role: 'curator', credential_id: k.cred }] : [])] }, sys).id;
  app.teams.start(id, sys);
  const project = app.blueprint.ensureTeamProject(id).id;
  return { id, project, c, w, r, k };
}
const file = (path: string) => app.store.fileByPath(path)!;
const put = (a: Agent, path: string, content: string) => {
  const current = file(path)?.current_revision ?? 'absent';
  return app.store.write(path.split('/'), Buffer.from(content), current, current === 'absent' ? 'create' : 'update', { agentId: a.id, credentialId: a.cred });
};
const audits = (action: string, id: string) => (app.db.prepare('SELECT details FROM audit_events WHERE action=? AND target_id=?').all(action, id) as { details: string }[]).map((r) => JSON.parse(r.details));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-small-')), vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp(testConfig(dir, { vaultDir, pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long', graph: { debounceMs: 0, verifyRate: 0 } }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  pcId = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 60 }, sys).secret;
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app?.close(); });

describe('R28 knowledge flag on approve-without-review', () => {
  it('the operator switching a flag task to no review closes the flag once its section changed, and refuses it otherwise', async () => {
    const X = await team('Flags', true);
    app.db.prepare("UPDATE projects SET review_policy='per_task' WHERE id=?").run(X.project);
    const raise = async (name: string) => {
      await put(X.w, `${name}.md`, '# Fact\nThe price is 10.');
      await put(X.k!, `${name}-src.md`, '# Fact\nThe price is 12.');
      const flag = app.graph.ext.raiseFlag({ fileId: file(`${name}.md`).id, anchor: 'fact', causeFile: file(`${name}-src.md`).id, causeRev: file(`${name}-src.md`).current_revision!, kind: 'stale', reason: 'price moved', raisedBy: X.k!.id })!;
      const task = (app.db.prepare('SELECT task_id FROM kg_flags WHERE id=?').get(flag) as { task_id: string }).task_id;
      expect(task).toBeTruthy();
      ok(await X.w.call('task_start', { task_id: task }));
      return { flag, task };
    };
    const status = (flag: string) => app.db.prepare('SELECT status, decided_by FROM kg_flags WHERE id=?').get(flag) as { status: string; decided_by: string | null };

    // The section did not change: the switch is refused and nothing moves.
    const a = await raise('Unchanged');
    ok(await X.w.call('task_submit', { task_id: a.task, summary: 'Looked at it.' }));
    expect(() => app.teams.adminSetReview(X.id, a.task, 'none', 'operator checked it', admin)).toThrow(/has not changed/);
    expect(status(a.flag).status).toBe('open');
    expect(app.teams.task(a.task)!.status).toBe('in_review');

    // The section changed: the same switch approves the task and closes the flag, as a reviewer's approval does.
    const b = await raise('Changed');
    await put(X.w, 'Changed.md', '# Fact\nThe price is 12.');
    ok(await X.w.call('task_submit', { task_id: b.task, summary: 'Aligned the price.' }));
    app.teams.adminSetReview(X.id, b.task, 'none', 'operator checked it', admin);
    expect(status(b.flag)).toEqual({ status: 'fixed', decided_by: admin.id }); // the operator's own id
    expect(['approved', 'done']).toContain(app.teams.task(b.task)!.status);
  });
});

describe('R29 work_next waits by default', () => {
  it('without wait_seconds it waits for new work instead of answering idle at once', async () => {
    const X = await team('Wait');
    for (let i = 0; i < 20; i++) { const n = ok(await X.w.call('work_next', { wait_seconds: 0 })); if (n.status !== 'item') break; ok(await X.w.call('work_ack', { item_id: n.item.item_id })); }
    expect(ok(await X.w.call('work_next', { wait_seconds: 0 }))).toMatchObject({ status: 'idle', note: 'Nothing new. Call work_next again.' });
    const t0 = Date.now();
    const waiting = X.w.call('work_next');
    await new Promise((r) => setTimeout(r, 400));
    const t = ok(await X.c.call('task_create', { team_id: X.id, title: 'Arrives while waiting' })).task;
    ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
    const got = ok(await waiting);
    expect(got.status).toBe('item');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });
  it('outside a running team it answers at once', async () => {
    const lone = await agent('lone');
    const t0 = Date.now();
    expect(ok(await lone.call('work_next'))).toMatchObject({ status: 'idle', note: 'You are not in a team.' });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it('the tool says so; the shipped playbooks act when woken and do not poll (one delivery model)', async () => {
    const pb = (app.db.prepare("SELECT playbook FROM team_role_defaults WHERE role='worker'").get() as { playbook: string }).playbook;
    expect(pb).toContain('you do not poll');
    const tool = (await clients[0]!.listTools()).tools.find((x) => x.name === 'work_next')!.description!;
    expect(tool).toMatch(/It waits for new work: [0-9]+ s by default/);
  });
});

describe('R30 directives_read {unread, ack}', () => {
  it('reads the unread ones with their precedence and confirms them in one call; directive_ack is removed and says what replaces it', async () => {
    const X = await team('Dirs');
    const hub = app.directives.create({ title: 'Be brief', body: 'Short answers.', scope: { kind: 'hub', ref: null } }, admin);
    const mine = app.directives.create({ title: 'Cite sources', body: 'Always cite.', scope: { kind: 'agent', ref: X.w.id } }, admin);
    const first = ok(await X.w.call('directives_read', { unread: true, ack: true }));
    const ids = first.directives.map((d: any) => d.id);
    expect(ids).toContain(hub.id); expect(ids).toContain(mine.id);
    const p = (id: string) => first.directives.find((d: any) => d.id === id).precedence;
    expect(p(mine.id)).toBeLessThan(p(hub.id)); // agent scope wins over hub scope
    expect(first.acked.map((x: any) => x.id).sort()).toEqual([...ids].sort());
    expect(ok(await X.w.call('directives_read', { unread: true })).directives).toEqual([]);
    expect(ok(await X.w.call('directives_list')).directives.every((d: any) => d.read === 'current')).toBe(true);
    // A changed version is unread again; reading it with ack confirms it. The removed directive_ack says what replaces it.
    app.directives.update(mine.id, { body: 'Always cite, with a link.' }, admin);
    expect(ok(await X.w.call('directives_read', { unread: true })).directives.map((d: any) => d.id)).toEqual([mine.id]);
    const old = await X.w.call('directive_ack', { id: mine.id, version: 2 });
    expect(old.structuredContent).toMatchObject({ error: 'removed', message: expect.stringContaining('directives_read {ack: true}') });
    expect(ok(await X.w.call('directives_read', { unread: true })).directives.map((d: any) => d.id)).toEqual([mine.id]);
    ok(await X.w.call('directives_read', { id: mine.id, ack: true }));
    expect(ok(await X.w.call('directives_read', { unread: true })).directives).toEqual([]);
  });
});

describe('R26 feedback nudge', () => {
  it('adds the line to task_submit and team_complete only when the team has it on', async () => {
    const X = await team('Nudge');
    const submit = async () => {
      const t = ok(await X.c.call('task_create', { team_id: X.id, title: `T ${Math.random().toString(36).slice(2, 6)}` })).task;
      ok(await X.c.call('task_assign', { task_id: t.id, agent_id: X.w.id }));
      ok(await X.w.call('task_start', { task_id: t.id }));
      return X.w.call('task_submit', { task_id: t.id, summary: 'Done.' });
    };
    const off = await submit();
    expect(text(off)).not.toContain(FEEDBACK_NUDGE); expect(off.structuredContent.feedback_nudge).toBeUndefined();
    expect((await api('PATCH', `/teams/${X.id}`, { feedback_nudge: true })).body.team.feedback_nudge).toBe(true);
    const on = await submit();
    expect(text(on)).toContain(FEEDBACK_NUDGE); expect(on.structuredContent.feedback_nudge).toBe(FEEDBACK_NUDGE);
    const done = await X.c.call('team_complete', { team_id: X.id, summary: 'All delivered.' });
    expect(text(done)).toContain(FEEDBACK_NUDGE);
  });
  it('is off by default', async () => {
    const X = await team('NudgeDefault');
    expect((await api('GET', `/teams/${X.id}`)).body.team.feedback_nudge).toBe(false);
  });
});

describe('R27 a session key made from a PC page is bound', () => {
  it('binds at create with machine_id, audits key.binding_set, and stays free without it', async () => {
    const bound = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'pc-agent' }, label: 'pc-agent key', machine_id: pcId });
    expect(bound.status).toBe(200);
    expect(bound.body.key.bound_pc.id).toBe(pcId);
    expect(audits('key.binding_set', bound.body.key.id)).toEqual([{ from: null, to: pcId, source: 'create' }]);
    const free = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'free-agent' }, label: 'free key' });
    expect(free.body.key.bound_pc).toBeNull();
    expect(audits('key.binding_set', free.body.key.id)).toEqual([]);
    // An unknown PC is refused before the new agent is made.
    const agents = app.keys.agents().length;
    expect((await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'ghost' }, label: 'ghost key', machine_id: 'pc_missing' })).status).toBe(404);
    expect(app.keys.agents().length).toBe(agents);
    // A retired PC is refused before the new agent is made too.
    const retired = (await api('POST', '/pcs', { name: 'old-pc' })).body.pc.id as string;
    app.db.prepare("UPDATE machines SET status='retired' WHERE id=?").run(retired);
    const r = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'late' }, label: 'late key', machine_id: retired });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.error?.message ?? JSON.stringify(r.body)).toMatch(/retired PC/);
    expect(app.keys.agents().length).toBe(agents);
  });
});

describe('R9 status-report archive', () => {
  it('a project with 501 reports shows 500 live and 501 in the export', async () => {
    const X = await team('Archive');
    const old = Date.now() - 3 * 864e5;
    const ins = app.db.prepare("INSERT INTO bp_items(id,project_id,kind,key,title,fields,team_id,created_by_kind,created_at,updated_by_kind,updated_at) VALUES (?,?,'report',?,?,?,?,'agent',?,'agent',?)");
    for (let i = 1; i <= 500; i++) ins.run(`bpi_arch${i}`, X.project, `SR-${String(i).padStart(3, '0')}`, 'Status on track', JSON.stringify({ health: 'on_track', done: [], next: [], blockers: [] }), X.id, old + i, old + i);
    const r = app.blueprint.fileReport(X.id, X.c.id, { health: 'at_risk', done: ['The archive test filed one more report.'] });
    expect(r.key).toBe('SR-501');
    const live = app.blueprint.items(X.project).filter((i) => i.kind === 'report');
    expect(live.length).toBe(500);
    expect(live.some((i) => i.key === 'SR-001')).toBe(false);
    expect(app.blueprint.read(X.project, X.id, { keys: ['SR-001'] }).items).toEqual([]);
    const views = new BlueprintViews(app.db, app.blueprint);
    expect(views.summary(X.project).health?.key).toBe('SR-501');
    const md = views.exportMarkdown(X.project).text;
    expect(md.match(/\*\*SR-\d+\*\*/g)!.length).toBe(501);
    expect(md).toMatch(/\*\*SR-001\*\* .* · archived/);
    expect(md).toContain('1 archived status report');
    // Lowering the limit archives the reports over it now; the export still has every one.
    const set = await api('PUT', '/settings/blueprint', { limits: { reports_per_project: 100 } });
    expect(set.body.limits.reports_per_project).toBe(100);
    expect(app.blueprint.items(X.project).filter((i) => i.kind === 'report').length).toBe(100);
    expect(views.exportMarkdown(X.project).text.match(/\*\*SR-\d+\*\*/g)!.length).toBe(501);
    await api('PUT', '/settings/blueprint', { limits: { reports_per_project: null } });
  });
  it("keeps each team's newest report live when another team fills the limit", async () => {
    const A = await team('ArchiveQuiet'), B = await team('ArchiveBusy');
    const old = Date.now() - 5 * 864e5;
    const ins = app.db.prepare("INSERT INTO bp_items(id,project_id,kind,key,title,fields,team_id,created_by_kind,created_at,updated_by_kind,updated_at) VALUES (?,?,'report',?,?,?,?,'agent',?,'agent',?)");
    const fields = JSON.stringify({ health: 'on_track', done: [], next: [], blockers: [] });
    ins.run('bpi_quiet1', A.project, 'SR-Q01', 'Quiet status', fields, A.id, old, old);
    for (let i = 1; i <= 501; i++) ins.run(`bpi_busy${i}`, A.project, `SR-B${String(i).padStart(3, '0')}`, 'Busy status', fields, B.id, old + i, old + i);
    expect(app.blueprint.archiveReports(A.project)).toBe(1);
    const live = app.blueprint.items(A.project).filter((i) => i.kind === 'report');
    expect(live.some((i) => i.key === 'SR-Q01')).toBe(true);
    expect(live.some((i) => i.key === 'SR-B001')).toBe(false);
    expect(live.length).toBe(501);
  });
});
