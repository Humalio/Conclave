/**
 * Account for a collaborator (docs/multi-user.md §7, Account): GET /api/me lists the agents the person owns, by label,
 * with their effective scope (delegated teams the agent is a live member of, delegated folders inside the owner's
 * visible ones; Read from a project grant, Contribute only where a folder grant and its delegation both say so), and
 * nothing an agent could use: no key, credential, machine, host or secret.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', admin = { cookie: '', csrf: '' }, project = '', team = '', other = '';
type Who = { cookie: string; csrf: string };
const call = async (who: Who, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.clone().text(), body: (await r.json().catch(() => ({}))) as any };
};
let dana = { id: '', who: { cookie: '', csrf: '' } as Who };
const secrets: string[] = [];
let mine = { id: '', cred: '' }, idle = { id: '', cred: '' }, notMine = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahacct-'));
  for (const f of ['Projects/ACC/Shared', 'Projects/ACC/Shared/Hush', 'Projects/ACC/Other', 'Projects/ACC/Peek']) mkdirSync(join(dir, 'vault', ...f.split('/')), { recursive: true });
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  project = (await call(admin, 'POST', '/projects', { key: 'ACC', name: 'ACC' })).body.project.id;
  const c = await call(admin, 'POST', '/users', { username: 'dana', display_name: 'Dana', role: 'member', external: true, org: 'Partner Lab' });
  expect(c.status, c.text).toBe(200);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'dana', password: c.body.password }) });
  dana = { id: c.body.user.id, who: { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as any).csrf } };
  const agent = (label: string, owner: string | null) => {
    const a = app.keys.createAgent(label, null, sys, owner);
    const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
    secrets.push(k.secret);
    return { id: a.id, cred: k.credential.id };
  };
  mine = agent('Dana writer', dana.id); idle = agent('Dana spare', dana.id); notMine = agent('Someone else', null).id;
  const t = app.teams.create({ name: 'Acc team', goal: 'goal', members: [{ agent_id: mine.id, role: 'worker' }, { agent_id: notMine, role: 'coordinator' }] }, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
  team = t.id;
  // A second team of the project, delegated too, that the agent is not a member of: it does not count.
  const t2 = app.teams.create({ name: 'Elsewhere', goal: 'goal', members: [{ agent_id: notMine, role: 'coordinator' }] }, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t2.id);
  other = t2.id;
  const g = await call(admin, 'PUT', `/users/${dana.id}/grants`, { grants: [{ project_id: project, components: ['tasks', 'vault'], vault_folders: ['/Projects/ACC/Shared/'],
    delegation: { teams: [team, other], folders: [{ path: '/Projects/ACC/Shared/', mode: 'read' }, { path: '/Projects/ACC/Shared/Hush/', mode: 'read' }] } }] });
  expect(g.status, g.text).toBe(200);
  // A folder inside the shared one, restricted after the delegation was saved (the save refuses one already restricted
  // for an external person): hidden from Dana, so never part of her agents' scope.
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Projects/ACC/Shared/Hush/', Date.now());
});
afterAll(async () => { await app.close(); });

describe('GET /api/me for a collaborator', () => {
  it('lists the agents the person owns with their effective scope', async () => {
    const me = await call(dana.who, 'GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body.external).toBe(true);
    expect(me.body.agents).toEqual([
      // Label order; the team the agent is not a member of and the restricted folder do not count.
      { id: idle.id, label: 'Dana spare', teams: [], folders: [{ path: '/Projects/ACC/Shared/', mode: 'read' }] },
      { id: mine.id, label: 'Dana writer', teams: [{ id: team, name: 'Acc team', project_name: 'ACC', operations: expect.any(Array) }], folders: [{ path: '/Projects/ACC/Shared/', mode: 'read' }] },
    ]);
  });

  it('folds in folder grants: Contribute only when the grant and the delegation both say so', async () => {
    const r = await call(admin, 'PUT', `/users/${dana.id}/folder-grants`, { grants: [
      { path: '/Projects/ACC/Other/', mode: 'contribute', delegation: { folders: [{ path: '/Projects/ACC/Other/', mode: 'contribute' }] } },
      { path: '/Projects/ACC/Peek/', mode: 'read', delegation: { folders: [{ path: '/Projects/ACC/Peek/', mode: 'read' }] } },
    ] });
    expect(r.status, r.text).toBe(200);
    // The hub refuses Contribute under a Read grant; a row stored otherwise (by hand, or before the rule) is still capped.
    app.db.prepare('UPDATE user_folder_grants SET delegation=? WHERE user_id=? AND path=?').run(JSON.stringify({ folders: [{ path: '/Projects/ACC/Peek/', mode: 'contribute' }] }), dana.id, '/Projects/ACC/Peek/');
    const me = await call(dana.who, 'GET', '/me');
    expect(me.body.folder_grants.map((g: any) => g.path)).toEqual(['/Projects/ACC/Other/', '/Projects/ACC/Peek/']);
    // Shared stays Read (a project grant); Peek is capped at its grant's Read.
    expect(me.body.agents[0].folders).toEqual([
      { path: '/Projects/ACC/Other/', mode: 'contribute' }, { path: '/Projects/ACC/Peek/', mode: 'read' }, { path: '/Projects/ACC/Shared/', mode: 'read' },
    ]);
    expect((await call(admin, 'PUT', `/users/${dana.id}/folder-grants`, { grants: [] })).status).toBe(200);
  });

  it('shows no key, credential, machine or secret', async () => {
    const me = await call(dana.who, 'GET', '/me');
    for (const s of [...secrets, mine.cred, idle.cred]) expect(me.text).not.toContain(s);
    expect(me.text).not.toMatch(/"(machine|pc|host|credential|policy)_?id"/i);
    expect(me.text).not.toContain('Someone else');
  });

  it('follows the grant: without the vault component the folders go, and an archived agent goes', async () => {
    expect((await call(admin, 'PUT', `/users/${dana.id}/grants`, { grants: [{ project_id: project, components: ['tasks'], delegation: { teams: [team] } }] })).status).toBe(200);
    app.db.prepare("UPDATE agents SET status='archived', archived_at=? WHERE id=?").run(Date.now(), idle.id);
    const me = await call(dana.who, 'GET', '/me');
    expect(me.body.agents).toEqual([{ id: mine.id, label: 'Dana writer', teams: [{ id: team, name: 'Acc team', project_name: 'ACC', operations: expect.any(Array) }], folders: [] }]);
  });

  it('an admin gets no agents list here', async () => {
    expect((await call(admin, 'GET', '/me')).body.agents).toBeUndefined();
  });
});
