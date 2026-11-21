// The wake on its real wiring (docs/connector.md, "The wake"): (13) a refused renewal ends a woken run and scans its transcript, through
// the worker's own wiring of the real broker and the real wake, killing the whole process tree; (15) the real launch builds its command
// line with the absolute-path lookup that leaves the agent's folder out, and carries no permission-bypass or sandbox flag.
// Only the hub (a throwaway TLS stub), the clock-free pieces and the spawn of the last test are replaced. Temporary homes only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub, putAgentKey, caFingerprint } from './connector/keyfile.mjs';
import { registerFolder } from './connector/register.mjs';
import { resolveFolder } from './connector/registry.mjs';
import { startBroker, askBroker } from './connector/broker.mjs';
import { approveFolderByConnector } from './connector/approvals.mjs';
import { createWake, setWake } from './connector/wake.mjs';
import { wireRefusal } from './connector/worker.mjs';
import { alive } from './connector/run.mjs';
import { canonicalFolder, WIN } from './connector/paths.mjs';
import { ORDER_REASONS } from './connector/orders.mjs';

process.env.CONCLAVE_KEY_STORE = 'file';
const tmp = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'cn-wire-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const APP = 'ah_app_FAKEappKEYforWIRINGtests00001', SES = 'ah_ses_FAKEsessionKEYforWIRING000001';
const TASK = 'task_wire1111';
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };

/** A stub hub over HTTPS for the broker's turn-token routes. */
function stubHub(pki) {
  const hub = { issued: new Set(), revoked: [], n: 0 };
  hub.server = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}'), json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      const act = req.url.slice('/connector/v1/turn-tokens'.length).replace(/^\//, '') || 'issue';
      if (act === 'issue') { const t = `tok-${++hub.n}`; hub.issued.add(t); return json(200, { token: t, agent_id: 'agent-w', label: 'Wire agent', expires_at: Date.now() + 900_000 }); }
      if (act === 'renew') return hub.issued.has(msg.token) ? json(200, { expires_at: Date.now() + 900_000 }) : json(404, { error: 'unknown' });
      if (act === 'revoke') { hub.issued.delete(msg.token); hub.revoked.push({ token: msg.token, reason: msg.reason }); return json(200, { ok: true }); }
      return json(404, {});
    });
  });
  return new Promise((ok) => hub.server.listen(0, '127.0.0.1', () => { hub.origin = `https://127.0.0.1:${hub.server.address().port}`; hub.close = () => new Promise((r) => hub.server.close(r)); ok(hub); }));
}

/** A home with one hub, one registered agent folder `dev`, and the wake switched on for it. */
function world(pki, hub) {
  const base = mk(), home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const folder = join(base, 'agent'); mkdirSync(folder);
  const hubKey = putHub(home, { hubId: 'hub-wire', origin: hub.origin, caPem: pki.caPem, appKey: APP });
  putAgentKey(home, hubKey, 'dev', SES);
  writeFileSync(join(home, 'conclave.mjs'), '');
  registerFolder(home, folder, { hubId: 'hub-wire', caSha256: caFingerprint(pki.caPem), agent: 'dev', claudeJson: join(base, 'claude.json'), win: WIN });
  setWake(home, 'dev', true);
  const canon = canonicalFolder(folder);
  const section = { hub_id: 'hub-wire', ca_sha256: caFingerprint(pki.caPem), app_key: APP, agents: { dev: { session_key: SES } } };
  const ctx = { hubKey, section, hub: { origin: hub.origin }, auth: {} };
  return { base, home, folder: canon, hubKey, section, ctx };
}
const order = (n, items) => ({ id: `pca_${n}`, kind: 'deliver', payload: { agent_id: 'agent-w', items } });

