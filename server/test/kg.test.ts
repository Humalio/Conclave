import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', appKey = '';
type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: any; content: { text: string }[] }>;
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const FS_ALL = ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.history'];
const RW: Rules = [{ effect: 'allow', actions: FS_ALL, resource: 'path:/vault/**' }];

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
  return r.structuredContent.revision as string;
};

/** work_next, confirming notices on the way. */
const wn = async (s: S) => {
  for (let i = 0; i < 10; i++) {
    const r = (await s.call('work_next')).structuredContent;
    if (r.status === 'item' && r.item.kind === 'notice') { await s.call('work_ack', { item_id: r.item.item_id }); continue; }
    return r;
  }
  throw new Error('too many notices');
};
const PARA = 'The enterprise plan costs forty dollars per seat per month and includes priority support, single sign on, audit logs, and a dedicated success manager for every customer account';
const ACME = '# Acme\n\nAcme Corp is a customer based in Lisbon.\n\n## Contract\n\nThe Acme contract renews on 2027-03-01 with a value of 120000 euros.\n\n## Contacts\n\nThe account owner at Acme is Maria Santos.\n';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahkg-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0, graph: { debounceMs: 0 },
  };
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = ((await r.json()) as { csrf: string }).csrf;
  const pcId = ((await (await fetch(`${base}/api/pcs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'pc' }) })).json()) as any).pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 100 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('K1: write -> impact candidates with reasons', () => {
  it('wikilink, depends_on frontmatter, read-before-write and near-duplicate section', async () => {
    const W = await mk('k1-writer', RW);
    const pricing = `# Pricing\n\nIntro text about the price list.\n\n## Tiers\n\n${PARA}.\n\n## Notes\n\nNothing special here.\n`;
    await write(W, '/vault/K1/Pricing.md', pricing);
    await write(W, '/vault/K1/Plan.md', '# Plan\n\nSee [[Pricing#Tiers]] for the numbers.\n');
    await write(W, '/vault/K1/Spec.md', '---\ndepends_on:\n  - "[[Pricing]]"\n---\n# Spec\n\nBuilt on the price list.\n');
    await write(W, '/vault/K1/Copy.md', `# Copy\n\n## Offer\n\n${PARA.replace('forty', 'fifty')}.\n`);
    await W.call('file_read', { path: '/vault/K1/Pricing.md' });                       // read before writing
    await write(W, '/vault/K1/Derived.md', '# Derived\n\nMy own summary of the pricing, written after reading it.\n');
    const O = await mk('k1-other', RW);
    await write(O, '/vault/K1/Unrelated.md', '# Unrelated\n\nGardening notes about tomatoes and soil.\n');

    const before = (app.db.prepare('SELECT COUNT(*) n FROM kg_impact').get() as any).n;
    const changedText = pricing.replace('forty dollars', 'fifty-five dollars');
    await update(W, '/vault/K1/Pricing.md', changedText);            // only the Tiers section changes
    const r = await W.call('graph_impact', { path: '/vault/K1/Pricing.md' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.trust).toBe('L2');
    expect(r.structuredContent.recorded).toBe(true);
    expect(r.structuredContent.changed_sections).toEqual(['tiers']);
    const by = (p: string) => r.structuredContent.candidates.find((c: any) => c.path === p);
    expect(by('/vault/K1/Plan.md').reasons.map((x: any) => x.kind)).toContain('link');
    expect(by('/vault/K1/Spec.md').reasons.map((x: any) => x.kind)).toContain('fm_depends_on');
    expect(by('/vault/K1/Copy.md').reasons.map((x: any) => x.kind)).toContain('near_dup');
    expect(by('/vault/K1/Derived.md').reasons.map((x: any) => x.kind)).toContain('derived_from');
    expect(by('/vault/K1/Unrelated.md')).toBeUndefined();
    expect(by('/vault/K1/Spec.md').score).toBeGreaterThan(by('/vault/K1/Derived.md').score);
    expect(by('/vault/K1/Plan.md').reasons[0].evidence).toContain('Pricing');

    const rel = await W.call('graph_related', { path: '/vault/K1/Pricing.md' });
    expect(rel.structuredContent.related.map((x: any) => x.path)).toEqual(expect.arrayContaining(['/vault/K1/Plan.md', '/vault/K1/Spec.md']));

    // formatting-only change records nothing new
    const n1 = (app.db.prepare('SELECT COUNT(*) n FROM kg_impact').get() as any).n;
    expect(n1).toBeGreaterThan(before);
    await update(W, '/vault/K1/Pricing.md', changedText.replace('## Notes\n\n', '## Notes\n\n\n   ') + '\n\n');
    expect((app.db.prepare('SELECT COUNT(*) n FROM kg_impact').get() as any).n).toBe(n1);
  });

  it('candidates are filtered by fs.read on the dependants', async () => {
    const W = await mk('k1-w2', RW);
    await write(W, '/vault/K1b/Open.md', '# Open\n\nBody of the open note.\n');
    await write(W, '/vault/K1b/Secret.md', '# Secret\n\nSee [[Open]] for context.\n');
    const R = await mk('k1-r', [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/K1b/Open.md' }]);
    await update(W, '/vault/K1b/Open.md', '# Open\n\nBody of the open note, changed.\n');
    const own = await W.call('graph_impact', { path: '/vault/K1b/Open.md' });
    expect(own.structuredContent.candidates.map((c: any) => c.path)).toContain('/vault/K1b/Secret.md');
    const r = await R.call('graph_impact', { path: '/vault/K1b/Open.md' });
    expect(r.structuredContent.candidates).toEqual([]);
    expect((await R.call('graph_impact', { path: '/vault/K1b/Secret.md' })).structuredContent.error).toBe('denied');
  });
});

describe('K2: curator jobs, validation, context packs, budgets, incremental indexing', () => {
  let K: S, W: S;
  beforeAll(async () => {
    app.db.prepare('DELETE FROM kg_jobs').run();                     // jobs queued by the K1 tests
    W = await mk('k2-writer', RW);
    const C = await mk('k2-coord', []);
    K = await mk('k2-curator', [{ effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/**' }], 'light-model');
    const t = app.teams.create({ name: 'Knowledge', goal: 'Index the vault', members: [{ agent_id: C.id, role: 'coordinator' }, { agent_id: K.id, role: 'curator' }] }, sys);
    app.teams.start(t.id, sys);
  });

  it('curator gets index_note via work_next, valid claims are stored, an invalid quote is rejected', async () => {
    await write(W, '/vault/K2/Acme.md', ACME);
    const w = { structuredContent: await wn(K) };
    expect(w.structuredContent.status).toBe('item');
    const item = w.structuredContent.item;
    expect(item.kind).toBe('knowledge_job');
    expect(item.input.path).toBe('/vault/K2/Acme.md');
    expect(item.input.sections.map((s: any) => s.anchor)).toEqual(['acme', 'contract', 'contacts']);
    expect(item.content).toContain('<note_data');
    const again = { structuredContent: await wn(K) };                              // same item until acked
    expect(again.structuredContent.item.item_id).toBe(item.item_id);

    const sub = await K.call('graph_job_submit', {
      job_id: item.job_id,
      payload: {
        entities: [{ name: 'Acme Corp', type: 'customer', aliases: ['Acme'] }, { name: 'Maria Santos', type: 'person' }],
        claims: [
          { subject: 'Acme Corp', predicate: 'renews_on', object_text: '2027-03-01', text: 'The Acme contract renews on 2027-03-01.', anchor: 'contract', quote: 'renews on 2027-03-01 with a value of 120000 euros', confidence: 0.9 },
          { subject: 'Acme Corp', predicate: 'has_account_owner', object: 'Maria Santos', text: 'Maria Santos owns the Acme account.', anchor: 'contacts', quote: 'The account owner at Acme is Maria Santos', confidence: 0.95 },
          { subject: 'Acme Corp', predicate: 'pays', object_text: '999999 euros', text: 'Acme pays 999999 euros.', anchor: 'contract', quote: 'a value of 999999 euros', confidence: 0.9 },
          { subject: 'Nobody', predicate: 'x', text: 'x', anchor: 'contract', quote: 'The Acme contract', confidence: 0.9 },
        ],
        relations: [{ src: 'Acme Corp', dst: 'Maria Santos', kind: 'has_contact', claims: [1] }],
        section_summaries: [{ anchor: 'contract', text: 'Renewal terms.' }],
        note_summary: 'Acme Corp is a Lisbon customer whose contract renews on 2027-03-01; Maria Santos is the account owner.',
      },
    });
    expect(sub.isError).toBeFalsy();
    expect(sub.structuredContent.verdict).toBe('partial');
    expect(sub.structuredContent.accepted_claims).toBe(2);
    expect(sub.structuredContent.rejected.map((x: any) => x.item).sort()).toEqual(['claims[2]', 'claims[3]']);
    expect(sub.structuredContent.rejected.find((x: any) => x.item === 'claims[2]').error).toContain('exact substring');
    expect(sub.structuredContent.relations).toBe(1);
    expect((await K.call('work_ack', { item_id: item.item_id })).isError).toBeFalsy();
    expect((await wn(K)).status).toBe('idle');

    const q = await W.call('graph_query', { entity: 'Acme' });
    expect(q.structuredContent.trust).toBe('L2');
    expect(q.structuredContent.claims).toHaveLength(2);
    const c = q.structuredContent.claims.find((x: any) => x.predicate === 'renews_on');
    expect(c.source).toMatch(/^\/vault\/K2\/Acme\.md#contract@sha256:[0-9a-f]{64}$/);
    expect(c.quote).toContain('2027-03-01');
    expect(c.status).toBe('accepted');
    expect(app.db.prepare("SELECT coverage FROM kg_note_state WHERE file_id=(SELECT id FROM files WHERE path='K2/Acme.md')").get()).toMatchObject({ coverage: 'current' });
    expect((await K.call('graph_job_submit', { job_id: item.job_id, payload: {} })).isError).toBe(true);   // done jobs take no more results
  });

  it('a fully invalid result keeps the job for a retry', async () => {
    await write(W, '/vault/K2/Bad.md', '# Bad\n\nThe sky is blue today and the grass is green.\n');
    const item = (await wn(K)).item;
    expect(item.input.path).toBe('/vault/K2/Bad.md');
    const sub = await K.call('graph_job_submit', { job_id: item.job_id, payload: { entities: [{ name: 'Sky' }], claims: [{ subject: 'Sky', predicate: 'is', object_text: 'red', text: 'The sky is red.', anchor: 'bad', quote: 'The sky is red', confidence: 0.9 }] } });
    expect(sub.structuredContent.verdict).toBe('rejected');
    expect(sub.structuredContent.accepted_claims).toBe(0);
    expect(app.db.prepare('SELECT state, attempts FROM kg_jobs WHERE id=?').get(item.job_id)).toMatchObject({ state: 'queued', attempts: 1 });
    const retry = (await wn(K)).item;
    expect(retry.job_id).toBe(item.job_id);
    const ok = await K.call('graph_job_submit', { job_id: retry.job_id, payload: { entities: [{ name: 'Sky' }], claims: [{ subject: 'Sky', predicate: 'is', object_text: 'blue', text: 'The sky is blue.', anchor: 'bad', quote: 'The sky is blue today', confidence: 0.8 }] } });
    expect(ok.structuredContent.verdict).toBe('accepted');
    await K.call('work_ack', { item_id: retry.item_id });
  });

  it('another agent gets a graph_context pack within 4k tokens, with sources, filtered by its read permissions', async () => {
    await write(W, '/vault/K2s/Hidden.md', '# Hidden\n\nAcme has a secret discount of 40 percent on every renewal.\n');
    const item = (await wn(K)).item;
    expect(item.input.path).toBe('/vault/K2s/Hidden.md');
    const s = await K.call('graph_job_submit', { job_id: item.job_id, payload: { entities: [{ name: 'Acme Corp' }], claims: [{ subject: 'Acme Corp', predicate: 'has_discount', object_text: '40 percent', text: 'Acme has a secret discount of 40 percent on renewals.', anchor: 'hidden', quote: 'a secret discount of 40 percent', confidence: 0.9 }], note_summary: 'Acme secret renewal discount.' } });
    expect(s.structuredContent.verdict).toBe('accepted');
    await K.call('work_ack', { item_id: item.item_id });

    const R = await mk('k2-reader', [{ effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/K2/**' }]);
    const ctx = await R.call('graph_context', { question: 'When does the Acme contract renew and who owns the account?' });
    expect(ctx.isError).toBeFalsy();
    const d = ctx.structuredContent;
    expect(d.trust).toBe('L2');
    expect(d.tokens_est).toBeLessThanOrEqual(4000);
    expect(d.claims.length).toBeGreaterThanOrEqual(2);
    for (const c of d.claims) expect(c.source).toMatch(/^\/vault\/K2\/.+#.+@sha256:/);
    expect(JSON.stringify(d)).not.toContain('secret discount');
    expect(JSON.stringify(d)).not.toContain('Hidden.md');
    expect(d.summaries.map((x: any) => x.path)).toEqual(['/vault/K2/Acme.md']);
    expect(d.sections_to_read.length).toBeGreaterThan(0);
    expect(d.coverage.notes_readable).toBeGreaterThan(0);

    const A = await mk('k2-all', [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }]);
    expect(JSON.stringify((await A.call('graph_context', { question: 'Acme discount renewal' })).structuredContent)).toContain('secret discount');
    const small = (await A.call('graph_context', { question: 'Acme contract renew owner discount', budget_tokens: 500 })).structuredContent;
    expect(small.tokens_est).toBeLessThanOrEqual(500);
    expect(small.truncated).toBe(true);

    const sm = await R.call('graph_summary', { scope: 'note', ref: '/vault/K2/Acme.md' });
    expect(sm.structuredContent.summary).toContain('Lisbon');
    expect(sm.structuredContent.stale).toBe(false);
    expect((await R.call('graph_summary', { scope: 'note', ref: '/vault/K2s/Hidden.md' })).structuredContent.error).toBe('denied');
    const N = await mk('k2-none', []);
    expect((await N.call('graph_context', { question: 'Acme' })).structuredContent.error).toBe('denied');
    expect((await R.call('graph_job_submit', { job_id: 'kj_x', payload: {} })).structuredContent.error).toBe('denied');
  });

  it('only changed sections are re-indexed', async () => {
    const pth = '/vault/K2/Inc.md';
    const body = (b: string) => `# Inc\n\nIntro about the incremental note.\n\n## Alpha\n\nAlpha facts live here and stay put.\n\n## Beta\n\n${b}\n\n## Gamma\n\nGamma facts also stay put.\n`;
    await write(W, pth, body('Beta says the limit is 10.'));
    const first = (await wn(K)).item;
    expect(first.input.sections.map((s: any) => s.anchor)).toEqual(['inc', 'alpha', 'beta', 'gamma']);
    await K.call('graph_job_submit', { job_id: first.job_id, payload: { entities: [{ name: 'Beta' }], claims: [{ subject: 'Beta', predicate: 'limit', object_text: '10', text: 'Beta limit is 10.', anchor: 'beta', quote: 'the limit is 10', confidence: 0.9 }] } });
    await K.call('work_ack', { item_id: first.item_id });
    expect((await wn(K)).status).toBe('idle');

    await update(W, pth, body('Beta says the limit is 25.'));
    expect((app.db.prepare("SELECT status FROM kg_claims WHERE predicate='limit'").get() as any).status).toBe('source_changed');   // still shown, marked
    const second = (await wn(K)).item;
    expect(second.input.sections.map((s: any) => s.anchor)).toEqual(['beta']);
    expect(second.input.existing_claims.map((c: any) => c.anchor)).toEqual(['beta']);
    expect(second.content).not.toContain('Alpha facts');
    const bad = await K.call('graph_job_submit', { job_id: second.job_id, payload: { claims: [{ subject: 'Beta', predicate: 'limit', object_text: '10', text: 'Beta limit is 10.', anchor: 'beta', quote: 'the limit is 10', confidence: 0.9 }] } });
    expect(bad.structuredContent.verdict).toBe('rejected');
    const retry = (await wn(K)).item;
    const ok = await K.call('graph_job_submit', { job_id: retry.job_id, payload: { claims: [{ subject: 'Beta', predicate: 'limit', object_text: '25', text: 'Beta limit is 25.', anchor: 'beta', quote: 'the limit is 25', confidence: 0.9 }] } });
    expect(ok.structuredContent.verdict).toBe('accepted');
    await K.call('work_ack', { item_id: retry.item_id });
    expect((await wn(K)).status).toBe('idle');
    const claims = (await W.call('graph_query', { entity: 'Beta', include_invalid: true })).structuredContent.claims;
    expect(claims.map((c: any) => c.status).sort()).toEqual(['accepted', 'source_changed']);
  });

  it('budgets stop job issue when exceeded; tiers come from the model label', async () => {
    const cap = (app.db.prepare("SELECT tokens_cap FROM kg_budgets WHERE scope='vault'").get() as any).tokens_cap as number;
    app.graph.setBudget('vault', '', 'day', 50, null);
    await write(W, '/vault/K2/Budget.md', '# Budget\n\nThis note waits for budget.\n');
    const blockedBefore = app.graph.budgetBlocked;
    expect((await wn(K)).status).toBe('idle');
    expect(app.graph.budgetBlocked).toBeGreaterThan(blockedBefore);
    expect(app.db.prepare("SELECT COUNT(*) n FROM kg_jobs WHERE state='queued' AND type='index_note'").get()).toMatchObject({ n: 1 });
    app.graph.setBudget('vault', '', 'day', cap, null);
    expect((await wn(K)).item.input.path).toBe('/vault/K2/Budget.md');
    expect((app.db.prepare("SELECT used_tokens FROM kg_budgets WHERE scope='vault'").get() as any).used_tokens).toBeGreaterThan(0);

    app.graph.setTier('claude-opus*', 'strong');
    expect(app.graph.tierOf('claude-opus-5')).toBe('strong');
    expect(app.graph.tierOf('light-model')).toBe('light');
    expect(app.graph.tierOf(null)).toBe('light');
  });
});
