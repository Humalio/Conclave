// Hub fixture: build, start on 18090 with a fresh data dir and a fresh vault copy, create keys/team, snapshot/restore.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, existsSync, openSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { WORK, FIXTURE, SERVER, HERE, PORT, BASE, Admin, readJson, writeJson, sleep, mcpSession, ensureFixture } from './lib.mjs';

const D = { data: join(WORK, 'data'), vault: join(WORK, 'vault'), sdata: join(WORK, 'snap-data'), svault: join(WORK, 'snap-vault'), state: join(WORK, 'state.json') };
const FS = ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.history', 'fs.rename'];
const allow = (actions, resource) => ({ effect: 'allow', actions, resource });
const TOOLS = (r) => allow(['tool.invoke'], r);
const DENY_PRIVATE = { effect: 'deny', actions: ['fs.read', 'fs.list', 'fs.search', 'fs.create', 'fs.update', 'fs.history'], resource: 'path:/vault/Private/**' };
const RO = ['fs.list', 'fs.read', 'fs.search'];
const TEMPLATES = {
  'eval-writer': [TOOLS('tool:*'), allow(FS, 'path:/vault/**'), allow(['graph.read'], 'graph:*'), allow(['share.create', 'share.upload', 'share.read', 'share.comment', 'share.suggest', 'share.promote'], 'share:*')],
  'eval-reader': [TOOLS('tool:*'), allow(RO, 'path:/vault/**'), allow(['graph.read'], 'graph:*')],
  'eval-restricted': [TOOLS('tool:*'), allow(RO, 'path:/vault/**'), allow(['graph.read'], 'graph:*'), DENY_PRIVATE],
  'eval-fileonly': [TOOLS('tool:session_*'), TOOLS('tool:file_*'), TOOLS('tool:access_*'), allow(RO, 'path:/vault/**')],
  'eval-fileonly-restricted': [TOOLS('tool:session_*'), TOOLS('tool:file_*'), TOOLS('tool:access_*'), allow(RO, 'path:/vault/**'), DENY_PRIVATE],
};
// name -> [template, team role | null]
const KEYS = {
  cur: ['eval-reader', 'curator'], wrk: ['eval-writer', 'worker'], coord: ['eval-writer', 'coordinator'], rev: ['eval-reader', 'reviewer'],
  setup: ['eval-writer', null], reader: ['eval-reader', null],
  qa: ['eval-reader', null], qa_r: ['eval-restricted', null], base: ['eval-fileonly', null], base_r: ['eval-fileonly-restricted', null],
};

