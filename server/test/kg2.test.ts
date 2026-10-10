import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { lookAlike, similarNames } from '../src/graph/kg2.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', appKey = '', cookie = '', csrf = '';
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const FS_ALL = ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.history'];
const RW: Rules = [{ effect: 'allow', actions: FS_ALL, resource: 'path:/vault/**' }];
const RO: Rules = [{ effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/**' }];

async function mk(label: string, rules: Rules, modelLabel?: string) {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [...TOOLS, ...rules], 'test', sys);
  if (modelLabel) app.keys.describeSelf(agent.id, { model_label: modelLabel });
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: k.secret } })) as any).structuredContent.session_token as string;
  const call: Call = async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as never;
  return { id: agent.id, call };
}
type S = Awaited<ReturnType<typeof mk>>;
const write = async (s: S, path: string, content: string) => {
  const r = await s.call('file_create', { path, content });
  if (r.isError) throw new Error(JSON.stringify(r.structuredContent));
  return r.structuredContent.revision as string;
};
const update = async (s: S, path: string, content: string) => {
  const cur = await s.call('file_read', { path });
  const r = await s.call('file_update', { path, content, base_revision: cur.structuredContent.revision });
  if (r.isError) throw new Error(JSON.stringify(r.structuredContent));
  return r;
};
const wn = async (s: S) => {
  for (let i = 0; i < 10; i++) {
    const r = (await s.call('work_next')).structuredContent;
    if (r.status === 'item' && r.item.kind === 'notice') { await s.call('work_ack', { item_id: r.item.item_id }); continue; }
    return r;
  }
  throw new Error('too many notices');
};
/** Answer every job a curator is offered with a harmless result; returns the job types seen. */
async function drain(K: S, summary = 'A short summary.', max = 30): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const r = await wn(K);
    if (r.status !== 'item') break;
    const it = r.item;
    if (it.kind !== 'knowledge_job') { await K.call('work_ack', { item_id: it.item_id }); continue; }
    seen.push(it.job_type);
    const ids = it.job_type === 'index_note' ? [it.job_id, ...(it.input.batch ?? []).map((b: any) => b.job_id)] : [it.job_id];
    for (const id of ids) {
      const payload = it.job_type === 'index_note' ? {} : it.job_type === 'impact_check' ? { verdicts: it.input.candidates.map((c: any) => ({ candidate: c.candidate, verdict: 'ok' })) }
        : it.job_type === 'verify_sample' ? { results: it.input.claims.map((c: any) => ({ claim: c.claim, verdict: 'agree' })) }
        : it.job_type === 'entity_merge' ? { decision: 'keep_apart', reason: 'not the same' } : { summary };
      const s = await K.call('graph_job_submit', { job_id: id, payload });
      if (s.isError) throw new Error(JSON.stringify(s.structuredContent));
    }
    await K.call('work_ack', { item_id: it.item_id });
  }
  return seen;
}
const rest = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as any };
};
const noticeCount = (agentId: string) => (app.db.prepare("SELECT COUNT(*) n FROM agent_notices WHERE agent_id=? AND kind='knowledge_flag'").get(agentId) as any).n as number;

let C: S, KS: S, KV: S, KL: S, R: S, WK: S;   // coordinator, strong curator, honest light curator, "liar" light curator, reviewer, worker

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahkg2-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0,
    graph: { debounceMs: 0, verifyRate: 1, communityMinMs: 0, folderMinNotes: 2, mergeReviewClaims: 2, repMinChecked: 3 },
  };
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await r.json()) as { csrf: string }).csrf;
  const pcId = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
  app.graph.setTier('strong-*', 'strong');
  C = await mk('coord', []);
  KS = await mk('k-strong', RO, 'strong-1');
  KV = await mk('k-honest', RO, 'honest-model');
  KL = await mk('k-liar', RO, 'liar-model');
  R = await mk('reviewer', RO);
  WK = await mk('worker', RW);
  const t = app.teams.create({ name: 'Knowledge', goal: 'Curate the vault', members: [{ agent_id: C.id, role: 'coordinator' }, { agent_id: KS.id, role: 'curator' }, { agent_id: KV.id, role: 'curator' }, { agent_id: KL.id, role: 'curator' }, { agent_id: R.id, role: 'reviewer' }, { agent_id: WK.id, role: 'worker' }] }, sys);
  app.teams.start(t.id, sys);
});
afterAll(async () => { await app.close(); });

