/**
 * The repo host allowlist at pickup (docs/checkout.md §8): a host removed after render is refused when the keys of the
 * checkout request are picked up, with repo_host_not_allowed as render answers, and no key is issued. The PC and team
 * are onboarded the real way, as in checkout-keys.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { RESTORE_TEMPLATE, scanClean } from './restoreTemplate.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base: string, cookie = '', csrf = '';
const admin = { kind: 'admin' as const, id: 'usr_test' };

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  if (method === 'POST' && path === '/pickup') scanClean(app.db, (o.body as { request_id?: unknown } | undefined)?.request_id);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.from) { headers['x-forwarded-for'] = o.from; headers['x-forwarded-proto'] = 'https'; }
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const nonce = () => `n${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24).padEnd(20, 'x');
/** A PC enrolled the real way, and a team of a coordinator and a worker onboarded from it. */
const onboarded = async () => {
  const add = await api('POST', '/pcs/add', { name: 'src-pc' });
  expect(add.status, JSON.stringify(add.body)).toBe(200);
  const n = nonce(), from = '10.9.0.1';
  const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
  await ob('POST', '/enrol/confirm', { body: { nonce: n }, from });
  const key = e.body.app_key as string;
  const f = await ob('POST', '/requests', { key, body: {
    kind: 'new_team', project: { name: 'Move', existing: false }, team: { name: 'Mover', goal: 'Move the work.' },
    roles: [{ name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'dev', team_role: 'worker', count: 1, job: 'Builds.' }],
    prompt: 'a small team', client: { app: 'claude-code', os: 'linux' },
  } });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
  const p = await ob('POST', '/pickup', { key, body: { request_id: f.body.request_id } });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const c = await ob('POST', '/pickup/confirm', { key, body: { pickup_id: p.body.pickup_id, written: p.body.agents.map((x: { session_var: string }) => x.session_var) } });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return { key, teamId: c.body.team_id as string };
};
const head = (c: string) => c.repeat(40);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahckp-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, repoHosts: ['git.example.org'] }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('pickup re-checks the repo host allowlist', () => {
  it('refuses a host removed since render, issues no key, and picks up once the host is back', async () => {
    const s = await onboarded();
    const st = await api('POST', `/teams/${s.teamId}/checkout`);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    const id = st.body.checkout.id as string;
    app.checkouts.handouts(id).forEach((h, i) => {
      app.checkouts.checkpointing(h.agent_id);
      app.checkouts.merged(h.agent_id, { integration_branch: 'integration/core', integration_head: head('abcd'[i]!), merge_commits: [head('e')], worktrees_left: 0, clean: true,
        leftover_check: { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] } });
      app.checkouts.write(h.agent_id, { folder: `core-${i}`, repo: { remote_name: 'origin', url: 'git@git.example.org:team/core.git', clone_folder: 'core' },
        provider_was: { provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' } });
    });
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'same_user' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const requestId = r.body.checkout.request_id as string;
    const creds = () => (app.db.prepare('SELECT COUNT(*) n FROM credentials').get() as { n: number }).n;
    const before = creds();

    app.checkouts.setRepoHosts(['github.com'], admin);
    const p = await ob('POST', '/pickup', { key: s.key, body: { request_id: requestId } });
    expect(p.status).toBe(400);
    expect(p.body).toMatchObject({ error: 'repo_host_not_allowed', hosts: ['git.example.org'] });
    expect(creds()).toBe(before);
    expect(app.db.prepare("SELECT 1 FROM audit_events WHERE action='checkout.repo_host_refused' AND target_id=?").get(id)).toBeTruthy();

    app.checkouts.setRepoHosts(['github.com', 'git.example.org'], admin);
    const p2 = await ob('POST', '/pickup', { key: s.key, body: { request_id: requestId } });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
  });
});
