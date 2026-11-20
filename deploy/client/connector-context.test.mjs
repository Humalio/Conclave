// Context size and Reset on the PC (design "the connector delivers work" 3c and 3g; docs/connector.md "Context size" and
// "Reset"): each message id counted once, an auto-compact is a drop and not a new turn, an unknown model reads unknown,
// the numbers follow a long turn as it grows, at most one read a minute, nothing read or sent with the usage opt-in off,
// the silent hook prints nothing, and a reset never happens in the middle of a turn. Temporary folders, no hub.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub, putAgentKey, caFingerprint } from './connector/keyfile.mjs';
import { registerFolder } from './connector/register.mjs';
import { canonicalFolder, WIN } from './connector/paths.mjs';
import { setUsageOptIn, registerSession } from './connector/usage.mjs';
import { newState, readMore, numbersOf, windowFor, recordChatContext, chatContexts, connectorContexts, contextReport, CONTEXT_EVERY_MS } from './connector/contextsize.mjs';
import { runContextHook } from './connector/hook.mjs';
import { report } from './connector/worker.mjs';
import { validateOrder } from './connector/orders.mjs';
import { onResetOrder, resetIfIdle, takeResetNotice, pendingReset, setWakeOwnsSession, RESET_BY_HAND } from './connector/reset.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'conclave.mjs');
const tmp = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'cn-ctx-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const SID = 'sess-ctx-0001';
const MODEL = 'claude-sonnet-4-5-20250929';
let clock = Date.parse('2026-11-20T10:00:00Z');
const at = () => new Date((clock += 1000)).toISOString();
// Transcript rows, as Claude Code writes them (only the fields the reader looks at, plus text it must never keep).
const row = (folder, extra) => ({ sessionId: SID, cwd: folder, timestamp: at(), ...extra });
const prompt = (folder) => row(folder, { type: 'user', message: { role: 'user', content: 'SECRET PROMPT TEXT' } });
const toolResult = (folder) => row(folder, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'SECRET TOOL OUTPUT' }] } });
const asst = (folder, id, { input = 10, read = 0, write = 0, output = 5, model = MODEL } = {}) => row(folder, { type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'SECRET REPLY' }],
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });
const compact = (folder) => row(folder, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function transcript(rows) {
  const f = join(mk(), `${SID}.jsonl`);
  writeFileSync(f, lines(rows));
  return f;
}
const read = (folder, file) => { const s = newState('claude_code', SID, folder); readMore(s, file); return s; };

describe('Claude Code transcripts: the numbers', () => {
  const folder = canonicalFolder(mk()); // canonicalFolder needs a folder that exists
  test('each message id is counted once, and context now is the last input plus cache tokens', () => {
    const f = transcript([prompt(folder),
      asst(folder, 'msg_1', { input: 100, read: 40_000, write: 2_000, output: 300 }),
      asst(folder, 'msg_1', { input: 100, read: 40_000, write: 2_000, output: 300 }), // the same message again, one row per content block
      toolResult(folder),
      asst(folder, 'msg_2', { input: 50, read: 42_000, write: 500, output: 200 }),
      asst(folder, 'msg_2', { input: 50, read: 42_000, write: 500, output: 200 })]);
    const n = numbersOf(read(folder, f));
    assert.equal(n.context_tokens, 50 + 42_000 + 500);
    assert.equal(n.turn_tokens, (100 + 40_000 + 2_000 + 300) + (50 + 42_000 + 500 + 200), 'each id once; a tool result is not a new turn');
    assert.equal(n.window, 200_000);
    assert.equal(n.percent, Math.round((42_550 / 200_000) * 100));
    assert.equal(n.model, MODEL);
  });
  test('only numbers and the model id come out, never text, a path or the session id', () => {
    const f = transcript([prompt(folder), asst(folder, 'msg_1')]);
    const s = read(folder, f), out = JSON.stringify(numbersOf(s));
    assert.ok(!/SECRET|ctx-agent-folder|sess-ctx/.test(out), out);
    assert.ok(!/SECRET/.test(JSON.stringify(s)), 'the reader state keeps no text either');
  });
  test("a person's prompt starts a new turn: the last turn's tokens start again", () => {
    const f = transcript([prompt(folder), asst(folder, 'a', { input: 1000, output: 10 }), prompt(folder), asst(folder, 'b', { input: 2000, output: 20 })]);
    assert.equal(numbersOf(read(folder, f)).turn_tokens, 2020);
  });
  test('an auto-compact shows as a drop in context, not as a new turn', () => {
    const f = transcript([prompt(folder), asst(folder, 'a', { input: 10, read: 150_000, output: 100 }), compact(folder),
      row(folder, { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } }),
      asst(folder, 'b', { input: 10, read: 30_000, output: 100 })]);
    const n = numbersOf(read(folder, f));
    assert.equal(n.context_tokens, 30_010, 'the context dropped');
    assert.equal(n.compacts, 1);
    assert.ok(n.compacted_at > 0);
    assert.equal(n.turn_tokens, 150_110 + 30_110, 'the turn goes on across the compact');
  });
  test('an unknown model reads unknown, never a guessed window', () => {
    const f = transcript([prompt(folder), asst(folder, 'a', { input: 5000, model: 'some-new-model-9' })]);
    const n = numbersOf(read(folder, f));
    assert.equal(n.window, null);
    assert.equal(n.percent, null);
    assert.equal(n.context_tokens, 5000);
    assert.equal(windowFor('claude-opus-4-1-20250805'), 200_000);
    assert.equal(windowFor('claude-opus-4-1-20250805', 600_000), null, 'more context than the table says (a long-context beta) reads unknown');
    assert.equal(windowFor(undefined), null);
  });
  test('the Claude 5 models and Opus 4.6 to 4.8 and Sonnet 4.6 read a 1M window; Haiku 4.5 stays at 200k', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-opus-5', 'claude-sonnet-5',
      'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6']) assert.equal(windowFor(m, 300_000), 1_000_000, m);
    assert.equal(windowFor('claude-opus-5-5', 1_200_000), null, 'more than the window reads unknown');
    assert.equal(windowFor('claude-haiku-4-5'), 200_000);
    assert.equal(windowFor('claude-sonnet-4-5-20250929'), 200_000);
    assert.equal(windowFor('claude-haiku-5'), null, 'an id not in the docs is not guessed');
    assert.equal(windowFor('claude-opus-5-5[1m]'), null, 'a flagged alias is not a model id');
  });
  test('rows of another session, another folder, a subagent or an API error are left out', () => {
    const f = transcript([prompt(folder), asst(folder, 'a', { input: 1000 }),
      { ...asst(folder, 'b', { input: 9_999 }), sessionId: 'other-session' },
      { ...asst(folder, 'c', { input: 9_999 }), cwd: canonicalFolder(mk()) },
      { ...asst(folder, 'd', { input: 9_999 }), isSidechain: true },
      { ...asst(folder, 'e', { input: 9_999 }), isApiErrorMessage: true }]);
    assert.equal(numbersOf(read(folder, f)).context_tokens, 1000);
  });
  test('during a long turn each read takes only what was added, and a half-written line waits for the next read', () => {
    const f = transcript([prompt(folder), asst(folder, 'a', { input: 10, read: 20_000 })]);
    const s = read(folder, f);
    assert.equal(numbersOf(s).context_tokens, 20_010);
    appendFileSync(f, lines([toolResult(folder), asst(folder, 'b', { input: 10, read: 60_000 })]));
    readMore(s, f);
    assert.equal(numbersOf(s).context_tokens, 60_010, 'the bar moves during the turn');
    const next = JSON.stringify(asst(folder, 'c', { input: 10, read: 90_000 }));
    appendFileSync(f, next.slice(0, 40));
    readMore(s, f);
    assert.equal(numbersOf(s).context_tokens, 60_010, 'a line still being written is not read');
    appendFileSync(f, next.slice(40) + '\n');
    readMore(s, f);
    assert.equal(numbersOf(s).context_tokens, 90_010);
  });
  test('a file that got shorter is read again from the start', () => {
    const f = transcript([prompt(folder), asst(folder, 'a', { input: 50_000 }), asst(folder, 'b', { input: 60_000 })]);
    const s = read(folder, f);
    writeFileSync(f, lines([prompt(folder), asst(folder, 'z', { input: 7 })]));
    readMore(s, f);
    assert.equal(numbersOf(s).context_tokens, 7);
  });
});

