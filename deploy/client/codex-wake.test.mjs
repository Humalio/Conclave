/**
 * Tests for codex-wake.mjs, run with `npm run test:helper` in server/ (plain node:test). No Codex CLI is involved: the
 * spawn tests run this Node as the "Codex" executable. The Waker against a real hub is server/test/codex-wake.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TASK_ID, wakeEnv, codexArgs, wakePrompt, loadConfig, runTurn, Waker, reviewed, MAX_TURNS_PER_HOUR, TURN_TIMEOUT_MS,
  Collector, readCollectKeys, writeKeyFile, instanceId, hubClient, readKeys, post as postJson,
} from './codex-wake.mjs';

const WIN = platform() === 'win32';
const SES = '019a0000-0000-7000-8000-000000000000';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); } return f(); };

test('the task id pattern is ^task_[a-z0-9]{1,40}$', () => {
  for (const ok of ['task_a', 'task_kwi54db3ibclkqag', 'task_' + 'a'.repeat(40)]) assert.ok(TASK_ID.test(ok), ok);
  for (const bad of ['task_', 'task_A1', 'task_a b', 'task_a\n', 'task_a"', 'xtask_a', 'task_' + 'a'.repeat(41), 'task_wake_smoke']) assert.ok(!TASK_ID.test(bad), bad);
  assert.equal(TASK_ID.source, '^task_[a-z0-9]{1,40}$');
});

test('Codex gets an allowlisted environment: no session key, app key or other secret', () => {
  const src = {
    Path: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', TMP: 'C:\\t', USERPROFILE: 'C:\\Users\\me', CODEX_HOME: 'C:\\c',
    AGENT_HUB_APP_KEY: 'ah_app_x', CONCLAVE_CONCLAVE_DEVELOPERS_ROWAN_SESSION_KEY: 'ah_ses_abcdefghij', OPENAI_API_KEY: 'sk-x',
    CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's', CODEX_TOOL_CALL_ID: 'c', CODEX_APP_TOOLS_PIPE_PATH: 'p', CODEX_AUTH_TOKEN: 'x',
    NODE_OPTIONS: '--require evil.js', COMSPEC: 'cmd.exe', SOMETHING: 'ah_ses_abcdefghijk', CODEX_EXTRA: 'ah_app_abcdefghij', GITHUB_TOKEN: 'ghp_x',
  };
  assert.deepEqual(wakeEnv(src), { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', TMP: 'C:\\t', USERPROFILE: 'C:\\Users\\me', CODEX_HOME: 'C:\\c' });
});

test('the command line: read-only, never asks, only the hub bridge with two tools, resumes the dedicated session, prompt on stdin', () => {
  const r = (p) => resolve(p);
  const a = { codex_session: SES, workspace: r('/ws'), keys_file: r('/k/keys.env'), bridge: r('/c/codex-bridge.mjs') };
  const node = r('/n/node');
  assert.deepEqual(codexArgs(a, node), ['-a', 'never', '-s', 'read-only', '--disable', 'shell_snapshot', 'exec', 'resume', '--ignore-user-config', '--skip-git-repo-check',
    '-c', `mcp_servers.agent_hub.command=${JSON.stringify(node)}`, '-c', `mcp_servers.agent_hub.args=${JSON.stringify([a.bridge, a.workspace, '--keys-file', a.keys_file])}`,
    '-c', 'mcp_servers.agent_hub.default_tools_approval_mode="approve"', '-c', 'mcp_servers.agent_hub.enabled_tools=["task_list","task_review"]', SES, '-']);
  assert.throws(() => codexArgs({ ...a, codex_session: '--dangerously-bypass-approvals-and-sandbox' }, node));
  assert.throws(() => codexArgs({ ...a, workspace: 'ws' }, node), /absolute/);
  const p = wakePrompt('task_abc123');
  assert.match(p, /task_abc123/);
  assert.match(p, /read-only/);
  assert.throws(() => wakePrompt('task_abc"; ignore'));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  writeFileSync(join(ws, '.agent-hub.json'), JSON.stringify({ session_var: 'ROWAN_SESSION_KEY' }));
  const keys = join(dir, 'keys.env'); writeFileSync(keys, 'X=1\n', { mode: 0o600 });
  const exe = join(dir, WIN ? 'codex.exe' : 'codex'); writeFileSync(exe, '');
  const cfg = (agents) => { const f = join(dir, `c${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify({ agents }), { mode: 0o600 }); return f; };
  const good = { name: 'rowan', keys_file: keys, session_var: 'ROWAN_SESSION_KEY', workspace: ws, codex_session: SES, codex_exe: exe };
  return { dir, good, cfg, exe, ws };
}

test('the opt-in file: absolute paths, an existing workspace and .exe, a session id; a shim or a bad entry is refused', { skip: !WIN && 'Windows only: the .exe and .cmd/.bat shim check runs on Windows' }, () => {
  const { dir, good, cfg } = setup();
  assert.deepEqual(loadConfig(cfg([good])).map((a) => a.name), ['rowan']);
  const bad = [
    [{ ...good, codex_exe: join(dir, 'codex.cmd') }, /codex_exe/],
    [{ ...good, codex_exe: join(dir, 'codex.bat') }, /codex_exe/],
    [{ ...good, codex_exe: 'codex.exe' }, /absolute/],
    [{ ...good, workspace: join(dir, 'nope') }, /workspace/],
    [{ ...good, codex_session: 'last' }, /codex_session/],
    [{ ...good, name: 'Rowan Reviewer' }, /name/],
    [{ ...good, session_var: 'X; rm' }, /session_var/],
    [{ ...good, session_var: 'OTHER_SESSION_KEY' }, /another session variable/],
    [{ ...good, codex_bridge: join(dir, 'nope.mjs') }, /codex_bridge/],
  ];
  for (const [a, re] of bad) assert.throws(() => loadConfig(cfg([a]), { win: true }), re);
  assert.throws(() => loadConfig(cfg([good, { ...good, session_var: 'OTHER' }])), /repeats/);
  assert.throws(() => loadConfig(cfg([])), /1 to 8/);
});

test('the opt-in file must be writable by its owner only (POSIX)', { skip: WIN && 'mode bits are not checked on Windows' }, () => {
  const { good, cfg } = setup();
  const f = cfg([good]);
  chmodSync(f, 0o666);
  assert.throws(() => loadConfig(f), /writable by you only/);
});

test('a turn runs without a shell, with only the allowlisted environment and the prompt on stdin', async () => {
  const { dir, ws } = setup();
  const out = join(dir, 'seen.json');
  const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({env:process.env,stdin:s,cwd:process.cwd(),argv:process.argv.slice(1)})))`;
  const env = wakeEnv({ ...process.env, AGENT_HUB_APP_KEY: 'ah_app_abcdefghijk', ROWAN_SESSION_KEY: 'ah_ses_abcdefghijk' });
  const r = await runTurn({ exe: process.execPath, args: ['-e', script, 'a&b', '|x'], cwd: ws, env, prompt: wakePrompt('task_abc') });
  assert.equal(r.code, 0);
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(seen.stdin, wakePrompt('task_abc'));
  assert.equal(seen.cwd.toLowerCase(), ws.toLowerCase());
  assert.deepEqual(seen.argv, ['a&b', '|x']); // no shell parsed the arguments
  assert.ok(!JSON.stringify(seen.env).match(/ah_(app|ses)_/));
  // On Windows libuv adds the variables a process needs to start (HOMEDRIVE, SYSTEMDRIVE, USERNAME, WINDIR, …) from the parent; none is a secret.
  const LIBUV = /^(homedrive|homepath|logonserver|systemdrive|userdomain|username|windir)$/i;
  for (const k of Object.keys(seen.env)) assert.ok(/^(path|systemroot|temp|tmp|userprofile|home|codex_.*)$/i.test(k) || (WIN && LIBUV.test(k)), `unexpected variable ${k}`);
});

test('a turn past its time is stopped with its whole process tree', async () => {
  const { dir } = setup();
  const pids = join(dir, 'pids');
  const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pids)},process.pid+' '+c.pid);setInterval(()=>{},1000)`;
  const t0 = Date.now();
  const p = runTurn({ exe: process.execPath, args: ['-e', script], cwd: dir, env: wakeEnv(), prompt: '', timeoutMs: 1500 });
  assert.ok(await until(() => existsSync(pids)));
  const [parent, child] = readFileSync(pids, 'utf8').split(' ').map(Number);
  const r = await p;
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 10_000);
  assert.ok(await until(() => !alive(parent) && !alive(child)), 'the parent and its child are gone');
  assert.equal(TURN_TIMEOUT_MS, 30 * 60_000);
});

test('an executable that cannot start is reported, not retried at once', async () => {
  const r = await runTurn({ exe: join(tmpdir(), 'no-such-codex.exe'), args: [], cwd: tmpdir(), env: {}, prompt: '' });
  assert.equal(r.spawnFailed, true);
});

test('a Codex writer conflict returns a fixed signal even when stderr splits the message', async () => {
  const script = "process.stderr.write('private diagnostic: already has an ');"
    + "setTimeout(() => { process.stderr.write('active writer'); process.exitCode = 1; }, 20);";
  const r = await runTurn({ exe: process.execPath, args: ['-e', script], cwd: tmpdir(), env: wakeEnv(), prompt: '' });
  assert.deepEqual(r, { code: 1, timedOut: false, spawnFailed: false, threadBusy: true });
});

/** A stub hub: each in_review task is reviewed by a launch that `posts`. */
function stub({ posts = true, out = { code: 0, timedOut: false } } = {}) {
  const tasks = new Map(), queue = [], acks = [], logs = [], launched = [];
  let now = 1_000_000;
  const add = (id) => { tasks.set(id, { id, status: 'in_review', version: 4, submitted_version: 4 }); queue.push({ item_id: 'wi_' + id, kind: 'review_requested', task: { id, version: 4, submitted_version: 4 } }); };
  const call = async (name, args) => {
    if (name === 'work_next') return queue.length ? { status: 'item', item: queue[0] } : { status: 'idle' };
    if (name === 'task_list') return { tasks: [tasks.get(args.task_id)].filter(Boolean) };
    // This stub redelivers even after a review, like a hub that never drops stale items.
    if (name === 'work_ack') { acks.push(args.item_id); queue.shift(); return { acked: true }; }
    throw new Error(name);
  };
  const w = new Waker({ name: 'rowan' }, {
    call, now: () => now, log: (l) => logs.push(l), waitS: 0, stale: () => {},
    state: { read: () => null, write: () => {}, clear: () => {} },
    launch: async (id) => { launched.push(id); if (posts) Object.assign(tasks.get(id), { status: 'approved', version: 5 }); return out; },
  });
  return { w, add, queue, acks, logs, launched, tick: (ms) => { now += ms; } };
}