describe('a refused renewal ends a woken run, through the worker\'s wiring', () => {
  test('the whole process tree stops, the wake reports it stopped, and the transcript is scanned for a key', async () => {
    const pki = testCa('Wire CA'), hub = await stubHub(pki);
    const w = world(pki, hub);
    const lines = [];
    // The program: a parent that starts a child of its own, records both process ids, and waits (a tool the run is in the middle of).
    const prog = join(w.base, 'hang.mjs'), pids = join(w.base, 'pids.json');
    writeFileSync(prog, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ parent: process.pid, child: kid.pid }));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-wire' }) + '\\n'); setInterval(() => {}, 1000);`);
    const sent = [];
    const stubReq = async (_h, _m, path, o = {}) => { sent.push(path); return path === '/connector/v1/turn-tokens' ? { status: 200, json: { token: 'ah_turn_x', agent_id: 'agent-w' } } : { status: 200, json: path.endsWith('/wake/check') ? { held: [], task_open: true, paused: false } : {} }; };
    approveFolderByConnector(w.home, w.folder, resolveFolder(w.home, w.folder).binding);
    const broker = await startBroker({ home: w.home, log: (m) => lines.push(m), deps: { renewMs: 3_600_000 } });
    const wake = createWake({ home: w.home, log: () => {}, broker, deps: { request: stubReq, bin: () => process.execPath, args: () => [prog] } });
    wireRefusal(broker, wake); // the worker's own wiring (worker.mjs)
    try {
      assert.equal((await wake.onDeliver(w.ctx, order(1, [{ notice: 'task_assigned', task: TASK }]), ORDER_REASONS)).state, 'reported');
      await until(() => existsSync(pids));
      const { parent, child } = JSON.parse(readFileSync(pids, 'utf8'));
      assert.ok(alive(parent) && alive(child), 'the run and its child are up');
      // The run asks the broker for its turn token (as its hook does), and leaves a transcript holding a key.
      assert.equal((await askBroker(w.home, { op: 'turn', folder: w.folder, pid: parent })).ok, true);
      const t = join(w.base, 'transcript.jsonl');
      writeFileSync(t, JSON.stringify({ role: 'assistant', text: `here is the key ${SES}` }) + '\n');
      await askBroker(w.home, { op: 'transcript', folder: w.folder, path: t });
      const revoked = hub.revoked.length;
      hub.issued.clear(); // pause, lockdown or a suspended key: the hub refuses the renewal
      await broker.renewAll();
      await until(() => !alive(parent) && !alive(child), 10000);
      assert.equal(broker.runs.size, 0, 'the broker forgot the run');
      assert.equal(wake.state('hk').agents['agent-w']?.run ?? null, null, 'the wake holds no run any more');
      assert.ok(sent.includes('/connector/v1/wake/report'), 'the hub is told');
      assert.ok(lines.some((l) => /was stopped/.test(l)), 'the woken run was stopped');
      assert.ok(lines.some((l) => /long-lived key was found in the transcript/.test(l)), 'the transcript was scanned and the key found');
      assert.equal(hub.revoked.length, revoked, 'the refused token is not revoked again');
    } finally { await broker.close(); await hub.close(); try { await wake.stopFolder(w.folder, w.hubKey); } catch { /* ended */ } }
  }, 60000);

  test('a chat a person opened by hand is not the wake\'s to stop, and the transcript is still scanned', async () => {
    const pki = testCa('Wire CA 2'), hub = await stubHub(pki);
    const w = world(pki, hub);
    const lines = [];
    approveFolderByConnector(w.home, w.folder, resolveFolder(w.home, w.folder).binding);
    const broker = await startBroker({ home: w.home, log: (m) => lines.push(m), deps: { renewMs: 3_600_000 } });
    const wake = createWake({ home: w.home, log: () => {}, broker, deps: { request: async () => ({ status: 200, json: {} }) } });
    wireRefusal(broker, wake);
    try {
      assert.equal((await askBroker(w.home, { op: 'turn', folder: w.folder, pid: process.pid })).ok, true);
      const t = join(w.base, 'hand.jsonl');
      writeFileSync(t, JSON.stringify({ role: 'assistant', text: `key ${SES}` }) + '\n');
      await askBroker(w.home, { op: 'transcript', folder: w.folder, path: t });
      hub.issued.clear();
      await broker.renewAll();
      assert.ok(alive(process.pid), 'nothing was killed');
      assert.equal(lines.some((l) => /was stopped/.test(l)), false, 'no wake run was there to stop');
      assert.ok(lines.some((l) => /long-lived key was found in the transcript/.test(l)));
    } finally { await broker.close(); await hub.close(); }
  }, 60000);
});

