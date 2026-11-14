/**
 * The 16 Nov feedback fixes (docs/proposals/feedback-fixes.md), one test per fix: checkout tools listed with no checkout
 * open, the vault-copy step before the handout, no_repo, one checkout branch per member (old reports still read
 * checkout/<id>), the next step on a generic refusal, contributor progress notes, graph_stale coverage, and the repo
 * hosts named up front.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { CHECKPOINT_STEPS, VAULT_COPY_STEP, RECONNECT_HINT, INTEGRATION_FALLBACK, refSafe } from '../src/checkout/checkout.js';
import { NOT_ALLOWED } from '../src/policy/engine.js';
import { RESTORE_TEMPLATE } from './restoreTemplate.js';
import { testConfig } from './hub.js';

let app: App, base: string, vaultDir: string, appKey: string;
const admin = { kind: 'admin' as const, id: '' };
const sys = { kind: 'system' as const, id: null };
let seq = 0;
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
const clients: Client[] = [];

async function connect(): Promise<Client> {
  const c = new Client({ name: 'claude-code', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  clients.push(c);
  return c;
}
async function loginAs(secret: string): Promise<{ c: Client; call: Call }> {
  const c = await connect();
  const r = (await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res;
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
  const token = r.structuredContent.session_token as string;
  return { c, call: async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res };
}
/** A running team of a coordinator and `workers` workers, each with a session key, members logged in over MCP. */
const team = async (workers = 1, labels?: string[]) => {
  const n = ++seq;
  const names = labels ?? [`lead-${n}`, ...Array.from({ length: workers }, (_, i) => `w${i}-${n}`)];
  const made = names.map((label) => { const a = app.keys.createAgent(label, null, admin); const k = app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, admin); return { id: a.id, secret: k.secret }; });
  const t = app.teams.create({ name: `Fix team ${n}`, goal: 'Fix it.', members: made.map((m, i) => ({ agent_id: m.id, role: i === 0 ? 'coordinator' : 'worker' })) }, admin);
  app.teams.start(t.id, admin);
  const members = [];
  for (const m of made) members.push({ ...m, ...(await loginAs(m.secret)) });
  return { id: t.id, lead: members[0]!, workers: members.slice(1), all: members };
};
const noLeftovers = { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] };
const clean = { integration_branch: 'develop', integration_head: 'a'.repeat(40), merge_commits: ['b'.repeat(40)], worktrees_left: 0, clean: true, leftover_check: noLeftovers };
const repo = { remote_name: 'origin', url: 'https://github.com/acme/core.git', clone_folder: 'core' };
const ok = (r: Res) => { expect(r.isError, JSON.stringify(r.structuredContent ?? r.content)).toBeFalsy(); return r.structuredContent; };
const errOf = (r: Res) => (r.isError ? r.structuredContent?.error : 'ok');
const pathOf = (kind: string, ref: string) => (app.db.prepare('SELECT path FROM mirror_files WHERE kind=? AND ref_id=?').get(kind, ref) as { path: string } | undefined)?.path;
const page = (p: string) => readFileSync(join(vaultDir, p), 'utf8');
const sameUser = { target_machine_id: null, request_id: null, choices: { target: 'same_user', rotate_agent_keys: false } };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahfix-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'G'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, repoHosts: ['github.com', 'gitlab.com'] }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin.id = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = app.keys.createMachine('pc-fixes', null, sys);
  appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys).secret;
});
afterAll(async () => { for (const c of clients) await c.close().catch(() => {}); await app.close(); });

describe('fix 1: checkout tools for every member, always', () => {
  it('a member session lists the checkout tools with no checkout open, they answer "no checkout for your team", and the notice ends with the reconnect hint', async () => {
    const t = await team(1);
    const names = (await t.workers[0]!.c.listTools()).tools.map((x) => x.name);
    for (const n of ['checkout_status', 'checkout_progress', 'checkout_handout', 'checkout_resume']) expect(names).toContain(n);
    expect(ok(await t.workers[0]!.call('checkout_status')).checkout).toBeNull();
    expect((await t.workers[0]!.call('checkout_status')).content[0]!.text).toMatch(/^No checkout for your team/);
    const p = await t.workers[0]!.call('checkout_progress', { status: 'checkpointing' });
    expect(errOf(p)).toBe('not_found');
    expect(p.content[0]!.text).toContain('No checkout for your team');
    // No report yet names the integration branch: the notice and the steps say what it usually is.
    app.checkouts.start(t.id, admin);
    const notice = app.db.prepare("SELECT body FROM agent_notices WHERE agent_id=? AND kind='checkout_requested' ORDER BY seq DESC LIMIT 1").get(t.workers[0]!.id) as { body: string };
    expect(notice.body.endsWith(RECONNECT_HINT)).toBe(true);
    expect(notice.body).toContain(INTEGRATION_FALLBACK);
    // Once a member reports it, checkout_status names the team's integration branch.
    app.checkouts.checkpointing(t.lead.id);
    app.checkouts.merged(t.lead.id, clean);
    const s = ok(await t.workers[0]!.call('checkout_status'));
    expect(s.checkout.integration_branch).toBe('develop');
    expect(s.steps).toContain("your team's integration branch `develop`");
    expect(ok(await t.workers[0]!.call('team_info')).teams[0].checkout).toContain(RECONNECT_HINT);
  });
});

