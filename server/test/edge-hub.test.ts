/**
 * Regression coverage for design/15. Former expected failures now assert supported behavior.
 * E-04 intentionally retains delivered-input charges; lease retries must not evade budgets.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Who } from '../src/teams/teams.js';

const sys = { kind: 'system' as const, id: null };
let app: App;
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const ALL: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update'], resource: 'path:/vault/**' }];
const PUB: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Pub/**' }];
type A = { id: string; cred: string };

function mk(label: string, rules: Rules): A {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, ...rules], 'test', sys);
  return { id: agent.id, cred: k.credential.id };
}
const who = (a: A): Who => ({ agentId: a.id, credId: a.cred, tokenHash: `th_${a.id}`, rules: app.keys.rulesFor(a.cred), cap: [] });
const sess = (a: A) => ({ agentId: a.id, rules: app.keys.rulesFor(a.cred), cap: [] });
const put = async (a: A, path: string, text: string) => {
  const rel = path.split('/');
  const cur = app.store.fileByPath(path)?.current_revision ?? 'absent';
  return (await app.store.write(rel, Buffer.from(text, 'utf8'), cur, cur === 'absent' ? 'create' : 'update', { agentId: a.id, credentialId: a.cred })).revision;
};
/** Next non-notice item (notices acked on the way). */
async function next(a: A): Promise<any> {
  for (let i = 0; i < 30; i++) {
    const r = await app.teams.workNext(who(a), 0);
    if (r.status === 'item' && r.item!.kind === 'notice') { app.teams.workAck(who(a), r.item!.item_id as string); continue; }
    return r;
  }
  throw new Error('too many notices');
}
const clearJobs = () => app.db.prepare("UPDATE kg_jobs SET state='done', leased_by=NULL WHERE state IN ('queued','leased')").run();
const fid = (path: string) => app.store.fileByPath(path)!.id;

let C: A, K1: A, K2: A, WK: A, R: A, RD: A, teamId = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahedge-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0,
    graph: { debounceMs: 0, verifyRate: 0 },
  };
  app = await buildApp(config);
  await app.store.ready;
  C = mk('coord', []); K1 = mk('cur-1', ALL); K2 = mk('cur-2', ALL); WK = mk('worker', ALL); R = mk('reviewer', ALL); RD = mk('pub-reader', PUB);
  const t = app.teams.create({ name: 'Edge', goal: 'edge cases', members: [{ agent_id: C.id, role: 'coordinator' }, { agent_id: K1.id, role: 'curator' }, { agent_id: K2.id, role: 'curator' }, { agent_id: WK.id, role: 'worker' }, { agent_id: R.id, role: 'reviewer' }] }, sys);
  app.teams.start(t.id, sys);
  teamId = t.id;
});
afterAll(async () => { await app.close(); });

describe('job queue (problem 1, E-01..E-05)', () => {
  it('E-01 one note has at most one live index job (a write during a lease must not create a second lease holder)', async () => {
    clearJobs();
    await put(WK, 'Q1/A.md', '## One\n\nFirst text of note A.\n');
    const r = await next(K1);
    expect(r.item.job_type).toBe('index_note');
    await put(WK, 'Q1/A.md', '## One\n\nSecond text of note A, changed.\n');
    const live = (app.db.prepare("SELECT COUNT(*) n FROM kg_jobs WHERE scope_ref=? AND type='index_note' AND state IN ('queued','leased')").get(fid('Q1/A.md')) as { n: number }).n;
    expect(live).toBeLessThanOrEqual(1);
  });

  it('E-02 a re-delivered batch never lists member jobs that are already done', async () => {
    clearJobs();
    for (const n of ['a', 'b', 'c']) await put(WK, `Q2/${n}.md`, `## Part\n\nSmall note ${n} text.\n`);
    const first = await next(K1);
    const member = first.item.input.batch[0].job_id as string;
    expect(app.graph.submit(K1.id, member, {}).job_state).toBe('done');
    const again = await next(K1);
    expect(again.item.job_id).toBe(first.item.job_id);
    expect(again.item.input.batch.map((b: any) => b.job_id)).not.toContain(member);
  });

  it('E-03 a submit after the lease was swept says lease_expired, not "no such job"', async () => {
    clearJobs();
    await put(WK, 'Q3/A.md', '## One\n\nLease test note.\n');
    const r = await next(K1);
    app.db.prepare('UPDATE kg_jobs SET lease_until=? WHERE id=?').run(Date.now() - 1, r.item.job_id);
    await next(K2);                                           // any curator's work_next sweeps and may re-lease it
    let code = '';
    try { app.graph.submit(K1.id, r.item.job_id, {}); } catch (e) { code = (e as { code: string }).code; }
    expect(code).toBe('lease_expired');
  });

  it('E-04 delivered inputs remain charged after expiry so retries cannot evade budgets', async () => {
    clearJobs();
    app.graph.setBudget('vault', '', 'hour', 1_000_000, null);
    await put(WK, 'Q4/A.md', '## One\n\nBudget test note with some words.\n');
    const used = () => (app.db.prepare("SELECT used_tokens u FROM kg_budgets WHERE scope='vault' AND scope_ref='' AND period='hour'").get() as { u: number }).u;
    const r = await next(K1);
    const once = used();
    app.db.prepare('UPDATE kg_jobs SET lease_until=? WHERE id=?').run(Date.now() - 1, r.item.job_id);
    await next(K1);                                           // swept, then leased again
    const twice = used();
    app.db.prepare("DELETE FROM kg_budgets WHERE scope='vault'").run();
    expect(once).toBeGreaterThan(0);
    expect(twice).toBeGreaterThan(once);
  });

  it('E-05 work_ack after graph_job_submit is a no-op (the extra call can be dropped)', async () => {
    clearJobs();
    await put(WK, 'Q5/A.md', '## One\n\nAck test note.\n');
    const r = await next(K1);
    for (const id of [r.item.job_id, ...(r.item.input.batch ?? []).map((b: any) => b.job_id)]) app.graph.submit(K1.id, id, {});
    expect(app.teams.workAck(who(K1), r.item.item_id)).toEqual({ acked: true, already: true });
  });
});