describe('Codex session logs: the numbers', () => {
  test('context now is the last call, the window comes from the log, and a turn counts from its start', () => {
    const folder = canonicalFolder(mk());
    const tc = (last, total, win = 272_000) => ({ timestamp: at(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: last }, total_token_usage: { total_tokens: total }, model_context_window: win } } });
    const f = join(mk(), `rollout-${SID}.jsonl`);
    writeFileSync(f, lines([
      { timestamp: at(), type: 'session_meta', payload: { id: SID, cwd: folder } },
      { timestamp: at(), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
      { timestamp: at(), type: 'event_msg', payload: { type: 'task_started', model_context_window: 272_000 } },
      tc(30_000, 30_000), tc(45_000, 75_000),
      { timestamp: at(), type: 'event_msg', payload: { type: 'user_message', message: 'SECRET' } },
      tc(50_000, 125_000),
      { timestamp: at(), type: 'compacted', payload: { message: 'SECRET' } },
      tc(12_000, 137_000),
    ]));
    const s = newState('codex', SID, folder); readMore(s, f);
    const n = numbersOf(s);
    assert.equal(n.context_tokens, 12_000, 'the compact shows as a drop');
    assert.equal(n.window, 272_000);
    assert.equal(n.turn_tokens, 137_000 - 75_000);
    assert.equal(n.compacts, 1);
    assert.equal(n.model, 'gpt-5-codex');
  });
  test("another session's log gives nothing", () => {
    const f = join(mk(), 'rollout-x.jsonl');
    writeFileSync(f, lines([{ type: 'session_meta', payload: { id: 'someone-else', cwd: '/x' } }, { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 5 }, total_token_usage: { total_tokens: 5 } } } }]));
    const s = newState('codex', SID, '/x'); readMore(s, f);
    assert.equal(numbersOf(s), null);
  });
});