describe('fix 2: the vault copy comes before the handout', () => {
  it('the steps put the vault copy before the handout step, and checkout_status names it until the handout is written', async () => {
    const steps = CHECKPOINT_STEPS.split('\n');
    const vault = steps.findIndex((s) => s.includes(VAULT_COPY_STEP)), hand = steps.findIndex((s) => s.includes('Write your handout with checkout_handout'));
    expect(vault).toBeGreaterThan(-1);
    expect(vault).toBeLessThan(hand);
    const t = await team(1);
    app.checkouts.start(t.id, admin);
    const w = t.workers[0]!;
    expect(ok(await w.call('checkout_status')).next).toContain(VAULT_COPY_STEP);
    ok(await w.call('checkout_progress', { status: 'checkpointing' }));
    expect(ok(await w.call('checkout_status')).next).toContain(VAULT_COPY_STEP);
    ok(await w.call('checkout_progress', { status: 'merged', ...clean }));
    expect(ok(await w.call('checkout_status')).next).toContain(VAULT_COPY_STEP);
    ok(await w.call('checkout_handout', { folder: 'core-w', repo }));
    expect(ok(await w.call('checkout_status')).next).not.toContain(VAULT_COPY_STEP);
  });
});

describe('fix 3: no_repo', () => {
  it('a no_repo report opens the handout step; render, the push list and the vault pages say "nothing to merge"; never both', async () => {
    const t = await team(1);
    const c = app.checkouts.start(t.id, admin);
    const w = t.workers[0]!;
    ok(await w.call('checkout_progress', { status: 'checkpointing' }));
    const both = await w.call('checkout_progress', { status: 'merged', ...clean, no_repo: 'review-only' });
    expect(errOf(both)).toBe('invalid_argument');
    const neither = await w.call('checkout_progress', { status: 'merged', worktrees_left: 0, clean: true, leftover_check: noLeftovers });
    expect(errOf(neither)).toBe('invalid_argument');
    const m = ok(await w.call('checkout_progress', { status: 'merged', no_repo: 'review-only', worktrees_left: 0, clean: true, leftover_check: noLeftovers }));
    expect(m.complete).toBe(true);
    ok(await w.call('checkout_handout', { folder: 'core-w' }));
    app.checkouts.checkpointing(t.lead.id);
    app.checkouts.merged(t.lead.id, clean);
    app.checkouts.write(t.lead.id, { folder: 'core-lead', repo });
    expect(app.checkouts.checkout(c.id)!.status).toBe('ready');
    const h = app.checkouts.handouts(c.id).find((x) => x.agent_id === w.id)!;
    expect(JSON.parse(h.body!).checkpoint).toEqual({ no_repo: 'review-only', merge_commits: [] });
    const push = app.checkoutKeys.pushList(app.checkouts.mustCheckout(c.id));
    expect(push.flatMap((r) => r.agents)).toEqual([t.lead.id]);
    expect(app.checkoutKeys.details(c.id).nothing_to_merge).toEqual([{ agent_id: w.id, reason: 'review-only' }]);
    app.checkouts.recordRender(c.id, sameUser, admin);
    await app.mirror.checkoutChanged(c.id);
    expect(page(pathOf('handout', h.id)!)).toContain('Nothing to merge: review-only');
    expect(page(pathOf('checkout', c.id)!)).toContain('nothing to merge: review-only');
  });
});

