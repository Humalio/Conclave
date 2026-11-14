/**
 * Checkout, operator side (docs/checkout.md §7, §8): the repo host allowlist (system settings, seeded from
 * CONCLAVE_REPO_HOSTS, else github.com) checked at checkout_handout and again at render, and the Attention feed
 * GET /api/checkouts?open=1 with the steps that wait on the operator. The new-PC approval step is covered in
 * checkout-keys.test.ts, where a PC enrols the real way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { ATTENTION_SOON_MS } from '../src/checkout/checkout.js';
import { repoHost, hostAllowed, validRepoHost, DEFAULT_REPO_HOSTS } from '../src/checkout/fields.js';
import { RESTORE_TEMPLATE } from './restoreTemplate.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base = '', cookie = '', csrf = '';
const admin = { kind: 'admin' as const, id: '' };
let seq = 0;

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
/** A running team of a coordinator and n workers, made directly (not onboarded). */
const team = (workers = 1) => {
  const n = ++seq;
  const mk = (label: string) => {
    const a = app.keys.createAgent(`${label}-h${n}`, null, admin);
    app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, admin);
    return a.id;
  };
  const lead = mk('lead');
  const ws = Array.from({ length: workers }, (_, i) => mk(`w${i}`));
  const t = app.teams.create({ name: `Host team ${n}`, goal: 'Move it.', members: [{ agent_id: lead, role: 'coordinator' }, ...ws.map((w) => ({ agent_id: w, role: 'worker' }))] }, admin);
  app.teams.start(t.id, admin);
  return { id: t.id, name: t.name, lead, workers: ws, all: [lead, ...ws] };
};
const none = { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] };
const clean = { integration_branch: 'integration/core', integration_head: 'a'.repeat(40), merge_commits: [], worktrees_left: 0, clean: true, leftover_check: none };
const handIn = (agentId: string, url?: string) => {
  app.checkouts.checkpointing(agentId);
  app.checkouts.merged(agentId, clean);
  return app.checkouts.write(agentId, { folder: `f-${agentId.slice(-6)}`, ...(url ? { repo: { remote_name: 'origin', url, clone_folder: 'core' } } : {}) });
};
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as { code: string }).code ?? String(e); } return 'ok'; };
const auditOf = (action: string) => app.db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY rowid').all(action) as { details: string; target_id: string | null }[];
const setHosts = (hosts: string[]) => app.checkouts.setRepoHosts(hosts, admin);
const needs = async (id: string) => ((await api('GET', '/checkouts?open=1')).body.checkouts as { id: string; needs_operator: { kind: string }[] }[]).find((c) => c.id === id)?.needs_operator;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahckh-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  const config: Config = testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  admin.id = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
});
afterAll(async () => { await app.close(); });

describe('repo host matching', () => {
  it('reads the host of https, ssh and scp-like URLs, lower-cased, never the user part', () => {
    expect(repoHost('https://github.com/team/core.git')).toBe('github.com');
    expect(repoHost('https://GitHub.COM:443/team/core.git')).toBe('github.com');
    expect(repoHost('ssh://git@github.com:22/team/core.git')).toBe('github.com');
    expect(repoHost('ssh://github.com/team/core.git')).toBe('github.com');
    expect(repoHost('git@github.com:team/core.git')).toBe('github.com');
    expect(repoHost('git@GITHUB.com:team/core.git')).toBe('github.com');
    expect(repoHost('https://github.com@evil.example/x.git')).toBe('evil.example');
    expect(repoHost('ssh://github.com@evil.example/x.git')).toBe('evil.example');
    for (const u of ['-x@github.com:y', 'https://-github.com/x', 'ssh://-oProxyCommand=x/y', 'git@-oX:y', 'file:///srv/x.git', '/srv/x.git', 'github.com:x/y', 42, null]) expect(repoHost(u), String(u)).toBeNull();
  });
  it('allows exact hosts only, case-insensitively, in every form; no subdomain, suffix or leading "-"', () => {
    const allow = ['github.com', 'git.example.org'];
    for (const u of ['https://github.com/a/b.git', 'ssh://git@github.com/a/b.git', 'git@github.com:a/b.git', 'https://GITHUB.com/a/b.git', 'git@Git.Example.org:a/b.git', 'ssh://git@git.example.org:2222/a/b.git']) expect(hostAllowed(u, allow), u).toBe(true);
    for (const u of ['https://gist.github.com/a.git', 'https://github.com.evil.example/a.git', 'https://evil.example/github.com/a.git', 'git@evilgithub.com:a/b.git', 'https://github.com@evil.example/a.git', '-x@github.com:a', 'ssh://-oProxyCommand=x/github.com', '']) expect(hostAllowed(u, allow), u).toBe(false);
    expect(hostAllowed('https://GitHub.com/a.git', ['GITHUB.COM'])).toBe(true);
    expect(hostAllowed('https://github.com/a.git', [])).toBe(false);
  });
  it('accepts host names only on the list', () => {
    for (const h of ['github.com', 'git.example.org', 'gitlab', 'a-b.c9.io']) expect(validRepoHost(h), h).toBe(true);
    for (const h of ['*.github.com', '-evil.com', 'github.com:22', 'https://github.com', 'github.com/', 'git@github.com', 'a..b', 'a-.com', '', ' github.com']) expect(validRepoHost(h), h).toBe(false);
  });
});

