/**
 * Blueprint JSON export (docs/blueprint.md §7, docs/multi-user.md §2): `GET /api/projects/:id/export.json` is the
 * admin's lossless export for a rebuild. It holds every item (parents, teams, fields, archived reports, writers) and
 * every link; a member is refused it even with export access and keeps the Markdown export as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { BlueprintViews } from '../src/blueprint/views.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, ana: S;
const PW = 'export json password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '', text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const audits = () => (app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='export.read'").get() as { n: number }).n;

let P = '', teamId = '', coordId = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbpjson-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base, 'admin', ADMIN_PASSWORD);
  P = (await call(admin, 'POST', '/projects', { key: 'CNV', name: 'Conclave' })).body.project.id;
  const a = app.keys.createAgent('cnv-coord', null, sys);
  coordId = a.id;
  app.keys.createSessionKey({ agentId: a.id, label: 'cnv-coord key' }, sys);
  const t = app.teams.create({ name: 'CNV One', goal: 'goal', members: [{ agent_id: a.id, role: 'coordinator' }] }, sys);
  teamId = t.id;
  app.teams.start(t.id, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, t.id);
  const ops = [
    { op: 'upsert', kind: 'module', key: 'ONE', title: 'Module one', team_id: t.id },
    { op: 'upsert', kind: 'fr', key: 'FR-ONE-01', parent_key: 'ONE', title: 'Fold the field', body: 'The field folds on request.\n\nTwo lines of body.', status: 'agreed' },
    { op: 'upsert', kind: 'ac', key: 'FR-ONE-01/AC1', parent_key: 'FR-ONE-01', title: 'Folds in 3 s', status: 'passing', fields: { given: 'a flat field', when: 'the operator folds it', then: 'it folds in 3 s' } },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Field folds', status: 'planned', team_id: t.id },
    { op: 'link', from: 'M1', to: 'FR-ONE-01', rel: 'delivers' },
  ];
  expect((await call(admin, 'POST', `/projects/${P}/ops`, { version: app.blueprint.project(P)!.version, ops })).status).toBe(200);
  // An archived status report written by the team's coordinator: archives and agent writers must survive the export.
  const old = Date.now() - 3 * 864e5;
  app.db.prepare("INSERT INTO bp_items(id,project_id,kind,key,title,fields,team_id,created_by_kind,created_by_id,created_at,updated_by_kind,updated_by_id,updated_at,archived) VALUES (?,?,'report','SR-001','Status on track',?,?,'agent',?,?,'agent',?,?,1)")
    .run('bpi_json_sr1', P, JSON.stringify({ health: 'on_track', done: [], next: [], blockers: [] }), t.id, a.id, old, a.id, old);

  const c = await call(admin, 'POST', '/users', { username: 'ana' });
  const first = await adminLogin(base, 'ana', c.body.password);
  expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
  expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: P, components: ['blueprint'], may_export: true }] })).status).toBe(200);
  ana = await adminLogin(base, 'ana', PW);
});
afterAll(async () => { await app?.close(); });

describe('Blueprint JSON export', () => {
  it('a member with export access is refused the JSON export, and nothing is audited', async () => {
    const before = audits();
    const r = await call(ana, 'GET', `/projects/${P}/export.json`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('admin_only');
    expect(r.text).not.toContain('Module one');
    expect(audits()).toBe(before);
  });

  it('the member keeps the Markdown export, unchanged', async () => {
    const m = await call(ana, 'GET', `/projects/${P}/export.md`);
    expect(m.status).toBe(200);
    expect(m.type).toMatch(/^text\/markdown/);
    expect(m.text).toContain('FR-ONE-01');
    expect((await call(admin, 'GET', `/projects/${P}/export.md`)).status).toBe(200);
  });

  it('the admin gets every item and link: parents, teams, fields, archives and writers', async () => {
    const r = await call(admin, 'GET', `/projects/${P}/export.json`);
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^application\/json/);
    expect(r.disposition).toBe('attachment; filename="CNV-blueprint.json"');
    const doc = r.body;
    expect(doc).toMatchObject({ format: 'conclave-blueprint', version: 1, project: { key: 'CNV', name: 'Conclave', version: app.blueprint.project(P)!.version } });
    expect(Date.parse(doc.generated_at)).not.toBeNaN();
    const all = app.blueprint.items(P, { includeArchived: true });
    expect(doc.items.map((i: any) => i.key).sort()).toEqual(all.map((i) => i.key).sort());
    const by = (k: string) => doc.items.find((i: any) => i.key === k);
    expect(by('ONE')).toMatchObject({ kind: 'module', parent_key: null, team_id: teamId, created_by: { kind: 'operator', id: null }, updated_by: { kind: 'operator', id: null } });
    expect(by('FR-ONE-01')).toMatchObject({ kind: 'fr', parent_key: 'ONE', status: 'agreed', body: 'The field folds on request.\n\nTwo lines of body.' });
    expect(by('FR-ONE-01/AC1')).toMatchObject({ parent_key: 'FR-ONE-01', fields: { given: 'a flat field', when: 'the operator folds it', then: 'it folds in 3 s' } });
    expect(by('SR-001')).toMatchObject({ kind: 'report', archived: true, team_id: teamId, created_by: { kind: 'agent', id: coordId }, updated_by: { kind: 'agent', id: coordId } });
    expect(by('ONE').archived).toBeUndefined();
    expect(doc.links).toEqual(app.blueprint.links(P).map((l) => ({ from: l.from_key, to: l.to_key, rel: l.rel })));
    expect(doc.links).toContainEqual({ from: 'M1', to: 'FR-ONE-01', rel: 'delivers' });
    // An operator's console id never appears in the file.
    const adminId = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
    expect(r.text).not.toContain(adminId);
  });

  it('takes no query and refuses an export over its bound rather than cutting it short', async () => {
    expect((await call(admin, 'GET', `/projects/${P}/export.json?paper=PAP-1`)).status).toBe(400);
    expect((await call(admin, 'GET', '/projects/prj_nope/export.json')).status).toBe(404);
    const views = new BlueprintViews(app.db, app.blueprint);
    expect(() => views.exportJson(P, Date.now(), 100)).toThrow(/over the 100 an export may hold/);
  });
});