describe('fix 4: one checkout branch per member', () => {
  it('two members report two branches and both reach the push list; a stored report without checkout_branch still means checkout/<id>', async () => {
    const n = ++seq;
    const t = await team(2, [`Lead Ana ${n}`, `Dev Bo ${n}`, `Dev Cy ${n}`]);
    const c = app.checkouts.start(t.id, admin);
    const [w1, w2] = t.workers as [typeof t.lead, typeof t.lead];
    const st = ok(await w1.call('checkout_status'));
    expect(st.checkout.checkout_branch).toBe(`checkout/${c.id}-${refSafe(`Dev Bo ${n}`, w1.id)}`);
    expect(st.checkout.checkout_branch).toMatch(new RegExp(`^checkout/${c.id}-dev-bo-\\d+$`));
    ok(await w1.call('checkout_progress', { status: 'checkpointing' }));
    expect(errOf(await w1.call('checkout_progress', { status: 'merged', ...clean, checkout_branch: 'feature/x', checkout_head: 'c'.repeat(40) }))).toBe('invalid_argument');
    expect(errOf(await w1.call('checkout_progress', { status: 'merged', ...clean, checkout_branch: st.checkout.checkout_branch }))).toBe('invalid_argument');
    ok(await w1.call('checkout_progress', { status: 'merged', ...clean, checkout_branch: st.checkout.checkout_branch, checkout_head: 'c'.repeat(40) }));
    const b2 = ok(await w2.call('checkout_status')).checkout.checkout_branch as string;
    expect(b2).not.toBe(st.checkout.checkout_branch);
    ok(await w2.call('checkout_progress', { status: 'checkpointing' }));
    ok(await w2.call('checkout_progress', { status: 'merged', ...clean, checkout_branch: b2, checkout_head: 'd'.repeat(40) }));
    // The lead's report is stored the old way: checkout_head and no checkout_branch (as on BIRAZ and TwinArk).
    app.checkouts.checkpointing(t.lead.id);
    app.checkouts.merged(t.lead.id, clean);
    const lh = app.checkouts.handouts(c.id).find((x) => x.agent_id === t.lead.id)!;
    const old = { ...JSON.parse(lh.report!), checkout_head: 'e'.repeat(40) };
    app.db.prepare('UPDATE handouts SET report=? WHERE id=?').run(JSON.stringify(old), lh.id);
    for (const m of t.all) app.checkouts.write(m.id, { folder: `f-${m.id}`, repo });
    expect(app.checkouts.checkout(c.id)!.status).toBe('ready');
    expect(JSON.parse(app.checkouts.handout(lh.id)!.body!).checkpoint.checkout_branch).toBe(`checkout/${c.id}`);
    const branches = app.checkoutKeys.pushList(app.checkouts.mustCheckout(c.id))[0]!.branches.filter((b) => b.unreviewed).map((b) => [b.branch, b.tip]);
    expect(branches).toEqual(expect.arrayContaining([[st.checkout.checkout_branch, 'c'.repeat(40)], [b2, 'd'.repeat(40)], [`checkout/${c.id}`, 'e'.repeat(40)]]));
    expect(branches).toHaveLength(3);
    app.checkouts.recordRender(c.id, sameUser, admin);
    await app.mirror.checkoutChanged(c.id);
    const readme = page(pathOf('checkout', c.id)!);
    for (const b of [st.checkout.checkout_branch, b2, `checkout/${c.id} at ${'e'.repeat(40)}`]) expect(readme).toContain(b);
    // A body written before this build (checkout_branch absent from the checkpoint) still renders checkout/<id>.
    const legacy = JSON.parse(app.checkouts.handout(lh.id)!.body!);
    delete legacy.checkpoint.checkout_branch;
    app.db.prepare('UPDATE handouts SET body=? WHERE id=?').run(JSON.stringify(legacy), lh.id);
    expect(app.checkoutKeys.pushList(app.checkouts.mustCheckout(c.id))[0]!.branches.some((b) => b.branch === `checkout/${c.id}` && b.tip === 'e'.repeat(40))).toBe(true);
    await app.mirror.checkoutChanged(c.id);
    expect(page(pathOf('handout', lh.id)!)).toContain(`checkout/${c.id} at ${'e'.repeat(40)}`);
  });
});