const PRICING = (cost: string) => `# Pricing\n\n## Plan\n\nThe enterprise plan costs ${cost} per seat per month for every customer.\n`;
const FAQ = (cost: string) => `# FAQ\n\n## Cost\n\nEnterprise customers pay ${cost} per seat per month, billed yearly.\n`;

describe('K3: impact_check, flags, notices, fixes only through a reviewed task', () => {
  let W: S, W2: S, flagId = '';
  it('batches small notes into one index job and a changed fact flags the note that restates it', async () => {
    W = await mk('k3-writer', RW);
    W2 = await mk('k3-writer2', RW);
    await write(W, '/vault/K3/Pricing.md', PRICING('forty dollars'));
    await write(W2, '/vault/K3/Faq.md', FAQ('forty dollars'));
    await write(W2, '/vault/K3/Other.md', '# Other\n\nGardening notes about tomatoes.\n');
    const first = (await wn(KS)).item;
    expect(first.job_type).toBe('index_note');
    const members = first.input.batch as any[];
    expect(members.length).toBe(2);                                         // three small notes, one item
    const all = [{ job_id: first.job_id, path: first.input.path }, ...members];
    const claimFor: Record<string, any> = {
      '/vault/K3/Pricing.md': { anchor: 'plan', quote: 'costs forty dollars per seat per month' },
      '/vault/K3/Faq.md': { anchor: 'cost', quote: 'pay forty dollars per seat per month' },
    };
    for (const j of all) {
      const c = claimFor[j.path];
      const payload = c ? { entities: [{ name: 'Enterprise Plan' }], claims: [{ subject: 'Enterprise Plan', predicate: 'costs', object_text: 'forty dollars per seat per month', text: 'The enterprise plan costs forty dollars per seat per month.', anchor: c.anchor, quote: c.quote, confidence: 0.9 }] } : {};
      expect((await KS.call('graph_job_submit', { job_id: j.job_id, payload })).structuredContent.verdict).toBe('accepted');
    }
    await KS.call('work_ack', { item_id: first.item_id });

    const upd = await update(W, '/vault/K3/Pricing.md', PRICING('fifty-five dollars'));
    expect(upd.structuredContent.graph_hint).toBeUndefined();               // W did not opt in
    const item = (await wn(KS)).item;
    expect(item.job_type).toBe('impact_check');
    expect(item.input.path).toBe('/vault/K3/Pricing.md');
    expect(item.input.changes[0].after).toContain('fifty-five');
    const cand = item.input.candidates.find((c: any) => c.path === '/vault/K3/Faq.md');
    expect(cand).toBeTruthy();
    expect(item.input.candidates.map((c: any) => c.path)).not.toContain('/vault/K3/Other.md');

    // no direct fixes, no invented evidence
    const fixed = await KS.call('graph_job_submit', { job_id: item.job_id, payload: { verdicts: [{ candidate: cand.candidate, verdict: 'fixed', reason: 'done' }] } });
    expect(fixed.structuredContent.verdict).toBe('rejected');
    expect(fixed.structuredContent.rejected[0].error).toContain('never edit');
    const bad = (await wn(KS)).item;
    const badQuote = await KS.call('graph_job_submit', { job_id: bad.job_id, payload: { verdicts: [{ candidate: cand.candidate, verdict: 'stale', reason: 'old price', quote: 'costs ninety dollars' }] } });
    expect(badQuote.structuredContent.rejected[0].error).toContain('exact substring');

    const retry = (await wn(KS)).item;
    expect(retry.job_id).toBe(item.job_id);
    const before = noticeCount(W2.id);
    const ok = await KS.call('graph_job_submit', { job_id: retry.job_id, payload: { verdicts: [{ candidate: cand.candidate, verdict: 'stale', reason: 'still says forty dollars', quote: 'pay forty dollars per seat per month' }] } });
    expect(ok.structuredContent.verdict).toBe('accepted');
    await KS.call('work_ack', { item_id: retry.item_id });

    const flags = (await W2.call('graph_stale', { mine: true })).structuredContent.flags;
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'stale', path: '/vault/K3/Faq.md', status: 'open', cause_path: '/vault/K3/Pricing.md' });
    flagId = flags[0].id;
    expect(noticeCount(W2.id)).toBeGreaterThan(before);                    // notice to the note's last writer
    expect(noticeCount(W.id)).toBeGreaterThan(0);                          // and to the editor of the cause
    const task = app.db.prepare('SELECT * FROM tasks WHERE id=?').get(flags[0].task_id) as any;
    expect(task.reviewer_agent_id).toBe(R.id);                             // fixes go through a reviewer
    expect(task.claimable).toBe(1);
    expect(task.title).toContain(flagId);
    expect(task.title).not.toContain('/vault/'); // team-visible metadata stays safe under changing app caps
  });

  it('flags are filtered by fs.read; a fix needs a new revision; dismissing is for reviewers', async () => {
    const onlyPricing = await mk('k3-narrow', [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/K3/Pricing.md' }]);
    expect((await onlyPricing.call('graph_stale')).structuredContent.flags).toEqual([]);
    const none = await mk('k3-none', []);
    expect((await none.call('graph_stale')).structuredContent.error).toBe('denied');
    expect((await onlyPricing.call('graph_resolve', { flag_id: flagId, status: 'fixed' })).isError).toBe(true);
    expect((await W2.call('graph_resolve', { flag_id: flagId, status: 'fixed' })).structuredContent.error).toBe('denied');   // no graph grant
    expect((await R.call('graph_resolve', { flag_id: flagId, status: 'fixed' })).structuredContent.error).toBe('invalid_state');   // note not changed yet
    await update(W2, '/vault/K3/Faq.md', FAQ('fifty-five dollars'));
    const done = await R.call('graph_resolve', { flag_id: flagId, status: 'fixed' });
    expect(done.structuredContent.flag.status).toBe('fixed');
    expect((await W2.call('graph_stale')).structuredContent.flags).toEqual([]);
  });

  it('an opted-in editor is offered the impact check of its own write first', async () => {
    app.db.prepare('DELETE FROM kg_jobs').run();
    const E = await mk('k3-editor', RW, 'strong-editor');
    await E.call('graph_editor_optin', { enabled: true });
    await write(E, '/vault/K3e/DepA.md', '# DepA\n\nThe widget weighs ten grams.\n');
    await write(E, '/vault/K3e/DepB.md', '---\ndepends_on:\n  - "[[DepA]]"\n---\n# DepB\n\nBuilt on the widget facts.\n');
    app.db.prepare('DELETE FROM kg_jobs').run();
    const upd = await update(E, '/vault/K3e/DepA.md', '# DepA\n\nThe widget weighs twelve grams.\n');
    expect(upd.structuredContent.graph_hint).toContain('impact check');
    const other = await wn(KS);
    expect(other.item?.job_type).not.toBe('impact_check');                  // the editor has it for 5 minutes
    if (other.item) await KS.call('work_ack', { item_id: other.item.item_id });
    const mine = (await wn(E)).item;
    expect(mine.job_type).toBe('impact_check');
    expect(mine.input.candidates.map((c: any) => c.path)).toContain('/vault/K3e/DepB.md');
    const s = await E.call('graph_job_submit', { job_id: mine.job_id, payload: { verdicts: [{ candidate: mine.input.candidates[0].candidate, verdict: 'ok' }] } });
    expect(s.structuredContent.verdict).toBe('accepted');
    await E.call('work_ack', { item_id: mine.item_id });
    expect((await E.call('graph_job_submit', { job_id: 'kj_nope', payload: {} })).isError).toBe(true);
    // after the offer window anyone can take it
    await update(E, '/vault/K3e/DepA.md', '# DepA\n\nThe widget weighs fifteen grams.\n');
    app.db.prepare('UPDATE kg_jobs SET offered_until=? WHERE type=?').run(Date.now() - 1, 'impact_check');
    const late = await drain(KS);
    expect(late).toContain('impact_check');
  });

  it('budgets hold back impact checks; tags and co_changed become signals', async () => {
    app.db.prepare('DELETE FROM kg_jobs').run();
    await write(W, '/vault/K3t/A.md', '---\ntags: [pricing-topic]\n---\n# A\n\nAlpha note body.\n');
    await write(W, '/vault/K3t/B.md', '# B\n\nBeta note body with #pricing-topic inline.\n');
    const kinds = (p: string, k: string) => (app.db.prepare("SELECT COUNT(*) n FROM kg_signals WHERE kind=? AND src_file=(SELECT id FROM files WHERE path=?)").get(k, p) as any).n;
    expect(kinds('K3t/A.md', 'tag')).toBe(1);
    expect(kinds('K3t/B.md', 'tag')).toBe(1);
    expect(kinds('K3t/B.md', 'co_changed')).toBeGreaterThan(0);              // same session, minutes apart
    const rel = (await W.call('graph_related', { path: '/vault/K3t/A.md', kinds: ['tag'] })).structuredContent.related;
    expect(rel.map((x: any) => x.path)).toEqual(['/vault/K3t/B.md']);
    // weak signals alone never trigger an impact check
    await update(W, '/vault/K3t/A.md', '---\ntags: [pricing-topic]\n---\n# A\n\nAlpha note body, changed.\n');
    expect((app.db.prepare("SELECT COUNT(*) n FROM kg_jobs WHERE type='impact_check'").get() as any).n).toBe(0);

    await write(W, '/vault/K3t/C.md', '# C\n\nSee [[A]].\n');
    await update(W, '/vault/K3t/A.md', '---\ntags: [pricing-topic]\n---\n# A\n\nAlpha note body, changed again.\n');
    expect((app.db.prepare("SELECT COUNT(*) n FROM kg_jobs WHERE type='impact_check' AND state='queued'").get() as any).n).toBe(1);
    const cap = (app.db.prepare("SELECT tokens_cap FROM kg_budgets WHERE scope='vault'").get() as any).tokens_cap as number;
    app.graph.setBudget('vault', '', 'day', 5, null);
    const blocked = app.graph.budgetBlocked;
    expect((await wn(KS)).status).toBe('idle');
    expect(app.graph.budgetBlocked).toBeGreaterThan(blocked);
    app.graph.setBudget('vault', '', 'day', cap, null);
    expect((await wn(KS)).item.job_type).toBe('impact_check');
  });
});

