/** Keys are per project (docs/blueprint.md §3): two projects with an M14, an agent in teams of both, event-time project (0119). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Op, ProjectRow } from '../src/blueprint/blueprint.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const op = { kind: 'operator' as const, id: 'adm_1' };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', appKey = '';
let X: Call, Y: Call, teamA = '', teamB = '', teamC = '', PA: ProjectRow, PB: ProjectRow;
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const errCode = (r: Res) => (r.isError ? /^(\w+)/.exec(text(r))?.[1] ?? 'error' : 'ok');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const put = (p: ProjectRow, ops: Op[]) => app.blueprint.write(p.id, { version: app.blueprint.project(p.id)!.version, ops }, op);
const ver = (p: ProjectRow) => app.blueprint.project(p.id)!.version;

async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbpk-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const { cookie, csrf } = await adminLogin(base);
  const pc = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  // x coordinates a team in each of two projects; y is in a live team of one project and an ended team of another.
  const x = agent('coord-x'), y = agent('coord-y');
  teamA = app.teams.create({ name: 'Harbour Survey', goal: 'g', members: [{ agent_id: x.id, role: 'coordinator', credential_id: x.cred }, { agent_id: y.id, role: 'coordinator', credential_id: y.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tide Gauges', goal: 'g', members: [{ agent_id: x.id, role: 'coordinator', credential_id: x.cred }] }, sys).id;
  teamC = app.teams.create({ name: 'Old Moorings', goal: 'g', members: [{ agent_id: y.id, role: 'coordinator', credential_id: y.cred }] }, sys).id;
  for (const t of [teamA, teamB, teamC]) app.teams.start(t, sys);
  app.db.prepare("UPDATE teams SET status='stopped' WHERE id=?").run(teamC);
  PA = app.blueprint.projectOfTeam(teamA)!; PB = app.blueprint.projectOfTeam(teamB)!;
  expect(PA.id).not.toBe(PB.id);
  // Both projects have an M14, with different titles, and a module each team owns.
  put(PA, [{ op: 'upsert', kind: 'milestone', key: 'M14', title: 'Survey charts issued' }, { op: 'upsert', kind: 'module', key: 'SRV', title: 'Survey', team_id: teamA }]);
  put(PB, [{ op: 'upsert', kind: 'milestone', key: 'M14', title: 'Gauges calibrated' }, { op: 'upsert', kind: 'module', key: 'TIDE', title: 'Tides', team_id: teamB }]);
  X = await session(x.secret); Y = await session(y.secret);
});
afterAll(async () => { await app?.close(); });

describe('keys resolve per project (§3)', () => {
  it('an agent whose live teams span two projects must name one; the refusal lists both', async () => {
    const r = await X('bp_read', { keys: ['M14'] });
    expect(errCode(r)).toBe('invalid_argument');
    expect(text(r)).toContain(PA.key);
    expect(text(r)).toContain(PB.key);
    const w = await X('bp_write', { version: ver(PB), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-TIDE-01', parent_key: 'TIDE', title: 'Gauge drift is logged' }] });
    expect(errCode(w)).toBe('invalid_argument');
    expect(app.blueprint.item(PB.id, 'FR-TIDE-01')).toBeFalsy();
  });

  it('with project, the same key M14 reads the item of that project', async () => {
    const a = ok(await X('bp_read', { project: PA.key, keys: ['M14'] }));
    const b = ok(await X('bp_read', { project: PB.key, keys: ['M14'] }));
    expect(a.items.map((i: { title: string }) => i.title)).toEqual(['Survey charts issued']);
    expect(b.items.map((i: { title: string }) => i.title)).toEqual(['Gauges calibrated']);
    // team_id names its project too.
    expect(ok(await X('bp_read', { team_id: teamB, keys: ['M14'] })).items[0].title).toBe('Gauges calibrated');
  });

  it('a write with project lands only in that project', async () => {
    const w = ok(await X('bp_write', { project: PB.key, version: ver(PB), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-TIDE-01', parent_key: 'TIDE', title: 'Gauge drift is logged' }] }));
    expect(w.status).toBe('applied');
    expect(app.blueprint.item(PB.id, 'FR-TIDE-01')).toMatchObject({ team_id: teamB });
    expect(app.blueprint.item(PA.id, 'FR-TIDE-01')).toBeFalsy();
    // A key of the other project is not found in this one.
    expect(errCode(await X('bp_write', { project: PA.key, version: ver(PA), ops: [{ op: 'upsert', kind: 'ac', key: 'FR-TIDE-01/AC1', parent_key: 'FR-TIDE-01', title: 'Drift check' }] }))).toBe('invalid_argument');
  });

  it('an ended team does not make the call ambiguous', async () => {
    const r = ok(await Y('bp_read', { keys: ['M14'] }));
    expect(r.items.map((i: { title: string }) => i.title)).toEqual(['Survey charts issued']);
  });

  it('team_ask refs resolve in the team\'s project; a project that is not the team\'s is refused', async () => {
    const bad = await X('team_ask', { team_id: teamA, project: PB.key, question: 'Which datum for the charts?', refs: ['M14'] });
    expect(errCode(bad)).toBe('invalid_argument');
    expect(text(bad)).toContain(PA.key);
    const r = ok(await X('team_ask', { team_id: teamA, project: PA.key, question: 'Which datum for the charts?', refs: ['M14'] }));
    expect(r.refs).toEqual(['M14']);
    expect(app.db.prepare('SELECT project_id FROM decisions WHERE id=?').get(r.decision_id)).toEqual({ project_id: PA.id });
  });
});

describe('event-time project and refs in task history (migration 0119)', () => {
  it('adds the columns', () => {
    const cols = (t: string) => (app.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('task_events')).toEqual(expect.arrayContaining(['project_id', 'refs']));
    expect(cols('decisions')).toContain('project_id');
  });

  it('records the project and the refs with their item ids, and keeps them when the team moves', async () => {
    const t = ok(await X('task_create', { team_id: teamA, title: 'Issue the survey charts', refs: ['M14'] }));
    const id = t.task?.id ?? t.id;
    const m14 = app.db.prepare("SELECT id FROM bp_items WHERE project_id=? AND key='M14'").get(PA.id) as { id: string };
    const first = app.db.prepare('SELECT project_id, refs FROM task_events WHERE task_id=? ORDER BY id LIMIT 1').get(id) as { project_id: string; refs: string };
    expect(first.project_id).toBe(PA.id);
    expect(JSON.parse(first.refs)).toEqual([{ key: 'M14', id: m14.id }]);
    // The team moves to the other project: the old event keeps its project, a new one records the new project.
    app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(PB.id, teamA);
    try {
      const t2 = ok(await X('task_create', { team_id: teamA, title: 'Calibrate the new gauges' }));
      const id2 = t2.task?.id ?? t2.id;
      expect(app.db.prepare('SELECT project_id, refs FROM task_events WHERE task_id=? ORDER BY id LIMIT 1').get(id2)).toEqual({ project_id: PB.id, refs: null });
      expect((app.db.prepare('SELECT project_id FROM task_events WHERE task_id=? ORDER BY id LIMIT 1').get(id) as { project_id: string }).project_id).toBe(PA.id);
    } finally {
      app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(PA.id, teamA);
    }
  });
});
