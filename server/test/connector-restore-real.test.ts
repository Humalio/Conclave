/**
 * The connector's restore against the real hub (docs/checkout.md §6): a team onboarded the real way, a checkout ready and
 * rendered, then deploy/client/connector/restore.mjs runs against the hub's own routes (scan, scan gate, pickup, confirm,
 * trust, key suspension) through a TLS front, exactly as the worker would. Ends with every agent's checkout_resume accepted
 * over MCP with its new key, and the old keys suspended. A throwaway git repo stands in for the team's remote.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { LEFTOVER_KINDS } from '../src/checkout/fields.js';
import { RESTORE_TEMPLATE } from './restoreTemplate.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error plain ESM without types
import { testCa } from './test-ca.mjs';
// @ts-expect-error plain ESM without types
import { putHub, readKeyFile, agentKey } from '../../deploy/client/connector/keyfile.mjs';
// @ts-expect-error plain ESM without types
import { connect } from '../../deploy/client/connector/hubclient.mjs';
// @ts-expect-error plain ESM without types
import { addDestination } from '../../deploy/client/connector/destinations.mjs';
// @ts-expect-error plain ESM without types
import { pendingList, approvePickup } from '../../deploy/client/connector/approvals.mjs';
// @ts-expect-error plain ESM without types
import { beginRestore, runRestore } from '../../deploy/client/connector/restore.mjs';
// @ts-expect-error plain ESM without types

const hasGit = spawnSync('git', ['--version']).status === 0;
let app: App, base = '', cookie = '', csrf = '', front: https.Server, frontOrigin = '';
const tmp: string[] = [];
const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
const G = (dir: string, ...a: string[]) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.from) { headers['x-forwarded-for'] = o.from; headers['x-forwarded-proto'] = 'https'; }
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let b: any; try { b = JSON.parse(text); } catch { b = text; }
  return { status: r.status, body: b };
};
const clients: Client[] = [];
async function login(appKey: string, secret: string, url = `${base}/mcp`) {
  const c = new Client({ name: 'claude-code', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  clients.push(c);
  const r = (await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as any;
  const token = r.structuredContent?.session_token as string | undefined;
  return { error: r.isError ? r.structuredContent?.error : null, call: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as any };
}

beforeAll(async () => {
  const dir = mk('ahrr-');
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  const config: Config = testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client, repoHosts: ['git.lab.example'] });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  front?.closeAllConnections?.(); front?.close();
  await app?.close();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('the connector restores a moved team on the real hub', () => {
  it('render, restore by the connector, every agent resumes with its new key, the old keys are suspended', async () => {
    // A TLS front for the hub: the connector speaks https only.
    const pki = testCa('Real restore CA');
    const hubPort = (app.fastify.server.address() as { port: number }).port;
    front = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
      const up = http.request({ host: '127.0.0.1', port: hubPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(up);
    });
    await new Promise<void>((ok) => front.listen(0, '127.0.0.1', () => ok()));
    frontOrigin = `https://127.0.0.1:${(front.address() as { port: number }).port}`;

    // The team's remote: a local repo that stands in for https://git.lab.example/core.git.
    const src = join(mk('ahrr-src-'), 'core');
    mkdirSync(src);
    G(src, 'init', '-q', '-b', 'integration/core');
    writeFileSync(join(src, 'a.txt'), 'one\n'); G(src, 'add', '.'); G(src, 'commit', '-qm', 'one');
    const first = G(src, 'rev-parse', 'HEAD');
    writeFileSync(join(src, 'a.txt'), 'two\n'); G(src, 'commit', '-qam', 'two');
    const tip = G(src, 'rev-parse', 'HEAD');
    // Restore's safe git drops every inherited GIT_* variable, so the rewrite lives in a user-level git config (XDG).
    const xdg = mk('ahrr-xdg-');
    mkdirSync(join(xdg, 'git'));
    writeFileSync(join(xdg, 'git', 'config'), `[url "${src.replace(/\\/g, '/')}"]\n\tinsteadOf = https://git.lab.example/core.git\n`);
    process.env.XDG_CONFIG_HOME = xdg;

    // A PC enrolled the real way and a team onboarded from it (running, keys confirmed), both agents logged in.
    const add = await api('POST', '/pcs/add', { name: 'real-restore-pc' });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const nn = `n${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24).padEnd(20, 'x');
    const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: nn }, from: '10.9.0.1' });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    await ob('POST', '/enrol/confirm', { body: { nonce: nn }, from: '10.9.0.1' });
    const appKey = e.body.app_key as string;
    const f = await ob('POST', '/requests', { key: appKey, body: {
      kind: 'new_team', project: { name: 'Real Move', existing: false }, team: { name: 'Real Movers', goal: 'Move the work.' },
      roles: [{ name: 'lead', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'dev', team_role: 'worker', count: 1, job: 'Builds.' }],
      prompt: 'a small team', client: { app: 'claude-code', os: 'linux' } } });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
    const p0 = await ob('POST', '/pickup', { key: appKey, body: { request_id: f.body.request_id } });
    expect(p0.status, JSON.stringify(p0.body)).toBe(200);
    expect((await ob('POST', '/pickup/confirm', { key: appKey, body: { pickup_id: p0.body.pickup_id, written: p0.body.agents.map((x: any) => x.session_var) } })).status).toBe(200);
    const teamId = app.onboarding.request(f.body.request_id)!.team_id as string;
    const olds = p0.body.agents as { agent_id: string; secret: string; session_var: string; folder: string; role: string }[];
    const oldLogins = [];
    for (const a of olds) { const l = await login(appKey, a.secret); expect(l.error).toBeNull(); oldLogins.push(l); }

    // A ready checkout with real heads, rendered for another PC (rotation forced: new keys).
    const s = await api('POST', `/teams/${teamId}/checkout`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const id = s.body.checkout.id as string;
    const none = Object.fromEntries(LEFTOVER_KINDS.map((k: string) => [k, []]));
    app.checkouts.handouts(id).forEach((h, i) => {
      app.checkouts.checkpointing(h.agent_id);
      app.checkouts.merged(h.agent_id, { integration_branch: 'integration/core', integration_head: tip, merge_commits: [first], worktrees_left: 0, clean: true, leftover_check: none });
      app.checkouts.write(h.agent_id, { folder: `core-${i}`, notes: `Next for ${i}: the parser.`, repo: { remote_name: 'origin', url: 'https://git.lab.example/core.git', clone_folder: 'core' },
        provider_was: { provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' } });
    });
    expect(app.checkouts.checkout(id)!.status).toBe('ready');
    const add2 = await api('POST', '/pcs/add', { name: 'real-restore-target' });
    const nn2 = `m${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 24).padEnd(20, 'x');
    const e2 = await ob('POST', '/enrol', { body: { code: add2.body.code, nonce: nn2 }, from: '10.9.0.2' });
    await ob('POST', '/enrol/confirm', { body: { nonce: nn2 }, from: '10.9.0.2' });
    const targetKey = e2.body.app_key as string;
    const r = await api('POST', `/checkouts/${id}/render`, { target: 'other_pc', machine_id: add2.body.pc.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.checkout.status).toBe('rendered');
    expect(r.body.restore_sent, 'no destination approved on the target yet: the operator sends Restore').toBe(false);

    // The target PC's connector: a key file, a destination its user approved, then the restore run.
    const base2 = mk('ahrr-pc-'), home = join(base2, 'conclave home'), dest = join(base2, 'dest'), claudeJson = join(base2, 'claude.json');
    mkdirSync(home, { recursive: true }); mkdirSync(dest);
    writeFileSync(join(home, 'conclave.mjs'), '');
    const hubKey = putHub(home, { hubId: 'hub-real', origin: frontOrigin, caPem: pki.caPem, appKey: targetKey });
    const section = readKeyFile(home).data.hubs[hubKey];
    const d = addDestination(home, dest, 'Real dest').destination;
    const cx = { home, hubKey, section, hub: connect(section).hub, auth: { Authorization: `Bearer ${targetKey}` }, claudeJson };
    const st = beginRestore(home, hubKey, { id: 'pca_real1', kind: 'restore', payload: { checkout_id: id, destination_id: d.id } });
    // The PC user allows the key pickup on the connector's screen (one click per move), then the restore carries on.
    const wait = await runRestore(cx, st);
    expect(wait.phase, JSON.stringify(wait)).toBe('waiting');
    const pick = pendingList(home).pickups as { key: string }[];
    expect(pick).toHaveLength(1);
    expect(approvePickup(home, pick[0]!.key)).toBe(true);
    const run = await runRestore(cx, st);
    expect(run.phase, JSON.stringify(run)).toBe('done');
    expect(run.start_lines).toHaveLength(2);

    // The hub's view: confirmed, restoring, the old keys suspended, the folders built with the connector's entries.
    expect(app.checkouts.checkout(id)!.status).toBe('restoring');
    for (const a of olds) {
      const l = await login(appKey, a.secret);
      expect(l.error, 'an old key cannot log in any more').toBeTruthy();
    }
    const dir0 = join(dest, 'Real Move', 'core-0');
    expect(JSON.parse(readFileSync(join(dir0, '.mcp.json'), 'utf8')).mcpServers.conclave.args[1]).toBe('mcp');
    expect(existsSync(join(dir0, 'AGENTS.override.md'))).toBe(false);
    expect(readFileSync(join(dest, 'Real Move', 'core', 'a.txt'), 'utf8').replace(/\r/g, '')).toBe('two\n');

    // Move team with no one at the keyboard (docs/connector.md, "Reason orders"): the hub's restore order reports done from the
    // target PC, and each moved agent's new PC gets one resume order, so the restored agent calls checkout_resume by itself.
    const tgt = add2.body.pc.id as string, order = 'pca_realrestore1', t0 = Date.now();
    app.db.prepare("INSERT INTO pc_actions(id,machine_id,kind,state,payload,created_at,created_by,expires_at) VALUES (?,?,'restore','queued',?,?,'test',?)")
      .run(order, tgt, JSON.stringify({ checkout_id: id, destination_id: d.id }), t0, t0 + 3600_000);
    const cnAt = (method: string, path: string, body?: unknown) => fetch(`${base}/connector/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${targetKey}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await cnAt('GET', '/orders')).status).toBe(200);
    expect((await cnAt('POST', `/orders/${order}/result`, { state: 'done', result: {} })).status).toBe(200);
    for (const a of olds) {
      const o = app.db.prepare("SELECT machine_id, payload FROM pc_actions WHERE kind='deliver' AND json_extract(payload,'$.agent_id')=? AND json_extract(payload,'$.reason')='resume'").all(a.agent_id) as { machine_id: string; payload: string }[];
      expect(o, 'one resume order per moved agent, on the target PC').toEqual([{ machine_id: tgt, payload: JSON.stringify({ agent_id: a.agent_id, items: [], reason: 'resume' }) }]);
    }

    // Every agent resumes with its new key (from the connector's key file): accepted, and the checkout ends restored.
    const kf = readKeyFile(home).data.hubs[hubKey];
    for (let i = 0; i < olds.length; i++) {
      const l = await login(targetKey, agentKey(kf, `core-${i}`), `${base}/mcp`);
      expect(l.error).toBeNull();
      const res = await l.call('checkout_resume', { client: 'claude-code' });
      expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
      expect(res.structuredContent.handout.notes).toMatch(/the parser/);
    }
    expect(app.checkouts.checkout(id)!.status).toBe('restored');
  }, 120_000);
});
