/**
 * The multi-user leak test (docs/multi-user.md §4). Two projects, Conclave (CNV) and Echo (BRZ), with teams,
 * agents, tasks, decisions, team-room and direct messages, vault notes (one restricted), graph entities (one sourced in
 * both) and feed events. Every BRZ string carries the canary "zzBRZ", every CNV string "zzCNV". Ana (member, CNV full
 * project) and Jonas (external, BRZ Blueprint and feed, 2FA) walk every route the hub registers. Each project also has
 * Blueprint items owned by its first team and an open proposal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Who } from '../src/teams/teams.js';
import { ROUTE_SCOPES, MEMBER_READY } from '../src/admin/scopes.js';
import { totp } from '../src/util/crypto.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, ana: S, jonas: S;
const PW = 'leak test password 1234';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  // The search echoes the query the user typed; that is not data from the hub, so it is left out of the scan.
  const text = (await r.text()).replace(/"query":"[^"]*"/, '"query":""');
  return { status: r.status, text, headers: JSON.stringify([...r.headers.entries()]), json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const login = (username: string, code?: string): Promise<S> => adminLogin(base, username, username === 'admin' ? ADMIN_PASSWORD : PW, code);
type A = { id: string; cred: string };
const mk = (label: string): A => {
  const a = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.create', 'fs.update'], resource: 'path:/vault/**' }], 'test', sys);
  return { id: a.id, cred: k.credential.id };
};
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });

/** Everything one project seeded, for parameters and for the "must never appear" sets. */
interface Seed { project: string; teams: string[]; tasks: string[]; decisions: string[]; rooms: string[]; files: string[]; agents: string[]; entities: string[]; proposals: string[]; canary: string; folder: string }
const seed: Record<'CNV' | 'BRZ', Seed> = {} as never;
let restrictedFile = '', directRoom = '';

