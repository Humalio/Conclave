import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp, type App } from '../src/app.js';
import type { Who } from '../src/teams/teams.js';

const sys = { kind: 'system' as const, id: null };
let app: App, curator: Who, other: Who, writer: Who, teamId: string;
function agent(name: string, prefix = '/vault/**'): Who {
  const a = app.keys.createAgent(name, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: name }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['fs.*'], resource: `path:${prefix}` }], 'fixture', sys);
  return { agentId: a.id, credId: k.credential.id, tokenHash: `test-${a.id}`, rules: app.keys.rulesFor(k.credential.id), cap: [] };
}
async function write(path: string, text = `## Fact\n\nInformation about ${path}.`) {
  const old = app.store.fileByPath(path)?.current_revision ?? 'absent';
  await app.store.write(path.split('/'), Buffer.from(text), old, old === 'absent' ? 'create' : 'update', { agentId: writer.agentId, credentialId: writer.credId });
}
async function next(w = curator): Promise<any> {
  for (let i = 0; i < 30; i++) {
    const r = await app.teams.workNext(w, 0);
    if (r.item?.kind !== 'notice') return r;
    app.teams.workAck(w, r.item.item_id as string);
  }
  throw new Error('notice loop');
}
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-queue-regression-')), vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir);
  app = await buildApp({ dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 'test.db'), vaultDir, vaultAlias: 'vault', host: '127.0.0.1', port: 0, pepper: 'test', publicUrl: 'http://test', production: false, adminUsername: 'admin', adminPassword: 'fixture-password', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0, graph: { debounceMs: 0, verifyRate: 0 } });
  await app.store.ready;
  curator = agent('curator'); other = agent('other'); writer = agent('writer');
  const coord = agent('coordinator');
  const team = app.teams.create({ name: 'queue', goal: 'fixtures', members: [{ agent_id: coord.agentId, role: 'coordinator' }, { agent_id: curator.agentId, role: 'curator' }, { agent_id: other.agentId, role: 'curator' }, { agent_id: writer.agentId, role: 'worker' }] }, sys);
  teamId = team.id; app.teams.start(team.id, sys);
});
afterEach(async () => { await app.close(); });

