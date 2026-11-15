// The startup check of codex-wake.mjs (docs/connector.md, "The startup check"): run with: node --test deploy/client/codex-wake-start.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startProblem } from './codex-wake.mjs';

const WIN = platform() === 'win32';
const SES = '00000000-0000-7000-8000-000000000000';
const WAKE = fileURLToPath(new URL('./codex-wake.mjs', import.meta.url));
const SECRET = 'sekret-value-that-must-never-be-printed';

function world(keysText) {
  const dir = mkdtempSync(join(tmpdir(), 'cwks-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  writeFileSync(join(ws, '.agent-hub.json'), JSON.stringify({ session_var: 'ROWAN_SESSION_KEY' }));
  const keys = join(dir, 'rowan-keys.env'); writeFileSync(keys, keysText, { mode: 0o600 });
  const exe = join(dir, WIN ? 'codex.exe' : 'codex'); writeFileSync(exe, '');
  const agent = { name: 'rowan', keys_file: keys, session_var: 'ROWAN_SESSION_KEY', workspace: ws, codex_session: SES, codex_exe: exe };
  const cfg = join(dir, 'codex-wake.json'); writeFileSync(cfg, JSON.stringify({ agents: [agent] }), { mode: 0o600 });
  return { dir, keys, cfg, agent: { ...agent, wake: true } };
}
const keysWith = (o) => Object.entries({ AGENT_HUB_APP_KEY: 'app-' + SECRET, ROWAN_SESSION_KEY: 'ses-' + SECRET, AGENT_HUB_URL: 'https://hub.example:8443', ...o })
  .map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

test('startProblem names each missing entry and the file, never a value', () => {
  const w = world(keysWith({ AGENT_HUB_APP_KEY: '' }));
  const p = startProblem(w.agent).wake;
  assert.match(p, /AGENT_HUB_APP_KEY/);
  assert.ok(p.includes(w.keys));
  assert.ok(!p.includes(SECRET));
  const two = world(keysWith({ AGENT_HUB_APP_KEY: '', ROWAN_SESSION_KEY: '' }));
  assert.match(startProblem(two.agent).wake, /AGENT_HUB_APP_KEY, ROWAN_SESSION_KEY/);
});

test('startProblem: a good file passes; a collect-only entry needs no session variable; a missing file or CA is named', () => {
  const ok = world(keysWith({}));
  assert.deepEqual(startProblem(ok.agent), { collect: null, wake: null });
  const co = world(keysWith({ ROWAN_SESSION_KEY: '' }));
  assert.deepEqual(startProblem({ ...co.agent, wake: false, collect_keys: true }), { collect: null, wake: null });
  assert.match(startProblem({ ...ok.agent, keys_file: join(ok.dir, 'gone.env') }).wake, /gone\.env/);
  const ca = world(keysWith({ AGENT_HUB_CA: join(tmpdir(), 'no-such-ca.pem') }));
  const p = startProblem(ca.agent).wake;
  assert.match(p, /AGENT_HUB_CA/);
  assert.ok(!p.includes(SECRET));
  assert.match(startProblem(world(keysWith({ AGENT_HUB_URL: 'ftp://x' })).agent).wake, /AGENT_HUB_URL/);
});

test('with an empty app key the program prints and logs the missing entry, and exits non-zero', () => {
  const w = world(keysWith({ AGENT_HUB_APP_KEY: '' }));
  const home = join(w.dir, 'home'); mkdirSync(home);
  const r = spawnSync(process.execPath, [WAKE, 'run', '--config', w.cfg], { encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 1);
  const logFile = join(home, '.config', 'conclave', 'helper.log');
  assert.ok(existsSync(logFile), 'helper.log is written');
  const logged = readFileSync(logFile, 'utf8');
  for (const text of [r.stderr, logged]) {
    assert.match(text, /rowan: not started: .*AGENT_HUB_APP_KEY/);
    assert.ok(text.includes(w.keys), 'the keys file is named');
    assert.ok(!text.includes(SECRET), 'no value is printed');
  }
  assert.match(logged, /no agent could start/);
});

test('an entry that collects keeps its collector when only its session key is missing: the wake part is not started, the program keeps running', async () => {
  const w = world(keysWith({ ROWAN_SESSION_KEY: '' }));
  const both = { ...w.agent, collect_keys: true };
  const c = startProblem(both);
  assert.equal(c.collect, null);
  assert.match(c.wake, /ROWAN_SESSION_KEY/);
  // A missing app key stops the collection too, and says so.
  const noApp = startProblem({ ...both, keys_file: world(keysWith({ AGENT_HUB_APP_KEY: '' })).keys });
  assert.match(noApp.collect, /AGENT_HUB_APP_KEY/);
  assert.match(noApp.wake, /AGENT_HUB_APP_KEY/);
  const cfg = join(w.dir, 'collect.json');
  writeFileSync(cfg, JSON.stringify({ agents: [{ ...JSON.parse(readFileSync(w.cfg, 'utf8')).agents[0], collect_keys: true }] }), { mode: 0o600 });
  const home = join(w.dir, 'home'); mkdirSync(home);
  const child = spawn(process.execPath, [WAKE, 'run', '--config', cfg], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'ignore' });
  let code = null; child.on('exit', (x) => { code = x; });
  const logFile = join(home, '.config', 'conclave', 'helper.log');
  const seen = () => existsSync(logFile) && /collecting rotated keys/.test(readFileSync(logFile, 'utf8'));
  for (let i = 0; i < 60 && !seen(); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));
  const stillRunning = code === null;
  child.kill();
  assert.ok(stillRunning, 'the program keeps running for the collector');
  const logged = readFileSync(logFile, 'utf8');
  assert.match(logged, /rowan: the wake part is not started \(the collection keeps running\): .*ROWAN_SESSION_KEY/);
  assert.match(logged, /rowan: collecting rotated keys/);
  assert.ok(!logged.includes(SECRET));
});