async function seedProject(key: 'CNV' | 'BRZ', name: string, folder: string): Promise<Seed> {
  const canary = `zz${key}`;
  const project = (await call(admin, 'POST', '/api/projects', { key, name })).json.project.id as string;
  const s: Seed = { project, teams: [], tasks: [], decisions: [], rooms: [], files: [], agents: [], entities: [], proposals: [], canary, folder };
  for (const tn of ['One', 'Two']) {
    const c = mk(`${canary}-${tn}-coord`), w = mk(`${canary}-${tn}-worker`);
    const t = app.teams.create({ name: `${canary} team ${tn}`, goal: `${canary} goal`, members: [{ agent_id: c.id, role: 'coordinator' }, { agent_id: w.id, role: 'worker' }] }, sys);
    app.teams.start(t.id, sys);
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(project, t.id);
    const team = app.teams.team(t.id)!;
    s.teams.push(t.id); s.agents.push(c.id, w.id);
    if (team.room_id) {
      s.rooms.push(team.room_id);
      app.messaging.insert({ roomId: team.room_id, agentId: c.id, credId: c.cred, kind: 'text', body: `${canary} room message`, replyTo: null, clientMsgId: `${canary}-${tn}-m` });
    }
    const task = app.teams.create_task(who(c), { team_id: t.id, title: `${canary} task ${tn}`, description: `${canary} description` });
    s.tasks.push(task.id);
    s.decisions.push(app.decisions.ask(who(c), { team_id: t.id, question: `${canary} question ${tn}?` }).id);
  }
  // Blueprint: a module and a requirement owned by team One, and the coordinator's proposal to agree it.
  const ver = () => app.blueprint.project(project)!.version;
  expect((await call(admin, 'POST', `/api/projects/${project}/ops`, { version: ver(), ops: [
    { op: 'upsert', kind: 'module', key: `${key}A`, title: `${canary} module`, team_id: s.teams[0] },
    { op: 'upsert', kind: 'fr', key: `FR-${key}A-01`, parent_key: `${key}A`, title: `${canary} requirement` },
    { op: 'upsert', kind: 'paper', key: 'PAP-1', title: `${canary} paper` },
  ] })).status).toBe(200);
  const pr = app.blueprint.submit(project, { version: ver(), ops: [{ op: 'upsert', kind: 'fr', key: `FR-${key}A-01`, status: 'agreed' }], reason: `${canary} reason`, team_id: s.teams[0] }, s.agents[0]!);
  expect(pr.status).toBe('proposed');
  if (pr.status === 'proposed') s.proposals.push(pr.proposal.id);
  const rel = [...folder.split('/').filter(Boolean), `${canary}-note.md`];
  await app.store.write(rel, Buffer.from(`# ${canary} note\n`), 'absent', 'create', { agentId: s.agents[0]!, credentialId: null as never });
  s.files.push(app.store.fileByPath(rel.join('/'))!.id);
  return s;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahleak-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await login('admin');
  seed.CNV = await seedProject('CNV', 'Conclave', '/Projects/Conclave/');
  seed.BRZ = await seedProject('BRZ', 'Echo', '/Projects/Echo/');
  // A restricted folder inside CNV's root, not named in Ana's grant: its note must stay hidden from her.
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Projects/Conclave/Restricted/', Date.now());
  await app.store.write(['Projects', 'Conclave', 'Restricted', 'zzRESTRICTED.md'], Buffer.from('zzRESTRICTED secret\n'), 'absent', 'create', { agentId: seed.CNV.agents[0]!, credentialId: null as never });
  restrictedFile = app.store.fileByPath('Projects/Conclave/Restricted/zzRESTRICTED.md')!.id;
  // A direct room between a CNV and a BRZ agent: never visible to members.
  const [a, b] = [seed.CNV.agents[0]!, seed.BRZ.agents[0]!];
  directRoom = app.messaging.ensureDirect(a, b).id;
  app.messaging.insert({ roomId: directRoom, agentId: b, credId: app.keys.credentials({ agentId: b })[0]!.id, kind: 'text', body: 'zzBRZ direct zzDIRECT', replyTo: null, clientMsgId: 'dm1' });
  // Graph: one entity per project, one sourced in both, its description and alias from BRZ.
  const ins = app.db.prepare("INSERT INTO kg_claims(id,subject_id,predicate,text,src_file,src_anchor,src_rev,quote,quote_hash,recorded_at,status,confidence) VALUES (?,?,'is','fixture',?,'',?,'fixture','h',0,'accepted',1)");
  const ent = app.db.prepare('INSERT INTO kg_entities(id,name,description,created_at) VALUES (?,?,?,0)');
  for (const k of ['CNV', 'BRZ'] as const) { ent.run(`e_${k}`, `${seed[k].canary} entity`, `${seed[k].canary} description`); ins.run(`c_${k}`, `e_${k}`, seed[k].files[0], 'r1'); seed[k].entities.push(`e_${k}`); }
  ent.run('e_both', 'Shared entity', 'zzBRZ shared description');
  app.db.prepare("INSERT INTO kg_aliases(entity_id,alias) VALUES ('e_both','zzbrz alias')").run();
  ins.run('c_both_cnv', 'e_both', seed.CNV.files[0], 'r1'); ins.run('c_both_brz', 'e_both', seed.BRZ.files[0], 'r1'); ins.run('c_both_brz2', 'e_both', seed.BRZ.files[0], 'r2');
  ent.run('e_restricted', 'zzRESTRICTED entity', null); ins.run('c_r', 'e_restricted', restrictedFile, 'r1');

  // Users: Ana (member, CNV full project, CNV's folder); Jonas (external, BRZ Blueprint and feed, 2FA).
  const mkUser = async (username: string, over: Record<string, unknown>, grants: unknown[]) => {
    const c = await call(admin, 'POST', '/api/users', { username, ...over });
    // First sign-in with the generated password; a 2FA user enrols right away, then each chooses the test's password.
    const first = await adminLogin(base, username, c.json.password);
    let secret: string | undefined;
    if (c.json.user.totp_required) {
      secret = (await call(first, 'POST', '/api/totp/enroll', {})).json.secret as string;
      expect((await call(first, 'POST', '/api/totp/confirm', { code: totp(secret, Date.now()) })).status).toBe(200);
    }
    expect((await call(first, 'POST', '/api/me/password', { current: c.json.password, new: PW })).status).toBe(200);
    expect((await call(admin, 'PUT', `/api/users/${c.json.user.id}/grants`, { grants })).status).toBe(200);
    return { id: c.json.user.id as string, secret };
  };
  const anaU = await mkUser('ana', {}, [{ project_id: seed.CNV.project, components: ['tasks', 'feed', 'messages', 'vault', 'graph', 'topology'], vault_folders: ['/Projects/Conclave/'], may_export: false }]);
  const jonasU = await mkUser('jonas', { external: true, org: 'Partner' }, [{ project_id: seed.BRZ.project, components: ['feed'] }]);
  // Ana decides for CNV's second team, so the walk runs the decider paths too (the proposals belong to team One).
  expect((await call(admin, 'PUT', `/api/teams/${seed.CNV.teams[1]}/deciders`, { user_ids: [anaU.id] })).status).toBe(200);
  ana = await login('ana');
  jonas = await login('jonas', totp(jonasU.secret!, Date.now(), 1)); // enrolment spent the current code
  void anaU;
});
afterAll(async () => { await app?.close(); });