export class Hub {
  constructor() { this.proc = null; this.state = readJson(D.state, null); }
  static dirs = D;
  build() {
    const r = spawnSync('npm', ['run', 'build'], { cwd: SERVER, shell: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('build failed\n' + (r.stdout + r.stderr).slice(-2000));
  }
  async start() {
    if (this.proc) return;
    const s = this.state;
    const log = openSync(join(WORK, 'hub.log'), 'a');
    this.proc = spawn(process.execPath, [join(HERE, "serve.mjs")], { stdio: ["ignore", log, log, "ipc"], windowsHide: true, env: this.envVars() });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('hub start timeout')), 60000); this.proc.once('message', () => { clearTimeout(t); res(); }); this.proc.once('exit', (c) => rej(new Error('hub exited ' + c))); });
    this.admin = await new Admin(s.adminUser, s.adminPass).login();
  }
  envVars() {
    const s = this.state;
    return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, HUB_DIST: join(SERVER, "dist"), VAULT_DIR: D.vault, DATA_DIR: D.data, PORT: String(PORT), HOST: "127.0.0.1",
      ADMIN_USERNAME: s.adminUser, ADMIN_PASSWORD: s.adminPass, KEY_PEPPER: s.pepper, LOG_LEVEL: "warn", VAULT_SCAN_SECONDS: "0", VAULT_WATCH: "0" };
  }
  /** Background hub that outlives this process (pid in WORK/hub.pid). */
  async startDetached() {
    const log = openSync(join(WORK, "hub.log"), "a");
    const p = spawn(process.execPath, [join(HERE, "serve.mjs")], { detached: true, stdio: ["ignore", log, log], windowsHide: true, env: this.envVars() });
    p.unref();
    writeFileSync(join(WORK, "hub.pid"), String(p.pid));
    for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* starting */ } await sleep(500); }
    throw new Error("hub did not come up");
  }
  async stop() {
    if (!this.proc) return;
    const p = this.proc; this.proc = null;
    await new Promise((res) => { p.once('exit', res); try { p.send('quit'); } catch { p.kill(); } setTimeout(() => { p.kill(); res(); }, 8000); });
    await sleep(300);
  }
  /** Fresh data dir + fresh vault copy, keys, team. Secrets live in state.json under WORK only. */
  async fresh() {
    await this.stop();
    for (const d of [D.data, D.vault, D.sdata, D.svault]) rmSync(d, { recursive: true, force: true });
    mkdirSync(D.data, { recursive: true });
    ensureFixture('vault');
    cpSync(join(FIXTURE, 'vault'), D.vault, { recursive: true });
    this.state = { adminUser: 'eval-admin', adminPass: randomBytes(18).toString('hex'), pepper: randomBytes(24).toString('hex'), keys: {} };
    writeJson(D.state, this.state);
    await this.start();
    const a = this.admin;
    const pc = (await a.post('/api/pcs', { name: 'eval-pc' })).pc;
    const ak = await a.post('/api/keys', { kind: 'app_key', machine_id: pc.id, app_name: 'claude-code' });
    this.state.appKey = ak.secret;
    const tpl = {};
    for (const [name, rules] of Object.entries(TEMPLATES)) tpl[name] = (await a.post('/api/templates', { name, description: 'eval', rules })).id;
    const agents = {};
    for (const [name, [t]] of Object.entries(KEYS)) {
      const k = await a.post('/api/keys', { kind: 'session_key', new_agent: { label: `eval-${name}` }, label: `eval-${name}`, template_id: tpl[t] });
      this.state.keys[name] = { secret: k.secret, credId: k.key.id, agentId: k.key.agent_id };
      agents[name] = k.key.agent_id;
    }
    const members = Object.entries(KEYS).filter(([, [, role]]) => role).map(([n, [, role]]) => ({ agent_id: agents[n], role }));
    const team = (await a.post('/api/teams', { name: 'Knowledge', goal: 'Curate and use the Halden vault together.', members, grant_messaging: true })).team;
    await a.post(`/api/teams/${team.id}/start`);
    this.state.teamId = team.id;
    for (const p of ['haiku*', 'sonnet*']) await a.put('/api/graph/tier', { pattern: p, tier: 'strong' });
    writeJson(D.state, this.state);
    return this.state;
  }
  async snapshot() {
    await this.stop();
    for (const d of [D.sdata, D.svault]) rmSync(d, { recursive: true, force: true });
    cpSync(D.data, D.sdata, { recursive: true }); cpSync(D.vault, D.svault, { recursive: true });
    await this.start();
  }
  async restore() {
    await this.stop();
    for (const d of [D.data, D.vault]) rmSync(d, { recursive: true, force: true });
    cpSync(D.sdata, D.data, { recursive: true }); cpSync(D.svault, D.vault, { recursive: true });
    await this.start();
  }
  hasSnapshot() { return existsSync(D.sdata) && existsSync(D.state); }
  key(name) { return this.state.keys[name].secret; }
  agentId(name) { return this.state.keys[name].agentId; }
  session(name) { return mcpSession(this.state.appKey, this.key(name)); }
  /** Read-only view of the hub DB (WAL: safe while the server runs). */
  db() { return new DatabaseSync(join(D.data, 'agent-hub.db'), { readOnly: true }); }
  vaultPath(rel) { return join(D.vault, rel); }
  /** Apply a task's setup (replace/create) through the file tools so that write signals fire. */
  async applySetup(setup, who = 'setup') {
    const s = await this.session(who);
    for (const op of setup) {
      const path = `/vault/${op.path}`;
      if (op.op === 'create') { const r = await s.call('file_create', { path, content: op.content }); if (r.isError) throw new Error(`create ${op.path}: ${r.text}`); continue; }
      const cur = await s.call('file_read', { path });
      const text = cur.data?.content ?? '';
      if (!text.includes(op.old)) throw new Error(`setup: old text not found in ${op.path}`);
      const r = await s.call('file_update', { path, content: text.replace(op.old, op.new), base_revision: cur.data.revision });
      if (r.isError) throw new Error(`update ${op.path}: ${r.text}`);
    }
    await s.close();
  }
}

