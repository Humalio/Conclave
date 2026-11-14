/**
 * Task attachments, part 3 (docs/dashboard-ux.md, task screen "Attachments"): the operator's task screen gets the brief's
 * latest version and every submission version as a round; the board carries the count; the operator's Attach adds
 * images and HTML mockups to the brief, guarded by the task's version; a member of the project gets the count and never
 * a file, a name or the Attach route.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Who } from '../src/teams/teams.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, lena: S;
const PW = 'attachments console password 1234';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HTML = Buffer.from('<!doctype html><html><body><p>Rename team</p></body></html>').toString('base64');
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
let team = '', task = '', worker = { id: '', cred: '' }, coord: Who;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-attach-console-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const project = (await call(admin, 'POST', '/projects', { key: 'ATT', name: 'Attachments project' })).body.project.id as string;
  const mk = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
    return { id: a.id, cred: k.credential.id };
  };
  const c = mk('Att coordinator'); worker = mk('Developer 2');
  const t = app.teams.create({ name: 'Att team', goal: 'goal', members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: worker.id, role: 'worker' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  team = t.id;
  const who: Who = { agentId: c.id, credId: c.cred, tokenHash: `th_${c.id}`, rules: app.keys.rulesFor(c.cred), cap: [] };
  coord = who;
  task = app.teams.create_task(who, { team_id: t.id, title: 'Rename a team', description: 'See the mockup.' }).id;
  app.db.prepare("UPDATE tasks SET status='in_progress', assignee_agent_id=? WHERE id=?").run(worker.id, task);
  const u = await call(admin, 'POST', '/users', { username: 'lena' });
  const first = await adminLogin(base, 'lena', u.body.password);
  expect((await call(first, 'POST', '/me/password', { current: u.body.password, new: PW })).status).toBe(200);
  expect((await call(admin, 'PUT', `/users/${u.body.user.id}/grants`, { grants: [{ project_id: project, components: ['tasks'] }] })).status).toBe(200);
  lena = await adminLogin(base, 'lena', PW);
});
afterAll(async () => { await app?.close(); });

const view = async (who = admin) => (await call(who, 'GET', `/teams/${team}/tasks/${task}`)).body.task;
/** The worker hands in a round of files, as task_submit does. */
async function submitRound(files: { path: string; content: string }[]) {
  const A = app.taskAttachments, w = { agentId: worker.id, credId: worker.cred, actor: { kind: 'agent' as const, id: worker.id } };
  const staged = (await A.stage(w, files.map((f) => ({ ...f, encoding: 'base64' as const })), undefined))!;
  A.commit(app.teams.task(task)!, 'submission', staged, w);
}

describe('the operator attaches to the brief', () => {
  it('adds images and mockups as the brief\'s next version, named on the task screen', async () => {
    const k = await view();
    expect(k.attachments).toEqual({ brief: null, rounds: [] });
    const r = await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [{ path: 'sheet-1440.png', content: PNG, encoding: 'base64' }, { path: 'rename-sheet.html', content: HTML, encoding: 'base64' }] });
    expect(r.status, r.text).toBe(200);
    const b = r.body.task.attachments.brief;
    expect(b).toMatchObject({ version: 1, added_by_label: 'The operator', copied_from: null, removed_at: null });
    expect(b.files.map((f: { path: string; type: string }) => [f.path, f.type])).toEqual([['rename-sheet.html', 'text/html'], ['sheet-1440.png', 'image/png']]);
    expect(r.body.task.version).toBe(k.version + 1);
    expect(r.body.task.attachments_count).toBe(2);
  });
  it('replaces a file given again by name and keeps the others', async () => {
    const k = await view();
    const r = await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [{ path: 'sheet-1440.png', content: PNG, encoding: 'base64' }] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.task.attachments.brief.version).toBe(2);
    expect(r.body.task.attachments.brief.files).toHaveLength(2);
  });
  it('refuses a stale screen, a file that is not an image or a mockup, and an empty pick', async () => {
    const k = await view();
    const stale = await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version - 1, files: [{ path: 'a.png', content: PNG, encoding: 'base64' }] });
    expect(stale.status).toBe(409);
    const txt = await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [{ path: 'notes.png', content: Buffer.from('just text').toString('base64'), encoding: 'base64' }] });
    expect(txt.status).toBe(400);
    expect(txt.body.message).toMatch(/not a PNG, JPEG, GIF, WebP or HTML file/);
    expect((await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [] })).status).toBe(400);
    expect((await view()).attachments.brief.version).toBe(2);
  });
  it('refuses Attach during a lockdown, through part 1\'s checks, and attaches again once it ends', async () => {
    expect((await call(admin, 'POST', '/lockdown', { writes_disabled: true })).status).toBe(200);
    try {
      const k = await view();
      const r = await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [{ path: 'a.png', content: PNG, encoding: 'base64' }] });
      expect(r.status, r.text).not.toBe(200);
      expect(r.body.message).toMatch(/lockdown/i);
      expect((await view()).attachments.brief.version).toBe(2);
    } finally { await call(admin, 'POST', '/lockdown', { writes_disabled: false }); }
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='task.attach' AND target_id=?").get(task)).toMatchObject({ n: 2 });
  });
  it('refuses a closed task, and a credential file whatever its bytes', async () => {
    const closed = app.teams.create_task(coord, { team_id: team, title: 'Closed task', description: 'x' }).id;
    app.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(closed);
    const v = (await call(admin, 'GET', `/teams/${team}/tasks/${closed}`)).body.task.version;
    const r = await call(admin, 'POST', `/teams/${team}/tasks/${closed}/attachments`, { version: v, files: [{ path: 'a.png', content: PNG, encoding: 'base64' }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.message).toMatch(/cancelled/);
    const k = await view();
    const env = await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [{ path: 'keys.env', content: PNG, encoding: 'base64' }] });
    expect(env.status).toBe(400);
    expect(env.body.message).toMatch(/environment or key file/);
  });
});