test('a redelivered review never starts a second turn, even from a hub that hands it out again', async () => {
  const s = stub();
  s.add('task_one');
  s.queue.push(s.queue[0]); // delivered twice
  await s.w.step(); await s.w.step(); await s.w.step();
  assert.deepEqual(s.launched, ['task_one']);
  assert.deepEqual(s.acks, ['wi_task_one', 'wi_task_one']);
});

test('at most one turn at a time and six an hour', async () => {
  const s = stub();
  for (let i = 0; i < MAX_TURNS_PER_HOUR + 2; i++) s.add(`task_r${i}`);
  for (let i = 0; i < MAX_TURNS_PER_HOUR + 2; i++) await s.w.step();
  assert.equal(s.launched.length, MAX_TURNS_PER_HOUR);
  assert.match(s.logs.join('\n'), /6 turns this hour; the next review waits/);
  s.tick(3600_000 + 1);
  await s.w.step();
  assert.equal(s.launched.length, MAX_TURNS_PER_HOUR + 1);
});

test('a timeout or an early exit leaves the item pending and is reported with fixed text only', async () => {
  for (const [out, why] of [
    [{ code: null, timedOut: true }, 'timed out after 30 min; the process tree was stopped'],
    [{ code: 3, timedOut: false }, 'exit code 3'],
    [{ code: 1, threadBusy: true }, 'the Codex session already has an active writer. Use a dedicated review session kept out of Desktop or other Codex clients'],
  ]) {
    const s = stub({ posts: false, out });
    s.add('task_late');
    await s.w.step();
    assert.deepEqual(s.acks, []);
    assert.equal(s.logs.at(-1), `rowan: the turn for task_late ended without a review (${why}); the item stays pending`);
  }
});