describe('flags and fix tasks (problem 7, E-10..E-13)', () => {
  it('E-10 a whole-note flag and a section flag for the same cause give one fix task', async () => {
    await put(WK, 'F1/Cause.md', '## Price\n\nThe price is 10.\n');
    await put(WK, 'F1/Note.md', '## Price\n\nWe charge 10.\n');
    const base = { fileId: fid('F1/Note.md'), causeFile: fid('F1/Cause.md'), causeRev: 'x', kind: 'stale' as const, reason: 'price changed', raisedBy: K1.id };
    app.graph.ext.raiseFlag({ ...base, anchor: null });
    app.graph.ext.raiseFlag({ ...base, anchor: 'price' });
    const n = (app.db.prepare("SELECT COUNT(DISTINCT task_id) n FROM kg_flags WHERE file_id=? AND status='open'").get(fid('F1/Note.md')) as { n: number }).n;
    expect(n).toBe(1);
  });

  it('E-11 approving the fix task closes its flag', async () => {
    await put(WK, 'F2/Cause.md', '## Price\n\nThe price is 12.\n');
    await put(WK, 'F2/Note.md', '## Price\n\nWe charge 10.\n');
    const flag = app.graph.ext.raiseFlag({ fileId: fid('F2/Note.md'), anchor: 'price', causeFile: fid('F2/Cause.md'), causeRev: 'x', kind: 'stale', reason: 'price changed', raisedBy: K1.id })!;
    const taskId = (app.db.prepare('SELECT task_id t FROM kg_flags WHERE id=?').get(flag) as { t: string }).t;
    expect(app.teams.task(taskId)!.assignee_agent_id).toBe(WK.id);
    app.teams.start_task(who(WK), taskId);
    await put(WK, 'F2/Note.md', '## Price\n\nWe charge 12.\n');
    app.teams.submit(who(WK), { task_id: taskId, summary: 'updated' });
    app.teams.review(who(R), { task_id: taskId, decision: 'approve', comments: 'ok' });
    expect((app.db.prepare('SELECT status s FROM kg_flags WHERE id=?').get(flag) as { s: string }).s).toBe('fixed');
  });

  it('E-12 "fixed" needs a change to the flagged section, not any new revision', async () => {
    await put(WK, 'F3/Cause.md', '## Price\n\nThe price is 15.\n');
    await put(WK, 'F3/Note.md', '## Price\n\nWe charge 10.\n\n## Other\n\nUnrelated.\n');
    const flag = app.graph.ext.raiseFlag({ fileId: fid('F3/Note.md'), anchor: 'price', causeFile: fid('F3/Cause.md'), causeRev: 'x', kind: 'stale', reason: 'price changed', raisedBy: K1.id })!;
    await put(WK, 'F3/Note.md', '## Price\n\nWe charge 10.\n\n## Other\n\nUnrelated, edited.\n');
    expect(() => app.graph.ext.resolveFlag(flag, WK.id, 'fixed')).toThrow();
  });

  it('E-13 one agent never both proposes an invalidation and decides it (curator in one team, reviewer in another)', async () => {
    await put(WK, 'F4/Fact.md', '## Fact\n\nThe Brisa weighs 2 kg.\n');
    const rep = await app.graph.upsert(K1.id, 'F4/Fact.md', { entities: [{ name: 'Brisa' }], claims: [{ subject: 'Brisa', predicate: 'weight', object_text: '2 kg', text: 'The Brisa weighs 2 kg', anchor: 'fact', quote: 'The Brisa weighs 2 kg', confidence: 0.9 }] });
    const claim = rep.claim_ids[0]!;
    app.graph.ext.invalidate(K2.id, claim, 'wrong');
    expect(() => app.graph.ext.decide(K2.id, claim, 'invalidate')).toThrow();
  });
});

