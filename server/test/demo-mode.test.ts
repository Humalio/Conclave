/**
 * Demo mode (docs/showcase.md#demo-mode): without DEMO_MODE the routes do not exist; with it, a replay resets the hub to
 * the story's start (admins, sessions and the audit trail kept) and runs the whole story in-process; Stop aborts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { adminLogin, testConfig } from './hub.js';
import { loadConfig } from '../src/config.js';
import { DemoHost, DEMO_MARKER, type DemoState } from '../src/demo/demo.js';

const STORY_VAULT = resolve(process.cwd(), '..', 'eval', 'vault');
const cfg = (dir: string, demoMode: boolean): Config => testConfig(dir, {
  publicUrl: 'http://127.0.0.1', adminUsername: 'demo', adminPassword: 'demo-password-long', vaultScanSeconds: 5, vaultWatch: true, demoMode, graph: { debounceMs: 1000 },
});
const signIn = (base: string) => adminLogin(base, 'demo', 'demo-password-long');
const call = async (base: string, s: { cookie: string; csrf: string } | null, method: string, path: string, body?: unknown, csrf = true) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie, ...(csrf ? { 'x-csrf-token': s.csrf } : {}) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const waitFor = async (host: DemoHost, done: (s: DemoState) => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (done(host.demo!.state)) return host.demo!.state; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`timed out; state ${JSON.stringify(host.demo!.state).slice(0, 300)}`);
};

describe('demo mode in production', () => {
  const env = { VAULT_DIR: '/v', KEY_PEPPER: 'p', DEMO_MODE: '1', NODE_ENV: 'production' };
  it('is refused unless the hub says it is a demonstrator', () => {
    expect(() => loadConfig(env)).toThrow(/DEMO_MODE is not allowed/);
    expect(loadConfig({ ...env, DEMO_ALLOW_PRODUCTION: '1' }).demoMode).toBe(true);
    expect(loadConfig({ ...env, NODE_ENV: 'development' }).demoMode).toBe(true);
  });
});

describe('demo mode off', () => {
  let app: App, base = '';
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahdemo-off-'));
    mkdirSync(join(dir, 'vault'));
    app = await buildApp(cfg(dir, false));
    await app.store.ready;
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await app?.close(); });

  it('has no demo routes and says so in /api/me', async () => {
    const s = await signIn(base);
    expect((await call(base, s, 'GET', '/me')).body.demo).toBe(false);
    expect((await call(base, s, 'GET', '/demo')).status).toBe(404);
    expect((await call(base, s, 'POST', '/demo/replay', { pace: 'instant' })).status).toBe(404);
    expect((await call(base, s, 'POST', '/demo/stop', {})).status).toBe(404);
  });

  it('a host without demo mode has no controller and refuses to reset', async () => {
    const host = new DemoHost(cfg(mkdtempSync(join(tmpdir(), 'ahdemo-x-')), false));
    expect(host.demo).toBeUndefined();
    await expect(host.resetAndRebuild()).rejects.toThrow(/Demo mode is off/);
  });
});

describe('demo mode on', () => {
  let host: DemoHost, dir = '';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ahdemo-on-'));
    cpSync(STORY_VAULT, join(dir, 'vault'), { recursive: true });
    writeFileSync(join(dir, 'vault', DEMO_MARKER), 'demo\n'); // as a replay leaves it
    host = new DemoHost(cfg(dir, true));
    await host.start();
    await host.app.store.ready;
  }, 60_000);
  afterAll(async () => { host?.demo?.stop(); await host?.app?.close(); });

  it('refuses to wipe a vault that is not a demo vault, and leaves it untouched', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'ahdemo-real-'));
    mkdirSync(join(d2, 'vault'));
    writeFileSync(join(d2, 'vault', 'My notes.md'), '# mine\n');
    const real = new DemoHost(cfg(d2, true));
    await real.start(); await real.app.store.ready;
    try {
      const s = await signIn(real.base);
      const r = await call(real.base, s, 'POST', '/demo/replay', { pace: 'instant' });
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain('not a demo vault');
      expect(real.demo!.state.phase).toBe('idle');
      await expect(real.resetAndRebuild()).rejects.toThrow(/not a demo vault/);
      expect(readFileSync(join(d2, 'vault', 'My notes.md'), 'utf8')).toBe('# mine\n');
      expect((await call(real.base, s, 'GET', '/me')).status).toBe(200); // nothing was reset
    } finally { await real.app.close(); }
  });

  it('needs the operator and CSRF, and lists the story', async () => {
    expect((await call(host.base, null, 'POST', '/demo/replay', { pace: 'instant' })).status).toBe(401);
    const s = await signIn(host.base);
    expect((await call(host.base, s, 'POST', '/demo/replay', { pace: 'instant' }, false)).status).toBe(403);
    expect((await call(host.base, s, 'POST', '/demo/replay', { pace: 'fast' })).status).toBe(400);
    expect((await call(host.base, s, 'POST', '/demo/replay', { from: 4, until: 2 })).status).toBe(400);
    const info = (await call(host.base, s, 'GET', '/demo')).body;
    expect(info.title).toBe('The Early Echo');
    expect(info.acts.map((a: any) => a.act)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(info.state.phase).toBe('idle');
    expect((await call(host.base, s, 'GET', '/me')).body.demo).toBe(true);
  });

  it('an instant replay of Acts 0-1: reset, the story, the operator stays signed in, the audit names who started it, nothing from before survives', async () => {
    const s = await signIn(host.base);
    // Something to be wiped: a stray note in the vault and a leftover agent.
    writeFileSync(join(dir, 'vault', 'stray.md'), '# stray\n');
    expect((await call(host.base, s, 'POST', '/agents', { label: 'Leftover', project: null })).status).toBe(200);
    // And what the story itself leaves: a member, and settings it changes.
    const old = await call(host.base, s, 'POST', '/users', { username: 'old-member', display_name: 'Nadia Okafor' });
    expect(old.status).toBe(200);
    expect((await call(host.base, s, 'PUT', `/users/${old.body.user.id}/folder-grants`, { grants: [{ path: '/Case Command/', mode: 'read' }] })).status).toBe(200);
    expect((await call(host.base, s, 'PUT', '/settings/onboarding', { max_agents: 7 })).status).toBe(200);
    expect((await call(host.base, s, 'PUT', '/feedback/settings', { enabled: false })).status).toBe(200);
    const r = await call(host.base, s, 'POST', '/demo/replay', { pace: 'instant', until: 1 });
    expect(r.status).toBe(202);
    expect(r.body.state.phase).toBe('resetting');
    expect((await call(host.base, s, 'POST', '/demo/replay', { pace: 'instant' })).status).toBe(409);
    const end = await waitFor(host, (st) => !['resetting', 'running'].includes(st.phase), 240_000);
    expect(end.result?.message ?? null).toBeNull();
    expect(end.phase).toBe('done');
    expect(end.result?.coverage).toMatch(/partial run/);
    expect(end.index).toBe(end.total);
    // The vault was replaced, so the stray note is gone; the old agent is gone too.
    expect(existsSync(join(dir, 'vault', 'stray.md'))).toBe(false);
    const agents = (await call(host.base, s, 'GET', '/agents')).body.agents.map((a: any) => a.label);
    expect(agents).not.toContain('Leftover');
    expect(agents).toContain('Hesper');
    // The member and the changed settings are gone: a replay starts the same way every time.
    expect((await call(host.base, s, 'GET', '/users')).body.users.map((u: any) => u.username)).not.toContain('old-member');
    expect((await call(host.base, s, 'GET', '/settings/onboarding')).body.settings.max_agents).not.toBe(7);
    expect((await call(host.base, s, 'GET', '/feedback/settings')).body.enabled).toBe(true);
    // The same session still works after the rebuild; the audit kept the replay.
    expect((await call(host.base, s, 'GET', '/me')).status).toBe(200);
    const audit = host.app.db.prepare("SELECT action, actor_kind FROM audit_events WHERE action LIKE 'demo.%'").all() as any[];
    expect(audit).toEqual(expect.arrayContaining([{ action: 'demo.replay', actor_kind: 'admin' }, { action: 'demo.finish', actor_kind: 'system' }]));
    expect(readFileSync(join(dir, 'vault', 'Case Command', 'Case board.md'), 'utf8')).toContain('Case board');
    expect(existsSync(join(dir, 'vault', DEMO_MARKER))).toBe(true); // the replay marks its vault for the next one
  }, 300_000);

  it('the full replay leaves actionable work, Blueprint evidence and a scoped collaborator', async () => {
    const s = await signIn(host.base);
    expect((await call(host.base, s, 'POST', '/demo/replay', { pace: 'instant' })).status).toBe(202);
    const end = await waitFor(host, (st) => !['resetting', 'running'].includes(st.phase), 240_000);
    expect(end.result?.message ?? null).toBeNull();
    expect(end.phase).toBe('done');
    const get = async (path: string) => (await call(host.base, s, 'GET', path)).body;
    const attention = await get('/needs-you?limit=200');
    expect(attention.items.map((x: any) => x.title)).toContain('Who should be listening at 22:14 on 9 June?');
    expect(attention.items.map((x: any) => x.kind)).toContain('access_request');
    expect(attention.later.items.map((x: any) => x.title)).toContain('Which archive gets the duplicate clock strips?');
    expect(attention.awareness.items.map((x: any) => x.kind)).toContain('team_paused');
    const command = (await get('/teams')).teams.find((t: any) => t.name === 'Case Command');
    expect((await get(`/teams/${command.id}/tasks?status=all`)).tasks.map((t: any) => t.status))
      .toEqual(expect.arrayContaining(['assigned', 'in_progress', 'blocked', 'in_review', 'changes_requested', 'approved']));
    const bp = await get(`/projects/${command.project_id}/blueprint?kind=hypothesis,milestone,paper&detail=full`);
    expect(bp.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'hypothesis', status: 'inconclusive' }),
      expect.objectContaining({ key: 'M1', status: 'reached' }),
      expect.objectContaining({ key: 'M6', status: 'reached' }),
      expect.objectContaining({ kind: 'paper', fields: expect.objectContaining({ manuscript: '/vault/Signals Lab/Echo model v2.md' }) }),
    ]));
    const paper = bp.items.find((i: any) => i.kind === 'paper');
    const outline = await fetch(`${host.base}/api/projects/${command.project_id}/export.md?paper=${paper.key}`, { headers: { cookie: s.cookie } });
    expect(await outline.text()).toContain('1 of 2 claims supported');
    const guest = (await get('/users')).users.find((u: any) => u.username === 'echo-guest');
    expect(guest.status).toBe('active');
    expect((await get(`/users/${guest.id}/folder-grants`)).folder_grants.map((g: any) => g.path)).toEqual(['/Captures/', '/Case Command/'].sort());
    expect((await get('/lockdown')).pcs).toHaveLength(1);
    const watch = (await get('/keys')).keys.find((k: any) => k.label === 'Watch console session' && k.status === 'active');
    expect((await get(`/keys/${watch.id}/handover`)).confirmed?.key).toBeTruthy();
  }, 300_000);

  it('a failed vault copy still brings the hub back up', async () => {
    const d3 = mkdtempSync(join(tmpdir(), 'ahdemo-fail-'));
    mkdirSync(join(d3, 'vault'));
    mkdirSync(join(d3, 'story'));
    writeFileSync(join(d3, 'story', 'vault'), 'a file where the story vault folder should be\n');
    const was = process.env.DEMO_STORY_DIR;
    process.env.DEMO_STORY_DIR = join(d3, 'story');
    const h = new DemoHost(cfg(d3, true));
    try {
      await h.start(); await h.app.store.ready;
      await expect(h.resetAndRebuild()).rejects.toThrow();
      expect((await fetch(`${h.base}/health`)).ok).toBe(true);
    } finally { if (was === undefined) delete process.env.DEMO_STORY_DIR; else process.env.DEMO_STORY_DIR = was; await h.app?.close(); }
  });

  it('Stop aborts a paced replay cleanly, and a new replay can start afterwards', async () => {
    const s = await signIn(host.base);
    expect((await call(host.base, s, 'POST', '/demo/replay', { pace: '1x', until: 1 })).status).toBe(202);
    await waitFor(host, (st) => st.phase === 'running' && st.index >= 3, 60_000);
    const st = await call(host.base, s, 'POST', '/demo/stop', {});
    expect(st.body.stopped).toBe(true);
    const end = await waitFor(host, (x) => !['resetting', 'running'].includes(x.phase), 30_000);
    expect(end.phase).toBe('stopped');
    expect(end.result?.message).toMatch(/Stopped/);
    expect((await call(host.base, s, 'POST', '/demo/stop', {})).body.stopped).toBe(false);
    expect(host.app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='demo.stop'").get()).toEqual({ n: 1 });
  }, 120_000);
});
