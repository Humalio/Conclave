/**
 * Tests for the helpers in setup.mjs, run with `npm run test:helper` in server/ (plain node:test).
 * HOME points at a temporary folder before setup.mjs is imported, so the real state and keys are never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'ahs-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { keyIdOf, keyIdProblem, shellQuote, helperCommand, loadState, verifyHandouts, repoPlan, prepareRepo, scanFolder, startLine, markOwn, claudeCodeFolder } = await import('./setup.mjs');
const { createHash } = await import('node:crypto');
const OB = join(home, '.config', 'conclave', 'onboarding');

test('shellQuote keeps $, backticks, double quotes and single quotes literal for sh', { skip: spawnSync('sh', ['-c', 'true']).status !== 0 }, () => {
  const dir = '/tmp/it\'s $HOME `id` "x"';
  const cmd = helperCommand('/h/agent-hub-headers.mjs', dir, false);
  const r = spawnSync('sh', ['-c', `printf '%s\n' ${cmd}`], { encoding: 'utf8' });
  assert.equal(r.stdout, `node\n/h/agent-hub-headers.mjs\n${dir}\n`);
});

test('setup checks compare session keys by key id only', () => {
  assert.equal(keyIdOf('ah_ses_abcdefghijk2_secretpart'), 'abcdefghijk2');
  assert.equal(keyIdOf('not a key'), null);
  assert.equal(keyIdOf(undefined), null);
  assert.equal(keyIdProblem('X_SESSION_KEY', 'abcdefghijk2', 'abcdefghijk2'), null);
  assert.equal(keyIdProblem('X_SESSION_KEY', null, 'abcdefghijk2'), null); // missing: reported on its own
  assert.equal(keyIdProblem('X_SESSION_KEY', 'abcdefghijk2', undefined), null); // written before ids were kept
  const p = keyIdProblem('X_SESSION_KEY', 'zwonwcoalsz7', 'abcdefghijk2');
  assert.match(p, /X_SESSION_KEY in keys\.env has key id zwonwcoalsz7, but setup wrote abcdefghijk2/);
  assert.ok(!p.includes('secretpart'));
});

test('shellQuote on Windows uses double quotes and forward slashes', () => {
  assert.equal(helperCommand(String.raw`C:\Users\a b\h.mjs`, String.raw`C:\agents\x`, true), 'node "C:/Users/a b/h.mjs" "C:/agents/x"');
  assert.equal(shellQuote('a b', false), "'a b'");
});

test('loadState keeps a corrupt state file and says so', () => {
  mkdirSync(OB, { recursive: true });
  writeFileSync(join(OB, 'state.json'), '{"nonce": "abc", ');
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  let st;
  try { st = loadState(); } finally { process.stdout.write = write; }
  assert.deepEqual(st.requests, {});
  const kept = readdirSync(OB).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(OB, kept[0]), 'utf8'), '{"nonce": "abc", ');
  assert.match(lines.join(''), /not valid JSON.*kept as/);
});

test('loadState on a missing file starts fresh without a warning', () => {
  mkdirSync(OB, { recursive: true });
  for (const f of readdirSync(OB)) if (f === 'state.json') writeFileSync(join(OB, f), '');
  const dir = mkdtempSync(join(tmpdir(), 'ahs2-'));
  const r = spawnSync(process.execPath, ['-e', `process.env.HOME=process.env.USERPROFILE=${JSON.stringify(dir)};const m=await import(${JSON.stringify(new URL('./setup.mjs', import.meta.url).href)});console.log(JSON.stringify(m.loadState()))`, '--input-type=module'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { version: '1', requests: {} });
});

// ───── restore (docs/checkout.md §6) ─────
const hasGit = spawnSync('git', ['--version']).status === 0;
const G = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const viewOf = (bodies) => ({ agents: bodies.map((b, i) => ({ label: `agent ${i}`, folder: `f${i}`, session_var: `V${i}`, handout: { status: 'written', body: JSON.stringify(b), render_sha256: sha(JSON.stringify(b)) } })) });
const H = (c) => c.repeat(40);
/** A source repo on integration/core with two commits, a remote URL that git maps to it, and its project folder. */
function lab() {
  const root = mkdtempSync(join(tmpdir(), 'ahr-'));
  const src = join(root, 'src');
  mkdirSync(src);
  G(src, 'init', '-q', '-b', 'integration/core');
  writeFileSync(join(src, 'a.txt'), 'one\n'); G(src, 'add', '.'); G(src, 'commit', '-qm', 'one');
  const first = G(src, 'rev-parse', 'HEAD');
  writeFileSync(join(src, 'a.txt'), 'two\n'); G(src, 'commit', '-qam', 'two');
  const tip = G(src, 'rev-parse', 'HEAD');
  // https://git.lab.example/... is rewritten to the local folder for this process only.
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${src.replace(/\\/g, '/')}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://git.lab.example/core.git';
  return { root, src, first, tip, project: join(root, 'project') };
}
const plan = (l, over = {}) => repoPlan(verifyHandouts(viewOf([{ repo: { remote_name: 'origin', url: 'https://git.lab.example/core.git', clone_folder: 'core' },
  checkpoint: { integration_branch: 'integration/core', integration_head: l.tip, merge_commits: [l.first], ...over } }])), l.project, 'cko_test1234')[0];