describe('knowledge queue regression coverage', () => {
  it('a changed leased note keeps one owner, then queues only the remaining revision', async () => {
    await write('A.md', '## Fact\n\nOld fact.');
    const first = (await next()).item;
    await write('A.md', '## Fact\n\nNew fact.');
    expect((app.db.prepare("SELECT COUNT(*) n FROM kg_jobs WHERE type='index_note' AND state IN ('queued','leased')").get() as any).n).toBe(1);
    expect((await next(other)).status).toBe('idle');
    app.graph.submit(curator.agentId, first.job_id, {});
    const fresh = (await next(other)).item;
    expect(fresh.job_id).not.toBe(first.job_id);
    expect(fresh.content).toContain('New fact.');
  });

  it('redelivers only unfinished batch jobs and recovers members after leader completion without charging again', async () => {
    for (const n of ['A', 'B', 'C']) await write(`${n}.md`);
    const first = (await next()).item;
    expect(first.input.batch).toHaveLength(2);
    const done = first.input.batch[0].job_id;
    app.graph.submit(curator.agentId, done, {});
    const again = (await next()).item;
    expect(again.job_id).toBe(first.job_id);
    expect(again.input.batch.map((b: any) => b.job_id)).not.toContain(done);
    const left = again.input.batch[0].job_id;
    const used = () => (app.db.prepare("SELECT used_tokens FROM kg_budgets WHERE scope='vault'").get() as any).used_tokens;
    const before = used();
    app.graph.submit(curator.agentId, first.job_id, {});
    const pending = (await next()).item;
    expect(pending.job_id).toBe(left);
    expect(used()).toBe(before);
  });

  it('reports an expired lease to its former holder after reassignment, without revealing it to strangers', async () => {
    await write('A.md');
    const job = (await next()).item.job_id;
    app.db.prepare('UPDATE kg_jobs SET lease_until=? WHERE id=?').run(Date.now() - 1, job);
    expect((await next(other)).item.job_id).toBe(job);
    expect(() => app.graph.submit(curator.agentId, job, {})).toThrow(expect.objectContaining({ code: 'lease_expired' }));
    expect(() => app.graph.submit(writer.agentId, job, {})).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(app.graph.submit(other.agentId, job, {}).job_state).toBe('done');
  });

  it('a rejected leader leaves its children reachable by the original curator after reassignment', async () => {
    await write('A.md'); await write('B.md');
    const first = (await next()).item;
    const child = first.input.batch[0].job_id;
    expect(app.graph.submit(curator.agentId, first.job_id, null).verdict).toBe('rejected');
    expect((await next(other)).item.job_id).toBe(first.job_id);
    app.teams.touch(curator.agentId);
    expect((await next()).item.job_id).toBe(child);
    expect(app.graph.submit(curator.agentId, child, {}).job_state).toBe('done');
  });

  it('voluntary acknowledgement does not count as failure or park the job', async () => {
    await write('A.md');
    for (let i = 0; i < 4; i++) {
      const job = (await next()).item.job_id;
      app.teams.workAck(curator, job);
      expect(app.db.prepare('SELECT state, attempts FROM kg_jobs WHERE id=?').get(job)).toEqual(expect.objectContaining({ state: 'queued', attempts: 0 }));
    }
  });

  it('authenticated activity renews live leases but does not revive expired leases', async () => {
    await write('A.md');
    const job = (await next()).item.job_id, now = Date.now();
    app.db.prepare('UPDATE kg_jobs SET lease_until=? WHERE id=?').run(now + 100, job);
    app.teams.touch(curator.agentId);
    expect((app.db.prepare('SELECT lease_until FROM kg_jobs WHERE id=?').get(job) as any).lease_until).toBeGreaterThan(now + 1000);
    app.db.prepare('UPDATE kg_jobs SET lease_until=? WHERE id=?').run(now - 1, job);
    app.teams.touch(curator.agentId);
    expect((app.db.prepare('SELECT lease_until FROM kg_jobs WHERE id=?').get(job) as any).lease_until).toBe(now - 1);
  });

  it('pages past more than 100 unreadable jobs to find eligible work', async () => {
    const scoped = agent('public curator', '/vault/Public/**');
    app.teams.addMember(teamId, { agent_id: scoped.agentId, role: 'curator' }, sys);
    for (let i = 0; i < 101; i++) await write(`Private/${i}.md`);
    await write('Public/Ready.md');
    expect((await next(scoped)).item.input.path).toBe('/vault/Public/Ready.md');
  });

  it('batch reservations respect the aggregate job budget', async () => {
    app.graph.setBudget('vault', '', 'day', 100000, 2); // P2 gets 80%, so only one job.
    for (const n of ['A', 'B', 'C']) await write(`${n}.md`);
    const item = (await next()).item;
    expect(item.input.batch).toHaveLength(0);
    expect((app.db.prepare("SELECT used_jobs FROM kg_budgets WHERE scope='vault'").get() as any).used_jobs).toBe(1);
  });

  it('rechecks permissions before redelivering a held batch', async () => {
    await write('Public/A.md'); await write('Private/B.md');
    const first = (await next()).item;
    expect(first.input.batch).toHaveLength(1);
    curator.cap = [{ id: 'cap', effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Public/**' }];
    const nextItem = (await next()).item;
    expect(JSON.stringify(nextItem)).not.toContain('Private/B.md');
    expect(nextItem.input.path).toBe('/vault/Public/A.md');
  });

  it('readable claims do not expose entity descriptions from private notes', async () => {
    await write('Private/A.md', '## Fact\n\nAna works here.'); await write('Public/B.md', '## Fact\n\nAna works here.');
    const claims = [{ subject: 'Ana', predicate: 'works', text: 'Ana works here.', anchor: 'fact', quote: 'Ana works here.', confidence: 0.9 }];
    await app.graph.upsert(curator.agentId, 'Private/A.md', { entities: [{ name: 'Ana', description: 'Secret exit list' }], claims });
    await app.graph.upsert(curator.agentId, 'Public/B.md', { entities: [{ name: 'Ana' }], claims });
    const scoped = agent('reader', '/vault/Public/**');
    const result = app.graph.query(scoped, { entity: 'Ana' });
    expect(result.claims).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('Secret exit list');
  });
});
