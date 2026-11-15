/**
 * A member's read of one Blueprint item (docs/multi-user.md §4, §7): the item route sends a collaborator agents by their
 * label and console users as plain `operator`, never an agent id, a user id or a username; no History, no Next and no
 * issue marks; who clarified a requirement as "the operator" (or the member, when they answered it); and the tasks that
 * name the item only with the `tasks` component. The admin's read of the same item keeps all of it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Who } from '../src/teams/teams.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, ops: S, mia: S, noor: S;
const PW = 'member item test password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
type A = { id: string; cred: string };
const mk = (label: string): A => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  return { id: a.id, cred: k.credential.id };
};
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
let P = '', team = '', coord: A, worker: A;
const users: Record<string, string> = {};
const ver = () => app.blueprint.project(P)!.version;
const asAgent = (a: A, o: Op[]) => app.blueprint.write(P, { version: ver(), ops: o, team_id: team }, { kind: 'agent', id: a.id });
const item = (s: S, key: string) => call(s, 'GET', `/projects/${P}/items/${encodeURIComponent(key)}`);
const enc = encodeURIComponent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahmemberitem-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base, 'admin', ADMIN_PASSWORD);
  P = (await call(admin, 'POST', '/projects', { key: 'RLAB', name: 'Reading lab', kind: 'research' })).body.project.id;
  coord = mk('Lab coordinator'); worker = mk('Lab writer');
  const t = app.teams.create({ name: 'Lab', goal: 'g', members: [{ agent_id: coord.id, role: 'coordinator' }, { agent_id: worker.id, role: 'worker' }] }, sys);
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, t.id);
  team = t.id;
  // People: a second admin whose username is a canary, and two collaborators (one without the tasks component).
  const mkUser = async (username: string, role: 'admin' | 'member', grants: unknown[]) => {
    const c = await call(admin, 'POST', '/users', { username, role });
    const first = await adminLogin(base, username, c.body.password);
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    if (grants.length) expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants })).status).toBe(200);
    users[username] = c.body.user.id;
    return adminLogin(base, username, PW);
  };
  ops = await mkUser('zzopsuser', 'admin', []);
  mia = await mkUser('mia', 'member', [{ project_id: P, components: ['feed'] }]);
  noor = await mkUser('noor', 'member', [{ project_id: P, components: ['tasks', 'feed'] }]);
  users['admin'] = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
  // Mia decides for the team, so she can clarify a requirement herself.
  expect((await call(admin, 'PUT', `/teams/${team}/deciders`, { user_ids: [users['mia']] })).status).toBe(200);

  // The agents write the module, a requirement, a paper with two claims and a finding; then the canary admin edits the paper.
  asAgent(coord, [
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Field shape', fields: { mode: 'validate' }, team_id: team },
    { op: 'upsert', kind: 'finding', key: 'F-L1-01', parent_key: 'L1', title: 'Run 46 is symmetric', fields: { confidence: 'high' } },
    { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'Symmetry, measured', team_id: team, status: 'planned' },
    { op: 'upsert', kind: 'claim', key: 'PAP-1/C1', parent_key: 'PAP-1', title: 'The field is axisymmetric', fields: { part: 'results' } },
    { op: 'upsert', kind: 'claim', key: 'PAP-1/C2', parent_key: 'PAP-1', title: 'The drift is small (XQZ-7)', fields: { part: 'discussion' } },
    { op: 'link', from: 'F-L1-01', to: 'PAP-1/C1', rel: 'evidence' },
  ]);
  asAgent(worker, [{ op: 'upsert', kind: 'claim', key: 'PAP-1/C2', body: 'Within XQZ-7 of the target.' }]);
  expect((await call(ops, 'POST', `/projects/${P}/ops`, { version: ver(), ops: [{ op: 'upsert', kind: 'paper', key: 'PAP-1', body: 'An edit by the canary admin.' }] })).status).toBe(200);
  // A task of the team names the paper.
  const task = app.teams.create_task(who(coord), { team_id: team, title: 'Draft the results', description: 'd' });
  app.db.prepare('UPDATE tasks SET plan_refs=? WHERE id=?').run(JSON.stringify(['PAP-1']), task.id);
});
afterAll(async () => { await app?.close(); });

/** Every agent id, user id and other person's username the hub knows: none may reach a member's answer. */
const canaries = (except: string) => [coord.id, worker.id, ...Object.entries(users).filter(([u]) => u !== except).flatMap(([u, id]) => [id, u === 'admin' ? '"admin"' : u])];
const clean = (text: string, member: string) => { for (const c of canaries(member)) expect(text, `the answer holds ${c}`).not.toContain(c); };