test('a verdict counts only once the hub shows it on a newer version', () => {
  assert.equal(reviewed({ status: 'approved', version: 5 }, 4), true);
  assert.equal(reviewed({ status: 'changes_requested', version: 5 }, 4), true);
  assert.equal(reviewed({ status: 'blocked', blocked_from: 'changes_requested', version: 5 }, 4), true);
  assert.equal(reviewed({ status: 'in_review', version: 5 }, 4), false);
  assert.equal(reviewed({ status: 'in_progress', version: 5 }, 4), false);
  assert.equal(reviewed({ status: 'approved', version: 4 }, 4), false);
  assert.equal(reviewed(null, 4), false);
});

test('a turn left by a previous run is stopped only if its pid is still Codex, never a recycled pid', { skip: !WIN && 'Windows only: checks the image name with tasklist' }, async () => {
  const { runningAs } = await import('./codex-wake.mjs');
  assert.equal(runningAs(process.pid, process.execPath), true);
  assert.equal(runningAs(process.pid, WIN ? 'C:\tools\codex.exe' : '/usr/bin/codex'), false);
  assert.equal(runningAs(0, process.execPath), false);
});

test('one agent\'s turn ending leaves the other agents\' running turns on the stop list', async () => {
  const { tracked } = await import('./codex-wake.mjs');
  const live = new Set();
  let endA, endB;
  const a = tracked(live, (add) => { add(101); return new Promise((r) => { endA = r; }); });
  const b = tracked(live, (add) => { add(202); return new Promise((r) => { endB = r; }); });
  assert.deepEqual([...live].sort(), [101, 202]);
  endA(); await a;
  assert.deepEqual([...live], [202]);
  endB(); await b;
  assert.equal(live.size, 0);
  // A turn that failed before it had a pid removes nothing.
  live.add(303);
  await tracked(live, () => Promise.reject(new Error('spawn failed'))).catch(() => {});
  assert.deepEqual([...live], [303]);
});