describe('the allowlist setting', () => {
  it('defaults to github.com, then the env seed, then what the operator saves', async () => {
    app.db.prepare("DELETE FROM system_settings WHERE key='checkout.repo_hosts'").run();
    const g = await api('GET', '/settings/checkout');
    expect(g.status).toBe(200);
    expect(g.body.settings).toMatchObject({ hosts: [...DEFAULT_REPO_HOSTS], source: 'default', default: ['github.com'] });
    expect(loadConfig({ VAULT_DIR: '.', KEY_PEPPER: 'x', CONCLAVE_REPO_HOSTS: ' GitHub.com, git.example.org ,' }).repoHosts).toEqual(['github.com', 'git.example.org']);
    expect(loadConfig({ VAULT_DIR: '.', KEY_PEPPER: 'x' }).repoHosts).toBeUndefined();
    app.checkouts.seedRepoHosts = ['git.example.org', 'bad host', 'GIT.example.org'];
    try {
      expect(app.checkouts.repoHosts()).toEqual({ hosts: ['git.example.org'], source: 'env' });
      const p = await api('PUT', '/settings/checkout', { repo_hosts: ['GitHub.com', 'github.com', ' code.example.net '] });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body.settings).toMatchObject({ hosts: ['github.com', 'code.example.net'], source: 'settings' });
      expect(JSON.parse(auditOf('checkout.repo_hosts_set').at(-1)!.details)).toEqual({ before: ['git.example.org'], after: ['github.com', 'code.example.net'], was: 'env' });
    } finally { app.checkouts.seedRepoHosts = null; }
    expect(app.checkouts.repoHosts().source).toBe('settings'); // a saved list outlives the seed
  });
  it('refuses wildcards, ports, schemes and a leading "-", and keeps the saved list', async () => {
    setHosts(['github.com']);
    for (const h of ['*.github.com', '-evil.com', 'github.com:22', 'https://github.com', 'git@github.com']) {
      const r = await api('PUT', '/settings/checkout', { repo_hosts: ['github.com', h] });
      expect(r.status, h).toBe(400);
      expect(r.body.error, h).toBe('invalid_argument');
    }
    expect((await api('PUT', '/settings/checkout', { repo_hosts: 'github.com' })).status).toBe(400);
    expect(app.checkouts.repoHosts().hosts).toEqual(['github.com']);
    expect((await api('PUT', '/settings/checkout', { repo_hosts: [] })).body.settings.hosts).toEqual([]); // no repo URL may move
    setHosts(['github.com']);
  });
  it('is admin-only and needs the CSRF header to change', async () => {
    const r = await fetch(`${base}/api/settings/checkout`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ repo_hosts: ['evil.example'] }) });
    expect(r.status).toBe(403);
    expect((await fetch(`${base}/api/settings/checkout`)).status).toBe(401);
    expect((await fetch(`${base}/api/checkouts?open=1`)).status).toBe(401);
    expect(app.checkouts.repoHosts().hosts).toEqual(['github.com']);
  });
});

