/**
 * Fixes from the code review of features-round: GET /api/graph/entities needs the graph component (a vault-only member
 * gets nothing) and names merged_into only when the member sees that entity too; a room export carries at most the
 * newest EXPORT_MAX_MESSAGES messages and says so; the report archive runs for every project at hub start.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { EXPORT_MAX_MESSAGES } from '../src/admin/phase3.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type S = { cookie: string; csrf: string };
let app: App, base = '', dir = '', admin: S;
const PW = 'review nits password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
/** A member with these grants, signed in with the test password. */
const member = async (username: string, grants: unknown[]): Promise<S> => {
  const c = await call(admin, 'POST', '/api/users', { username });
  const first = await adminLogin(base, username, c.json.password);
  expect((await call(first, 'POST', '/api/me/password', { current: c.json.password, new: PW })).status).toBe(200);
  const g = await call(admin, 'PUT', `/api/users/${c.json.user.id}/grants`, { grants });
  expect(g.status, JSON.stringify(g.json)).toBe(200);
  return adminLogin(base, username, PW);
};
/** An agent with a session key, as a team member needs. */
const agent = (label: string) => { const a = app.keys.createAgent(label, null, sys); app.keys.createSessionKey({ agentId: a.id, label }, sys); return a; };
const start = async () => {
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahnits-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  await start();
});
afterAll(async () => { await app?.close(); });

describe('GET /api/graph/entities for a member', () => {
  it('needs the graph component, and hides merged_into outside the member view', async () => {
    const project = (await call(admin, 'POST', '/api/projects', { key: 'GRN', name: 'Grn' })).json.project.id as string;
    const a = agent('graph writer');
    const file = async (rel: string[]) => {
      await app.store.write(rel, Buffer.from('# note\n'), 'absent', 'create', { agentId: a.id, credentialId: null as never });
      return app.store.fileByPath(rel.join('/'))!.id;
    };
    const inside = await file(['Projects', 'Grn', 'n.md']), outside = await file(['Elsewhere', 'o.md']);
    const ent = app.db.prepare('INSERT INTO kg_entities(id,name,description,created_at) VALUES (?,?,?,0)');
    const claim = app.db.prepare("INSERT INTO kg_claims(id,subject_id,predicate,text,src_file,src_anchor,src_rev,quote,quote_hash,recorded_at,status,confidence) VALUES (?,?,'is','fixture',?,'',?,'fixture','h',0,'accepted',1)");
    ent.run('e_in', 'nits inside', null); claim.run('c_in', 'e_in', inside, 'r1');
    ent.run('e_out', 'nits outside', null); claim.run('c_out', 'e_out', outside, 'r1');
    ent.run('e_m1', 'nits merged out', null); claim.run('c_m1', 'e_m1', inside, 'r1');
    ent.run('e_m2', 'nits merged in', null); claim.run('c_m2', 'e_m2', inside, 'r1');
    app.db.prepare("UPDATE kg_entities SET merged_into='e_out' WHERE id='e_m1'").run();
    app.db.prepare("UPDATE kg_entities SET merged_into='e_in' WHERE id='e_m2'").run();
    const grant = (components: string[]) => [{ project_id: project, components, vault_folders: ['/Projects/Grn/'], may_export: false }];
    const vaultOnly = await member('vonly', grant(['vault']));
    const withGraph = await member('vgraph', grant(['vault', 'graph']));

    const v = await call(vaultOnly, 'GET', '/api/graph/entities?q=nits');
    expect(v.status).toBe(200);
    expect(v.json.entities).toEqual([]);
    // The vault itself still answers for the vault-only member.
    const tree = await call(vaultOnly, 'GET', '/api/vault/tree?path=/vault/Projects');
    expect(tree.status, JSON.stringify(tree.json)).toBe(200);

    const g = (await call(withGraph, 'GET', '/api/graph/entities?q=nits')).json.entities as { id: string; merged_into: string | null; claims: number }[];
    expect(g.map((e) => e.id).sort()).toEqual(['e_in', 'e_m1', 'e_m2']);
    expect(g.find((e) => e.id === 'e_m1')!.merged_into).toBeNull(); // e_out is sourced outside the grant
    expect(g.find((e) => e.id === 'e_m2')!.merged_into).toBe('e_in');
    // The admin sees every one, merged_into as stored.
    const all = (await call(admin, 'GET', '/api/graph/entities?q=nits')).json.entities as { id: string; merged_into: string | null }[];
    expect(all.find((e) => e.id === 'e_m1')!.merged_into).toBe('e_out');
  });
});

describe('room export cap', () => {
  it(`exports the newest ${EXPORT_MAX_MESSAGES} messages and says the rest is left out`, async () => {
    const c = agent('exp coord'), w = agent('exp worker');
    const t = app.teams.create({ name: 'Export cap', goal: 'g', members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: w.id, role: 'worker' }] }, sys);
    app.teams.start(t.id, sys);
    const room = app.teams.team(t.id)!.room_id!;
    const base0 = (app.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM messages WHERE room_id=?').get(room) as { s: number }).s;
    const ins = app.db.prepare("INSERT INTO messages(id,room_id,seq,kind,body,size_bytes,created_at) VALUES (?,?,?,'system',?,4,?)");
    const total = EXPORT_MAX_MESSAGES + 5;
    app.db.exec('BEGIN');
    for (let i = 1; i <= total; i++) ins.run(`msg_cap${i}`, room, base0 + i, `m${i}`, i);
    app.db.exec('COMMIT');
    const r = await call(admin, 'GET', `/api/conversations/${room}/export`);
    expect(r.status).toBe(200);
    expect(r.json.messages).toHaveLength(EXPORT_MAX_MESSAGES);
    expect(r.json.truncated).toBe(true);
    expect(r.json.note).toMatch(/newest 20000/);
    expect(r.json.messages.at(-1).content).toBe(`m${total}`);
    expect(r.json.messages[0].seq).toBeLessThan(r.json.messages[1].seq); // still oldest first
    // A small room is whole and not marked.
    const small = await call(admin, 'GET', `/api/conversations/${app.messaging.ensureDirect(c.id, w.id).id}/export`);
    expect(small.json.truncated).toBe(false);
    expect(small.json.note).toBeUndefined();
  });
});

describe('report archive catch-up (the limits route runs it; 1.0 no longer runs it at hub start)', () => {
  it('archives reports over the limit for every project without a new bp_report', async () => {
    const c = agent('arch coord');
    const t = app.teams.create({ name: 'Archive at start', goal: 'g', members: [{ agent_id: c.id, role: 'coordinator' }] }, sys);
    app.teams.start(t.id, sys);
    const project = app.blueprint.ensureTeamProject(t.id).id;
    const old = Date.now() - 3 * 864e5, fields = JSON.stringify({ health: 'on_track', done: [], next: [], blockers: [] });
    const ins = app.db.prepare("INSERT INTO bp_items(id,project_id,kind,key,title,fields,team_id,created_by_kind,created_at,updated_by_kind,updated_at) VALUES (?,?,'report',?,?,?,?,'agent',?,'agent',?)");
    for (let i = 1; i <= 503; i++) ins.run(`bpi_st${i}`, project, `SR-${String(i).padStart(3, '0')}`, 'Status on track', fields, t.id, old + i, old + i);
    const live = () => (app.db.prepare("SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND kind='report' AND archived=0").get(project) as { n: number }).n;
    expect(live()).toBe(503);
    app.blueprint.archiveAllReports();
    expect(live()).toBe(500);
  });
});
