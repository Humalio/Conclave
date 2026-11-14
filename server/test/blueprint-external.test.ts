/**
 * Outside references on Blueprint items (docs/blueprint.md §2.2 "Outside references", §3 "Outside systems", §4, §5):
 * the `external` field every kind takes ({system, id}, never a url), the project's outside systems with the operator's
 * URL templates, the `bp_read {external}` search, the reference-only right of a coordinator in its own part, and the
 * export, restore and archive carrying the field.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { BlueprintArchive } from '../src/blueprint/archive.js';
import { rulesText, DEFAULT_LIMITS } from '../src/blueprint/kinds.js';
import { checkSystems, refUrl, templateOrigin } from '../src/blueprint/external.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '', adminId = '', dir = '';
let teamA = '', teamB = '', coordA = '', workerA = '', P = '';
let CA: Call;
const opr = () => ({ kind: 'operator' as const, id: adminId });
const v = () => app.blueprint.project(P)!.version;
const put = (ops: Op[]) => app.blueprint.write(P, { version: v(), ops }, opr());
const sub = (agent: string, ops: Op[]) => {
  const r = app.blueprint.submit(P, { version: v(), ops }, agent);
  if (r.status === 'proposed') app.blueprint.rejectProposal(r.proposal.id, opr(), null);
  return r;
};
const code = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; } };
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, raw: t, body: (r.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t) as any };
};
const ext = (k: string) => { const f = app.blueprint.item(P, k, true)!.fields as unknown; return ((typeof f === "string" ? JSON.parse(f) : f) as { external?: unknown }).external; };
const setSystems = (external_systems: unknown) => api('PATCH', `/projects/${P}`, { external_systems });

async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahbpx-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 20 }, sys).secret;
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const ca = agent('coord-a'), wa = agent('worker-a'), cb = agent('coord-b');
  coordA = ca.id; workerA = wa.id;
  teamA = app.teams.create({ name: 'Signals Lab', goal: 'g', members: [{ agent_id: ca.id, role: 'coordinator', credential_id: ca.cred }, { agent_id: wa.id, role: 'worker', credential_id: wa.cred }] }, sys).id;
  teamB = app.teams.create({ name: 'Tern-9 Keepers', goal: 'g', members: [{ agent_id: cb.id, role: 'coordinator', credential_id: cb.cred }] }, sys).id;
  app.teams.start(teamA, sys); app.teams.start(teamB, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, teamB);
  put([
    { op: 'upsert', kind: 'module', key: 'FLD', title: 'Field model', team_id: teamA },
    { op: 'upsert', kind: 'module', key: 'PWR', title: 'Power', team_id: teamB },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-01', parent_key: 'FLD', title: 'Fold the field', status: 'agreed' },
    { op: 'upsert', kind: 'fr', key: 'FR-FLD-02', parent_key: 'FLD', title: 'Measure drift', status: 'dropped' },
    { op: 'upsert', kind: 'fr', key: 'FR-PWR-01', parent_key: 'PWR', title: 'Wind the coils', status: 'agreed', fields: { external: [{ system: 'tracker', id: '90048' }] } },
    { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'One field model', status: 'accepted', team_id: teamA },
  ]);
  CA = await session(ca.secret);
});
afterAll(async () => { await app?.close(); });

describe('the external field (§2.2)', () => {
  it('every kind takes {system, id}; a url, a bad system, a long id or a pair named twice is refused', () => {
    expect(ext('FR-PWR-01')).toEqual([{ system: 'tracker', id: '90048' }]);
    const w = (external: unknown) => code(() => put([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', fields: { external } }]));
    expect(w([{ system: 'tracker', id: '1', url: 'https://evil.example' }])).toMatch(/invalid_argument: .*holds only system and id, not url/);
    expect(w([{ system: 'Tracker', id: '1' }])).toMatch(/invalid_argument: .*short lower-case word/);
    expect(w([{ system: 'tracker', id: 'x'.repeat(101) }])).toMatch(/invalid_argument: .*1 to 100 characters/);
    expect(w([{ system: 'tracker', id: 'a\nb' }])).toMatch(/invalid_argument/);
    expect(w([{ system: 'tracker', id: '7' }, { system: 'tracker', id: ' 7 ' }])).toMatch(/named twice/);
    expect(w(Array.from({ length: 21 }, (_, i) => ({ system: 'pr', id: String(i) })))).toMatch(/at most 20/);
    expect(w('tracker:1')).toMatch(/must be a list/);
    // Kept as written, trimmed; an empty list removes the field.
    expect(w([{ system: 'pr', id: ' 412 ' }, { system: 'decision-log', id: 'DL-12' }])).toBe('ok');
    expect(ext('FR-FLD-01')).toEqual([{ system: 'pr', id: '412' }, { system: 'decision-log', id: 'DL-12' }]);
    put([{ op: 'upsert', kind: 'milestone', key: 'M1', title: 'Field folds', team_id: teamA, fields: { external: [{ system: 'pr', id: '9' }] } }]);
    put([{ op: 'upsert', kind: 'milestone', key: 'M1', fields: { external: [] } }]);
    expect(ext('M1')).toBeUndefined();
  });

  it('the rules name the field and the reference-only right, and the kinds list leaves it out', () => {
    const t = rulesText(DEFAULT_LIMITS);
    expect(t).toMatch(/Every kind also takes external: outside references/);
    expect(t).toMatch(/Never a link/);
    expect(t).toMatch(/outside references only .* applied whatever the status/);
    expect(t).not.toMatch(/- fr: [^\n]*external/);
  });
});

describe('outside systems in project settings (§3)', () => {
  it('the operator sets systems and https templates with {id}; anything else is refused and nothing changes', async () => {
    expect((await setSystems([{ system: 'tracker', url_template: 'http://tracker.example/{id}' }])).status).toBe(400);
    expect((await setSystems([{ system: 'tracker', url_template: 'https://tracker.example/story' }])).status).toBe(400);
    expect((await setSystems([{ system: 'tracker' }, { system: 'tracker' }])).status).toBe(400);
    expect((await setSystems([{ system: 'Bad System' }])).status).toBe(400);
    expect((await setSystems([{ system: 'pr', url: 'https://x' }])).status).toBe(400);
    expect(app.blueprint.project(P)!.external_systems ?? null).toBeNull();
    const r = await setSystems([{ system: 'tracker', url_template: 'https://tracker.example/story/{id}' }, { system: 'pr', url_template: null }, { system: 'decision-log' }]);
    expect(r.status).toBe(200);
    expect(r.body.project.external_systems).toEqual([{ system: 'tracker', url_template: 'https://tracker.example/story/{id}' }, { system: 'pr', url_template: null }, { system: 'decision-log', url_template: null }]);
    const a = app.db.prepare("SELECT details FROM audit_events WHERE action='blueprint.external_systems' ORDER BY id DESC LIMIT 1").get() as { details: string };
    expect(JSON.parse(a.details).to).toHaveLength(3);
    const n = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='project_changed' ORDER BY seq DESC LIMIT 1").get(coordA) as { body: string };
    expect(n.body).toMatch(/outside references now name only these systems: tracker, pr, decision-log/);
    // The project list carries the parsed list for the console.
    const list = (await api('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === P);
    expect(list.external_systems.map((s: { system: string }) => s.system)).toEqual(['tracker', 'pr', 'decision-log']);
  });

  it('with a list, a new reference names only those systems; one the item already holds stays and passes', async () => {
    expect(code(() => put([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', fields: { external: [{ system: 'jira', id: 'X-1' }] } }])))
      .toMatch(/invalid_argument: This project takes outside references from tracker, pr, decision-log only, not jira/);
    put([{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat', team_id: teamA, fields: { external: [{ system: 'decision-log', id: 'DL-3' }] } }]);
    expect((await setSystems([{ system: 'tracker', url_template: 'https://tracker.example/story/{id}' }, { system: 'pr' }])).status).toBe(200);
    // decision-log is off the list: RK-01 keeps DL-3 through a title edit and a new pr reference, but cannot add DL-4.
    expect(code(() => put([{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Coil heat at 80 K' }]))).toBe('ok');
    expect(code(() => put([{ op: 'upsert', kind: 'risk', key: 'RK-01', fields: { external: [{ system: 'decision-log', id: 'DL-3' }, { system: 'pr', id: '5' }] } }]))).toBe('ok');
    expect(code(() => put([{ op: 'upsert', kind: 'risk', key: 'RK-01', fields: { external: [{ system: 'decision-log', id: 'DL-4' }] } }]))).toMatch(/not decision-log/);
    const r = await api('GET', `/projects/${P}/items/RK-01`);
    expect(r.body.external).toEqual([{ system: 'decision-log', id: 'DL-3', url: null }, { system: 'pr', id: '5', url: null }]);
  });

  it('the item answer builds each link from the template with the id encoded; a system with no template has none', async () => {
    put([{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', fields: { external: [{ system: 'tracker', id: 'A/1 b?' }, { system: 'pr', id: '412' }] } }]);
    const r = await api('GET', `/projects/${P}/items/FR-FLD-01`);
    expect(r.body.external).toEqual([{ system: 'tracker', id: 'A/1 b?', url: 'https://tracker.example/story/A%2F1%20b%3F' }, { system: 'pr', id: '412', url: null }]);
    // An empty list clears the setting: any system again, and no chip is a link.
    expect((await setSystems([])).body.project.external_systems).toEqual([]);
    expect((await api('GET', `/projects/${P}/items/FR-FLD-01`)).body.external.every((x: { url: unknown }) => x.url === null)).toBe(true);
    expect((await setSystems([{ system: 'tracker', url_template: 'https://tracker.example/story/{id}' }, { system: 'pr' }])).status).toBe(200);
  });
});

describe('bp_read {external} (§5)', () => {
  it('finds the item by system:id in the whole project, every item of a system with system:*, and refuses a bad filter', async () => {
    const one = ok(await CA('bp_read', { external: 'tracker:90048' }));
    expect(one.items.map((i: { key: string }) => i.key)).toEqual(['FR-PWR-01']); // in team B's part, found from team A
    const all = ok(await CA('bp_read', { external: 'tracker:*' }));
    expect(all.items.map((i: { key: string }) => i.key).sort()).toEqual(['FR-FLD-01', 'FR-PWR-01']);
    expect(ok(await CA('bp_read', { external: 'tracker:nope' })).items).toEqual([]);
    const bad = await CA('bp_read', { external: 'Tracker 90048' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/"system:id" or "system:\*"/);
    // The admin read takes it too.
    expect((await api('GET', `/projects/${P}/blueprint?external=pr:412`)).body.items.map((i: { key: string }) => i.key)).toEqual(['FR-FLD-01']);
  });

  it('the rules name the project\'s outside systems', async () => {
    const r = ok(await CA('bp_read', { rules: true }));
    expect(r.external_systems).toEqual(['tracker', 'pr']);
    expect(r.rules).toMatch(/Outside systems of [A-Z]+: tracker, pr \(external names only these\)/);
  });
});

describe('rights: references only (§4)', () => {
  it('a coordinator changes only the references of an agreed requirement or an accepted decision in its part, with no proposal', () => {
    const before = app.db.prepare('SELECT COUNT(*) n FROM bp_proposals WHERE project_id=?').get(P) as { n: number };
    expect(sub(coordA, [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', fields: { external: [{ system: 'tracker', id: '90050' }] } }]).status).toBe('applied');
    expect(ext('FR-FLD-01')).toEqual([{ system: 'tracker', id: '90050' }]);
    expect(app.blueprint.item(P, 'FR-FLD-01')!.status).toBe('agreed');
    expect(sub(coordA, [{ op: 'upsert', kind: 'decision', key: 'ADR-001', fields: { external: [{ system: 'pr', id: '77' }] } }]).status).toBe('applied');
    // Its own dropped requirement too: the status does not matter.
    expect(sub(coordA, [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-02', fields: { external: [{ system: 'pr', id: '78' }] } }]).status).toBe('applied');
    expect((app.db.prepare('SELECT COUNT(*) n FROM bp_proposals WHERE project_id=?').get(P) as { n: number }).n).toBe(before.n);
  });

  it('with any other change, outside the part, or for a team agent, the usual rule applies', () => {
    const withTitle = sub(coordA, [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', title: 'Fold the field fast', fields: { external: [{ system: 'tracker', id: '90051' }] } }]);
    expect(withTitle.status).toBe('proposed');
    const withStatus = sub(coordA, [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', status: 'built', fields: { external: [{ system: 'tracker', id: '90051' }] } }]);
    expect(withStatus.status).toBe('proposed'); // a status move is not a reference-only write
    expect(sub(coordA, [{ op: 'upsert', kind: 'fr', key: 'FR-PWR-01', fields: { external: [{ system: 'tracker', id: '1' }] } }]).status).toBe('proposed');
    expect(sub(workerA, [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-01', fields: { external: [{ system: 'tracker', id: '2' }] } }]).status).toBe('proposed');
    expect(ext('FR-FLD-01')).toEqual([{ system: 'tracker', id: '90050' }]);
  });

  it('an archived item refuses a reference-only write too, and the archive keeps the field', () => {
    new BlueprintArchive(app.db, app.blueprint).apply(P, 'FR-FLD-02', 'archive', opr());
    expect(app.blueprint.item(P, 'FR-FLD-02', true)!.archived).toBe(1);
    expect(ext('FR-FLD-02')).toEqual([{ system: 'pr', id: '78' }]);
    expect(code(() => app.blueprint.submit(P, { version: v(), ops: [{ op: 'upsert', kind: 'fr', key: 'FR-FLD-02', fields: { external: [] } }] }, coordA))).toMatch(/is archived/);
    new BlueprintArchive(app.db, app.blueprint).apply(P, 'FR-FLD-02', 'unarchive', opr());
    expect(ext('FR-FLD-02')).toEqual([{ system: 'pr', id: '78' }]);
  });
});

describe('export and restore carry the field', () => {
  it('the JSON and Markdown exports hold it, and a restore from either puts it back', async () => {
    const json = (await api('GET', `/projects/${P}/export.json`)).raw;
    expect(JSON.parse(json).items.find((i: { key: string }) => i.key === 'FR-PWR-01').fields.external).toEqual([{ system: 'tracker', id: '90048' }]);
    const md = (await api('GET', `/projects/${P}/export.md`)).raw;
    expect(md).toMatch(/external: \[\{"system":"tracker","id":"90048"\}\]/);
    // The references change, then each export brings them back, even for decision-log, which the project no longer lists.
    put([{ op: 'upsert', kind: 'fr', key: 'FR-PWR-01', fields: { external: [] } }, { op: 'upsert', kind: 'risk', key: 'RK-01', fields: { external: [{ system: 'pr', id: '5' }] } }]);
    expect((await api('POST', `/projects/${P}/restore`, { text: json, version: v() })).status).toBe(200);
    expect(ext('FR-PWR-01')).toEqual([{ system: 'tracker', id: '90048' }]);
    expect(ext('RK-01')).toEqual([{ system: 'decision-log', id: 'DL-3' }, { system: 'pr', id: '5' }]);
    put([{ op: 'upsert', kind: 'fr', key: 'FR-PWR-01', fields: { external: [] } }]);
    const r = await api('POST', `/projects/${P}/restore`, { text: md, version: v() });
    expect(r.status).toBe(200);
    expect(ext('FR-PWR-01')).toEqual([{ system: 'tracker', id: '90048' }]);
  });
});

describe('URL templates keep a fixed https host (§3)', () => {
  it('saving refuses {id} anywhere but the path or the query, a host that is not fixed, and anything but https', async () => {
    const refused = [
      'http://tracker.example/story/{id}', // not https
      'https://{id}.tracker.example/story', // {id} in the host
      'https://tracker.example{id}/story', // {id} glued to the host
      'https://tracker.example:{id}/story', // {id} as the port
      'https://{id}@tracker.example/story', // {id} as a user name
      'https://user@tracker.example/story/{id}', // a user name at all
      'https://tracker.example/story#{id}', // {id} in the fragment
      'https://{id}', // no fixed host
      'https:///story/{id}', // no host
      'https://tracker.example/story', // no {id}
      'https://tracker.example\@evil.example/{id}', // backslash trick
      'https://tracker.example/story/{id} x', // whitespace
    ];
    for (const t of refused) {
      expect(templateOrigin(t), t).toBeNull();
      expect(() => checkSystems([{ system: 'tracker', url_template: t }]), t).toThrow(/fixed host, contain \{id\} only in the path or the query/);
      expect((await setSystems([{ system: 'tracker', url_template: t }])).status, t).toBe(400);
    }
    for (const t of ['https://tracker.example/story/{id}', 'https://tracker.example/search?q={id}&x=1', 'https://tracker.example:8443/a/{id}/b#top', 'https://tracker.example?id={id}']) {
      expect(templateOrigin(t), t).not.toBeNull();
    }
    expect(app.blueprint.project(P)!.external_systems).toContain('https://tracker.example/story/{id}'); // nothing changed
  });

  it('building a link URL-encodes the id, so no id can leave the template\'s host, path segment or query value', () => {
    const sys = [{ system: 'tracker', url_template: 'https://tracker.example/story/{id}' }, { system: 'q', url_template: 'https://tracker.example/search?q={id}&x=1' }];
    expect(refUrl({ system: 'tracker', id: '90048' }, sys)).toBe('https://tracker.example/story/90048');
    expect(refUrl({ system: 'tracker', id: '../../admin?x=1#y' }, sys)).toBe('https://tracker.example/story/..%2F..%2Fadmin%3Fx%3D1%23y');
    expect(refUrl({ system: 'tracker', id: '@evil.example' }, sys)).toBe('https://tracker.example/story/%40evil.example');
    expect(refUrl({ system: 'q', id: 'a&x=2 b' }, sys)).toBe('https://tracker.example/search?q=a%26x%3D2%20b&x=1');
    for (const id of ['//evil.example', '\\evil.example', 'javascript:alert(1)', '%2F%2Fevil']) {
      expect(new URL(refUrl({ system: 'tracker', id }, sys)!).origin).toBe('https://tracker.example');
    }
    // A stored template that fails the check today (saved some other way) gives no link at all.
    expect(refUrl({ system: 'tracker', id: 'evil' }, [{ system: 'tracker', url_template: 'https://{id}.example/' }])).toBeNull();
    expect(refUrl({ system: 'pr', id: '1' }, sys)).toBeNull();
  });
});