// ───────────── key collection ─────────────
const APP = 'ah_app_FAKEappKEYforCOLLECTtests00';
const OLD = 'ah_ses_FAKEoldKEYrevokedforTESTS0000';
const NEW = 'ah_ses_FAKEnewKEYcollectedforTESTS00';
const VARN = 'ROWAN_SESSION_KEY';
const INST = 'a'.repeat(32);

/** A stub hub on loopback: the three collection endpoints and /mcp, where only the current session key can log in. */
async function hubStub({ collect = ['col_one'], pick = {}, poll = {} } = {}) {
  const st = { calls: [], ses: OLD, open: [...collect], secret: NEW, confirms: [] };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = body ? JSON.parse(body) : {};
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      st.calls.push({ path: req.url, auth: req.headers.authorization, body: b });
      if (req.headers.authorization !== `Bearer ${APP}`) return send(401, { error: 'unauthorized' });
      if (req.url === '/onboard/key-collect/poll') return poll.error ? send(poll.status ?? 403, { error: poll.error }) : send(200, { collect_ids: st.open, ...(poll.after ? { poll_after_s: poll.after } : {}) });
      if (req.url === '/onboard/key-pickup') {
        if (pick.error) return send(pick.status ?? 403, { error: pick.error, message: 'SECRET-LOOKING free text ' + NEW });
        if (!st.open.includes(b.collect_id) || b.instance_id !== INST) return send(404, { error: 'not_found' });
        st.ses = st.secret;
        return send(200, { secret: pick.secret ?? st.secret, session_var: pick.var ?? VARN, label: 'rowan', pc: 'desk' });
      }
      if (req.url === '/onboard/key-collect/confirm') { st.confirms.push(b); st.open = st.open.filter((x) => x !== b.collect_id); if (!b.ok) st.ses = null; return send(200, { ok: true }); }
      if (req.url === '/mcp') {
        const ok = b.params?.arguments?.session_key === st.ses;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { structuredContent: ok ? { session_token: 'tok-1' } : { error: 'key_revoked' } } }));
      }
      send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.url = `http://127.0.0.1:${srv.address().port}`;
  st.close = () => new Promise((r) => srv.close(r));
  return st;
}
const keysText = (url) => `# my keys\nAGENT_HUB_APP_KEY=${APP}\nOTHER_SESSION_KEY=ah_ses_FAKEotherKEYuntouched0000\n${VARN}=${OLD}\nAGENT_HUB_URL=${url}/mcp\n`;
function collectorFor(dir, st, over = {}) {
  const keys = join(dir, 'keys.env');
  if (!existsSync(keys)) writeFileSync(keys, keysText(st.url), { mode: 0o600 });
  const logs = [];
  const c = new Collector({ name: 'rowan', session_var: VARN, keys_file: keys }, {
    readKeys: () => readCollectKeys(keys), readCa: () => null, post: postJson, instance: INST, log: (l) => logs.push(l), now: () => Date.now(),
    write: (v, s) => writeKeyFile(keys, v, s), ...over,
  });
  return { c, logs, keys };
}
const noKey = (text) => assert.doesNotMatch(text, /FAKEnewKEY|FAKEoldKEY|FAKEappKEY|FAKEotherKEY/);