/** A registered agent folder on a PC home, with Claude Code's projects folder in a temporary place. */
function setup() {
  const pki = testCa('Context test CA');
  const base = mk(), home = join(base, 'home'), config = join(base, 'claude-config');
  mkdirSync(home, { recursive: true });
  const folder0 = join(base, 'agent'); mkdirSync(folder0);
  const ca = caFingerprint(pki.caPem);
  const hubKey = putHub(home, { hubId: 'hub-ctx', origin: 'https://127.0.0.1:9', caPem: pki.caPem, appKey: 'ah_app_FAKEappKEYforCONTEXTtests0001' });
  putAgentKey(home, hubKey, 'dev-1', 'ah_ses_FAKEsessionKEYforCONTEXT00001');
  writeFileSync(join(home, 'conclave.mjs'), '');
  registerFolder(home, folder0, { hubId: 'hub-ctx', caSha256: ca, agent: 'dev-1', claudeJson: join(base, 'claude.json'), win: WIN });
  const folder = canonicalFolder(folder0);
  const projects = join(config, 'projects', 'agent-project'); mkdirSync(projects, { recursive: true });
  const file = join(projects, `${SID}.jsonl`);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  return { home, folder, hubKey, ca, file, env, section: { hub_id: 'hub-ctx', ca_sha256: ca } };
}
const stopEv = (s, name = 'Stop') => JSON.stringify({ hook_event_name: name, session_id: SID, cwd: s.folder, transcript_path: s.file });