describe('the allowlist at checkout_handout and render', () => {
  it('a handout naming a host off the list is refused, in https, ssh and scp forms, and audited', () => {
    setHosts(['github.com']);
    const t = team(1);
    const w = t.workers[0]!;
    // No open checkout: the agent learns nothing about the list, and no audit row is written.
    const before = auditOf('checkout.repo_host_refused').length;
    expect(code(() => app.checkouts.write(w, { folder: 'core', repo: { remote_name: 'origin', url: 'https://git.example.org/x.git' } }))).toBe('not_found');
    expect(auditOf('checkout.repo_host_refused').length).toBe(before);
    const co = app.checkouts.start(t.id, admin);
    app.checkouts.checkpointing(w);
    app.checkouts.merged(w, clean);
    const write = (url: string) => code(() => app.checkouts.write(w, { folder: 'core', repo: { remote_name: 'origin', url } }));
    for (const u of ['https://git.example.org/team/core.git', 'ssh://git@git.example.org/team/core.git', 'git@git.example.org:team/core.git', 'https://github.com@git.example.org/x.git', 'https://gist.github.com/x.git']) expect(write(u), u).toBe('repo_host_not_allowed');
    expect(JSON.parse(auditOf('checkout.repo_host_refused').at(-1)!.details)).toEqual({ at: 'handout', checkout: co.id, host: 'gist.github.com' });
    expect(auditOf('checkout.repo_host_refused').at(-1)!.target_id).toBe(co.id);
    expect(app.checkouts.handouts(app.checkouts.openFor(t.id)!.id).find((h) => h.agent_id === w)!.status).toBe('merged'); // nothing written
    for (const u of ['https://GitHub.com/team/core.git', 'ssh://git@github.com:22/team/core.git', 'git@GITHUB.COM:team/core.git']) expect(write(u), u).toBe('ok');
    expect(code(() => app.checkouts.write(w, { folder: 'core', repo: { remote_name: 'origin', clone_folder: 'core' } }))).toBe('ok'); // no URL, nothing to check
  });
  it('render refuses once the operator takes the host off the list, and goes on when it is back', async () => {
    setHosts(['github.com', 'git.example.org']);
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead, 'git@git.example.org:team/core.git');
    handIn(t.workers[0]!, 'https://github.com/team/core.git');
    expect(app.checkouts.checkout(c.id)!.status).toBe('ready');
    setHosts(['GitHub.com']);
    const r = await api('POST', `/checkouts/${c.id}/render`, { target: 'other_pc', new_pc_name: `host-pc-${seq}` });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'repo_host_not_allowed', agents: [t.lead], hosts: ['git.example.org'] });
    expect(JSON.parse(auditOf('checkout.repo_host_refused').at(-1)!.details)).toEqual({ at: 'render', agents: [t.lead], hosts: ['git.example.org'] });
    expect(app.checkouts.checkout(c.id)!.status).toBe('ready'); // nothing rendered, no PC or key created
    expect(app.keys.machines().some((m) => m.name === `host-pc-${seq}`)).toBe(false);
    setHosts(['github.com', 'git.example.org']);
    const ok = await api('POST', `/checkouts/${c.id}/render`, { target: 'other_pc', new_pc_name: `host-pc-${seq}` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(app.checkouts.checkout(c.id)!.status).toBe('rendered');
    // A rendered checkout rendered again checks the list as it stands then.
    setHosts([]);
    expect((await api('POST', `/checkouts/${c.id}/render`, { target: 'other_pc', new_pc_name: `host-pc-${seq}` })).body.error).toBe('repo_host_not_allowed');
    setHosts(['github.com']);
    app.checkouts.cancel(c.id, null, admin);
    // Not ready or rendered: render answers with the state, not the allowlist, and audits nothing.
    setHosts([]);
    const n = auditOf('checkout.repo_host_refused').length;
    expect((await api('POST', `/checkouts/${c.id}/render`, { target: 'other_pc', new_pc_name: `host-pc-${seq}` })).body.error).toBe('invalid_state');
    expect(auditOf('checkout.repo_host_refused').length).toBe(n);
    setHosts(['github.com']);
  });
  it('the checkout list takes a whole-number limit and ignores a fraction', async () => {
    for (const q of ['1.5', 'abc', '0', '999']) { const r = await api('GET', `/checkouts?limit=${q}`); expect(r.status, q).toBe(200); }
    expect(((await api('GET', '/checkouts?limit=1.5')).body.checkouts as unknown[]).length).toBeLessThanOrEqual(1);
  });
});