describe('the real wake launch', () => {
  /** Runs one real launch (the real program lookup and the real arguments); only the spawn is replaced, to see what it was given. */
  async function launch(provider) {
    const pki = testCa('Launch CA'), hub = { origin: 'https://127.0.0.1:1' };
    const w = world(pki, hub);
    const { bindFolder } = await import('./connector/registry.mjs');
    if (provider === 'codex') bindFolder(w.home, w.folder, { hubId: 'hub-wire', caSha256: caFingerprint(pki.caPem), agent: 'dev', provider: 'codex' });
    const exe = (n) => (WIN ? `${n}.exe` : n);
    const trusted = join(w.base, 'trusted-bin'), planted = join(w.folder, 'bin');
    mkdirSync(trusted, { recursive: true }); mkdirSync(planted, { recursive: true });
    for (const d of [trusted, planted]) for (const n of ['claude', 'codex']) writeFileSync(join(d, exe(n)), '');
    const was = process.env.PATH ?? process.env.Path;
    const key = process.env.Path !== undefined && process.env.PATH === undefined ? 'Path' : 'PATH';
    process.env[key] = [planted, trusted, was].join(WIN ? ';' : ':'); // the folder's own bin comes first on the PATH
    const calls = [];
    const spawn = (file, args, opts) => { calls.push({ file, args, opts }); const c = new EventEmitter(); c.pid = process.pid; c.unref = () => {}; queueMicrotask(() => c.emit('spawn')); return c; };
    const stubReq = async (_h, _m, path) => ({ status: 200, json: path === '/connector/v1/turn-tokens' ? { token: 'ah_turn_x', agent_id: 'agent-w' } : {} });
    const wake = createWake({ home: w.home, log: () => {}, deps: { request: stubReq, spawn, startTime: () => 1, kill: () => {}, isAlive: () => true } });
    try {
      assert.equal((await wake.onDeliver(w.ctx, order(1, [{ notice: 'task_assigned', task: TASK }]), ORDER_REASONS)).state, 'reported');
    } finally { process.env[key] = was; }
    return { calls, trusted, planted, w, exe };
  }
  const FLAGS = /dangerously|bypass|sandbox|yolo|full-access|skip-permissions|allow-all/i;

  test('Claude Code: the program is found by absolute path outside the agent folder, and no permission or sandbox flag is passed', async () => {
    const { calls, trusted, planted, w, exe } = await launch('claude');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, join(trusted, exe('claude')), 'the trusted copy, not the one in the folder');
    assert.ok(!calls[0].file.startsWith(planted), 'never the agent\'s folder');
    assert.equal(calls[0].opts.shell, false, 'no shell');
    assert.equal(calls[0].opts.cwd, w.folder);
    assert.ok(calls[0].args.includes('-p') && calls[0].args.includes('--output-format'));
    assert.ok(!calls[0].args.some((a) => FLAGS.test(String(a))), `no bypass or sandbox flag in ${JSON.stringify(calls[0].args.slice(0, 8))}`);
  });

  test('Codex: the same lookup and no sandbox or approval flag', async () => {
    const { calls, trusted, planted, exe } = await launch('codex');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, join(trusted, exe('codex')));
    assert.ok(!calls[0].file.startsWith(planted));
    assert.equal(calls[0].opts.shell, false);
    assert.equal(calls[0].args[0], 'exec');
    assert.ok(!calls[0].args.some((a) => FLAGS.test(String(a))), `no bypass or sandbox flag in ${JSON.stringify(calls[0].args.slice(0, 8))}`);
  });

  test('with the program only inside the agent folder, no turn starts', async () => {
    const pki = testCa('Launch CA 2'), w = world(pki, { origin: 'https://127.0.0.1:1' });
    const planted = join(w.folder, 'bin'); mkdirSync(planted);
    writeFileSync(join(planted, WIN ? 'claude.exe' : 'claude'), '');
    const key = process.env.Path !== undefined && process.env.PATH === undefined ? 'Path' : 'PATH', was = process.env[key];
    process.env[key] = planted;
    const calls = [];
    const wake = createWake({ home: w.home, log: () => {}, deps: { request: async (_h, _m, path) => ({ status: 200, json: path === '/connector/v1/turn-tokens' ? { token: 't', agent_id: 'agent-w' } : {} }), spawn: (...a) => { calls.push(a); return new EventEmitter(); }, program: undefined } });
    try {
      const r = await wake.onDeliver(w.ctx, order(1, [{ notice: 'task_assigned', task: TASK }]), ORDER_REASONS);
      // The lookup also reads the person's own install places, so a real program on this PC may be used: never the one in the folder.
      for (const c of calls) assert.ok(!String(c[0]).toLowerCase().startsWith(w.folder.toLowerCase()), `nothing was started from the folder: ${c[0]}`);
      assert.ok(r);
    } finally { process.env[key] = was; }
  });
});