describe('K4: contradictions, verify_sample, reputation, entity_merge', () => {
  it('two notes that disagree on a value are disputed, flagged and routed to a reviewer', async () => {
    app.db.prepare('DELETE FROM kg_jobs').run();
    const W = await mk('k4-writer', RW);
    await write(W, '/vault/K4/T1.md', '# T1\n\nThe Orbit contract renews on 2027-03-01 for a year.\n');
    await write(W, '/vault/K4/T2.md', '# T2\n\nThe Orbit contract renews on 2028-09-09 for a year.\n');
    const up = (path: string, anchor: string, quote: string, value: string) => KS.call('graph_upsert', { path, payload: { entities: [{ name: 'Orbit Contract' }], claims: [{ subject: 'Orbit Contract', predicate: 'renews_on', object_text: value, text: `Orbit renews on ${value}.`, anchor, quote, confidence: 0.9 }] } });
    expect((await up('/vault/K4/T1.md', 't1', 'renews on 2027-03-01', '2027-03-01')).structuredContent.accepted_claims).toBe(1);
    expect((await W.call('graph_stale')).structuredContent.flags).toEqual([]);
    expect((await up('/vault/K4/T2.md', 't2', 'renews on 2028-09-09', '2028-09-09')).structuredContent.accepted_claims).toBe(1);
    const flags = (await W.call('graph_stale')).structuredContent.flags;
    expect(flags.map((f: any) => f.kind)).toEqual(['contradiction', 'contradiction']);
    const task = app.db.prepare('SELECT reviewer_agent_id r FROM tasks WHERE id=?').get(flags[0].task_id) as any;
    expect(task.r).toBe(R.id);
    const claims = (await W.call('graph_query', { entity: 'Orbit Contract' })).structuredContent.claims;
    expect(claims.map((c: any) => c.status)).toEqual(['disputed', 'disputed']);
    // only a reviewer decides, and the producer cannot
    const loser = claims.find((c: any) => c.source.includes('T2.md'));
    expect((await KS.call('graph_decide', { id: loser.id, decision: 'invalidate' })).structuredContent.error).toBe('denied');
    expect((await R.call('graph_decide', { id: loser.id, decision: 'invalidate' })).structuredContent.status).toBe('invalidated');
    expect((await W.call('graph_stale')).structuredContent.flags).toEqual([]);
  });

  it('a seeded false claim is caught by verify_sample from another session; repeated disagreement restricts the model label', async () => {
    app.db.prepare('DELETE FROM kg_jobs').run();
    const W = await mk('k4-writer2', RW);
    for (let i = 1; i <= 3; i++) {
      const path = `/vault/K4v/Zeta${i}.md`;
      await write(W, path, `# Zeta${i}\n\nThe Zeta${i} licence renews on 2027-05-0${i} under the standard terms.\n`);
      const job = (await wn(KL)).item;                                    // the "liar" extracts a claim whose quote is real but whose meaning is false
      expect(job.input.path).toBe(path);
      const s = await KL.call('graph_job_submit', { job_id: job.job_id, payload: { entities: [{ name: `Zeta${i}` }], claims: [{ subject: `Zeta${i}`, predicate: 'renews_on', object_text: '2030-01-01', text: `Zeta${i} renews on 2030-01-01.`, anchor: `zeta${i}`, quote: `renews on 2027-05-0${i}`, confidence: 0.95 }] } });
      expect(s.structuredContent.verdict).toBe('accepted');
      await KL.call('work_ack', { item_id: job.item_id });
      const mine = await wn(KL);                                           // never verifies its own work
      expect(mine.status === 'idle' || mine.item.job_type !== 'verify_sample').toBe(true);
      if (mine.item) await KL.call('work_ack', { item_id: mine.item.item_id });

      const v = (await wn(KV)).item;
      expect(v.job_type).toBe('verify_sample');
      expect(v.input.path).toBe(path);
      const claim = v.input.claims[0].claim;
      const ok = await KV.call('graph_job_submit', { job_id: v.job_id, payload: { results: [{ claim, verdict: 'disagree', reason: 'the note says 2027, not 2030' }] } });
      expect(ok.structuredContent.verdict).toBe('accepted');
      await KV.call('work_ack', { item_id: v.item_id });
      const row = app.db.prepare('SELECT status FROM kg_claims WHERE id=?').get(claim) as any;
      expect(row.status).toBe('disputed');
    }
    const flags = (await W.call('graph_stale')).structuredContent.flags.filter((f: any) => f.path.includes('Zeta'));
    expect(flags).toHaveLength(3);
    expect(flags[0].reason).toContain('verification disagreed');
    const rep = app.db.prepare("SELECT checked, disagreed, restricted FROM kg_reputation WHERE kind='label' AND ref='liar-model'").get() as any;
    expect(rep).toMatchObject({ checked: 3, disagreed: 3, restricted: 1 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='kg_reputation' AND subject='label:liar-model'").get()).toMatchObject({ n: 1 });
    const h = (await rest('GET', '/api/graph/health')).body;
    expect(h.verification.find((x: any) => x.model_label === 'liar-model')).toMatchObject({ restricted: 1 });
    // restricted label only gets extraction jobs
    expect(app.graph.ext.restricted(KL.id, 'liar-model')).toBe(true);
  });

  it('entity_merge: look-alikes are protected, small merges apply, big merges need a reviewer', async () => {
    app.db.prepare('DELETE FROM kg_jobs').run();
    expect(lookAlike({ name: 'Initech 2023', type: null }, { name: 'Initech 2024', type: null })).toBe(true);
    expect(lookAlike({ name: 'Acme', type: 'customer' }, { name: 'Acme Corp', type: 'vendor' })).toBe(true);
    expect(lookAlike({ name: 'Globex', type: null }, { name: 'Globex Corporation', type: null })).toBe(false);
    expect(similarNames('Globex', 'Globex Corporation')).toBe(true);
    expect(similarNames('Project Alpha', 'Project Beta')).toBe(false);

    const W = await mk('k4-writer3', RW);
    await write(W, '/vault/K4m/Globex.md', '# Globex\n\nGlobex makes widgets. Globex Corporation is based in Porto.\n');
    await write(W, '/vault/K4m/Initech.md', '# Initech\n\nInitech 2023 shipped version one. Initech 2024 shipped version two.\n');
    await KS.call('graph_upsert', { path: '/vault/K4m/Globex.md', payload: { entities: [{ name: 'Globex' }, { name: 'Globex Corporation' }],
      claims: [{ subject: 'Globex', predicate: 'makes', object_text: 'widgets', text: 'Globex makes widgets.', anchor: 'globex', quote: 'Globex makes widgets', confidence: 0.9 },
        { subject: 'Globex Corporation', predicate: 'based_in', object_text: 'Porto', text: 'Globex Corporation is based in Porto.', anchor: 'globex', quote: 'is based in Porto', confidence: 0.9 }] } });
    await KS.call('graph_upsert', { path: '/vault/K4m/Initech.md', payload: { entities: [{ name: 'Initech 2023' }, { name: 'Initech 2024' }],
      claims: [{ subject: 'Initech 2023', predicate: 'shipped', object_text: 'version one', text: 'Initech 2023 shipped version one.', anchor: 'initech', quote: 'shipped version one', confidence: 0.9 }] } });
    const jobs = app.db.prepare("SELECT scope_ref FROM kg_jobs WHERE type='entity_merge'").all() as any[];
    expect(jobs).toHaveLength(1);                                           // Globex pair only
    const names = (id: string) => (app.db.prepare('SELECT name FROM kg_entities WHERE id=?').get(id) as any).name;
    expect(jobs[0].scope_ref.split('|').map(names).sort()).toEqual(['Globex', 'Globex Corporation']);

    app.db.prepare("DELETE FROM kg_jobs WHERE type IN ('index_note','verify_sample')").run();
    const job = (await wn(KV)).item;
    expect(job.job_type).toBe('entity_merge');
    const keep = job.input.entities.find((e: any) => e.name === 'Globex').id;
    const s = await KV.call('graph_job_submit', { job_id: job.job_id, payload: { decision: 'merge', keep, reason: 'same company' } });
    expect(s.structuredContent.verdict).toBe('accepted');
    await KV.call('work_ack', { item_id: job.item_id });
    const q = await KS.call('graph_query', { entity: 'Globex Corporation' });             // the alias now resolves to the kept entity
    expect(q.structuredContent.claims.map((c: any) => c.subject)).toEqual(['Globex', 'Globex']);

    // big merge: more than 2 claims on either side goes to a reviewer
    await write(W, '/vault/K4m/Hooli.md', '# Hooli\n\nHooli builds search. Hooli employs a hundred people. Hooli sits in Palo Alto. Hooli Inc builds search.\n');
    await KS.call('graph_upsert', { path: '/vault/K4m/Hooli.md', payload: { entities: [{ name: 'Hooli' }, { name: 'Hooli Inc' }],
      claims: [{ subject: 'Hooli', predicate: 'builds', object_text: 'search', text: 'Hooli builds search.', anchor: 'hooli', quote: 'Hooli builds search', confidence: 0.9 },
        { subject: 'Hooli', predicate: 'employs', object_text: 'a hundred', text: 'Hooli employs a hundred.', anchor: 'hooli', quote: 'employs a hundred people', confidence: 0.9 },
        { subject: 'Hooli', predicate: 'sits_in', object_text: 'Palo Alto', text: 'Hooli sits in Palo Alto.', anchor: 'hooli', quote: 'sits in Palo Alto', confidence: 0.9 },
        { subject: 'Hooli Inc', predicate: 'builds', object_text: 'search', text: 'Hooli Inc builds search.', anchor: 'hooli', quote: 'Hooli Inc builds search', confidence: 0.9 }] } });
    app.db.prepare("DELETE FROM kg_jobs WHERE type IN ('index_note','verify_sample')").run();
    const job2 = (await wn(KV)).item;
    expect(job2.job_type).toBe('entity_merge');
    const keep2 = job2.input.entities.find((e: any) => e.name === 'Hooli').id;
    const drop2 = job2.input.entities.find((e: any) => e.name === 'Hooli Inc').id;
    await KV.call('graph_job_submit', { job_id: job2.job_id, payload: { decision: 'merge', keep: keep2, reason: 'same company' } });
    await KV.call('work_ack', { item_id: job2.item_id });
    const prop = app.db.prepare("SELECT * FROM kg_merge_proposals WHERE state='pending'").get() as any;
    expect(prop).toBeTruthy();
    expect((app.db.prepare('SELECT status FROM kg_entities WHERE id=?').get(drop2) as any).status).toBe('active');   // not applied yet
    expect((await KV.call('graph_decide', { id: prop.id, decision: 'approve' })).structuredContent.error).toBe('denied');   // curators cannot approve
    expect((await R.call('graph_decide', { id: prop.id, decision: 'approve' })).isError).toBeFalsy();
    expect((app.db.prepare('SELECT status, merged_into FROM kg_entities WHERE id=?').get(drop2) as any)).toMatchObject({ status: 'merged', merged_into: keep2 });
  });
});

describe('K5: communities, community and folder summaries, refresh on change', () => {
  const NOTE = (n: string, a: string, b: string) => `# ${n}\n\n${a} works with ${b} every day.\n`;
  let comId = '';
  it('communities are computed and summarised by curators; summaries are withheld from readers who cannot read all sources', async () => {
    app.db.prepare('DELETE FROM kg_jobs').run();
    const W = await mk('k5-writer', RW);
    const mkNote = async (file: string, a: string, b: string) => {
      await write(W, `/vault/K5/${file}.md`, NOTE(file, a, b));
      await KS.call('graph_upsert', { path: `/vault/K5/${file}.md`, payload: { entities: [{ name: a }, { name: b }],
        claims: [{ subject: a, predicate: 'works_with', object: b, text: `${a} works with ${b}.`, anchor: file.toLowerCase(), quote: `${a} works with ${b} every day`, confidence: 0.9 }],
        relations: [{ src: a, dst: b, kind: 'works_with', claims: [0] }], note_summary: `${a} and ${b} collaborate.` } });
    };
    await mkNote('N1', 'Alice', 'Blair');
    await mkNote('N2', 'Blair', 'Carla');
    await mkNote('N3', 'Dmitri', 'Elena');
    await mkNote('N4', 'Elena', 'Farid');
    app.db.prepare("DELETE FROM kg_jobs WHERE type IN ('index_note','verify_sample','entity_merge')").run();
    const n = app.graph.ext.refresh();
    expect(n.communities).toBeGreaterThanOrEqual(2);
    const groups = (app.db.prepare('SELECT entity_ids FROM kg_communities').all() as any[]).map((r) => (JSON.parse(r.entity_ids) as string[]).map((id) => (app.db.prepare('SELECT name FROM kg_entities WHERE id=?').get(id) as any).name).sort().join('+'));
    expect(groups).toContain('Alice+Blair+Carla');
    expect(groups).toContain('Dmitri+Elena+Farid');
    const seen = await drain(KS, 'Summary written by a curator.');
    expect(seen).toContain('summarize_community');
    expect(seen).toContain('refresh_summary');

    const A = await mk('k5-all', RO);
    const c = (await A.call('graph_summary', { scope: 'community', ref: 'Alice' })).structuredContent;
    expect(c.summary).toBe('Summary written by a curator.');
    expect(c.entities.sort()).toEqual(['Alice', 'Blair', 'Carla']);
    comId = c.community;
    expect((await A.call('graph_summary', { scope: 'community', ref: comId })).structuredContent.stale).toBe(false);
    const f = (await A.call('graph_summary', { scope: 'folder', ref: '/vault/K5' })).structuredContent;
    expect(f.summary).toBe('Summary written by a curator.');
    expect(f.source_files.length).toBeGreaterThanOrEqual(2);

    const narrow = await mk('k5-narrow', [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/K5/N1.md' }]);
    const w1 = (await narrow.call('graph_summary', { scope: 'community', ref: comId })).structuredContent;
    expect(w1.summary).toBeNull();
    expect(w1.withheld).toBe(true);
    expect((await narrow.call('graph_summary', { scope: 'folder', ref: '/vault/K5' })).structuredContent.withheld).toBe(true);
    expect(JSON.stringify(w1)).not.toContain('Carla');
    expect((await (await mk('k5-none', [])).call('graph_summary', { scope: 'folder', ref: '/vault/K5' })).structuredContent.error).toBe('denied');
  });

  it('a change to member claims marks the summary stale and queues a refresh', async () => {
    const W = await mk('k5-writer2', RW);
    await write(W, '/vault/K5/N5.md', NOTE('N5', 'Alice', 'Carla'));
    await KS.call('graph_upsert', { path: '/vault/K5/N5.md', payload: { entities: [{ name: 'Alice' }, { name: 'Carla' }], claims: [{ subject: 'Alice', predicate: 'mentors', object: 'Carla', text: 'Alice mentors Carla.', anchor: 'n5', quote: 'Alice works with Carla every day', confidence: 0.9 }] } });
    app.db.prepare("DELETE FROM kg_jobs WHERE type IN ('index_note','verify_sample','entity_merge')").run();
    app.graph.ext.refresh();
    const A = await mk('k5-all2', RO);
    const c = (await A.call('graph_summary', { scope: 'community', ref: comId })).structuredContent;
    expect(c.stale).toBe(true);
    expect((app.db.prepare("SELECT COUNT(*) n FROM kg_jobs WHERE type='summarize_community' AND state='queued'").get() as any).n).toBeGreaterThanOrEqual(1);
    const seen = await drain(KS, 'Refreshed summary.');
    expect(seen).toContain('summarize_community');
    expect((await A.call('graph_summary', { scope: 'community', ref: comId })).structuredContent).toMatchObject({ summary: 'Refreshed summary.', stale: false });
    // the entity scope is a hub-made digest of readable claims
    const e = (await A.call('graph_summary', { scope: 'entity', ref: 'Alice' })).structuredContent;
    expect(e.derived).toBe(true);
    expect(e.summary).toContain('Alice');
  });
});

describe('graph admin API and health', () => {
  it('GET /api/graph/health has the dashboard shape', async () => {
    const h = (await rest('GET', '/api/graph/health')).body;
    expect(typeof h.coverage_pct).toBe('number');
    expect(typeof h.stale_flags_open).toBe('number');
    expect(typeof h.contradictions_open).toBe('number');
    expect(typeof h.communities).toBe('number');
    expect(h.communities).toBeGreaterThanOrEqual(2);
    expect(h.pending_jobs_by_type).toBeTypeOf('object');
    expect(h.curator_spend_today).toMatchObject({ used_tokens: expect.any(Number), cap_tokens: 200000 });
    expect(h.curator_spend_today.used_tokens).toBeGreaterThan(0);
    expect(h.contradictions_open).toBeGreaterThanOrEqual(3);
    expect(Object.keys(h.coverage_by_folder)).toContain('K5');
  });
  it('flags, jobs, budget and entities', async () => {
    const flags = (await rest('GET', '/api/graph/flags?status=open&kind=contradiction')).body.flags as any[];
    expect(flags.length).toBeGreaterThanOrEqual(3);
    const r = await rest('POST', `/api/graph/flags/${flags[0].id}/resolve`, { status: 'dismissed' });
    expect(r.body.flag.status).toBe('dismissed');
    expect((await rest('POST', `/api/graph/flags/${flags[0].id}/resolve`, { status: 'dismissed' })).status).toBeGreaterThanOrEqual(400);
    expect(((await rest('GET', '/api/graph/flags?status=dismissed')).body.flags as any[]).some((f) => f.id === flags[0].id)).toBe(true);
    const jobs = (await rest('GET', '/api/graph/jobs?state=done&limit=5')).body.jobs as any[];
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]).toHaveProperty('type');
    const b = (await rest('GET', '/api/graph/budget')).body.budgets as any[];
    expect(b.find((x) => x.scope === 'vault' && x.period === 'day').tokens_cap).toBe(200000);
    await rest('PUT', '/api/graph/budget', { scope: 'vault', period: 'day', tokens_cap: 123456 });
    expect(((await rest('GET', '/api/graph/budget')).body.budgets as any[]).find((x) => x.scope === 'vault').tokens_cap).toBe(123456);
    await rest('PUT', '/api/graph/budget', { scope: 'vault', period: 'day', tokens_cap: 200000 });
    const ents = (await rest('GET', '/api/graph/entities?q=glob')).body.entities as any[];
    expect(ents.map((e) => e.name)).toContain('Globex');
    expect(ents.find((e) => e.name === 'Globex Corporation').status).toBe('merged');
  });
  it('graph_health is counts only and needs graph.read', async () => {
    const h = (await KS.call('graph_health')).structuredContent;
    expect(h.trust).toBe('L2');
    expect(h).toHaveProperty('coverage_pct');
    expect(h).not.toHaveProperty('coverage_by_folder');
    expect((await (await mk('h-none', [])).call('graph_health')).structuredContent.error).toBe('denied');
  });
});