describe('Attention: GET /api/checkouts?open=1', () => {
  it('lists open checkouts with one item per step that waits on the operator', async () => {
    setHosts(['github.com']);
    const t = team(2);
    const c = app.checkouts.start(t.id, admin);
    const list = (await api('GET', '/checkouts?open=1')).body.checkouts as any[];
    const row = list.find((x) => x.id === c.id);
    expect(row).toMatchObject({ team_id: t.id, team: t.name, status: 'collecting', handouts: { total: 3, written: 0 }, needs_operator: [] }); // agents are working: nothing waits on the operator
    // Two agents list leftover exceptions: one item each.
    const [w0, w1] = t.workers as [string, string];
    for (const w of [w0, w1]) {
      app.checkouts.checkpointing(w);
      app.checkouts.merged(w, { ...clean, leftover_check: { ...none, scratch: [{ item: `tmp-${w.slice(-4)}`, reason: 'needed' }, { item: 'x', reason: 'y' }] } });
    }
    expect(await needs(c.id)).toEqual([
      expect.objectContaining({ kind: 'leftovers', agent_id: w0, count: 2 }),
      expect.objectContaining({ kind: 'leftovers', agent_id: w1, count: 2 }),
    ]);
    const sha = app.checkouts.view(c.id).handouts.find((h) => h.agent_id === w0)!.report_sha256!;
    app.checkouts.approveLeftovers(c.id, w0, sha, admin);
    expect((await needs(c.id))!.map((x: any) => x.agent_id)).toEqual([w1]);
    // Close to expiry, missing handouts wait on the operator too: go on without them, or cancel.
    app.db.prepare('UPDATE checkouts SET expires_at=? WHERE id=?').run(Date.now() + ATTENTION_SOON_MS - 60_000, c.id);
    expect(await needs(c.id)).toContainEqual(expect.objectContaining({ kind: 'handouts_missing', count: 3, of: 3 }));
    // Ready: render. Hub-built handouts are not counted as written by agents.
    handIn(t.lead);
    app.checkouts.proceed(c.id, admin);
    expect(await needs(c.id)).toEqual([expect.objectContaining({ kind: 'handouts_complete', count: 1, of: 3 })]);
    // Rendered: nothing waits until the prompt comes close to expiry without being run.
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin);
    expect(await needs(c.id)).toEqual([]);
    app.db.prepare('UPDATE checkouts SET expires_at=? WHERE id=?').run(Date.now() + 3600_000, c.id);
    expect(await needs(c.id)).toEqual([expect.objectContaining({ kind: 'prompt_expiring' })]);
    // Ended checkouts leave the open list; without open=1 they are still listed, with nothing waiting.
    app.checkouts.cancel(c.id, null, admin);
    expect(await needs(c.id)).toBeUndefined();
    const all = (await api('GET', '/checkouts')).body.checkouts as any[];
    expect(all.find((x) => x.id === c.id)).toMatchObject({ status: 'cancelled', needs_operator: [] });
  });
  it('the overdue alert names the team by id, so the console can open the checkout', () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin);
    app.checkouts.markRestoring(c.id, { kind: 'system', id: null });
    app.checkouts.sweep(app.checkouts.checkout(c.id)!.expires_at);
    const a = app.db.prepare("SELECT details FROM security_alerts WHERE type='checkout_overdue' AND subject=?").get(c.id) as { details: string };
    expect(JSON.parse(a.details)).toMatchObject({ team: t.id, team_id: t.id });
    app.checkouts.cancel(c.id, null, admin, { force: true });
  });
});
