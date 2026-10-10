import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey: string, cappedKey: string;
const clients: Client[] = [];
type Rule = { effect: 'allow' | 'deny'; actions: string[]; resource: string };
const ALL: Rule[] = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'allow', actions: ['fs.*'], resource: 'path:/vault/**' }, { effect: 'allow', actions: ['graph.*'], resource: 'graph:vault' }];
const DENY: Rule = { effect: 'deny', actions: ['fs.*'], resource: 'path:/vault/Private/**' };
async function connect(secret: string, key = appKey) {
  const c = new Client({ name: 'security-fixture', version: '1' }); clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const login = await c.callTool({ name: 'session_login', arguments: { session_key: secret } });
  const token = login.structuredContent!.session_token;
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: { session_token: token, ...args } });
    return { error: r.isError, data: r.structuredContent as Record<string, any> };
  };
}
async function agent(label: string, restricted = false) {
  const a = app.keys.createAgent(label, null, sys), key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  app.keys.setRules(key.credential.policy_id, [...ALL, ...(restricted ? [DENY] : [])], 'fixture', sys);
  return { id: a.id, key, call: await connect(key.secret) };
}
type Agent = Awaited<ReturnType<typeof agent>>;
let curator: Agent, reader: Agent, reviewer: Agent;
const f = (path: string) => app.store.fileByPath(path)!;
const put = async (a: Agent, path: string, content: string) => {
  const current = f(path)?.current_revision ?? 'absent';
  return app.store.write(path.split('/'), Buffer.from(content), current, current === 'absent' ? 'create' : 'update', { agentId: a.id, credentialId: a.key.credential.id });
};
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-graph-security-')), vaultDir = join(root, 'vault'); mkdirSync(vaultDir);
  app = await buildApp({ dataDir: join(root, 'data'), dbFile: join(root, 'data', 't.db'), vaultDir, vaultAlias: 'vault', host: '127.0.0.1', port: 0,
    pepper: 'fixture', publicUrl: 'http://fixture.test', production: false, adminUsername: 'admin', adminPassword: 'fixture password', publicDir: join(process.cwd(), 'public'),
    logLevel: 'silent', allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0, graph: { debounceMs: 0, verifyRate: 0 } });
  await app.store.ready; await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const pc = app.keys.createMachine('fixture', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'test', maxLiveSessions: 100 }, sys).secret;
  const cap = app.keys.createAppKey({ machineId: pc.id, appName: 'capped', maxLiveSessions: 100 }, sys);
  app.keys.setRules(cap.credential.policy_id, [...ALL, DENY], 'fixture', sys); cappedKey = cap.secret;
  curator = await agent('curator'); reader = await agent('restricted', true); reviewer = await agent('reviewer');
  const coordinator = await agent('coordinator');
  const team = app.teams.create({ name: 'Mixed permissions', goal: 'security fixture', members: [{ agent_id: coordinator.id, role: 'coordinator' }, { agent_id: curator.id, role: 'curator' }, { agent_id: reader.id, role: 'worker' }, { agent_id: reviewer.id, role: 'reviewer' }] }, sys);
  app.teams.start(team.id, sys);
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('graph source boundaries over MCP', () => {
  it('redacts cause-derived flag details and durable task/notice data under a different app cap', async () => {
    await put(reader, 'Public.md', '# Public\nPublic fact.');
    await put(curator, 'Private/Secret.md', '# Secret\nSECRET-CANARY merger.');
    const raised = await curator.call('graph_flag', { path: '/vault/Public.md', cause_path: '/vault/Private/Secret.md', kind: 'stale', reason: 'SECRET-CANARY merger changes this public fact' });
    const id = raised.data.flag_id;
    const capped = await connect(curator.key.secret, cappedKey);
    expect((await capped('file_read', { path: '/vault/Private/Secret.md' })).error).toBe(true);
    for (const call of [reader.call, capped]) {
      const result = await call('graph_stale');
      const flag = result.data.flags.find((x: any) => x.id === id);
      expect(flag).toMatchObject({ cause_path: null, cause_revision: null, evidence_claims: [] });
      for (const name of ['graph_stale', 'task_list', 'session_whoami', 'work_next']) {
        const text = JSON.stringify(await call(name));
        expect(text).not.toContain('SECRET-CANARY'); expect(text).not.toContain('Private/Secret.md');
      }
    }
    expect((await curator.call('graph_stale')).data.flags.find((x: any) => x.id === id).reason).toContain('SECRET-CANARY');
    const resolved = await capped('graph_resolve', { flag_id: id, status: 'dismissed' });
    expect(resolved.error).toBeFalsy();
    expect(JSON.stringify(resolved)).not.toContain('SECRET-CANARY');
    expect(JSON.stringify(resolved)).not.toContain('Private/');
  });

  it('private-only changes cannot change restricted graph health', async () => {
    const before = (await reader.call('graph_health')).data;
    await put(curator, 'Private/Other.md', '# Other\nPrivate-only facts.');
    await curator.call('graph_flag', { path: '/vault/Private/Other.md', kind: 'contradiction', reason: 'private change' });
    expect((await reader.call('graph_health')).data).toEqual(before);
  });

  it('community jobs, summaries and merge jobs exclude unsupported private entity names', async () => {
    app.db.prepare("INSERT INTO kg_entities(id,name,created_at) VALUES ('sec_pub','Public Entity',0),('sec_private','SECRET-ENTITY',0)").run();
    app.db.prepare("INSERT INTO kg_communities VALUES ('com_security',0,?,0,'h')").run(JSON.stringify(['sec_pub', 'sec_private']));
    const insert = app.db.prepare("INSERT INTO kg_claims(id,subject_id,predicate,text,src_file,src_anchor,src_rev,quote,quote_hash,recorded_at,status,confidence) VALUES (?,?,'is','fixture',?,'',?,'fixture','h',0,'accepted',1)");
    insert.run('sec_claim_public', 'sec_pub', f('Public.md').id, f('Public.md').current_revision);
    insert.run('sec_claim_private', 'sec_private', f('Private/Secret.md').id, f('Private/Secret.md').current_revision);
    const w = { agentId: reader.id, credId: reader.key.credential.id, tokenHash: '', rules: app.keys.rulesFor(reader.key.credential.id), cap: [] };
    const built = (app.graph.ext as any).buildCommunity({ id: 'sec_job', scope_ref: 'com_security', tier: 'strong' }, w);
    expect(JSON.stringify(built)).not.toContain('SECRET-ENTITY');
    expect((app.graph.ext as any).buildMerge({ id: 'sec_merge', scope_ref: 'sec_pub|sec_private', tier: 'light' }, w)).toBeNull();
    app.db.prepare("INSERT INTO kg_summaries(id,scope,scope_ref,text,source_revs_hash,source_files,status,created_at) VALUES ('sec_sum','community','com_security','Public summary','h',?,'current',0)").run(JSON.stringify([f('Public.md').id]));
    const summary = await reader.call('graph_summary', { scope: 'community', ref: 'com_security' });
    expect(summary.data.summary).toBe('Public summary'); expect(JSON.stringify(summary)).not.toContain('SECRET-ENTITY');
    app.db.prepare("INSERT INTO kg_merge_proposals(id,keep_id,drop_id,state,reason,proposed_by,created_at) VALUES ('kmp_security','sec_pub','sec_private','pending','private proposal',?,0)").run(curator.id);
    expect((await reader.call('graph_decide', { id: 'kmp_security', decision: 'approve' })).data.error).toBe('not_found');
  });

  it('incomplete and mixed-invalid impact verdicts remain leased until every candidate is valid', async () => {
    const extra = { file_id: f('Public.md').id, revision: f('Public.md').current_revision, changed_claims: [], cands: {
      c1: { file_id: f('Public.md').id, anchor: '', text: 'Public fact.', claim_ids: [] }, c2: { file_id: f('Private/Secret.md').id, anchor: '', text: 'SECRET-CANARY merger.', claim_ids: [] } } };
    app.db.prepare("INSERT INTO kg_jobs(id,type,priority,tier,scope_ref,input_json,dedupe_key,state,leased_by,lease_until,created_at,updated_at) VALUES ('sec_impact','impact_check',1,'strong',?,?,'sec_impact','leased',?,?,0,0)").run(f('Public.md').id, JSON.stringify({ ext: true, extra, files: [f('Public.md').id, f('Private/Secret.md').id] }), curator.id, Date.now() + 60000);
    const submit = (verdicts: unknown[]) => curator.call('graph_job_submit', { job_id: 'sec_impact', payload: { verdicts } });
    expect((await submit([{ candidate: 'c1', verdict: 'ok' }])).data).toMatchObject({ verdict: 'partial', job_state: 'leased' });
    expect((await submit([{ candidate: 'c1', verdict: 'ok' }, { candidate: 'c2', verdict: 'stale', reason: 'bad', quote: 'not in source' }])).data).toMatchObject({ verdict: 'partial', job_state: 'leased' });
    expect((await submit([{ candidate: 'c1', verdict: 'ok' }, { candidate: 'c2', verdict: 'ok' }])).data).toMatchObject({ verdict: 'accepted', job_state: 'done' });
  });

  it('an authorized independent reviewer can approve a one-sided contradiction fix; a capped reviewer cannot', async () => {
    const worker = await agent('fix-worker');
    const team = app.teams.teamsOf(curator.id)[0]!;
    app.teams.addMember(team.id, { agent_id: worker.id, role: 'worker' }, sys);
    await put(worker, 'Fix.md', '# Fact\nThe price is 10.');
    await put(curator, 'Private/Authority.md', '# Fact\nThe price is 12.');
    const a = app.graph.ext.raiseFlag({ fileId: f('Fix.md').id, anchor: 'fact', causeFile: f('Private/Authority.md').id, causeRev: f('Private/Authority.md').current_revision!, kind: 'contradiction', reason: 'different prices', raisedBy: curator.id })!;
    const b = app.graph.ext.raiseFlag({ fileId: f('Private/Authority.md').id, anchor: 'fact', causeFile: f('Fix.md').id, causeRev: f('Fix.md').current_revision!, kind: 'contradiction', reason: 'different prices', raisedBy: curator.id })!;
    const taskId = (app.db.prepare('SELECT task_id FROM kg_flags WHERE id=?').get(a) as any).task_id;
    expect((app.db.prepare('SELECT task_id FROM kg_flags WHERE id=?').get(b) as any).task_id).toBe(taskId);
    expect((await worker.call('task_start', { task_id: taskId })).error).toBeFalsy();
    await put(worker, 'Fix.md', '# Fact\nThe price is 12.');
    expect((await worker.call('task_submit', { task_id: taskId, summary: 'Aligned the public price with the authority.' })).error).toBeFalsy();
    const capped = await connect(reviewer.key.secret, cappedKey);
    expect((await capped('task_review', { task_id: taskId, decision: 'approve', comments: 'Looks fine' })).data.error).toBe('denied');
    expect((app.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as any).status).toBe('in_review');
    expect((await reviewer.call('task_review', { task_id: taskId, decision: 'approve', comments: 'Read both sources; corrected side is accurate.' })).error).toBeFalsy();
    expect((app.db.prepare('SELECT status FROM kg_flags WHERE id=?').get(a) as any).status).toBe('fixed');
    expect((app.db.prepare('SELECT status FROM kg_flags WHERE id=?').get(b) as any).status).toBe('fixed');
  });
});