test('opt-in: collect_keys on a wake entry, a collect-only entry, and the entries that are refused', () => {
  const { dir, good, cfg, ws } = setup();
  const keys = join(dir, 'keys.env');
  const only = { name: 'claude-dev', keys_file: keys, session_var: 'CLAUDE_SESSION_KEY', collect_keys: true };
  const r = loadConfig(cfg([{ ...good, collect_keys: true }, only]));
  assert.deepEqual(r.map((a) => [a.name, a.collect_keys, a.wake]), [['rowan', true, true], ['claude-dev', true, false]]);
  assert.equal(loadConfig(cfg([good]))[0].collect_keys, false);
  assert.throws(() => loadConfig(cfg([{ ...only, collect_keys: false }])), /does nothing/);
  assert.throws(() => loadConfig(cfg([{ ...only, collect_keys: 'yes' }])), /collect_keys must be true or false/);
  assert.throws(() => loadConfig(cfg([{ ...only, workspace: ws }])), /codex_exe/); // half a wake entry
  assert.throws(() => loadConfig(cfg([{ ...only, keys_file: join(dir, 'missing.env') }])), /keys_file/);
});

test('the instance id is random, 32 hex digits, kept in the wake\'s own folder and stable across restarts', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cwk-')), 'codex-wake');
  const a = instanceId(dir);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(instanceId(dir), a);
  assert.equal(readFileSync(join(dir, 'instance'), 'utf8'), a);
  if (!WIN) assert.equal(statSync(join(dir, 'instance')).mode & 0o777, 0o600);
  writeFileSync(join(dir, 'instance'), 'not an id');
  assert.match(instanceId(dir), /^[0-9a-f]{32}$/);
  assert.notEqual(instanceId(join(mkdtempSync(join(tmpdir(), 'cwk-')), 'x')), a);
});

