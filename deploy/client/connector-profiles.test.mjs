// Account profiles (docs/connector.md "Account profiles"): binding writes trust into the bound profile's folder only,
// the run environment is the profile's one variable, a hidden profile is not reported, an email-shaped or key-shaped name
// is refused, and an agent with no profile is unchanged. Temporary folders; nothing touches a real config.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCa } from '../../server/test/test-ca.mjs';
import { putHub, putAgentKey, caFingerprint } from './connector/keyfile.mjs';
import { registerFolder } from './connector/register.mjs';
import { readJson, canonicalFolder, trustKeys, WIN } from './connector/paths.mjs';
import { registryPath } from './connector/registry.mjs';
import { markRunning, runningAgents } from './connector/run.mjs';
import { addProfile, setHidden, bindAgent, bindTeam, runEnv, reportedProfile, checkName, removeProfile, listTeams, bindRegisteredTeam, grantCodexTrust, projectHeaderFolder } from './connector/profiles.mjs';
import { startScreen } from './connector/screen.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'cn-prof-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const KEY = 'ah_ses_FAKEsessionKEYforPROFILE00001';

function setup({ codex = false } = {}) {
  const pki = testCa('Profiles CA'), base = mk(), home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const folder = join(base, 'agent'); mkdirSync(folder);
  const hubKey = putHub(home, { hubId: 'hub-prof', origin: 'https://127.0.0.1:9', caPem: pki.caPem, appKey: 'ah_app_FAKEappKEYforPROFILEtests001' });
  putAgentKey(home, hubKey, 'dev-1', KEY);
  writeFileSync(join(home, 'conclave.mjs'), '');
  const claudeJson = join(base, 'default-claude.json');
  registerFolder(home, folder, { hubId: 'hub-prof', caSha256: caFingerprint(pki.caPem), agent: 'dev-1', claudeJson, win: WIN, provider: codex ? 'codex' : null });
  return { base, home, folder: canonicalFolder(folder), hubKey, claudeJson, caSha: caFingerprint(pki.caPem) };
}
/** A team of three agents registered on this PC as pickup records them: two Claude folders and one Codex folder. */
function teamSetup() {
  const s = setup();
  const team = { id: 'team_build', name: 'Builders' };
  const more = [['dev-2', null], ['cx-1', 'codex']].map(([agent, provider]) => {
    const dir = join(s.base, agent); mkdirSync(dir);
    putAgentKey(s.home, s.hubKey, agent, KEY);
    registerFolder(s.home, dir, { hubId: 'hub-prof', caSha256: s.caSha, agent, claudeJson: s.claudeJson, win: WIN, provider, team });
    return canonicalFolder(dir);
  });
  registerFolder(s.home, s.folder, { hubId: 'hub-prof', caSha256: s.caSha, agent: 'dev-1', claudeJson: s.claudeJson, win: WIN, team });
  return { ...s, team, dev2: more[0], codexFolder: more[1] };
}
const trusted = (file, folder) => { const j = readJson(file, {}); return trustKeys(folder, WIN).every((k) => j.projects?.[k]?.hasTrustDialogAccepted === true); };
const bindingOf = (home) => Object.values(readJson(registryPath(home)).folders)[0];

