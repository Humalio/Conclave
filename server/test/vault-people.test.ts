/**
 * The vault folder's Access view lists people from the hub's own rule (docs/multi-user.md §1.2a): the answer for a
 * folder is what each person's MemberScope decides, the scope every member read and write is checked with, so the list
 * and an actual read or write never disagree. The picker's marks come from the same tables a save is checked against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { MemberScope } from '../src/admin/memberScope.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base = '', admin = { cookie: '', csrf: '' };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const mk = async (username: string, external = false) => { const c = await api('POST', '/users', { username, role: 'member', external }); expect(c.status).toBe(200); return c.body.user.id as string; };
const share = async (id: string, grants: unknown[]) => { const r = await api('PUT', `/users/${id}/folder-grants`, { grants }); expect(r.status, JSON.stringify(r.body)).toBe(200); };
const people = async (path: string) => (await api('GET', `/vault/people?path=${encodeURIComponent(path)}`)).body.people as { user_id: string; username: string; reach: any[] }[];
let ana = '', bo = '', cy = '', ext = '', dee = '', eve = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahvpeople-'));
  const v = (...p: string[]) => join(dir, 'vault', ...p);
  for (const p of [['Papers', 'Drafts'], ['Papers', 'Reviews'], ['Papers', 'Hush'], ['Other']]) mkdirSync(v(...p), { recursive: true });
  writeFileSync(v('Papers', 'a.md'), '# a\n');
  app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Papers/Hush/', Date.now());
  ana = await mk('ana'); bo = await mk('bo'); cy = await mk('cy'); ext = await mk('ext', true);
  await share(ana, [{ path: '/Papers/', mode: 'contribute', may_export: true }, { path: '/Papers/Drafts/', mode: 'read' }]);
  await share(bo, [{ path: '/Papers/Reviews/', mode: 'read' }]);
  await share(cy, [{ path: '/Other/', mode: 'read' }]);
  await share(ext, [{ path: '/Papers/', mode: 'read' }]);
  // Project grants: Dee's project folder sits inside a folder others share; Eve's sits above the restricted Hush folder.
  dee = await mk('dee'); eve = await mk('eve');
  const pg = async (user: string, key: string, folder: string) => {
    const p = (await api('POST', '/projects', { key, name: `Proj ${key}` })).body.project.id as string;
    app.db.prepare('UPDATE projects SET vault_roots=? WHERE id=?').run(JSON.stringify([folder]), p);
    const r = await api('PUT', `/users/${user}/grants`, { grants: [{ project_id: p, components: ['vault'], vault_folders: [folder] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  await pg(dee, 'PA', '/Papers/Reviews/'); await pg(eve, 'PB', '/Papers/');
});
afterAll(async () => { await app.close(); });

describe('vault people', () => {
  it('lists each person with how they reach the folder, the deepest grant deciding', async () => {
    const at = await people('/Papers/');
    const byName = Object.fromEntries(at.map((p) => [p.username, p.reach]));
    expect(Object.keys(byName).sort()).toEqual(['ana', 'bo', 'dee', 'eve', 'ext']);
    // Ana: Contribute on the folder itself, plus her inner Drafts share as its own row.
    expect(byName.ana).toEqual([expect.objectContaining({ how: 'folder', path: '/Papers/', access: 'contribute', may_export: true }), expect.objectContaining({ how: 'inner', path: '/Papers/Drafts/', access: 'read' })]);
    expect(byName.bo).toEqual([expect.objectContaining({ how: 'inner', path: '/Papers/Reviews/', access: 'read' })]);
    // Inside Drafts the inner grant decides: Read, not the outer Contribute.
    expect((await people('/Papers/Drafts/')).find((p) => p.username === 'ana')!.reach).toEqual([expect.objectContaining({ how: 'folder', path: '/Papers/Drafts/', access: 'read' })]);
    expect((await people('/Other/')).map((p) => p.username)).toEqual(['cy']);
  });

  it('agrees with the scope that enforces reads and writes, for every person and folder', async () => {
    const users = [ana, bo, cy, ext, dee, eve];
    for (const f of ['/Papers/', '/Papers/Drafts/', '/Papers/Reviews/', '/Papers/Hush/', '/Other/', '/Nowhere/']) {
      const listed = new Map((await people(f)).map((p) => [p.user_id, p]));
      for (const id of users) {
        const row = app.db.prepare('SELECT external FROM admin_users WHERE id=?').get(id) as { external: number };
        const scope = new MemberScope(app.db, id, !!row.external);
        const reaches = scope.canSee(f, true) || scope.isAncestor(f).some((g) => scope.canSee(g, true));
        expect(listed.has(id), `${f} ${id}`).toBe(reaches);
        const direct = listed.get(id)?.reach.find((r) => r.how !== 'inner');
        if (scope.canSee(f, true)) expect(direct?.access, `${f} ${id}`).toBe(scope.canWrite(f.replace(/\/$/, '') + '/x.md') ? 'contribute' : 'read');
      }
    }
  });

  it('says a project row is a project, with the project name', async () => {
    const at = await people('/Papers/');
    const d = at.find((p) => p.username === 'dee')!.reach;
    expect(d).toEqual([expect.objectContaining({ how: 'project', path: '/Papers/Reviews/', access: 'read', project: expect.objectContaining({ name: 'Proj PA' }) })]);
    expect(at.find((p) => p.username === 'eve')!.reach[0]).toEqual(expect.objectContaining({ how: 'project', project: expect.objectContaining({ name: 'Proj PB' }) }));
    expect((await people('/Papers/Hush/')).map((p) => p.username)).toEqual([]);
  });

  it('never lists a person for a restricted folder their grant only sits above, and never an admin', async () => {
    expect((await people('/Papers/Hush/')).map((p) => p.username)).toEqual([]);
    expect((await people('/Papers/')).some((p) => p.username === 'admin')).toBe(false);
  });

  it('gives the picker its marks: restricted, the hub folder, what is shared', async () => {
    const m = (await api('GET', `/users/${ana}/folder-marks`)).body;
    expect(m.restricted).toContain('/Papers/Hush/');
    expect(m.shared).toEqual([{ path: '/Papers/', mode: 'contribute' }, { path: '/Papers/Drafts/', mode: 'read' }]);
    expect(Array.isArray(m.hub)).toBe(true);
    expect((await api('GET', '/users/nope/folder-marks')).status).toBe(404);
  });
});
