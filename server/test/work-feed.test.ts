/**
 * Work in motion (docs/dashboard-ux.md, Home): GET /api/work/recent lists task changes and plan moves across teams,
 * newest first (plan moves are blueprint events). Admin only, at most 50 per page, at most 7 days back, paged with a cursor; progress heartbeats are left out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const DAY = 86_400_000;
let app: App, base = '', cookie = '';
const get = async (path: string, auth = true) => {
  const r = await fetch(`${base}/api${path}`, { headers: auth ? { cookie } : {} });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-work-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  cookie = (await adminLogin(base, 'admin', 'admin-password-long')).cookie;

  // Two teams; tasks and their events written straight into the tables the feed reads.
  const dana = app.keys.createAgent('Dana', null, sys), eli = app.keys.createAgent('Eli', null, sys);
  for (const a of [dana, eli]) app.keys.createSessionKey({ agentId: a.id, label: a.label }, sys);
  const ta = app.teams.create({ name: 'Hull', goal: 'Qualify the shell', members: [{ agent_id: dana.id, role: 'coordinator' }, { agent_id: eli.id, role: 'worker' }] }, sys);
  const tb = app.teams.create({ name: 'Power', goal: 'Coil', members: [{ agent_id: eli.id, role: 'coordinator' }] }, sys);
  const now = Date.now(), db = app.db;
  const task = (id: string, team: string, title: string, refs: string[]) => db.prepare("INSERT INTO tasks(id,team_id,title,description,status,claimable,reviewer_agent_id,created_by_agent,created_at,updated_at,plan_refs) VALUES (?,?,?,?,'in_review',0,NULL,?,?,?,?)")
    .run(id, team, title, null, dana.id, now, now, JSON.stringify(refs));
  task('task_a', ta.id, 'A very long task title that a real team would write, with a colon: and more words after it', ['MH-R1']);
  task('task_b', tb.id, 'Coil', []);
  const ev = (k: string, from: string | null, to: string, tool: string, at: number, note: string | null = null, actor = eli.id) =>
    db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,?,?,'agent',?,?,?,?)").run(k, from, to, actor, tool, note, at);
  ev('task_a', null, 'open', 'task_create', now - 9000, null, dana.id);
  ev('task_a', 'in_progress', 'in_progress', 'task_progress', now - 8000, 'still working'); // a heartbeat: left out
  ev('task_a', 'in_progress', 'in_review', 'task_submit', now - 7000, 'x'.repeat(400));
  ev('task_a', 'in_review', 'changes_requested', 'task_review', now - 6000, 'Show the margin', dana.id);
  ev('task_a', 'in_review', 'in_review', 'task_submit', now - 5000, 'Replaced'); // a replaced submission: kept
  ev('task_b', 'open', 'blocked', 'task_block', now - 4000, 'B-01');
  ev('task_b', 'open', 'open', 'task_create', now - 8 * DAY); // older than the 7-day floor
  // Plan moves are blueprint events of the team's part (bp_events), as bp_write and the operator's plan request write them.
  const pa = app.blueprint.projectOfTeam(ta.id)!.id;
  db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,items,added,removed,changed,moves,created_at) VALUES (?,?,'update',3,'agent',?,6,'[]','[]','[\"M2\"]',?,?)")
    .run(pa, ta.id, dana.id, JSON.stringify([{ key: 'M2', status: 'missed', was: 'planned' }]), now - 3000);
  db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,note,created_at) VALUES (?,?,'review_request',3,'operator','admin','Re-plan the shell',?)").run(pa, ta.id, now - 2000);
});
afterAll(async () => { await app?.close(); });

describe('GET /api/work/recent', () => {
  it('needs the operator', async () => {
    expect((await get('/work/recent', false)).status).toBe(401);
  });

  it('lists task changes and plan moves across teams, newest first, without heartbeats', async () => {
    const r = await get('/work/recent');
    expect(r.status).toBe(200);
    const e = r.body.events;
    expect(e.map((x: any) => x.kind + ':' + (x.to ?? x.plan.event))).toEqual(['plan:review_request', 'plan:update', 'task:blocked', 'task:in_review', 'task:changes_requested', 'task:in_review', 'task:open']);
    expect(e.every((x: any, i: number) => i === 0 || e[i - 1].at >= x.at)).toBe(true);
    expect(e[1].plan.moves).toEqual([{ key: 'M2', status: 'missed', was: 'planned' }]);
    expect(e[1].team.name).toBe('Hull');
    expect(e[2]).toMatchObject({ team: { name: 'Power' }, task: { id: 'task_b', title: 'Coil' }, note: 'B-01', actor: { label: 'Eli' } });
    expect(e[3]).toMatchObject({ from: 'in_review', to: 'in_review', tool: 'task_submit', task: { refs: ['MH-R1'] } });
    expect(e[4]).toMatchObject({ to: 'changes_requested', round: 1, actor: { label: 'Dana' } });
    expect(e[5].note.length).toBeLessThanOrEqual(160); // a note is an excerpt
    expect(r.body.total).toBe(7);
    expect(r.body.next).toBeNull();
  });

  it('is bounded and pages with a cursor, without gaps or repeats', async () => {
    expect((await get('/work/recent?limit=51')).status).toBe(400);
    expect((await get('/work/recent?limit=0')).status).toBe(400);
    expect((await get('/work/recent?before=nonsense')).status).toBe(400);
    expect((await get('/work/recent?other=1')).status).toBe(400);
    const seen: string[] = [];
    let next: string | null = null, pages = 0;
    do {
      const r = await get(`/work/recent?limit=2${next ? `&before=${encodeURIComponent(next)}` : ''}`);
      expect(r.body.events.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.events.map((x: any) => x.id));
      next = r.body.next; pages++;
    } while (next && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual((await get('/work/recent')).body.events.map((x: any) => x.id));
  });

  it('never reaches back more than 7 days, and since narrows the window', async () => {
    const old = await get(`/work/recent?since=${Date.now() - 30 * DAY}`);
    expect(old.body.events.some((x: any) => x.task?.id === 'task_b' && x.to === 'open')).toBe(false);
    const recent = await get(`/work/recent?since=${Date.now() - 4500}`);
    expect(recent.body.events.map((x: any) => x.kind)).toEqual(['plan', 'plan', 'task']);
    expect(recent.body.total).toBe(3);
  });
});

describe('GET /api/work/recent: project-level events', () => {
  it('names the project and carries no team id for a blueprint event without a team', async () => {
    const db = app.db, [t] = db.prepare("SELECT t.id, t.project_id, p.key, p.name FROM teams t JOIN projects p ON p.id=t.project_id WHERE t.name='Hull'").all() as { id: string; project_id: string; key: string; name: string }[];
    db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,note,created_at) VALUES (?,NULL,'review_request',1,'operator','admin','Before the review',?)").run(t!.project_id, Date.now() - 1500);
    const e = (await get('/work/recent')).body.events.find((x: any) => x.note === 'Before the review');
    expect(e).toMatchObject({ kind: 'plan', team: { id: null, name: t!.name }, project: { id: t!.project_id, key: t!.key }, actor: { label: 'Operator' }, plan: { event: 'review_request' } });
    db.prepare("DELETE FROM bp_events WHERE note='Before the review'").run();
  });
});

describe('GET /api/work/recent paging at ties', () => {
  it('pages exactly through many events that share one millisecond', async () => {
    const db = app.db, at = Date.now() - 20_000;
    const [k] = db.prepare('SELECT id, team_id FROM tasks LIMIT 1').all() as { id: string; team_id: string }[];
    for (let i = 0; i < 120; i++) db.prepare("INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,'open','blocked','admin','admin','task_block',NULL,?)").run(k!.id, at);
    const pk = app.blueprint.projectOfTeam(k!.team_id)!.id;
    for (let i = 0; i < 5; i++) db.prepare("INSERT INTO bp_events(project_id,team_id,kind,version,actor_kind,actor_id,note,created_at) VALUES (?,?,'review_request',3,'operator','admin','tie',?)").run(pk, k!.team_id, at);
    const seen: string[] = [];
    let next: string | null = null, pages = 0, total = 0;
    do {
      const r = await get(`/work/recent?limit=7${next ? `&before=${encodeURIComponent(next)}` : ''}`);
      seen.push(...r.body.events.map((x: any) => x.id)); total = r.body.total;
      next = r.body.next; pages++;
    } while (next && pages < 100);
    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(seen.length).toBe(total); // no gaps: every event in the window, including all 125 at the tie
    const tie = seen.filter((id) => id.startsWith('p')).length;
    expect(tie).toBeGreaterThanOrEqual(5);
  });
});