test('writing the key: only that variable\'s line changes, atomically, then a read-back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const f = join(dir, 'keys.env');
  writeFileSync(f, keysText('http://127.0.0.1:1'), { mode: 0o600 });
  await writeKeyFile(f, VARN, NEW);
  assert.equal(readFileSync(f, 'utf8'), keysText('http://127.0.0.1:1').replace(OLD, NEW));
  if (!WIN) assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['keys.env'], 'no temporary file is left');
  // CRLF files stay CRLF.
  writeFileSync(f, `${VARN}=${OLD}\r\nX=1\r\n`);
  await writeKeyFile(f, VARN, NEW);
  assert.equal(readFileSync(f, 'utf8'), `${VARN}=${NEW}\r\nX=1\r\n`);
});

test('writing the key: a missing variable or file leaves everything as it was and says why in fixed words', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const f = join(dir, 'keys.env');
  writeFileSync(f, 'AGENT_HUB_APP_KEY=x\n');
  await assert.rejects(writeKeyFile(f, VARN, NEW), (e) => { assert.equal(e.message, `${VARN} is not in the keys file`); noKey(e.message); return true; });
  assert.equal(readFileSync(f, 'utf8'), 'AGENT_HUB_APP_KEY=x\n');
  await assert.rejects(writeKeyFile(join(dir, 'gone.env'), VARN, NEW), /cannot be read/);
  assert.deepEqual(readdirSync(dir), ['keys.env']);
});

test('collection: poll, pickup over the app key, write, confirm; the new key signs in and no log line holds a key', async () => {
  const st = await hubStub();
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const { c, logs, keys } = collectorFor(dir, st);
  try {
    assert.equal(c.isOpen(), false);
    const { wait } = await c.step();
    assert.equal(wait, 60_000);
    assert.deepEqual(st.calls.map((x) => x.path), ['/onboard/key-collect/poll', '/onboard/key-pickup', '/onboard/key-collect/confirm']);
    assert.deepEqual(st.calls[0].body, { instance_id: INST, session_var: VARN });
    assert.deepEqual(st.calls[1].body, { collect_id: 'col_one', instance_id: INST });
    assert.deepEqual(st.confirms, [{ collect_id: 'col_one', instance_id: INST, ok: true }]);
    assert.ok(st.calls.every((x) => x.auth === `Bearer ${APP}`));
    assert.equal(readFileSync(keys, 'utf8'), keysText(st.url).replace(OLD, NEW));
    assert.deepEqual(logs, [`rowan: collected the new key for ${VARN} into rowan's keys file`]);
    noKey(logs.join('\n'));
    assert.equal(c.isOpen(), false);
    // The agent's own login now reads the collected key from the file.
    const hub = hubClient(() => ({ ...readKeys(keys, VARN, { win: true }), ca: null }));
    await hub.login();
    // Nothing more to collect: one poll, no pickup, no repeat of the old id.
    st.open = ['col_one'];
    await c.step();
    assert.equal(st.calls.filter((x) => x.path === '/onboard/key-pickup').length, 1);
  } finally { await st.close(); }
});