describe('account profiles', () => {
  test('binding writes trust into the bound profile only, and the default config is not touched again', () => {
    const s = setup();
    const work = join(s.base, 'claude-work'), personal = join(s.base, 'claude-personal');
    assert.ok(addProfile(s.home, 'work', { kind: 'claude', dir: work }).ok);
    assert.ok(addProfile(s.home, 'personal', { kind: 'claude', dir: personal }).ok);
    const before = readFileSync(s.claudeJson, 'utf8');
    const r = bindAgent(s.home, s.folder, 'work', { win: WIN });
    assert.equal(r.ok, true);
    assert.ok(trusted(join(work, '.claude.json'), s.folder));
    assert.deepEqual(readdirSync(work), ['.claude.json'], 'the only file written into the profile is its trust file');
    assert.deepEqual(readdirSync(personal), [], 'another profile is untouched');
    assert.equal(readFileSync(s.claudeJson, 'utf8'), before, 'the default config is not rewritten');
    assert.equal(bindingOf(s.home).profile, 'work');
  });

  test('trust is merged into an existing profile file and keeps its other content', () => {
    const s = setup(), dir = join(s.base, 'cw'); mkdirSync(dir);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ userID: 'keep-me', projects: { other: { hasTrustDialogAccepted: true } } }));
    addProfile(s.home, 'work', { kind: 'claude', dir });
    bindAgent(s.home, s.folder, 'work', { win: WIN });
    const j = readJson(join(dir, '.claude.json'));
    assert.equal(j.userID, 'keep-me'); assert.equal(j.projects.other.hasTrustDialogAccepted, true); assert.ok(trusted(join(dir, '.claude.json'), s.folder));
  });

  test('a Codex profile gets trust in its own config.toml, and a trust_level already there is kept', () => {
    const s = setup({ codex: true }), dir = join(s.base, 'codex-work');
    addProfile(s.home, 'cx', { kind: 'codex', dir });
    assert.equal(bindAgent(s.home, s.folder, 'cx').ok, true);
    const toml = readFileSync(join(dir, 'config.toml'), 'utf8');
    assert.match(toml, /trust_level = "trusted"/);
    assert.ok(toml.includes(s.folder.replace(/\\/g, '\\\\')));
    assert.deepEqual(readdirSync(dir), ['config.toml']);
    assert.equal(bindAgent(s.home, s.folder, 'cx').trust_written, false, 'bound again: nothing added twice');
    assert.equal(readFileSync(join(dir, 'config.toml'), 'utf8'), toml);
  });

  test('a Codex table the program wrote itself, in its own quoting, is the same table: never a second one', () => {
    const base = mkdtempSync(join(tmpdir(), 'cx-hdr-')), f = join(base, 'config.toml');
    // Codex on Windows writes a literal string, with backslashes as they are and the drive letter in either case.
    writeFileSync(f, "model = \"x\"\n\n[projects.'c:\\workspace\\app']\ntrust_level = \"untrusted\"\n\n[projects.'C:\\Workspace\\Other']\nnote = 1\n");
    assert.equal(grantCodexTrust(f, 'C:\\Workspace\\App', { win: true }).wrote, false, 'the user chose untrusted: kept');
    assert.equal(grantCodexTrust(f, 'C:\\Workspace\\Other', { win: true }).wrote, true);
    const t = readFileSync(f, 'utf8');
    assert.equal((t.match(/^\[projects\./gm) ?? []).length, 2, 'no duplicate table');
    assert.match(t, /\[projects\.'C:\\Workspace\\Other'\]\ntrust_level = "trusted"\nnote = 1/);
    // On Linux and macOS a path is case-sensitive: another case is another folder.
    writeFileSync(f, "[projects.'/home/u/App']\ntrust_level = \"trusted\"\n");
    assert.equal(grantCodexTrust(f, '/home/u/app', { win: false }).wrote, true);
    assert.equal(grantCodexTrust(f, '/home/u/App', { win: false }).wrote, false);
    assert.equal((readFileSync(f, 'utf8').match(/^\[projects\./gm) ?? []).length, 2);
    rmSync(base, { recursive: true, force: true });
  });

  test('project headers are read in every TOML quoting', () => {
    assert.equal(projectHeaderFolder('[projects."C:\\\\a\\\\b"]'), 'C:\\a\\b');
    assert.equal(projectHeaderFolder("[projects.'C:\\a\\b']"), 'C:\\a\\b');
    assert.equal(projectHeaderFolder('  [ projects . "/x/\\"q\\"" ]  # note'), '/x/"q"');
    assert.equal(projectHeaderFolder('[projects]'), null);
    assert.equal(projectHeaderFolder('[other."/x"]'), null);
  });

  test('a profile of the other program is refused', () => {
    const s = setup(); addProfile(s.home, 'cx', { kind: 'codex', dir: join(s.base, 'cx') });
    assert.equal(bindAgent(s.home, s.folder, 'cx').reason, 'wrong_kind');
    assert.equal(bindAgent(s.home, s.folder, 'nope').reason, 'no_such_profile');
  });

  test('the run environment is the profile variable and nothing else; no profile gives an empty one', () => {
    const s = setup(); const dir = join(s.base, 'cw');
    assert.deepEqual(runEnv(s.home, s.folder), {}, 'default: unchanged');
    addProfile(s.home, 'work', { kind: 'claude', dir });
    bindAgent(s.home, s.folder, 'work');
    assert.deepEqual(runEnv(s.home, s.folder), { CLAUDE_CONFIG_DIR: canonicalFolder(dir) });
    bindAgent(s.home, s.folder, null);
    assert.deepEqual(runEnv(s.home, s.folder), {});
    assert.deepEqual(runEnv(s.home, join(s.base, 'unregistered')), {});
    const c = setup({ codex: true }); addProfile(c.home, 'cx', { kind: 'codex', dir: join(c.base, 'cx') }); bindAgent(c.home, c.folder, 'cx');
    assert.deepEqual(Object.keys(runEnv(c.home, c.folder)), ['CODEX_HOME']);
  });

  test('a team binding gives its agents the profile, and an agent binding wins', () => {
    const s = setup(); addProfile(s.home, 'a', { kind: 'claude', dir: join(s.base, 'a') }); addProfile(s.home, 'b', { kind: 'claude', dir: join(s.base, 'b') });
    assert.equal(bindTeam(s.home, 'team_1', 'a', [s.folder]).ok, true);
    assert.ok(trusted(join(s.base, 'a', '.claude.json'), s.folder));
    assert.equal(runEnv(s.home, s.folder).CLAUDE_CONFIG_DIR, canonicalFolder(join(s.base, 'a')));
    bindAgent(s.home, s.folder, 'b');
    assert.equal(runEnv(s.home, s.folder).CLAUDE_CONFIG_DIR, canonicalFolder(join(s.base, 'b')));
  });

  test('registration records the team the hub named, and a later registration without one keeps it', () => {
    const s = teamSetup();
    assert.deepEqual(listTeams(s.home).map((t) => [t.id, t.name, t.folders.length]), [['team_build', 'Builders', 3]]);
    registerFolder(s.home, s.dev2, { hubId: 'hub-prof', caSha256: s.caSha, agent: 'dev-2', claudeJson: s.claudeJson, win: WIN });
    assert.equal(listTeams(s.home)[0].folders.length, 3);
    // A name the hub sent is kept to one plain line; an invalid id is ignored and the recorded team stays.
    registerFolder(s.home, s.dev2, { hubId: 'hub-prof', caSha256: s.caSha, agent: 'dev-2', claudeJson: s.claudeJson, win: WIN, team: { id: 'team_x', name: 'Two\nlines' } });
    assert.equal(listTeams(s.home).find((t) => t.id === 'team_x').name, 'Two lines');
    registerFolder(s.home, s.dev2, { hubId: 'hub-prof', caSha256: s.caSha, agent: 'dev-2', claudeJson: s.claudeJson, win: WIN, team: { id: 'bad id!' } });
    assert.equal(listTeams(s.home).find((t) => t.id === 'team_x').folders.length, 1);
  });

  test("Bind team writes trust into every one of the team's folders of that program, and skips the other program", () => {
    const s = teamSetup(), dir = join(s.base, 'work');
    addProfile(s.home, 'work', { kind: 'claude', dir });
    const r = bindRegisteredTeam(s.home, 'team_build', 'work');
    assert.deepEqual([r.ok, r.folders, r.skipped, r.team], [true, 2, 1, 'Builders']);
    assert.ok(trusted(join(dir, '.claude.json'), s.folder)); assert.ok(trusted(join(dir, '.claude.json'), s.dev2));
    assert.equal(runEnv(s.home, s.dev2).CLAUDE_CONFIG_DIR, canonicalFolder(dir));
    assert.deepEqual(runEnv(s.home, s.codexFolder), {}, 'a Claude profile does not apply to the Codex agent');
    assert.equal(listTeams(s.home)[0].profile, 'work');
    // A Codex profile then binds only the Codex agent, and the team's Claude agents go back to the default account.
    addProfile(s.home, 'cx', { kind: 'codex', dir: join(s.base, 'cxh') });
    assert.equal(bindRegisteredTeam(s.home, 'team_build', 'cx').folders, 1);
    assert.equal(runEnv(s.home, s.codexFolder).CODEX_HOME, canonicalFolder(join(s.base, 'cxh')));
    assert.deepEqual(runEnv(s.home, s.dev2), {});
  });

  test('Bind team with one changed folder writes nothing at all', () => {
    const s = teamSetup(), dir = join(s.base, 'work');
    addProfile(s.home, 'work', { kind: 'claude', dir });
    writeFileSync(join(s.dev2, 'CLAUDE.md'), 'changed by someone\n');
    const before = readFileSync(registryPath(s.home), 'utf8');
    assert.equal(bindRegisteredTeam(s.home, 'team_build', 'work').reason, 'config_changed');
    assert.equal(readFileSync(registryPath(s.home), 'utf8'), before, 'the registry is unchanged');
    assert.equal(existsSync(join(dir, '.claude.json')), false, 'no trust was written for the unchanged folder either');
    assert.deepEqual(runEnv(s.home, s.folder), {});
  });

  test("an agent's own binding still beats the team's, and unbinding the team keeps it", () => {
    const s = teamSetup();
    addProfile(s.home, 'team-acct', { kind: 'claude', dir: join(s.base, 't') }); addProfile(s.home, 'mine', { kind: 'claude', dir: join(s.base, 'm') });
    bindAgent(s.home, s.folder, 'mine');
    bindRegisteredTeam(s.home, 'team_build', 'team-acct');
    assert.equal(runEnv(s.home, s.folder).CLAUDE_CONFIG_DIR, canonicalFolder(join(s.base, 'm')));
    assert.equal(runEnv(s.home, s.dev2).CLAUDE_CONFIG_DIR, canonicalFolder(join(s.base, 't')));
    assert.equal(bindRegisteredTeam(s.home, 'team_build', null).ok, true);
    assert.deepEqual(runEnv(s.home, s.dev2), {});
    assert.equal(runEnv(s.home, s.folder).CLAUDE_CONFIG_DIR, canonicalFolder(join(s.base, 'm')));
    assert.equal(bindRegisteredTeam(s.home, 'team_none', 'mine').reason, 'no_such_team');
  });

  test('the screen lists the team and its Bind team form binds it', async () => {
    const s = teamSetup();
    addProfile(s.home, 'work', { kind: 'claude', dir: join(s.base, 'work') });
    const scr = await startScreen(s.home, { claudeJson: s.claudeJson, io: { pair: async () => ({ ok: false }) } });
    try {
      const at = (p, o = {}) => fetch(`http://127.0.0.1:${scr.port}${p}`, { redirect: 'manual', ...o });
      const r = await at(`/?t=${new URL(scr.url).searchParams.get('t')}`);
      const cookie = r.headers.get('set-cookie').split(';')[0];
      const page = await (await at('/', { headers: { cookie } })).text();
      assert.match(page, /<b>Builders<\/b><span class="muted">Team, 3 agents<\/span>/);
      assert.match(page, /Bind team<\/button>/);
      const post = await at('/profile-bind-team', { method: 'POST', headers: { cookie, origin: `http://127.0.0.1:${scr.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'team=team_build&profile=work' });
      assert.equal(post.status, 303);
      assert.match(await (await at('/', { headers: { cookie } })).text(), /Builders: 2 agents bound to work\. 1 run the other program and keep their account\./);
      assert.equal(runEnv(s.home, s.dev2).CLAUDE_CONFIG_DIR, canonicalFolder(join(s.base, 'work')));
    } finally { scr.close(); }
  });

  test('a run on the bound profile reports its name, or only that it is hidden; a chat opened by hand reports nothing', () => {
    const s = setup(); addProfile(s.home, 'work', { kind: 'claude', dir: join(s.base, 'cw') });
    // Started with the profile's variable, as the wake does (runEnv).
    let un = markRunning(s.home, s.hubKey, 'dev-1', 'agent-1', process.pid, { CLAUDE_CONFIG_DIR: join(s.base, 'cw') });
    try {
      assert.deepEqual(runningAgents(s.home, s.hubKey), [{ agent_id: 'agent-1', state: 'open' }], 'not bound yet');
      bindAgent(s.home, s.folder, 'work');
      assert.deepEqual(runningAgents(s.home, s.hubKey), [{ agent_id: 'agent-1', state: 'open', profile: 'work' }]);
      setHidden(s.home, 'work', true);
      assert.deepEqual(runningAgents(s.home, s.hubKey), [{ agent_id: 'agent-1', state: 'open', profile_hidden: true }], 'hidden: no name, only that it is hidden');
      assert.equal(reportedProfile(s.home, { profile: 'work' }), null);
      setHidden(s.home, 'work', false);
    } finally { un(); }
    // The same bound agent in a chat opened by hand (no variable, or another account folder): nothing about a profile.
    for (const env of [{}, { CLAUDE_CONFIG_DIR: join(s.base, 'elsewhere') }, { CODEX_HOME: join(s.base, 'cw') }]) {
      un = markRunning(s.home, s.hubKey, 'dev-1', 'agent-1', process.pid, env);
      try { assert.deepEqual(runningAgents(s.home, s.hubKey), [{ agent_id: 'agent-1', state: 'open' }], JSON.stringify(Object.keys(env))); } finally { un(); }
    }
    assert.ok(!readdirSync(join(s.home, 'run')).some((d) => readdirSync(join(s.home, 'run', d)).length), 'marks removed');
  });

  test('an email-shaped, key-shaped or odd name is refused', () => {
    const s = setup(), dir = (n) => join(s.base, n);
    const keyShaped = 'ah_ses_' + 'a'.repeat(12) + 'b'.repeat(32);
    for (const bad of ['me@example.com', 'jane.doe', keyShaped, keyShaped.replace(/_/g, ''), '', '-x', 'a'.repeat(41)]) {
      assert.equal(addProfile(s.home, bad, { kind: 'claude', dir: dir('x') }).ok, false, bad);
    }
    assert.equal(checkName('me@example.com').reason, 'email_shaped');
    assert.equal(checkName(keyShaped).reason, 'key_shaped');
    assert.equal(existsSync(dir('x')), false, 'a refused name creates nothing');
    assert.equal(checkName('Work 2').ok, true);
  });

  for (const codex of [false, true]) {
    test(`${codex ? 'Codex' : 'Claude'}: a folder whose agent settings changed gets no trust, by agent or by team`, () => {
      const s = setup({ codex }), dir = join(s.base, 'p');
      addProfile(s.home, 'p', { kind: codex ? 'codex' : 'claude', dir });
      writeFileSync(join(s.folder, 'CLAUDE.md'), 'changed after registration');
      assert.equal(bindAgent(s.home, s.folder, 'p').reason, 'config_changed');
      assert.equal(bindTeam(s.home, 'team_1', 'p', [s.folder]).reason, 'config_changed');
      assert.deepEqual(readdirSync(dir), [], 'nothing written into the profile');
      assert.equal(bindingOf(s.home).profile, undefined);
      assert.equal(bindingOf(s.home).team, undefined);
      assert.deepEqual(runEnv(s.home, s.folder), {});
    });
  }

  test('removing a profile unbinds it and leaves its folder', () => {
    const s = setup(), dir = join(s.base, 'cw'); addProfile(s.home, 'work', { kind: 'claude', dir });
    bindAgent(s.home, s.folder, 'work'); assert.ok(removeProfile(s.home, 'work'));
    assert.deepEqual(runEnv(s.home, s.folder), {}); assert.ok(existsSync(join(dir, '.claude.json')));
  });

  test('registering the folder again keeps its profile', () => {
    const s = setup(); addProfile(s.home, 'work', { kind: 'claude', dir: join(s.base, 'cw') }); bindAgent(s.home, s.folder, 'work');
    registerFolder(s.home, s.folder, { hubId: 'hub-prof', caSha256: s.caSha, agent: 'dev-1', claudeJson: s.claudeJson, win: WIN });
    assert.equal(runEnv(s.home, s.folder).CLAUDE_CONFIG_DIR, canonicalFolder(join(s.base, 'cw')));
  });
});