describe('hand-opened chats: the silent hook', () => {
  let s;
  beforeEach(() => { s = setup(); writeFileSync(s.file, lines([prompt(s.folder), asst(s.folder, 'a', { input: 10, read: 62_000 })])); });

  test('with the usage opt-in off nothing is read, nothing is kept and the check-in has no context field', async () => {
    assert.deepEqual(await runContextHook(s.home, s.folder, stopEv(s), { env: s.env }), { state: 'opted_out' });
    assert.equal(existsSync(join(s.home, 'context')), false, 'no file');
    assert.equal(contextReport(s.home, s.hubKey, s.section, new Map(), { env: s.env }), undefined);
    const body = report(s.home, s.hubKey, { node: 'v24', git: null, clients: [] }, s.section, new Map());
    assert.equal('context' in body, false);
  });
  test('with it on, Stop reads the transcript and the next check-in carries numbers only, as a chat', async () => {
    setUsageOptIn(s.home, true);
    assert.deepEqual(await runContextHook(s.home, s.folder, stopEv(s), { env: s.env, now: clock }), { state: 'read' });
    const rows = contextReport(s.home, s.hubKey, s.section, new Map(), { env: s.env, labelToId: (l) => (l === 'dev-1' ? 'agt_dev1' : null) });
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['agent_id', 'at', 'client', 'compacted_at', 'compacts', 'context_tokens', 'model', 'percent', 'source', 'turn_tokens', 'window'].sort());
    assert.equal(rows[0].source, 'chat');
    assert.equal(rows[0].agent_id, 'agt_dev1');
    assert.equal(rows[0].context_tokens, 62_010);
    assert.equal(rows[0].percent, 31);
    assert.ok(!/SECRET|agent-project|sess-ctx/.test(JSON.stringify(rows)));
    const body = report(s.home, s.hubKey, { node: 'v24', git: null, clients: [] }, s.section, new Map());
    assert.ok(Array.isArray(body.context));
  });
  test('PostToolUse reads at most once a minute; Stop always reads', async () => {
    setUsageOptIn(s.home, true);
    const t0 = clock;
    assert.equal((await runContextHook(s.home, s.folder, stopEv(s, 'PostToolUse'), { env: s.env, now: t0 })).state, 'read');
    appendFileSync(s.file, lines([asst(s.folder, 'b', { input: 10, read: 90_000 })]));
    assert.equal((await runContextHook(s.home, s.folder, stopEv(s, 'PostToolUse'), { env: s.env, now: t0 + 10_000 })).state, 'throttled');
    assert.equal(chatContexts(s.home, s.hubKey)[0].numbers.context_tokens, 62_010);
    assert.equal((await runContextHook(s.home, s.folder, stopEv(s, 'PostToolUse'), { env: s.env, now: t0 + CONTEXT_EVERY_MS })).state, 'read');
    assert.equal(chatContexts(s.home, s.hubKey)[0].numbers.context_tokens, 90_010, 'the bar updates during a long turn');
    appendFileSync(s.file, lines([asst(s.folder, 'c', { input: 10, read: 95_000 })]));
    assert.equal((await runContextHook(s.home, s.folder, stopEv(s), { env: s.env, now: t0 + CONTEXT_EVERY_MS + 1 })).state, 'read', 'the turn end');
  });
  test('the hook reads no file outside Claude Code\'s projects folder, and skips other events and bad input', async () => {
    setUsageOptIn(s.home, true);
    const outside = join(mk(), `${SID}.jsonl`); writeFileSync(outside, lines([prompt(s.folder), asst(s.folder, 'x')]));
    assert.equal((await runContextHook(s.home, s.folder, JSON.stringify({ hook_event_name: 'Stop', session_id: SID, transcript_path: outside }), { env: s.env })).state, 'skipped');
    assert.equal((await runContextHook(s.home, s.folder, stopEv(s, 'UserPromptSubmit'), { env: s.env })).state, 'skipped');
    assert.equal((await runContextHook(s.home, s.folder, 'not json', { env: s.env })).state, 'skipped');
    assert.equal((await runContextHook(s.home, mk(), stopEv(s), { env: s.env })).state, 'skipped', 'not an agent folder');
  });
  test('a run the connector started is left to the connector, which reads it itself', async () => {
    setUsageOptIn(s.home, true);
    registerSession(s.home, { client: 'claude_code', sessionId: SID, agentId: 'agt_dev1', hubId: 'hub-ctx', caSha256: s.ca, folder: s.folder });
    assert.equal((await runContextHook(s.home, s.folder, stopEv(s), { env: s.env })).state, 'connector_run');
    const cache = new Map();
    const r1 = connectorContexts(s.home, s.section, cache, { now: clock, env: s.env });
    assert.deepEqual(r1.map((x) => [x.agent_id, x.numbers.context_tokens]), [['agt_dev1', 62_010]]);
    appendFileSync(s.file, lines([asst(s.folder, 'b', { input: 10, read: 80_000 })]));
    assert.equal(connectorContexts(s.home, s.section, cache, { now: clock + 1000, env: s.env })[0].numbers.context_tokens, 62_010, 'at most one read a minute');
    assert.equal(connectorContexts(s.home, s.section, cache, { now: clock + CONTEXT_EVERY_MS, env: s.env })[0].numbers.context_tokens, 80_010, 'and the next minute it moves');
    const rows = contextReport(s.home, s.hubKey, s.section, cache, { now: clock + CONTEXT_EVERY_MS, env: s.env });
    assert.equal(rows[0].source, 'connector');
  });
  test('the context-hook command prints nothing and exits at once, whatever it is given', async () => {
    setUsageOptIn(s.home, true);
    for (const input of [stopEv(s), stopEv(s, 'PostToolUse'), 'garbage', '', JSON.stringify({ hook_event_name: 'Stop' })]) {
      const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, [CLI, 'context-hook', '--folder', s.folder], { env: { ...s.env, CONCLAVE_HOME: s.home }, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', err = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        c.on('close', (code) => resolve({ code, out, err }));
        c.stdin.end(input);
      });
      assert.deepEqual(r, { code: 0, out: '', err: '' }, `input ${input.slice(0, 40)}`);
    }
  });
});

