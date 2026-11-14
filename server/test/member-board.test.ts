/**
 * Members can see the task board (docs/multi-user.md §1.2, §7): a per-project operator switch, off by default, set with
 * PATCH /api/projects/:id (admin only, audited). GET /api/projects/:id/board and /board/:taskId answer a member only when
 * the switch is on and they hold a grant on the project, and never an external user; otherwise the same 403
 * board_denied, whatever the reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Who } from '../src/teams/teams.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, ana: S, bo: S;
const PW = 'member board password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const login = (username: string): Promise<S> => adminLogin(base, username, username === 'admin' ? ADMIN_PASSWORD : PW);

interface P { id: string; team: string; agents: string[]; tasks: Record<string, string> }
const P: Record<'CNV' | 'BRZ', P> = {} as never;

async function seedProject(key: 'CNV' | 'BRZ'): Promise<P> {
  const id = (await call(admin, 'POST', '/projects', { key, name: `${key} project` })).body.project.id as string;
  const mk = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id };
  };
  const c = mk(`${key} coord`), w = mk(`${key} worker`);
  const t = app.teams.create({ name: `${key} team`, goal: 'goal', members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: w.id, role: 'worker' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(id, t.id);
  const who: Who = { agentId: c.id, credId: c.cred, tokenHash: `th_${c.id}`, rules: app.keys.rulesFor(c.cred), cap: [] };
  const tasks: Record<string, string> = {};
  // One task per status the board shows or leaves out; the status is set directly (the lifecycle is tested elsewhere).
  for (const st of ['open', 'in_progress', 'blocked', 'done', 'backlog', 'discarded', 'cancelled']) {
    const k = app.teams.create_task(who, { team_id: t.id, title: `${key} ${st} task`, description: `${key} ${st} description` });
    app.db.prepare('UPDATE tasks SET status=?, assignee_agent_id=?, blocked_reason=? WHERE id=?').run(st, st === 'in_progress' ? w.id : null, st === 'blocked' ? 'Waits for the dish' : null, k.id);
    tasks[st] = k.id;
  }
  return { id, team: t.id, agents: [c.id, w.id], tasks };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahboard-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin');
  P.CNV = await seedProject('CNV');
  P.BRZ = await seedProject('BRZ');
  const mkUser = async (username: string, project: string) => {
    const c = await call(admin, 'POST', '/users', { username });
    const first = await adminLogin(base, username, c.body.password);
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    // Blueprint only: the board switch, not the tasks component, opens the board.
    expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: project, components: ['blueprint'] }] })).status).toBe(200);
  };
  await mkUser('ana', P.CNV.id);
  await mkUser('kai', P.BRZ.id);
  ana = await login('ana');
  bo = await login('kai');
});
afterAll(async () => { await app?.close(); });

describe('members can see the task board', () => {
  it('is off by default: the member gets 403 board_denied and the project says member_board false', async () => {
    const list = (await call(ana, 'GET', '/projects')).body.projects;
    expect(list.find((p: any) => p.id === P.CNV.id).member_board).toBe(false);
    const r = await call(ana, 'GET', `/projects/${P.CNV.id}/board`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('board_denied');
    expect((await call(ana, 'GET', `/projects/${P.CNV.id}/board/${P.CNV.tasks.open}`)).status).toBe(403);
  });

  it('the admin reads the board with the switch off, and only the admin sets it', async () => {
    const r = await call(admin, 'GET', `/projects/${P.CNV.id}/board`);
    expect(r.status).toBe(200);
    expect(r.body.member_board).toBe(false);
    expect((await call(admin, 'GET', '/projects/prj_nope/board')).status).toBe(404);
    expect((await call(ana, 'PATCH', `/projects/${P.CNV.id}`, { member_board: true })).status).toBe(403);
    expect(app.blueprint.project(P.CNV.id)!.member_board).toBe(0);
    expect((await call(admin, 'PATCH', `/projects/${P.CNV.id}`, { member_board: 'yes' })).status).toBe(400);
  });

  it('on: the member reads the board, read only, without the operator queue or any ids but task ids', async () => {
    const set = await call(admin, 'PATCH', `/projects/${P.CNV.id}`, { member_board: true });
    expect(set.status).toBe(200);
    const audit = app.db.prepare("SELECT details FROM audit_events WHERE action='blueprint.member_board'").all() as { details: string }[];
    expect(audit.length).toBe(1);
    expect(JSON.parse(audit[0]!.details)).toMatchObject({ from: false, to: true });
    expect((await call(ana, 'GET', '/projects')).body.projects[0].member_board).toBe(true);
    // The admin's team settings read the switch from the team summary.
    const teams = (await call(admin, 'GET', '/teams')).body.teams as any[];
    expect(teams.find((t) => t.id === P.CNV.team).member_board).toBe(true);
    expect(teams.find((t) => t.id === P.BRZ.team).member_board).toBe(false);

    const r = await call(ana, 'GET', `/projects/${P.CNV.id}/board`);
    expect(r.status).toBe(200);
    expect(r.body.project).toEqual({ id: P.CNV.id, key: 'CNV', name: 'CNV project' });
    const [team] = r.body.teams;
    expect(team).toMatchObject({ id: P.CNV.team, name: 'CNV team' });
    expect(team.tasks.map((k: any) => k.status).sort()).toEqual(['blocked', 'done', 'in_progress', 'open']);
    const doing = team.tasks.find((k: any) => k.status === 'in_progress');
    expect(doing).toMatchObject({ title: 'CNV in_progress task', assignee: 'CNV worker' });
    expect(team.tasks.find((k: any) => k.status === 'blocked').blocked_reason).toBe('Waits for the dish');
    // Agent ids and the other project never appear.
    for (const s of [...P.CNV.agents, ...P.BRZ.agents, P.BRZ.id, 'BRZ']) expect(r.text).not.toContain(s);
  });

  it('a task opens read only; tasks off the board or of another project read as unknown', async () => {
    const r = await call(ana, 'GET', `/projects/${P.CNV.id}/board/${P.CNV.tasks.in_progress}`);
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ title: 'CNV in_progress task', description: 'CNV in_progress description', assignee: 'CNV worker', team: { id: P.CNV.team, name: 'CNV team' } });
    expect(r.text).not.toContain(P.CNV.agents[1]);
    for (const id of [P.CNV.tasks.backlog, P.CNV.tasks.discarded, P.CNV.tasks.cancelled, P.BRZ.tasks.open, 'task_nope']) {
      const x = await call(ana, 'GET', `/projects/${P.CNV.id}/board/${id}`);
      expect(x.status).toBe(404);
      expect(x.body.message).toBe('No such task.');
    }
  });

  it('a member without the project gets the same 403 as for an unknown project', async () => {
    const other = await call(bo, 'GET', `/projects/${P.CNV.id}/board`);
    const nope = await call(bo, 'GET', '/projects/prj_nope/board');
    expect(other.status).toBe(403);
    expect(other.text).toBe(nope.text);
    expect((await call(bo, 'GET', `/projects/${P.CNV.id}/board/${P.CNV.tasks.open}`)).status).toBe(403);
    // Bo's own project still has the switch off.
    expect((await call(bo, 'GET', `/projects/${P.BRZ.id}/board`)).text).toBe(nope.text);
  });

  it('shows the attachment count of a task, never a file or its name', async () => {
    const [coord] = P.CNV.agents;
    const cred = app.keys.credentials({ kind: 'session_key', agentId: coord! })[0]!.id;
    const w = { agentId: coord!, credId: cred, actor: { kind: 'agent' as const, id: coord! } };
    const staged = (await app.taskAttachments.stage(w, [{ path: 'mockups/secret-plan.html', content: '<p>plan</p>' }, { path: 'notes.txt', content: 'hidden words' }], undefined))!;
    app.taskAttachments.commit(app.teams.task(P.CNV.tasks.in_progress)!, 'brief', staged, w);
    const r = await call(ana, 'GET', `/projects/${P.CNV.id}/board/${P.CNV.tasks.in_progress}`);
    expect(r.status).toBe(200);
    expect(r.body.task.attachments).toBe(2);
    const list = await call(ana, 'GET', `/projects/${P.CNV.id}/board`);
    expect(JSON.stringify(list.body)).toContain('"attachments":2');
    for (const t of [r.text, list.text]) for (const leak of ['secret-plan', 'notes.txt', 'hidden words', 'shr_']) expect(t).not.toContain(leak);
  });

  it('an external user never sees the board, even with the switch on and a grant', async () => {
    const nope = await call(ana, 'GET', '/projects/prj_nope/board');
    expect((await call(ana, 'GET', `/projects/${P.CNV.id}/board`)).status).toBe(200);
    // Ana becomes external (2FA marked as set up, so the session stays usable); the grant and the switch stay as they are.
    const id = (app.db.prepare("SELECT id FROM admin_users WHERE username='ana'").get() as { id: string }).id;
    app.db.prepare("UPDATE admin_users SET external=1, totp_secret='x' WHERE id=?").run(id);
    try {
      const r = await call(ana, 'GET', `/projects/${P.CNV.id}/board`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('board_denied');
      expect(r.text).toBe(nope.text);
      expect((await call(ana, 'GET', `/projects/${P.CNV.id}/board/${P.CNV.tasks.open}`)).text).toBe(nope.text);
    } finally {
      app.db.prepare('UPDATE admin_users SET external=0, totp_secret=NULL WHERE id=?').run(id);
    }
    expect((await call(ana, 'GET', `/projects/${P.CNV.id}/board`)).status).toBe(200);
  });

  it('gives the member no write path on the board tasks', async () => {
    expect((await call(ana, 'POST', `/teams/${P.CNV.team}/tasks/${P.CNV.tasks.blocked}/unblock`, { note: 'go' })).status).toBeGreaterThanOrEqual(403);
    expect((await call(ana, 'POST', `/teams/${P.CNV.team}/tasks/${P.CNV.tasks.open}/accept`, {})).status).toBe(403);
    expect(app.teams.task(P.CNV.tasks.blocked)!.status).toBe('blocked');
  });

  it('off again closes it at once', async () => {
    expect((await call(admin, 'PATCH', `/projects/${P.CNV.id}`, { member_board: false })).status).toBe(200);
    expect((await call(ana, 'GET', `/projects/${P.CNV.id}/board`)).status).toBe(403);
  });
});