test('the spawned Codex gets no *_SESSION_KEY and no collected key, in its environment, arguments or prompt', async () => {
  const st = await hubStub();
  const { dir, ws } = setup();
  writeFileSync(join(dir, 'keys.env'), keysText(st.url), { mode: 0o600 });
  const { c, logs, keys } = collectorFor(dir, st);
  const before = process.env[VARN];
  try {
    await c.step();
  } finally { await st.close(); }
  assert.match(readFileSync(keys, 'utf8'), new RegExp(NEW));
  assert.equal(process.env[VARN], before, 'the wake process environment never holds the key');
  const out = join(dir, 'seen2.json');
  const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({env:process.env,stdin:s,argv:process.argv.slice(1)})))`;
  const a = { codex_session: SES, workspace: ws, keys_file: keys, bridge: resolve(join(dir, 'b.mjs')) };
  const args = codexArgs(a);
  const r = await runTurn({ exe: process.execPath, args: ['-e', script, '--', ...args], cwd: ws, env: wakeEnv({ ...process.env, [VARN]: NEW, AGENT_HUB_APP_KEY: APP }), prompt: wakePrompt('task_abc') });
  assert.equal(r.code, 0);
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(seen.env).filter((k) => /_SESSION_KEY$/i.test(k)), []);
  noKey(JSON.stringify(seen)); // environment, arguments and prompt
  noKey(logs.join('\n'));
});

test('a pickup that fails leaves the keys file unchanged and logs one fixed line, with no free text from the hub', async () => {
  for (const error of ['expired', 'not_found', 'refused']) {
    const st = await hubStub({ pick: { error } });
    const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
    const { c, logs, keys } = collectorFor(dir, st);
    try {
      await c.step();
      assert.equal(readFileSync(keys, 'utf8'), keysText(st.url));
      assert.deepEqual(logs, [`rowan: the hub did not hand over the new key for ${VARN} (${error}); the keys file is unchanged`]);
      noKey(logs.join('\n'));
      assert.equal(st.confirms.length, 0);
      await c.step(); // the same collection is not tried again
      assert.equal(st.calls.filter((x) => x.path === '/onboard/key-pickup').length, 1);
    } finally { await st.close(); }
  }
});

test('a lockdown keeps the collection open and waits; the next poll tries the pickup again', async () => {
  const st = await hubStub({ pick: { error: 'lockdown' } });
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const { c, logs, keys } = collectorFor(dir, st);
  try {
    await c.step(); await c.step();
    assert.equal(st.calls.filter((x) => x.path === '/onboard/key-pickup').length, 2);
    assert.deepEqual(logs, [`rowan: waiting to collect the new key for ${VARN}: a lockdown is on`]); // one line, not one per poll
    assert.equal(readFileSync(keys, 'utf8'), keysText(st.url));
    assert.equal(c.isOpen(), true);
  } finally { await st.close(); }
});

test('a keys file others can read (POSIX) is refused before any pickup: no key is created, so there is nothing to cancel', { skip: WIN && 'mode bits are not checked on Windows' }, async () => {
  const st = await hubStub();
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const keys = join(dir, 'keys.env');
  writeFileSync(keys, keysText(st.url), { mode: 0o600 });
  chmodSync(keys, 0o644);
  const { c, logs } = collectorFor(dir, st);
  try {
    await c.step();
    assert.equal(st.calls.length, 0, 'no poll, no pickup, no confirm');
    assert.deepEqual(st.confirms, []);
    assert.deepEqual(logs, ['rowan: no key collection: the keys file must be readable by you only (chmod 600)']);
    assert.equal(readFileSync(keys, 'utf8'), keysText(st.url));
  } finally { await st.close(); }
});

test('a keys file that cannot take the key: the hub is told ok:false and the file is unchanged', async () => {
  const st = await hubStub();
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const keys = join(dir, 'keys.env');
  writeFileSync(keys, `AGENT_HUB_APP_KEY=${APP}\nAGENT_HUB_URL=${st.url}/mcp\n`, { mode: 0o600 }); // the variable is not in it; mode 600 because the collector refuses a keys file others can read
  const { c, logs } = collectorFor(dir, st);
  try {
    await c.step();
    assert.deepEqual(st.confirms, [{ collect_id: 'col_one', instance_id: INST, ok: false }]);
    assert.equal(readFileSync(keys, 'utf8'), `AGENT_HUB_APP_KEY=${APP}\nAGENT_HUB_URL=${st.url}/mcp\n`);
    assert.deepEqual(logs, [`rowan: could not collect the new key for ${VARN}: ${VARN} is not in the keys file; the keys file is unchanged and the hub cancelled the key`]);
    noKey(logs.join('\n'));
  } finally { await st.close(); }
});

test('the hub returning a key for another variable or no key is refused and confirmed ok:false', async () => {
  for (const pick of [{ var: 'OTHER_SESSION_KEY' }, { secret: 'short' }]) {
    const st = await hubStub({ pick });
    const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
    const { c, logs, keys } = collectorFor(dir, st);
    try {
      await c.step();
      assert.equal(st.confirms[0].ok, false);
      assert.equal(readFileSync(keys, 'utf8'), keysText(st.url));
      assert.match(logs[0], /the keys file is unchanged/);
      noKey(logs.join('\n'));
    } finally { await st.close(); }
  }
});

test('plain HTTP off this computer, and HTTPS without a pinned CA, are refused: nothing is sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const sent = [];
  for (const [url, ca, why] of [['http://hub.example.com/mcp', null, /HTTPS with its CA pinned/], ['https://hub.example.com/mcp', null, /HTTPS with its CA pinned/]]) {
    const logs = [];
    const c = new Collector({ name: 'rowan', session_var: VARN }, { readKeys: () => ({ appKey: APP, url, ca }), readCa: () => null, post: async (...a) => { sent.push(a); return { status: 200, msg: {} }; }, instance: INST, log: (l) => logs.push(l), now: Date.now, write: async () => {} });
    await c.step(); await c.step();
    assert.equal(logs.length, 1);
    assert.match(logs[0], why);
  }
  assert.deepEqual(sent, []);
});

test('a refused or unreachable poll logs once and tries again; a bad keys file logs the reason', async () => {
  const st = await hubStub({ poll: { error: 'suspended' } });
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const { c, logs } = collectorFor(dir, st);
  try {
    await c.step(); await c.step();
    assert.deepEqual(logs, ['rowan: the hub refused the key collection poll (suspended); it tries again']);
  } finally { await st.close(); }
  const { c: c2, logs: l2 } = collectorFor(dir, { url: st.url }); // the server is closed now
  await c2.step(); await c2.step();
  assert.deepEqual(l2, ['rowan: the hub could not be reached for the key collection poll; it tries again']);
  const l3 = [];
  const c3 = new Collector({ name: 'rowan', session_var: VARN }, { readKeys: () => { throw new Error('the keys file has no AGENT_HUB_APP_KEY'); }, post: postJson, instance: INST, log: (l) => l3.push(l), now: Date.now });
  await c3.step();
  assert.deepEqual(l3, ['rowan: no key collection: the keys file has no AGENT_HUB_APP_KEY']);
});

test('the hub may set the poll interval (15 s while a collection is open), kept within 5 s and 5 min', async () => {
  for (const [after, want] of [[15, 15_000], [1, 5_000], [99999, 300_000]]) {
    const st = await hubStub({ collect: [], poll: { after } });
    const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
    const { c } = collectorFor(dir, st);
    try { assert.equal((await c.step()).wait, want); } finally { await st.close(); }
  }
});

test('the wake\'s own login reads the keys file again, so a collected key is used without a restart', async () => {
  const st = await hubStub();
  const dir = mkdtempSync(join(tmpdir(), 'cwk-'));
  const keys = join(dir, 'keys.env');
  writeFileSync(keys, keysText(st.url), { mode: 0o600 });
  const hub = hubClient(() => ({ ...readKeys(keys, VARN, { win: true }), ca: null }));
  st.ses = null; // the rotation revoked the old key
  try {
    await assert.rejects(hub.login(), /login refused \(key_revoked\)/); // the revoked key
    const { c } = collectorFor(dir, st);
    st.ses = OLD; // the hub issues the new key at pickup
    await c.step();
    await hub.login(); // no new hubClient: the next login reads the collected key
  } finally { await st.close(); }
});