/** Fill a route pattern for one project ("CNV", "BRZ") or with random ids ("rand"). */
function fill(route: string, k: 'CNV' | 'BRZ' | 'rand'): string {
  const s = k === 'rand' ? null : seed[k];
  const pick = (xs: string[] | undefined, fallback: string) => (s ? xs![0]! : fallback);
  let p = route.split(' ')[1]!;
  p = p.replace('/api/teams/:id/tasks/:taskId', `/api/teams/${pick(s?.teams, 'tm_nope')}/tasks/${pick(s?.tasks, 'task_nope')}`)
    .replace('/api/teams/:id', `/api/teams/${pick(s?.teams, 'tm_nope')}`)
    .replace('/api/decisions/:id', `/api/decisions/${pick(s?.decisions, 'dec_nope')}`)
    .replace(':roomId', pick(s?.rooms, 'room_nope'))
    .replace(':fileId', pick(s?.files, 'file_nope'))
    .replace('/api/projects/:id', `/api/projects/${s ? s.project : 'prj_nope'}`)
    .replace('/api/proposals/:id', `/api/proposals/${pick(s?.proposals, 'bpp_nope')}`)
    .replace('/items/:key', `/items/${k === 'rand' ? 'FR-NOPE-01' : `FR-${k}A-01`}`)
    .replace(/:[A-Za-z]+/g, 'x_nope');
  const q: Record<string, string> = {
    '/api/vault/preview': `?path=${encodeURIComponent(s ? `/vault${s.folder}${s.canary}-note.md` : '/vault/Projects/Nope/x.md')}`,
    '/api/vault/tree': `?path=${encodeURIComponent(s ? `/vault${s.folder}` : '/vault/Projects/Nope/')}`,
    '/api/vault/diff': `?file=${s ? s.files[0] : 'file_nope'}&from=x`,
    '/api/messages/search': `?q=${s ? s.canary : 'zz'}`,
    '/api/graph/entities': `?q=${s ? s.canary.slice(2) : ''}`,
  };
  return p + (q[p] ?? '');
}
/** Everything of the other project, which must never appear in a response. */
const forbidden = (k: 'CNV' | 'BRZ') => [seed[k].canary, seed[k].canary.toLowerCase(), seed[k].project, ...seed[k].teams, ...seed[k].tasks, ...seed[k].decisions, ...seed[k].rooms, ...seed[k].files, ...seed[k].agents, ...seed[k].entities, ...seed[k].proposals];
const alwaysHidden = () => ['zzRESTRICTED', 'zzDIRECT', directRoom].filter(Boolean);
const hash = () => createHash('sha256').update(JSON.stringify(['admin_users', 'user_project_grants', 'teams', 'tasks', 'decisions', 'messages', 'files', 'system_settings', 'audit_events', 'kg_entities', 'projects']
  .map((t) => app.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))).digest('hex');

