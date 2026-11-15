/**
 * Saved Blueprint views (docs/dashboard-ux.md, "List analysis"): per user, kept in the per-user settings, filters only,
 * re-checked on read against the viewer's grants, at most 20 per section, pinned first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const PW = 'views member password 1234';
type S = { cookie: string; csrf: string };
let app: App, base = '', admin: S, member: S, memberId = '', P = '', Q = '';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const view = (over: Record<string, unknown> = {}) => ({ project_id: P, section: 2, name: 'Open must-haves', f: ['priority:must', 'status:agreed'], gap: 'no_ac', x: 'area*milestone', g: 'milestone', s: 'risk', ...over });
const put = (who: S, views: unknown[]) => call(who, 'PUT', '/blueprint/views', { views });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahviews-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base, 'admin', ADMIN_PASSWORD);
  P = (await call(admin, 'POST', '/projects', { key: 'VWA', name: 'Views A' })).body.project.id;
  Q = (await call(admin, 'POST', '/projects', { key: 'VWB', name: 'Views B' })).body.project.id;
  const c = await call(admin, 'POST', '/users', { username: 'nora' });
  memberId = c.body.user.id;
  const first = await adminLogin(base, 'nora', c.body.password);
  expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
  expect((await call(admin, 'PUT', `/users/${memberId}/grants`, { grants: [{ project_id: P, components: ['blueprint'], vault_folders: [], may_export: false }] })).status).toBe(200);
  member = await adminLogin(base, 'nora', PW);
});
afterAll(async () => { await app?.close(); });

describe('saved Blueprint views', () => {
  it('start empty, and a saved view reads back the same on another sign-in (the same filters apply)', async () => {
    expect((await call(admin, 'GET', '/blueprint/views')).body).toEqual({ views: [], max_per_section: 20 });
    const r = await put(admin, [view()]);
    expect(r.status).toBe(200);
    const v = r.body.views[0];
    expect(v).toMatchObject({ project_id: P, section: 2, name: 'Open must-haves', pinned: false, f: ['priority:must', 'status:agreed'], gap: 'no_ac', x: 'area*milestone', g: 'milestone', s: 'risk' });
    expect(v.id).toMatch(/^bv_[a-f0-9]{12}$/);
    const other = await adminLogin(base, 'admin', ADMIN_PASSWORD);
    expect((await call(other, 'GET', '/blueprint/views')).body.views).toEqual([v]);
  });

  it('are stored in the per-user settings, and keep only filters', async () => {
    const row = app.db.prepare("SELECT value FROM system_settings WHERE key LIKE 'blueprint.views:%'").get() as { value: string };
    const stored = JSON.parse(row.value)[0];
    expect(Object.keys(stored).sort()).toEqual(['created_at', 'f', 'g', 'gap', 'id', 'name', 'pinned', 'project_id', 's', 'section', 'x']);
    // No count and no item: a view that tries to carry one is refused.
    expect((await put(admin, [view({ total: 5 })])).status).toBe(400);
    expect((await put(admin, [view({ items: ['FR-ONE-01'] })])).status).toBe(400);
  });

  it('take closed words only: a dimension, a stored value, a gap, a sort', async () => {
    for (const bad of [{ f: ['nope:x'] }, { f: ['status:two words'] }, { f: ['status:a,b'] }, { f: ['status'] }, { gap: 'made_up' }, { s: 'newest' }, { g: 'name' }, { x: 'status*bogus' }, { x: 'status' }, { kind: 'fr nfr' }, { section: 7 }]) {
      expect((await put(admin, [view(bad)])).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put(admin, [view({ f: ['owner:no'], q: 'free search text', kind: 'fr,nfr', status: 'agreed', sel: 'all', x: '-' })])).status).toBe(200);
  });

  it('list pinned views first, and keep an id and its created time when a view is saved again', async () => {
    const a = (await put(admin, [view({ name: 'A' })])).body.views[0];
    const r = await put(admin, [a, view({ name: 'B', pinned: true })]);
    expect(r.body.views.map((v: { name: string }) => v.name)).toEqual(['B', 'A']);
    expect(r.body.views.find((v: { name: string }) => v.name === 'A')).toMatchObject({ id: a.id, created_at: a.created_at });
    expect((await call(admin, 'GET', `/blueprint/views?project=${P}&section=2`)).body.views.map((v: { name: string }) => v.name)).toEqual(['B', 'A']);
    expect((await call(admin, 'GET', `/blueprint/views?section=3`)).body.views).toEqual([]);
  });

  it('allow at most 20 per section, and the same view twice is refused', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => view({ name: `v${i}` }));
    expect((await put(admin, twenty)).status).toBe(200);
    expect((await put(admin, [...twenty, view({ name: 'one more' })])).status).toBe(400);
    expect((await put(admin, [...twenty.slice(0, 19), ...Array.from({ length: 20 }, (_, i) => view({ name: `s3-${i}`, section: 3 }))])).status).toBe(200);
    const one = (await put(admin, [view()])).body.views[0];
    expect((await put(admin, [one, one])).status).toBe(400);
  });

  it('are per user: a member sees none of the operator\'s', async () => {
    await put(admin, [view()]);
    expect((await call(member, 'GET', '/blueprint/views')).body.views).toEqual([]);
  });

  it('a member keeps views on what they read, and cannot save one on a project they do not', async () => {
    const r = await put(member, [view({ name: 'Mine' })]);
    expect(r.status).toBe(200);
    expect(r.body.views).toHaveLength(1);
    const other = await put(member, [view({ project_id: Q })]);
    expect(other.status).toBe(400);
    expect(other.text).not.toContain('Views B');
    expect((await put(member, [view({ project_id: 'prj_missing' })])).text).toBe(other.text);
  });

  it('a view of a project the user lost access to is gone from the list', async () => {
    expect((await call(member, 'GET', '/blueprint/views')).body.views).toHaveLength(1);
    expect((await call(admin, 'PUT', `/users/${memberId}/grants`, { grants: [] })).status).toBe(200);
    expect((await call(member, 'GET', '/blueprint/views')).body.views).toEqual([]);
    // A grant given again reads the stored view again, as Home's pins do.
    expect((await call(admin, 'PUT', `/users/${memberId}/grants`, { grants: [{ project_id: P, components: ['blueprint'], vault_folders: [], may_export: false }] })).status).toBe(200);
    expect((await call(member, 'GET', '/blueprint/views')).body.views).toHaveLength(1);
  });

  it('a damaged stored value reads as no views', async () => {
    app.db.prepare('UPDATE system_settings SET value=? WHERE key=?').run('{"views":1}', `blueprint.views:${memberId}`);
    expect((await call(member, 'GET', '/blueprint/views')).body.views).toEqual([]);
  });

  it('are not part of the project export', async () => {
    const r = await call(admin, 'GET', `/projects/${P}/export.md`);
    expect(r.text).not.toContain('Open must-haves');
    expect(r.text).not.toContain('blueprint.views');
  });
});