describe('fix 5: a next step on refusals', () => {
  it('a hidden thing keeps the generic words plus access_list/access_request; a refused tool names the missing grant', async () => {
    const a = app.keys.createAgent(`plain-${++seq}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 'k' }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_read' }], 'test', sys);
    const { call } = await loginAs(k.secret);
    const hidden = await call('file_read', { path: '/vault/G/missing.md' });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0]!.text).toContain(NOT_ALLOWED);
    const tool = await call('graph_stale');
    expect(errOf(tool)).toBe('denied');
    expect(tool.content[0]!.text).toContain('missing grant: `tool.invoke` on `tool:graph_stale`');
    expect(tool.content[0]!.text).toContain('access_request');
    expect(tool.structuredContent.missing_grant).toEqual({ action: 'tool.invoke', resource: 'tool:graph_stale' });
  });
});

describe('fix 6: contributor progress notes', () => {
  it('a member who is not the assignee adds a note without touching the lease, check-in time, state or version; non-members are refused', async () => {
    const t = await team(2);
    const [w1, w2] = t.workers as [typeof t.lead, typeof t.lead];
    const cred = (app.db.prepare('SELECT credential_id FROM team_members WHERE team_id=? AND agent_id=?').get(t.id, t.lead.id) as { credential_id: string }).credential_id;
    const lead = { agentId: t.lead.id, credId: cred, tokenHash: `th_${t.lead.id}`, rules: app.keys.rulesFor(cred), cap: [] };
    const id = app.teams.create_task(lead, { team_id: t.id, title: 'Umbrella', description: 'Everything.', operator_request: { source: 'test' } }).id;
    app.teams.assign(lead, { task_id: id, agent_id: w1.id });
    ok(await w1.call('task_start', { task_id: id }));
    ok(await w1.call('task_progress', { task_id: id, note: 'Started.', until: Date.now() + 3600_000 }));
    const before = app.teams.task(id)!;
    ok(await w2.call('task_progress', { task_id: id, note: 'I did the parser part.' }));
    const after = app.teams.task(id)!;
    for (const k of ['lease_expires_at', 'progress_until', 'status', 'version', 'assignee_agent_id', 'overdue_at'] as const) expect(after[k]).toBe(before[k]);
    const ev = app.db.prepare("SELECT actor_id, note FROM task_events WHERE task_id=? AND tool='task_progress' ORDER BY rowid DESC LIMIT 1").get(id) as { actor_id: string; note: string };
    expect(ev).toEqual({ actor_id: w2.id, note: 'I did the parser part.' });
    expect(errOf(await w2.call('task_progress', { task_id: id }))).toBe('invalid_argument');
    expect(errOf(await w2.call('task_progress', { task_id: id, note: 'x', until: Date.now() + 60_000 }))).toBe('invalid_argument');
    const outsider = (await team(1)).workers[0]!;
    expect(errOf(await outsider.call('task_progress', { task_id: id, note: 'Not mine.' }))).toBe('denied');
  });
});

describe('fix 7: graph_stale coverage', () => {
  it('reports the coverage of its scope and says when "no flags" is not a full check', async () => {
    const a = app.keys.createAgent(`reader-${++seq}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 'k' }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' },
      { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.create'], resource: 'path:/vault/G/**' }], 'test', sys);
    const { call } = await loginAs(k.secret);
    for (const n of ['one', 'two', 'three']) ok(await call('file_create', { path: `/vault/G/${n}.md`, content: `# ${n}\n\nText.` }));
    const r = await call('graph_stale', { path_prefix: '/vault/G' });
    const d = ok(r);
    expect(d.flags).toEqual([]);
    expect(d.coverage).toMatchObject({ notes_readable: 3, notes_indexed: 0, complete: false });
    expect(r.content[0]!.text).toContain('No flags, but 3 of 3 notes here are not indexed yet, so this is not a full check.');
    // Mark every note indexed at its current revision: coverage is full and the text says so.
    app.db.prepare("INSERT INTO kg_note_state(file_id,indexed_rev,coverage) SELECT id,current_revision,'current' FROM files WHERE path LIKE 'G/%' ON CONFLICT(file_id) DO UPDATE SET indexed_rev=excluded.indexed_rev, coverage='current'").run();
    const full = await call('graph_stale', { path_prefix: '/vault/G' });
    expect(ok(full).coverage).toMatchObject({ notes_readable: 3, notes_indexed: 3, coverage_pct: 100, complete: true });
    expect(full.content[0]!.text).toContain('3 of 3 notes here are indexed.');
  });
});

describe('fix 8: repo hosts up front', () => {
  it('the checkpoint steps and checkout_status name the allowed hosts before the handout', async () => {
    const t = await team(1);
    app.checkouts.start(t.id, admin);
    const r = await t.workers[0]!.call('checkout_status');
    const s = ok(r);
    expect(s.checkout.repo_hosts).toEqual(['github.com', 'gitlab.com']);
    expect(s.steps).toContain('`github.com`, `gitlab.com`');
    expect(r.content[0]!.text).toContain('Repo hosts a handout may name: `github.com`, `gitlab.com`.');
  });
});
