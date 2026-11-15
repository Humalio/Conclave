/**
 * Tests for usage stats (deploy/client/connector/usage.mjs), run with `npm run test:helper` in server/. The session
 * files are copies of proof 4's text-free fixtures (fixtures/usage/), with the synthetic folder in them swapped for a
 * temporary agent folder. Nothing touches the real ~/.config/conclave, ~/.claude or ~/.codex, and no hub is called.
 */
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, createReadStream, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindFolder } from './connector/registry.mjs';
import { canonicalFolder } from './connector/paths.mjs';
import { registerSession, forgetSession, collectUsage, sendUsage, setUsageOptIn, usageOptIn, recordUsageEvent, registeredSessions } from './connector/usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'conclave.mjs');
const FIX = join(HERE, 'fixtures', 'usage');
const CA = 'a'.repeat(64), CA2 = 'b'.repeat(64);
const tmp = [];
const mk = (p = 'conclave-usage-') => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

/** A connector home with one registered agent folder, an empty Claude config and an empty Codex home. */
/** `optIn`: the PC user turned usage reports on (the default here, since most cases read files). */
function setup({ optIn = true } = {}) {
  const home = mk(), folder = canonicalFolder(mk('conclave-agent-')), other = canonicalFolder(mk('conclave-other-'));
  bindFolder(home, folder, { hubId: 'hub-a', caSha256: CA, agent: 'worker' });
  bindFolder(home, other, { hubId: 'hub-a', caSha256: CA, agent: 'other' });
  const claude = mk('conclave-claude-'), codex = mk('conclave-codex-');
  const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
  const fwd = (p) => p.replace(/\\/g, '/');
  /** Copies a fixture, its synthetic folder replaced by `inFolder`. */
  const place = (fixture, dest, inFolder = folder) => {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(FIX, fixture), 'utf8').replaceAll('C:/synthetic/agent-one', fwd(inFolder)));
  };
  const claudeFile = (fixture, sessionId, inFolder) => place(fixture, join(claude, 'projects', 'C--agent-one', `${sessionId}.jsonl`), inFolder);
  const codexFile = (fixture, id, inFolder) => place(fixture, join(codex, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${id}.jsonl`), inFolder);
  const reg = (client, sessionId, agentId = 'agent-w1', f = folder) => registerSession(home, { client, sessionId, agentId, hubId: 'hub-a', caSha256: CA, folder: f });
  if (optIn) setUsageOptIn(home, true);
  return { home, folder, other, claude, codex, env, claudeFile, codexFile, reg };
}
const session = (r, id) => r.sessions.find((s) => s.session_id === id);
const sum = (usage) => usage.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cache_read: a.cache_read + u.cache_read, cache_write: a.cache_write + u.cache_write, turns: a.turns + u.turns }), { input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0 });
const hubTotal = (r) => r.hubs.flatMap((h) => h.days.flatMap((d) => d.rows)).reduce((a, x) => ({ input: a.input + x.input_tokens, output: a.output + x.output_tokens }), { input: 0, output: 0 });

describe('Claude Code session files (proof 4 fixtures)', () => {
  test('a session counts each message once, skips API errors and reports side-chain messages apart', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.reg('claude_code', 'sess-A');
    const s = session(await collectUsage(t.home, { env: t.env }), 'sess-A');
    assert.deepEqual(sum(s.usage), { input: 14, output: 29, cache_read: 103, cache_write: 9, turns: 3 });
    assert.equal(s.sidechain_messages, 1);
    assert.equal(s.unknown, false);
    assert.deepEqual(s.versions, ['2.1.325']);
    assert.equal(s.usage[0].model, 'synthetic-model');
  });

  test('a half-written last line is skipped and counted; the rows before it count', async () => {
    const t = setup();
    t.claudeFile('claude-partial.jsonl', 'sess-P'); t.reg('claude_code', 'sess-P');
    const s = session(await collectUsage(t.home, { env: t.env }), 'sess-P');
    assert.equal(sum(s.usage).input, 5);
    assert.equal(s.skipped_rows, 1);
  });

  test('a resumed session and its parent give the same totals whichever is registered first', async () => {
    for (const order of [['sess-A', 'sess-D'], ['sess-D', 'sess-A']]) {
      const t = setup(); setUsageOptIn(t.home, true);
      t.claudeFile('claude-A.jsonl', 'sess-A'); t.claudeFile('claude-resume-D.jsonl', 'sess-D');
      for (const id of order) t.reg('claude_code', id);
      assert.deepEqual(hubTotal(await collectUsage(t.home, { env: t.env })), { input: 18, output: 33 }, order.join(' then '));
    }
  });

  test('a message copied into a second file of the same session counts once', async () => {
    const t = setup();
    t.claudeFile('claude-A.jsonl', 'sess-A');
    const sub = join(t.claude, 'projects', 'C--agent-one', 'sess-A', 'subagents', 'agent-x.jsonl');
    mkdirSync(dirname(sub), { recursive: true });
    writeFileSync(sub, readFileSync(join(t.claude, 'projects', 'C--agent-one', 'sess-A.jsonl')));
    t.reg('claude_code', 'sess-A');
    const s = session(await collectUsage(t.home, { env: t.env }), 'sess-A');
    assert.equal(s.files, 2);
    assert.equal(sum(s.usage).input, 14);
  });

  test('a file that is not JSON, or is empty, gives zero and counts its bad lines', async () => {
    const t = setup();
    t.claudeFile('claude-garbage.jsonl', 'sess-G'); t.claudeFile('claude-empty.jsonl', 'sess-E');
    t.reg('claude_code', 'sess-G'); t.reg('claude_code', 'sess-E');
    const r = await collectUsage(t.home, { env: t.env });
    assert.deepEqual(session(r, 'sess-G').usage, []);
    assert.equal(session(r, 'sess-G').skipped_rows, 2);
    assert.deepEqual(session(r, 'sess-E').usage, []);
    assert.equal(session(r, 'sess-E').skipped_rows, 0);
  });

  test('a usage row of a layout the reader does not know gives the session no stats: Unknown, not a guess', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.claudeFile('claude-A.jsonl', 'sess-A');
    const p = join(t.claude, 'projects', 'C--agent-one', 'sess-A.jsonl');
    writeFileSync(p, readFileSync(p, 'utf8') + JSON.stringify({ type: 'assistant', sessionId: 'sess-A', cwd: t.folder.replace(/\\/g, '/'), message: { id: 'msg_new', usage: { tokens_in: 5 } } }) + '\n');
    t.reg('claude_code', 'sess-A');
    const r = await collectUsage(t.home, { env: t.env });
    assert.equal(session(r, 'sess-A').usage, null);
    assert.equal(session(r, 'sess-A').unknown, true);
    assert.deepEqual(r.hubs, []);
  });
});

describe('large files are streamed', () => {
  test('a file much larger than one read is counted in small chunks, and an over-long line is skipped, not held', async () => {
    const t = setup();
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.reg('claude_code', 'sess-A');
    const p = join(t.claude, 'projects', 'C--agent-one', 'sess-A.jsonl'), cwd = t.folder.replace(/\\/g, '/');
    // 20,000 more messages (about 5 MB), then one 3 MB line with no usage in it, then one more message.
    const msg = (i) => JSON.stringify({ type: 'assistant', sessionId: 'sess-A', cwd, message: { id: `big_${i}`, model: 'synthetic-model', usage: { input_tokens: 1, output_tokens: 2 } } });
    let block = '';
    for (let i = 0; i < 20_000; i++) block += msg(i) + '\n';
    appendFileSync(p, block);
    appendFileSync(p, JSON.stringify({ type: 'user', sessionId: 'sess-A', cwd, pad: 'x'.repeat(3 * 1024 * 1024) }) + '\n' + msg('last') + '\n');
    let chunks = 0, biggest = 0;
    const io = { maxLine: 1024 * 1024, open: (q) => { const st = createReadStream(q, { highWaterMark: 64 * 1024 }); st.on('data', (c) => { chunks++; biggest = Math.max(biggest, c.length); }); return st; } };
    const s = session(await collectUsage(t.home, { env: t.env, io }), 'sess-A');
    assert.ok(chunks > 100, `read in ${chunks} chunks`);
    assert.ok(biggest <= 64 * 1024);
    assert.equal(s.skipped_rows, 1); // the 3 MB line, over the 1 MB line limit
    assert.deepEqual(sum(s.usage), { input: 14 + 20_001, output: 29 + 2 * 20_001, cache_read: 103, cache_write: 9, turns: 3 + 20_001 });
  });
});

describe('Codex rollout files (proof 4 fixtures)', () => {
  test('a cumulative counter is read as steps: a repeated total adds nothing', async () => {
    const t = setup();
    t.codexFile('codex-basic.jsonl', 'thr-1'); t.reg('codex', 'thr-1');
    const s = session(await collectUsage(t.home, { env: t.env }), 'thr-1');
    assert.equal(s.total_tokens, 350);
    assert.deepEqual(sum(s.usage), { input: 230, output: 90, cache_read: 30, cache_write: 0, turns: 2 });
    assert.equal(s.usage[0].day, '2026-01-01');
    assert.equal(s.usage[0].model, 'unknown');
  });

  test('a fork keeps its own counter and is never added to its parent', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.codexFile('codex-basic.jsonl', 'thr-1'); t.codexFile('codex-fork.jsonl', 'thr-2');
    t.reg('codex', 'thr-1'); t.reg('codex', 'thr-2');
    const r = await collectUsage(t.home, { env: t.env });
    assert.equal(session(r, 'thr-1').total_tokens, 350);
    assert.equal(session(r, 'thr-2').total_tokens, 475);
    assert.equal(session(r, 'thr-2').forked_from, true);
    assert.deepEqual(sum(session(r, 'thr-2').usage), { input: 450, output: 25, cache_read: 0, cache_write: 0, turns: 2 });
    const [row] = r.hubs[0].days[0].rows;
    assert.equal(row.sessions, 2);
    assert.equal(row.input_tokens + row.output_tokens + row.cache_read_tokens, 350 + 475);
  });

  test('an unknown version layout gives no stats, and says so locally', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.codexFile('codex-unknown-version.jsonl', 'thr-3'); t.reg('codex', 'thr-3');
    const r = await collectUsage(t.home, { env: t.env });
    const s = session(r, 'thr-3');
    assert.equal(s.total_tokens, null);
    assert.equal(s.usage, null);
    assert.equal(s.unknown_events, 1);
    assert.deepEqual(s.versions, ['9.9.9-future']);
    assert.deepEqual(r.hubs, []);
  });

  test('a half-written last event is skipped', async () => {
    const t = setup();
    t.codexFile('codex-partial.jsonl', 'thr-4'); t.reg('codex', 'thr-4');
    const s = session(await collectUsage(t.home, { env: t.env }), 'thr-4');
    assert.equal(s.total_tokens, 11);
    assert.equal(s.skipped_rows, 1);
  });

  test('an archived rollout is still found', async () => {
    const t = setup();
    mkdirSync(join(t.codex, 'archived_sessions'), { recursive: true });
    writeFileSync(join(t.codex, 'archived_sessions', 'rollout-2026-01-01T00-00-00-thr-1.jsonl'), readFileSync(join(FIX, 'codex-basic.jsonl'), 'utf8').replaceAll('C:/synthetic/agent-one', t.folder.replace(/\\/g, '/')));
    t.reg('codex', 'thr-1');
    assert.equal(session(await collectUsage(t.home, { env: t.env }), 'thr-1').total_tokens, 350);
  });
});

describe('only registered worker sessions', () => {
  test('a session the connector did not register is never read, even in an agent folder (a personal chat)', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.claudeFile('claude-partial.jsonl', 'sess-P'); t.codexFile('codex-basic.jsonl', 'thr-1');
    t.reg('claude_code', 'sess-P');
    const r = await collectUsage(t.home, { env: t.env });
    assert.deepEqual(r.sessions.map((s) => s.session_id), ['sess-P']);
    assert.deepEqual(hubTotal(r), { input: 5, output: 5 });
  });

  test('nothing registered: nothing read, nothing to send', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.codexFile('codex-basic.jsonl', 'thr-1');
    assert.deepEqual(await collectUsage(t.home, { env: t.env }), { opted_in: true, sessions: [], hubs: [] });
  });

  test('rows whose recorded folder is not the registered one are not counted', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.claudeFile('claude-A.jsonl', 'sess-A', t.other); t.codexFile('codex-basic.jsonl', 'thr-1', t.other);
    t.reg('claude_code', 'sess-A'); t.reg('codex', 'thr-1');
    const r = await collectUsage(t.home, { env: t.env });
    assert.deepEqual(session(r, 'sess-A').usage, []);
    assert.ok(session(r, 'sess-A').other_rows > 0);
    assert.deepEqual(session(r, 'thr-1').usage, []);
    assert.deepEqual(r.hubs, []);
  });

  test('a session is registered only for a registered agent folder of the same hub, and can be forgotten', async () => {
    const t = setup();
    assert.throws(() => registerSession(t.home, { client: 'claude_code', sessionId: 's1', agentId: 'agent-w1', hubId: 'hub-a', caSha256: CA, folder: mk() }), /not a registered agent folder/);
    assert.throws(() => registerSession(t.home, { client: 'claude_code', sessionId: 's1', agentId: 'agent-w1', hubId: 'hub-a', caSha256: CA2, folder: t.folder }), /another hub/);
    assert.throws(() => registerSession(t.home, { client: 'desktop', sessionId: 's1', agentId: 'agent-w1', hubId: 'hub-a', caSha256: CA, folder: t.folder }), /invalid/);
    assert.throws(() => registerSession(t.home, { client: 'codex', sessionId: '../x', agentId: 'agent-w1', hubId: 'hub-a', caSha256: CA, folder: t.folder }), /invalid/);
    t.reg('codex', 'thr-1');
    assert.equal(registeredSessions(t.home).length, 1);
    assert.equal(forgetSession(t.home, 'codex', 'thr-1'), true);
    assert.equal(registeredSessions(t.home).length, 0);
  });
});

describe('what leaves the PC', () => {
  test('off by default; turning it on keeps the user\'s other choices', async () => {
    const t = setup({ optIn: false });
    assert.equal(usageOptIn(t.home), false);
    writeFileSync(join(t.home, 'preferences.json'), JSON.stringify({ remote_cleanup: false }));
    setUsageOptIn(t.home, true);
    assert.deepEqual(JSON.parse(readFileSync(join(t.home, 'preferences.json'), 'utf8')), { remote_cleanup: false, usage_opt_in: true });
  });

  test('until the PC user opts in, no file is opened and nothing is prepared or sent', async () => {
    const t = setup({ optIn: false });
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.reg('claude_code', 'sess-A');
    t.codexFile('codex-basic.jsonl', 'thr-1'); t.reg('codex', 'thr-1');
    recordUsageEvent(t.home, { client: 'claude_code', sessionId: 'sess-A', model: 'model-x', input: 1 });
    const opened = [];
    const io = { open: (p) => { opened.push(p); return createReadStream(p); } };
    assert.deepEqual(await collectUsage(t.home, { env: t.env, io }), { opted_in: false, sessions: [], hubs: [] });
    assert.deepEqual(opened, []);
    setUsageOptIn(t.home, true); // the same spy does see the files once the user opts in
    await collectUsage(t.home, { env: t.env, io });
    assert.equal(opened.length, 2); // the connector's own events file and the Codex file; sess-A has events, so its file is not read
    setUsageOptIn(t.home, false);
    const calls = [];
    assert.deepEqual(await sendUsage(t.home, { days: [{ day: '2026-01-01', rows: [] }] }, async (...a) => calls.push(a)), []);
    assert.equal(calls.length, 0);
  });

  test('the report holds numbers in the hub\'s shape only: no text, paths or session ids', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.claudeFile('claude-resume-D.jsonl', 'sess-D'); t.codexFile('codex-basic.jsonl', 'thr-1'); t.codexFile('codex-fork.jsonl', 'thr-2');
    for (const [c, id] of [['claude_code', 'sess-A'], ['claude_code', 'sess-D'], ['codex', 'thr-1'], ['codex', 'thr-2']]) t.reg(c, id);
    const r = await collectUsage(t.home, { env: t.env });
    const calls = [];
    await sendUsage(t.home, r.hubs[0], async (path, body) => calls.push({ path, body }));
    assert.ok(calls.length >= 1);
    const sent = JSON.stringify(calls);
    for (const s of ['REDACTED', 'synthetic/', 'agent-one', t.folder.replace(/\\/g, '/'), t.folder, t.home, 'sess-', 'thr-', 'msg_', '2.1.325', '0.167.0']) assert.ok(!sent.includes(s), `the report contains ${s}`);
    for (const c of calls) {
      assert.equal(c.path, '/connector/v1/usage');
      assert.deepEqual(Object.keys(c.body), ['day', 'rows']);
      assert.match(c.body.day, /^\d{4}-\d{2}-\d{2}$/);
      for (const row of c.body.rows) {
        assert.deepEqual(Object.keys(row).sort(), ['agent_id', 'cache_read_tokens', 'cache_write_tokens', 'client', 'input_tokens', 'model', 'output_tokens', 'sessions', 'turns']);
        for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'sessions', 'turns']) assert.ok(Number.isSafeInteger(row[k]) && row[k] >= 0);
        assert.match(row.model, /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);
      }
    }
  });

  test('a model name that is not a plain name goes out as unknown', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    const p = join(t.claude, 'projects', 'C--agent-one', 'sess-M.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ type: 'assistant', sessionId: 'sess-M', cwd: t.folder, message: { id: 'm1', model: 'C:/Users/someone/secret plan', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
    t.reg('claude_code', 'sess-M');
    assert.equal((await collectUsage(t.home, { env: t.env })).hubs[0].days[0].rows[0].model, 'unknown');
  });

  test('events the connector recorded from the client are used instead of the session file', async () => {
    const t = setup(); setUsageOptIn(t.home, true);
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.reg('claude_code', 'sess-A');
    recordUsageEvent(t.home, { client: 'claude_code', sessionId: 'sess-A', model: 'model-x', at: '2026-02-03T10:00:00Z', input: 7, output: 8 });
    const r = await collectUsage(t.home, { env: t.env });
    assert.equal(session(r, 'sess-A').source, 'client_events');
    assert.deepEqual(r.hubs[0].days, [{ day: '2026-02-03', rows: [{ agent_id: 'agent-w1', client: 'claude_code', model: 'model-x', input_tokens: 7, output_tokens: 8, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 1, turns: 1 }] }]);
    assert.throws(() => recordUsageEvent(t.home, { client: 'claude_code', sessionId: 'sess-A', input: -1 }), /invalid/);
  });

  test('conclave usage turns reports on and off and prints numbers only', async () => {
    const t = setup({ optIn: false });
    t.claudeFile('claude-A.jsonl', 'sess-A'); t.reg('claude_code', 'sess-A');
    const env = { ...process.env, CONCLAVE_HOME: t.home, ...t.env };
    const run = (...a) => spawnSync(process.execPath, [CLI, 'usage', ...a], { env, encoding: 'utf8' });
    assert.match(run().stdout, /usage reports: off/);
    assert.equal(run('on').status, 0);
    const out = run('--json', '--days', '400');
    const j = JSON.parse(out.stdout);
    assert.equal(j.opted_in, true);
    assert.equal(j.sessions[0].agent_id, 'agent-w1');
    for (const s of ['REDACTED', 'sess-A', t.folder]) assert.ok(!out.stdout.includes(s), `the output contains ${s}`);
    assert.match(run().stdout, /claude_code agent-w1: 14 in, 29 out, 3 turns/);
    assert.match(run('off').stdout, /kept under its retention rule/);
    assert.equal(usageOptIn(t.home), false);
    assert.equal(run('maybe').status, 2);
  });
});