describe('the leak test (§4)', () => {
  it('walks every registered route as Ana: no BRZ data anywhere, admin routes 403, BRZ ids answer like random ids', async () => {
    const routes = [...new Set(app.adminRoutes)].filter((r) => ROUTE_SCOPES[r] !== 'public' && !['POST /api/logout', 'POST /api/totp/enroll', 'POST /api/totp/confirm'].includes(r));
    expect(routes.length).toBeGreaterThan(150);
    const leaks: string[] = [], identity: string[] = [], refused: string[] = [];
    const bad = [...forbidden('BRZ'), ...alwaysHidden()].filter(Boolean);
    for (const r of routes) {
      const method = r.split(' ')[0]!;
      const before = method === 'GET' ? '' : hash();
      const res = { CNV: await call(ana, method, fill(r, 'CNV'), method === 'GET' ? undefined : {}), BRZ: await call(ana, method, fill(r, 'BRZ'), method === 'GET' ? undefined : {}), rand: await call(ana, method, fill(r, 'rand'), method === 'GET' ? undefined : {}) };
      for (const [k, x] of Object.entries(res)) for (const b of bad) if (x.text.includes(b) || x.headers.includes(b)) leaks.push(`${r} [${k}] contains ${b}`);
      const ready = MEMBER_READY.has(r) || ROUTE_SCOPES[r] === 'self';
      if (!ready) { for (const x of Object.values(res)) if (x.status !== 403) refused.push(`${r} answered ${x.status}`); }
      else if (r.includes(':') && (res.BRZ.status !== res.rand.status || res.BRZ.text !== res.rand.text)) identity.push(`${r}: BRZ ${res.BRZ.status} ${res.BRZ.text.slice(0, 80)} vs random ${res.rand.status} ${res.rand.text.slice(0, 80)}`);
      if (method !== 'GET' && !ready && hash() !== before) refused.push(`${r} changed the database`);
    }
    expect(leaks).toEqual([]);
    expect(refused).toEqual([]);
    expect(identity).toEqual([]);
  });

  it('Ana sees CNV: filtered lists, counts that match, her folder without the restricted one', async () => {
    const teams = (await call(ana, 'GET', '/api/teams')).json.teams;
    expect(teams.map((t: any) => t.id).sort()).toEqual([...seed.CNV.teams].sort());
    expect((await call(ana, 'GET', `/api/teams/${seed.CNV.teams[0]}`)).json.team).toMatchObject({ id: seed.CNV.teams[0] });
    expect((await call(ana, 'GET', `/api/teams/${seed.CNV.teams[0]}`)).json.team.members[0]).not.toHaveProperty('credential_id');
    const decisions = (await call(ana, 'GET', '/api/decisions')).json.decisions;
    expect(decisions.length).toBe(2);
    expect((await call(ana, 'GET', '/api/decisions/counts')).json.open).toBe(decisions.filter((d: any) => d.status === 'open').length);
    const feed = (await call(ana, 'GET', '/api/work/recent?limit=50')).json;
    expect(feed.total).toBe(feed.events.length);
    expect(feed.events.every((e: any) => !e.project || e.project.id === seed.CNV.project)).toBe(true);
    // Paging never points past a hidden event: walk every page.
    let next: string | null = null, seen = 0;
    do { const p: any = (await call(ana, 'GET', `/api/work/recent?limit=1${next ? `&before=${next}` : ''}`)).json; seen += p.events.length; next = p.next; } while (next);
    expect(seen).toBe(feed.total);
    expect((await call(ana, 'GET', '/api/conversations')).json.conversations.map((c: any) => c.id).sort()).toEqual([...seed.CNV.rooms].sort());
    expect((await call(ana, 'GET', '/api/messages/search?q=zz')).json.messages.every((m: any) => seed.CNV.rooms.includes(m.room_id))).toBe(true);
    expect((await call(ana, 'GET', `/api/conversations/${seed.CNV.rooms[0]}/export`)).json.error).toBe('export_denied');
    const tree = (await call(ana, 'GET', '/api/vault/tree?path=/vault/Projects/Conclave')).json;
    expect(tree.files.map((f: any) => f.name)).toEqual(['zzCNV-note.md']);
    expect(tree.folders).toEqual([]);
    expect(tree).not.toHaveProperty('exposure');
    expect((await call(ana, 'GET', '/api/vault/tree')).json.folders.map((f: any) => f.name)).toEqual(['Projects']);
    expect((await call(ana, 'GET', '/api/vault/tree?path=/vault/Projects')).json.folders.map((f: any) => [f.name, f.files])).toEqual([['Conclave', 1]]);
    expect((await call(ana, 'GET', `/api/vault/revisions/${restrictedFile}`)).status).toBe(404);
    expect((await call(ana, 'GET', '/api/vault/activity')).json.revisions.map((r: any) => r.file_id)).toEqual([seed.CNV.files[0]]);
    const ents = (await call(ana, 'GET', '/api/graph/entities')).json.entities;
    expect(ents.map((e: any) => [e.id, e.claims]).sort()).toEqual([['e_CNV', 1], ['e_both', 1]]);
    const topo = (await call(ana, 'GET', '/api/topology')).json;
    expect(topo.pcs).toEqual([]);
    expect(topo.teams.map((t: any) => t.id).sort()).toEqual([...seed.CNV.teams].sort());
    expect((await call(ana, 'GET', '/api/agents')).json.agents.map((a: any) => a.id).sort()).toEqual([...seed.CNV.agents].sort());
  });

  it('Jonas (external, BRZ Blueprint and feed) sees no CNV data, no restricted path, no team pages', async () => {
    const bad = [...forbidden('CNV'), ...alwaysHidden()];
    for (const r of [...MEMBER_READY].filter((x) => x.startsWith('GET'))) {
      for (const k of ['CNV', 'BRZ', 'rand'] as const) {
        const x = await call(jonas, 'GET', fill(r, k));
        for (const b of bad) expect(`${r} ${x.text}`.includes(b) ? `${r} [${k}] contains ${b}` : '').toBe('');
      }
    }
    expect((await call(jonas, 'GET', '/api/teams')).json.teams.map((t: any) => [t.id, t.tasks]).sort()).toEqual(seed.BRZ.teams.map((id) => [id, false]).sort());
    expect((await call(jonas, 'GET', `/api/teams/${seed.BRZ.teams[0]}`)).status).toBe(404);
    expect((await call(jonas, 'GET', '/api/agents')).json.agents).toEqual([]);
    expect((await call(jonas, 'GET', '/api/work/recent')).json.events.length).toBeGreaterThan(0);
    expect((await call(jonas, 'GET', '/api/vault/tree')).status).toBe(404);
  });

  it('the Blueprint: granted projects only, proposals only when routed, export needs may_export', async () => {
    expect((await call(ana, 'GET', '/api/projects')).json.projects.map((p: any) => p.id)).toEqual([seed.CNV.project]);
    // The member Home's Papers card reads the papers each listed project carries: only the granted project's.
    expect((await call(ana, 'GET', '/api/projects')).json.projects.flatMap((p: any) => p.papers.map((x: any) => x.title))).toEqual(['zzCNV paper']);
    expect((await call(ana, 'GET', `/api/projects/${seed.CNV.project}/blueprint`)).text).toContain('zzCNV requirement');
    expect((await call(ana, 'GET', `/api/projects/${seed.CNV.project}/items/FR-CNVA-01`)).json.item.key).toBe('FR-CNVA-01');
    expect((await call(ana, 'GET', `/api/projects/${seed.CNV.project}/proposals`)).json).toMatchObject({ proposals: [], total: 0 });
    const att = (await call(ana, 'GET', '/api/blueprint/attention')).json;
    expect([att.items, att.counts.proposals]).toEqual([[], 0]);
    const routedElsewhere = await call(ana, 'POST', `/api/proposals/${seed.CNV.proposals[0]}/reject`, {});
    const unknown = await call(ana, 'POST', '/api/proposals/bpp_nope/reject', {});
    expect([routedElsewhere.status, routedElsewhere.text]).toEqual([unknown.status, unknown.text]);
    expect((await call(ana, 'GET', `/api/projects/${seed.CNV.project}/export.md`)).json.error).toBe('export_denied');
    expect((await call(jonas, 'GET', '/api/projects')).json.projects.map((p: any) => p.id)).toEqual([seed.BRZ.project]);
    expect((await call(jonas, 'GET', `/api/projects/${seed.BRZ.project}/summary`)).status).toBe(200);
    // Jonas has no tasks component: an item's linked tasks are left out.
    expect((await call(jonas, 'GET', `/api/projects/${seed.BRZ.project}/items/FR-BRZA-01`)).json.tasks).toEqual({ items: [], done: 0, total: 0 });
    // No console user id in any member Blueprint answer: the admin wrote the items, so labels read plain "operator".
    const adminId = (app.db.prepare("SELECT id FROM admin_users WHERE username='admin'").get() as { id: string }).id;
    for (const [who, k] of [[ana, 'CNV'], [jonas, 'BRZ']] as const) {
      for (const r of [...MEMBER_READY].filter((x) => /^GET \/api\/(projects|blueprint)/.test(x))) {
        const x = await call(who, 'GET', fill(r, k));
        expect(`${r} ${x.status} ${x.text.includes(adminId) ? 'has the admin id' : ''}`).toBe(`${r} ${x.status} `);
      }
    }
    expect((await call(jonas, 'GET', `/api/projects/${seed.BRZ.project}/items/FR-BRZA-01`)).json.item.created_by).toBe('operator');
    expect((await call(admin, 'GET', `/api/projects/${seed.BRZ.project}/items/FR-BRZA-01`)).json.item.created_by).toBe(`operator:${adminId}`);
    // The admin still sees both projects and every proposal.
    expect((await call(admin, 'GET', '/api/blueprint/attention')).json.counts.proposals).toBe(2);
  });

  it('a file moved into the grant from a restricted folder: its old revisions are not readable through diff or revisions', async () => {
    const who = { agentId: seed.CNV.agents[0]!, credentialId: null as never };
    const old = await app.store.write(['Projects', 'Conclave', 'Restricted', 'moved.md'], Buffer.from('zzRESTRICTED old content\n'), 'absent', 'create', who);
    // v1 exists only in the restricted folder; v2 is what gets moved into the grant.
    const v2 = await app.store.write(['Projects', 'Conclave', 'Restricted', 'moved.md'], Buffer.from('cleaned up\n'), old.revision, 'update', who);
    const moved = await app.store.rename(['Projects', 'Conclave', 'Restricted', 'moved.md'], ['Projects', 'Conclave', 'moved.md'], v2.revision, who as never);
    const edited = await app.store.write(['Projects', 'Conclave', 'moved.md'], Buffer.from('public now\n'), moved.revision, 'update', who);
    const f = app.store.fileByPath('Projects/Conclave/moved.md')!;
    const unknown = await call(ana, 'GET', `/api/vault/diff?file=${f.id}&from=sha256:${'0'.repeat(64)}`);
    const hidden = await call(ana, 'GET', `/api/vault/diff?file=${f.id}&from=${old.revision}&to=${edited.revision}`);
    expect(hidden.text).not.toContain('zzRESTRICTED');
    expect([hidden.status, hidden.text]).toEqual([unknown.status, unknown.text]);
    // The moved revision (v2) has the same content at a visible path now, so it is visible.
    const visible = await call(ana, 'GET', `/api/vault/diff?file=${f.id}&from=${moved.revision}&to=${edited.revision}`);
    expect(visible.status).toBe(200);
    expect((await call(ana, 'GET', `/api/vault/revisions/${f.id}`)).text).not.toContain('Restricted');
    // The admin still sees it all.
    expect((await call(admin, 'GET', `/api/vault/diff?file=${f.id}&from=${old.revision}&to=${edited.revision}`)).text).toContain('zzRESTRICTED');
  });

  it('a grant revoked mid-session filters the next call', async () => {
    const id = (app.db.prepare("SELECT id FROM admin_users WHERE username='ana'").get() as { id: string }).id;
    await call(admin, 'PUT', `/api/users/${id}/grants`, { grants: [] });
    expect((await call(ana, 'GET', '/api/teams')).json.teams).toEqual([]);
    expect((await call(ana, 'GET', `/api/teams/${seed.CNV.teams[0]}`)).status).toBe(404);
    expect((await call(ana, 'GET', '/api/work/recent')).json).toMatchObject({ events: [], total: 0 });
  });
});