describe("a member's item answer names no one by id or username", () => {
  it('the admin still reads who changed what, so the check below means something', async () => {
    const r = await item(admin, 'PAP-1');
    expect(r.status).toBe(200);
    expect(r.body.item.created_by).toBe(`agent:${coord.id}`);
    expect(r.body.history.revisions.map((x: any) => x.actor_name)).toContain('zzopsuser');
    expect(r.text).toContain(users['zzopsuser']);
  });

  it('a paper: agents by label, console users as operator, no History, Next or issue marks', async () => {
    for (const s of [mia, noor]) {
      const r = await item(s, 'PAP-1');
      expect(r.status).toBe(200);
      clean(r.text, s === mia ? 'mia' : 'noor');
      expect(r.body.item.created_by).toBe('Lab coordinator');
      expect(r.body.item.updated_by).toBe('operator');
      expect(r.body.history.revisions).toEqual([]);
      expect(r.body.history.total).toBeGreaterThan(1);
      expect(r.body.next).toBeUndefined();
      expect(r.body.paper).toMatchObject({ total: 2 });
      expect(r.body.paper.claims.map((c: any) => [c.key, c.part])).toEqual([['PAP-1/C1', 'results'], ['PAP-1/C2', 'discussion']]);
    }
  });

  it('a claim the worker changed reads the worker by label, without its issue marks', async () => {
    const admin2 = await item(admin, 'PAP-1/C2');
    expect(admin2.body.plain.issues.length + admin2.body.plain.codes.length).toBeGreaterThan(0);
    const r = await item(mia, 'PAP-1/C2');
    clean(r.text, 'mia');
    expect(r.body.item).toMatchObject({ created_by: 'Lab coordinator', updated_by: 'Lab writer' });
    expect(r.body.plain.issues).toEqual([]);
    expect(r.body.support).toBeDefined();
  });

  it('a hypothesis names who moved its status by label, and a field holding an agent id reads the label', async () => {
    asAgent(coord, [{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'The field is symmetric' },
      { op: 'upsert', kind: 'paper', key: 'PAP-2', title: 'Drift, measured', fields: { authors: [coord.id, 'Dr. Lee'] } }]);
    asAgent(worker, [{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', status: 'testing' }]);
    expect((await item(admin, 'H-L1-01')).body.research.changes[0].actor).toBe(`agent:${worker.id}`);
    const r = await item(mia, 'H-L1-01');
    expect(r.status).toBe(200);
    clean(r.text, 'mia');
    expect(r.body.research.changes.map((c: any) => c.actor)).toEqual(['Lab writer', 'Lab coordinator']);
    expect(r.body.actions).toEqual([]);
    const paper = await item(mia, 'PAP-2');
    clean(paper.text, 'mia');
    expect(paper.body.item.fields.authors).toEqual(['Lab coordinator', 'Dr. Lee']);
  });

  it("the item's History route gives a member no revisions", async () => {
    const hist = `/projects/${P}/items/${enc('PAP-1')}/history`;
    const r = await call(mia, 'GET', hist);
    expect(r.status).toBe(200);
    expect(r.body.revisions).toEqual([]);
    clean(r.text, 'mia');
    expect((await call(admin, 'GET', hist)).body.revisions.length).toBeGreaterThan(1);
  });

  it('an agent that no longer exists reads "an agent"', async () => {
    const gone = mk('Short-lived');
    asAgent(gone, [{ op: 'upsert', kind: 'finding', key: 'F-L1-02', parent_key: 'L1', title: 'Run 47 drifts' }]);
    app.db.prepare('PRAGMA foreign_keys=OFF').run();
    app.db.prepare('DELETE FROM agents WHERE id=?').run(gone.id);
    app.db.prepare('PRAGMA foreign_keys=ON').run();
    const r = await item(mia, 'F-L1-02');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(gone.id);
    expect(r.body.item.created_by).toBe('an agent');
  });

  it('a clarified requirement reads "the operator", or the member who answered it', async () => {
    // Requirements carry the clarification: a module of the team with two requirements, each marked unclear by its ask.
    app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'module', key: 'MOD', title: 'Module', team_id: team }] }, { kind: 'operator', id: null });
    const req = async (key: string, by: S, text: string) => {
      app.db.prepare("UPDATE decisions SET status='declined' WHERE status IN ('open','needs_info')").run();
      app.blueprint.write(P, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key, parent_key: 'MOD', title: `Requirement ${key}`, body: 'Statement' }] }, { kind: 'operator', id: null });
      const ask = app.decisions.ask(who(coord), { team_id: team, question: `What is unclear in ${key}?`, refs: [key] }).id;
      asAgent(coord, [{ op: 'upsert', kind: 'fr', key, fields: { unclear: true, unclear_ask: ask } }]);
      expect((await call(by, 'POST', `/decisions/${ask}/answer`, { text, item_rev: app.blueprint.item(P, key)!.rev })).status).toBe(200);
    };
    await req('FR-MOD-01', ops, 'It means the dry-bulb value.');
    await req('FR-MOD-02', mia, 'It means the wet-bulb value.');
    expect((await item(admin, 'FR-MOD-01')).body.clarification).toMatchObject({ by_label: 'zzopsuser' });
    const one = await item(noor, 'FR-MOD-01'), two = await item(mia, 'FR-MOD-02'), twoNoor = await item(noor, 'FR-MOD-02');
    for (const [r, m] of [[one, 'noor'], [two, 'mia'], [twoNoor, 'noor']] as const) clean(r.text, m);
    expect(one.body.clarification).toMatchObject({ by_label: 'the operator', text: 'It means the dry-bulb value.' });
    expect(two.body.clarification).toMatchObject({ by_label: 'mia' }); // the console reads "Clarified by you"
    expect(twoNoor.body.clarification).toMatchObject({ by_label: 'the operator' });
  });

  it('the tasks that name the item come only with the tasks component', async () => {
    expect((await item(mia, 'PAP-1')).body.tasks).toMatchObject({ items: [], total: 0 });
    const r = await item(noor, 'PAP-1');
    expect(r.body.tasks.items.map((t: any) => t.title)).toEqual(['Draft the results']);
    clean(r.text, 'noor');
  });

  it('an unknown key and a project without a grant answer the same way', async () => {
    const other = (await call(admin, 'POST', '/projects', { key: 'OTHR', name: 'Other' })).body.project.id;
    app.blueprint.write(other, { version: app.blueprint.project(other)!.version, ops: [{ op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'Elsewhere' }] }, { kind: 'operator', id: null });
    const unknown = await item(mia, 'PAP-9'), ungranted = await call(mia, 'GET', `/projects/${other}/items/${enc('PAP-1')}`);
    expect(unknown.status).toBe(404);
    expect([403, 404]).toContain(ungranted.status);
    expect(ungranted.text).not.toContain('Elsewhere');
  });
});