describe('review rounds', () => {
  it('lists every submission version, oldest first, with who handed it in', async () => {
    await submitRound([{ path: 'before-settings.png', content: PNG }, { path: 'after-settings.png', content: PNG }]);
    await submitRound([{ path: 'after-settings.png', content: PNG }, { path: 'diagram.svg', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') }]);
    const k = await view();
    expect(k.attachments.rounds.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(k.attachments.rounds[0]).toMatchObject({ added_by_label: 'Developer 2', removed_at: null });
    expect(k.attachments.rounds[1].files.map((f: { path: string }) => f.path)).toEqual(['after-settings.png', 'diagram.svg']);
    // The SVG is not an image to the hub: it is served as a download only.
    expect(k.attachments.rounds[1].files[1].type).not.toMatch(/^image\//);
    // The count is the brief's latest files plus the latest round's.
    expect(k.attachments_count).toBe(4);
  });
  it('names the share a version was copied from', async () => {
    const sub = app.db.prepare("SELECT id FROM shares WHERE task_id=? AND task_role='brief'").get(task) as { id: string };
    app.db.prepare("UPDATE share_versions SET copied_from=? WHERE share_id=(SELECT id FROM shares WHERE task_id=? AND task_role='submission') AND version=2").run(`share:${sub.id}@v1`, task);
    const v = (await view()).attachments.rounds[1];
    expect(v.copied_from).toEqual({ name: 'Brief: Rename a team', version: 1 });
  });
  it('shows a removed set as removed, without its files', async () => {
    app.db.prepare("UPDATE shares SET status='revoked' WHERE task_id=? AND task_role='submission'").run(task);
    const k = await view();
    expect(k.attachments.rounds.every((v: { removed_at: number | null; files: unknown[] }) => v.removed_at && !v.files.length)).toBe(true);
    expect(k.attachments.brief.removed_at).toBeNull();
    expect(k.attachments_count).toBe(2);
    app.db.prepare("UPDATE shares SET status='open' WHERE task_id=? AND task_role='submission'").run(task);
  });
});

describe('the files the screen links to', () => {
  const get = (who: S, path: string) => fetch(`${base}${path}`, { headers: { cookie: who.cookie } });
  it('serves the brief\'s image and mockup at the URLs the console builds, and refuses a member', async () => {
    const v = (await view()).attachments.brief.version;
    const img = await get(admin, `/api/tasks/${task}/attachments/brief/file?path=sheet-1440.png&v=${v}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    const mock = await get(admin, `/api/tasks/${task}/attachments/brief/file?path=rename-sheet.html&v=${v}&as=mockup`);
    expect(mock.headers.get('content-type')).toMatch(/^text\/html/);
    expect(mock.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);
    expect((await get(lena, `/api/tasks/${task}/attachments/brief/file?path=sheet-1440.png&v=${v}`)).status).not.toBe(200);
  });
  it('reaches a brief of ten versions or more, as Attach makes them', async () => {
    for (let n = (await view()).attachments.brief.version; n < 11; n++) {
      const k = await view();
      expect((await call(admin, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [{ path: 'sheet-1440.png', content: PNG, encoding: 'base64' }] })).status).toBe(200);
    }
    expect((await view()).attachments.brief.version).toBe(11);
    for (const v of [1, 10, 11]) expect((await get(admin, `/api/tasks/${task}/attachments/brief/file?path=sheet-1440.png&v=${v}`)).status, `v${v}`).toBe(200);
  });
});

describe('the count elsewhere', () => {
  it('puts the count on the operator\'s board card', async () => {
    const t = (await call(admin, 'GET', `/teams/${team}`)).body.team;
    expect(t.board.find((k: { id: string }) => k.id === task).attachments).toBe(4);
  });
  it('gives a project member the count, never a file, a name or Attach', async () => {
    const r = await call(lena, 'GET', `/teams/${team}/tasks/${task}`);
    expect(r.status).toBe(200);
    expect(r.body.task.attachments_count).toBe(4);
    expect(r.body.task.attachments).toBeUndefined();
    for (const name of ['sheet-1440.png', 'rename-sheet.html', 'after-settings.png', 'diagram.svg', 'shr_']) expect(r.text).not.toContain(name);
    const board = await call(lena, 'GET', `/teams/${team}`);
    expect(board.body.team.board.find((k: { id: string }) => k.id === task).attachments).toBe(4);
    expect(board.text).not.toContain('sheet-1440.png');
    const k = await view();
    const att = await call(lena, 'POST', `/teams/${team}/tasks/${task}/attachments`, { version: k.version, files: [{ path: 'x.png', content: PNG, encoding: 'base64' }] });
    expect(att.status).toBe(403);
    expect((await view()).attachments.brief.version).toBe(k.attachments.brief.version);
  });
});