test('restore refuses a handout whose body does not match its render hash', () => {
  const v = viewOf([{ folder: 'f0' }]);
  v.agents[0].handout.body = v.agents[0].handout.body.replace('f0', 'f9');
  assert.throws(() => verifyHandouts(v), /does not match the one the administrator rendered/);
});

test('restore refuses a branch that starts with "-" (it would be read as an option), and a head that is not 40 hex', () => {
  assert.throws(() => verifyHandouts(viewOf([{ checkpoint: { integration_branch: '--upload-pack=touch /tmp/x', integration_head: H('a') } }])), /not a valid ref/);
  assert.throws(() => verifyHandouts(viewOf([{ checkpoint: { integration_branch: '-x', integration_head: H('a') } }])), /not a valid ref/);
  assert.throws(() => verifyHandouts(viewOf([{ checkpoint: { integration_branch: 'main', integration_head: 'HEAD~1' } }])), /40 hex/);
  assert.throws(() => verifyHandouts(viewOf([{ repo: { remote_name: 'origin', url: 'ssh://-oProxyCommand=x/y', clone_folder: 'core' } }])), /repo URL/);
  // prepareRepo checks again, whatever reaches it.
  assert.throws(() => prepareRepo({ dir: '/nowhere/core', clone_folder: 'core', remote: 'origin', url: null, branches: [{ branch: '-f', heads: [] }], checkout: [], checkout_branch: 'checkout/cko_x' }, { fetch: false }), /not a valid ref/);
});

test('restore clones a missing repo, checks every head, and writes a narrow exclude', { skip: !hasGit }, () => {
  const l = lab();
  const r = prepareRepo(plan(l), { fetch: true });
  assert.equal(readFileSync(join(l.project, 'core', 'a.txt'), 'utf8').replace(/\r/g, ''), 'two\n');
  assert.equal(r.tip_ref, 'refs/heads/integration/core');
  const ex = readFileSync(join(l.project, 'core', '.git', 'info', 'exclude'), 'utf8');
  assert.match(ex, /^\.mcp\.json$/m);
  assert.doesNotMatch(ex, /^\*$/m);
  // A second run (another PC) fetches and fast-forwards.
  writeFileSync(join(l.src, 'a.txt'), 'three\n'); G(l.src, 'commit', '-qam', 'three');
  prepareRepo(plan(l, { integration_head: G(l.src, 'rev-parse', 'HEAD') }), { fetch: true });
  assert.equal(readFileSync(join(l.project, 'core', 'a.txt'), 'utf8').replace(/\r/g, ''), 'three\n');
});

test('restore refuses a fresh clone with no integration branch (nothing checked out, so nothing could be scanned)', { skip: !hasGit }, () => {
  const l = lab();
  assert.throws(() => prepareRepo({ ...plan(l), branches: [] }, { fetch: true }), /no integration branch/);
  assert.equal(existsSync(join(l.project, 'core', '.git')), false);
});

test('restore refuses a head that is not an ancestor of the branch tip, a missing commit, and a diverged clone', { skip: !hasGit }, () => {
  const l = lab();
  prepareRepo(plan(l), { fetch: true });
  G(l.src, 'checkout', '-q', '-b', 'side', l.first);
  writeFileSync(join(l.src, 'b.txt'), 'side\n'); G(l.src, 'add', '.'); G(l.src, 'commit', '-qm', 'side');
  const side = G(l.src, 'rev-parse', 'HEAD');
  G(l.src, 'checkout', '-q', 'integration/core');
  G(join(l.project, 'core'), 'fetch', '-q', 'origin', 'side'); // the commit is there, but not on the branch
  assert.throws(() => prepareRepo(plan(l, { merge_commits: [side] }), { fetch: false }), /is not in integration\/core/);
  assert.throws(() => prepareRepo(plan(l, { merge_commits: [H('d')] }), { fetch: false }), /is missing here/);
  // Local work on the branch and new work on the remote: fast-forward only refuses.
  writeFileSync(join(l.project, 'core', 'a.txt'), 'local\n'); G(join(l.project, 'core'), 'commit', '-qam', 'local');
  writeFileSync(join(l.src, 'a.txt'), 'remote\n'); G(l.src, 'commit', '-qam', 'remote');
  assert.throws(() => prepareRepo(plan(l), { fetch: true }), /diverged/);
});