// ───── CLI: node hub.mjs up <task-id|all> | down ─────
export const ROLES = { curator: ['cur', 'haiku-4.5'], worker: ['wrk', 'sonnet-4.5'], worker2: ['coord', 'sonnet-4.5'], reviewer: ['rev', 'haiku-4.5'], restricted: ['qa_r', 'sonnet-4.5'], baseline: ['base', 'sonnet-4.5'], baseline_restricted: ['base_r', 'sonnet-4.5'] };
export const ROLES_DIR = join(WORK, 'roles');
export function down() {
  const f = join(WORK, 'hub.pid');
  if (existsSync(f)) { spawnSync('taskkill', ['/PID', readFileSync(f, 'utf8').trim(), '/T', '/F'], { stdio: 'ignore' }); rmSync(f); }
}
import { pathToFileURL } from 'node:url';
async function cli() {
  const [cmd, id] = process.argv.slice(2);
  if (cmd === 'down') { down(); console.log('hub stopped'); }
  else if (cmd === 'up') {
    const { tasksOf, tok } = await import('./lib.mjs');
    const live = await import('./live.mjs');
    down(); await sleep(500);
    const hub = new Hub();
    if (!existsSync(join(SERVER, 'dist', 'app.js'))) hub.build();
    await hub.fresh();
    const cats = ['impact', 'staleness', 'context_qa', 'entity_merge', 'contradiction', 'summary', 'collab'];
    const all = Object.fromEntries(cats.flatMap((c) => tasksOf(c).map((t) => [t.id, { ...t, category: t.category ?? c }])));
    const task = id && id !== 'all' ? all[id] : null;
    if (id && id !== 'all' && !task) throw new Error(`unknown task ${id}`);
    // prime: first read enqueues the index job (lazy coverage), task-relevant notes only
    const paths = task ? (task.category === 'collab' ? [] : live.gtPaths(task)) : [...new Set(Object.values(all).filter((t) => t.category !== 'collab').flatMap(live.gtPaths))];
    const rd = await hub.session('reader');
    for (const p of paths) await rd.call('file_read', { path: `/vault/${p}` });
    await rd.close();
    if (task) for (const op of task.setup ?? []) await hub.applySetup([op], op.who ?? 'setup');
    hub.state.started = Date.now() - 1000; hub.state.task = task?.id ?? null;
    writeJson(D.state, hub.state);
    await hub.stop();
    await hub.startDetached();
    mkdirSync(ROLES_DIR, { recursive: true });
    for (const [role, [key, label]] of Object.entries(ROLES)) {
      const k = hub.state.keys[key];
      writeJson(join(ROLES_DIR, `${role}.json`), { role, key_name: key, model_label: label, agent_id: k.agentId, cred_id: k.credId, session_key: k.secret, app_key: hub.state.appKey, url: `${BASE}/mcp`, token: null, described: false });
      rmSync(join(ROLES_DIR, `${role}.usage.jsonl`), { force: true });
    }
    console.log(`hub up on ${BASE}, task ${task?.id ?? 'none'}, ${paths.length} notes primed, roles: ${Object.keys(ROLES).join(', ')}`);
  } else console.log('usage: hub.mjs up <task-id|all> | down');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