describe('Private leaks (problem 2, E-20..E-23)', () => {
  let flagged = false;
  beforeAll(async () => {
    await put(WK, 'Private/HR.md', '## Salary\n\nAna Silva salary is 90000 euros per year.\n');
    await put(WK, 'Pub/Team.md', '## Salary\n\nAna Silva salary is 50000 euros per year.\n');
    const claim = (v: string) => ({ subject: 'Ana Silva', predicate: 'salary', object_text: `${v} euros`, text: `Ana Silva earns ${v} euros per year`, anchor: 'salary', quote: `Ana Silva salary is ${v} euros per year`, confidence: 0.9 });
    await app.graph.upsert(K1.id, 'Private/HR.md', { entities: [{ name: 'Ana Silva', description: 'Employee on the 2027 exit list' }], claims: [claim('90000')] });
    await app.graph.upsert(K1.id, 'Pub/Team.md', { entities: [{ name: 'Ana Silva' }], claims: [claim('50000')] });
    flagged = !!app.db.prepare("SELECT 1 FROM kg_flags WHERE file_id=? AND kind='contradiction'").get(fid('Pub/Team.md'));
  });

  it('setup: the hub raised a contradiction flag on the public note, the public reader sees it', () => {
    expect(flagged).toBe(true);
    expect(app.graph.ext.staleFor(sess(RD), {}).length).toBeGreaterThan(0);
  });

  it('E-20 graph_stale never shows a Private claim to a reader who cannot read the cause note', () => {
    const flags = app.graph.ext.staleFor(sess(RD), {});
    expect(JSON.stringify(flags)).not.toContain('90000');
  });

  it('E-21 a hub fix task never names a cause note the team cannot all read', () => {
    const t = app.db.prepare("SELECT k.description d FROM kg_flags f JOIN tasks k ON k.id=f.task_id WHERE f.file_id=? AND f.kind='contradiction'").get(fid('Pub/Team.md')) as { d: string };
    expect(t.d).not.toContain('Private/');
    expect(t.d).not.toContain('90000');
  });

  it('E-22 graph_query never returns an entity description written from a note the reader cannot read', () => {
    const q = app.graph.query(sess(RD), { entity: 'Ana Silva' });
    expect(q.claims.length).toBeGreaterThan(0);
    expect(JSON.stringify(q.entities)).not.toContain('exit list');
  });

  it('E-23 one contradiction gives one fix task, not one per side', () => {
    const n = (app.db.prepare("SELECT COUNT(DISTINCT task_id) n FROM kg_flags WHERE kind='contradiction' AND file_id IN (?,?)").get(fid('Pub/Team.md'), fid('Private/HR.md')) as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe('team roles and membership (E-30)', () => {
  it('E-30 removing the reviewer of a task in review hands the review to another reviewer or reopens it', () => {
    const C2 = mk('c2', []), W2 = mk('w2', ALL), R2 = mk('r2', ALL), R3 = mk('r3', ALL);
    const t = app.teams.create({ name: 'Two', goal: 'g', members: [{ agent_id: C2.id, role: 'coordinator' }, { agent_id: W2.id, role: 'worker' }, { agent_id: R2.id, role: 'reviewer' }, { agent_id: R3.id, role: 'reviewer' }] }, sys);
    app.teams.start(t.id, sys);
    const task = app.teams.create_task(who(C2), { team_id: t.id, title: 'x', reviewer: R2.id });
    app.teams.assign(who(C2), { task_id: task.id, agent_id: W2.id });
    app.teams.start_task(who(W2), task.id);
    app.teams.submit(who(W2), { task_id: task.id, summary: 'done' });
    app.teams.removeMember(t.id, R2.id, sys);
    const k = app.teams.task(task.id)!;
    expect(k.status === 'in_review' && k.reviewer_agent_id === R2.id).toBe(false);
  });
});

describe('20+ curators, one queue (E-40)', () => {
  it('E-40 jobs a curator may not read never starve the ones it may read (queue scan stops at 100 rows)', async () => {
    clearJobs();
    const KP = mk('cur-pub', PUB);
    app.teams.addMember(teamId, { agent_id: KP.id, role: 'curator' }, sys);
    for (let i = 0; i < 101; i++) await put(WK, `Hidden/N${i}.md`, `## S\n\nHidden note ${i}.\n`);
    await put(WK, 'Pub/Open.md', '## S\n\nA public note.\n');
    const r = await next(KP);
    expect(r.status).toBe('item');
  });
});