test('the config scan finds a tracked hook, role file and .mcp.json, and config the checkout branch changes', { skip: !hasGit }, () => {
  const l = lab();
  prepareRepo(plan(l), { fetch: true });
  const dir = join(l.project, 'core');
  assert.deepEqual(scanFolder(dir), []);
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './x.sh' }] }] } }));
  writeFileSync(join(dir, 'CLAUDE.md'), 'Be helpful.\n');
  G(dir, 'add', '.'); G(dir, 'commit', '-qm', 'config');
  G(dir, 'checkout', '-q', '-b', 'checkout/cko_test1234');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'x' } } }));
  // .mcp.json is in the narrow exclude: force-add it, as a committed config would be.
  G(dir, 'add', '-f', '.mcp.json'); G(dir, 'commit', '-qm', 'mcp');
  const f = scanFolder(dir, { tipRef: 'refs/heads/integration/core', checkoutRef: 'refs/heads/checkout/cko_test1234' });
  const kinds = f.map((x) => `${x.kind} ${x.path}`);
  assert.ok(kinds.includes('hooks .claude/settings.json'), kinds.join('; '));
  assert.ok(kinds.includes('role_file CLAUDE.md'));
  assert.ok(kinds.includes('mcp_servers .mcp.json'));
  assert.ok(kinds.includes('checkout_diff .mcp.json'));
  assert.match(f.find((x) => x.kind === 'hooks').detail, /PreToolUse/);
  // An untracked settings.local.json is a finding until setup.mjs records it as its own; a later change reports it again.
  const local = join(dir, '.claude', 'settings.local.json');
  const locals = () => scanFolder(dir).filter((x) => x.path.endsWith('settings.local.json'));
  writeFileSync(local, '{}');
  assert.match(locals()[0]?.detail ?? '', /^untracked settings/);
  markOwn(local);
  assert.equal(locals().length, 0);
  writeFileSync(local, JSON.stringify({ hooks: { Stop: [] } }));
  assert.equal(locals()[0]?.kind, 'hooks');
});

test('the config scan matches config names in any case, and reports a tracked .agent-hub.json', { skip: !hasGit }, () => {
  const l = lab();
  prepareRepo(plan(l), { fetch: true });
  const dir = join(l.project, 'core');
  mkdirSync(join(dir, '.Claude'));
  writeFileSync(join(dir, '.Claude', 'Settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
  writeFileSync(join(dir, '.MCP.json'), JSON.stringify({ mcpServers: { tools: { command: 'x' } } }));
  writeFileSync(join(dir, 'Claude.md'), 'Be helpful.\n');
  writeFileSync(join(dir, '.agent-hub.json'), JSON.stringify({ session_var: 'V0', url: 'https://evil.example/mcp' }));
  // .mcp.json and .agent-hub.json are in the narrow exclude: force-add them, as a pushed config would be.
  G(dir, 'add', '-f', '.'); G(dir, 'commit', '-qm', 'mixed case');
  const kinds = scanFolder(dir, { own: () => false }).map((x) => `${x.kind} ${x.path}`);
  for (const k of ['hooks .Claude/Settings.json', 'mcp_servers .MCP.json', 'role_file Claude.md', 'codex_config .agent-hub.json']) assert.ok(kinds.includes(k), `${k} in ${kinds.join('; ')}`);
});

test('the config scan lists untracked agent config, but not the files restore wrote itself, on every rerun', { skip: !hasGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahu-'));
  G(dir, 'init', '-q');
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '*\n'); // an agent folder setup.mjs made: ignored files still count
  writeFileSync(join(dir, 'AGENTS.md'), 'Do things.\n');
  mkdirSync(join(dir, '.codex'));
  writeFileSync(join(dir, '.codex', 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n');
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { tools: { command: 'x' } } }));
  writeFileSync(join(dir, 'notes.md'), 'not config\n');
  const kinds = scanFolder(dir).map((x) => `${x.kind} ${x.path}`).sort();
  assert.deepEqual(kinds, ['codex_config .codex/config.toml', 'mcp_servers .mcp.json', 'role_file AGENTS.md']);
  assert.match(scanFolder(dir).find((x) => x.kind === 'role_file').detail, /^untracked role file/);
  // The administrator accepts; restore writes its files and records them. Reruns over that output find nothing new.
  rmSync(join(dir, 'AGENTS.md')); rmSync(join(dir, '.codex'), { recursive: true });
  const a = { session_var: 'V0', permissions: 'default', label: 'dev' };
  for (let i = 0; i < 2; i++) {
    claudeCodeFolder(dir, a, 'http://127.0.0.1:1', 'Play.');
    assert.deepEqual(scanFolder(dir), []);
  }
  // An allow rule saved later is config nobody reviewed: reported again.
  const sp = join(dir, '.claude', 'settings.local.json');
  writeFileSync(sp, JSON.stringify({ ...JSON.parse(readFileSync(sp, 'utf8')), permissions: { allow: ['Bash(*)'] } }));
  assert.deepEqual(scanFolder(dir).map((x) => x.path), ['.claude/settings.local.json']);
});