describe('Reset on the PC', () => {
  const home = mk(), hubKey = 'hub-ctx@' + 'a'.repeat(64);
  after(() => setWakeOwnsSession(null));
  test('a deliver order with reason reset and no items is valid and keeps its reason; an unknown reason is not', () => {
    const ok = validateOrder({ id: 'pca_reset00001', kind: 'deliver', payload: { agent_id: 'agt_dev1', reason: 'reset', items: [] } });
    assert.equal(ok.ok, true);
    assert.equal(ok.order.payload.reason, 'reset');
    assert.equal(validateOrder({ id: 'pca_reset00002', kind: 'deliver', payload: { agent_id: 'agt_dev1', reason: 'wipe', items: [] } }).ok, false);
    assert.equal(validateOrder({ id: 'pca_reset00003', kind: 'deliver', payload: { agent_id: 'agt_dev1', items: [] } }).ok, false, 'an item order still needs an item');
  });
  test('without the wake, a reset is answered "by hand", and the agent is asked once to record its progress', () => {
    const r = onResetOrder(home, hubKey, { id: 'pca_reset00010', kind: 'deliver', payload: { agent_id: 'agt_dev1', reason: 'reset', items: [] } });
    assert.deepEqual(r, { state: 'failed', code: 'reset_by_hand', reason: RESET_BY_HAND });
    assert.ok(RESET_BY_HAND.length <= 200 && /\/clear/.test(RESET_BY_HAND));
    assert.equal(takeResetNotice(home, hubKey, 'agt_dev1'), true);
    assert.equal(takeResetNotice(home, hubKey, 'agt_dev1'), false, 'once per reset');
  });
  test('a session the wake holds is reset only when its turn has ended, never in the middle of one', async () => {
    setWakeOwnsSession(() => true);
    assert.deepEqual(onResetOrder(home, hubKey, { id: 'pca_reset00020', kind: 'deliver', payload: { agent_id: 'agt_dev2', reason: 'reset', items: [] } }), { state: 'waiting' });
    let closed = 0, running = true;
    const io = { turnRunning: () => running, closeSession: () => { closed++; } };
    assert.deepEqual(await resetIfIdle(home, hubKey, 'agt_dev2', io), { state: 'waiting' });
    assert.equal(closed, 0, 'nothing closed mid-turn');
    running = false;
    assert.deepEqual(await resetIfIdle(home, hubKey, 'agt_dev2', io), { state: 'done', order: 'pca_reset00020' });
    assert.equal(closed, 1);
    assert.equal(pendingReset(home, hubKey, 'agt_dev2'), null);
    assert.deepEqual(await resetIfIdle(home, hubKey, 'agt_dev2', io), { state: 'none' });
    assert.equal(closed, 1);
  });
});