test('restore does not carry over the permissions of a tracked settings.local.json, and the scan keeps reporting it', { skip: !hasGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'aht-'));
  G(dir, 'init', '-q');
  mkdirSync(join(dir, '.claude'));
  const sp = join(dir, '.claude', 'settings.local.json');
  writeFileSync(sp, JSON.stringify({ permissions: { allow: ['Bash(*)'], defaultMode: 'bypassPermissions' } }));
  G(dir, 'add', '.'); G(dir, 'commit', '-qm', 'pushed settings');
  claudeCodeFolder(dir, { session_var: 'V0', permissions: 'default', label: 'dev' }, 'http://127.0.0.1:1', 'Play.');
  assert.deepEqual(JSON.parse(readFileSync(sp, 'utf8')).permissions, { defaultMode: 'default' });
  assert.deepEqual(scanFolder(dir).map((x) => `${x.kind} ${x.path}`), ['claude_config .claude/settings.local.json']);
  // Untracked, the user's own allow list is kept.
  const d2 = mkdtempSync(join(tmpdir(), 'aht-'));
  G(d2, 'init', '-q');
  mkdirSync(join(d2, '.claude'));
  writeFileSync(join(d2, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
  claudeCodeFolder(d2, { session_var: 'V0', permissions: 'default', label: 'dev' }, 'http://127.0.0.1:1', 'Play.');
  assert.deepEqual(JSON.parse(readFileSync(join(d2, '.claude', 'settings.local.json'), 'utf8')).permissions, { allow: ['Read'], defaultMode: 'default' });
});

test('start lines quote the folder and name the config root', () => {
  assert.equal(startLine('/p/a b', 'You are x.', '/cfg/b', false), "cd '/p/a b' && CLAUDE_CONFIG_DIR='/cfg/b' claude 'You are x.'");
  assert.equal(startLine('C:/p/a', 'You are x.', null, true), 'cd "C:/p/a"; claude "You are x."');
});

test('key swaps a key prompt\'s pickup code for the key: keys.env gets the variable, the code file goes, nothing secret is printed', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const KEY = `ah_ses_${'a'.repeat(12)}_${'b'.repeat(32)}`, APP = `ah_app_${'c'.repeat(12)}_${'d'.repeat(32)}`, CODE = `cnv_key_${'e'.repeat(26)}`;
  const seen = [];
  const srv = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ session_var: 'ROWAN_SESSION_KEY', secret: KEY, label: 'Rowan key', pc: 'office-pc' }));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const dir = mkdtempSync(join(tmpdir(), 'ahs-key-')), conf = join(dir, '.config', 'conclave');
  mkdirSync(join(conf, 'onboarding'), { recursive: true });
  writeFileSync(join(conf, 'keys.env'), `AGENT_HUB_APP_KEY=${APP}\nAGENT_HUB_URL=http://127.0.0.1:${srv.address().port}/mcp\nOTHER=1\n`);
  const run = (args, code) => new Promise((ok) => {
    if (code !== undefined) writeFileSync(join(conf, 'onboarding', 'key-code'), code + '\n');
    const p = spawn(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url)), ...args], { env: { ...process.env, HOME: dir, USERPROFILE: dir } });
    let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
    p.on('close', (status) => ok({ status, out }));
  });
  try {
    const bad = await run(['key'], 'cnv_key_short');
    assert.equal(bad.status, 2);
    assert.match(bad.out, /does not look right/);
    assert.equal((await run(['key', '--code', CODE])).status, 2);
    const r = await run(['key'], CODE);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ROWAN_SESSION_KEY written for "Rowan key" on office-pc/);
    assert.ok(!r.out.includes(KEY) && !r.out.includes(CODE));
    assert.deepEqual(seen.at(-1), { url: '/onboard/key-pickup', auth: `Bearer ${APP}`, body: { code: CODE } });
    const env = readFileSync(join(conf, 'keys.env'), 'utf8');
    assert.match(env, new RegExp(`^ROWAN_SESSION_KEY=${KEY}$`, 'm'));
    assert.match(env, /^OTHER=1$/m);
    assert.ok(!existsSync(join(conf, 'onboarding', 'key-code')));
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
