import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';

// CONFIG_DIR is read when the module loads, so point it at a fixture first (node --test runs each file in its own process).
const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ahb-cfg-')));
const home = path.join(base, 'real', 'Home');
const cfg = path.join(home, '.agent-hub');
mkdirSync(cfg, { recursive: true });
writeFileSync(path.join(cfg, 'bridge.json'), '{}');
process.env.AGENT_HUB_HOME = cfg;
// The connector's own folder: its keys, its builds and its launcher. Throwaway files, no real key.
const conn = path.join(home, '.config', 'conclave');
mkdirSync(path.join(conn, 'app', '1.0.0', 'deploy', 'client'), { recursive: true });
writeFileSync(path.join(conn, 'keys.json'), '{"hubs":{}}');
writeFileSync(path.join(conn, 'keys.master'), 'throwaway');
writeFileSync(path.join(conn, 'approvals.json'), '{}');
mkdirSync(path.join(conn, 'run'), { recursive: true });
writeFileSync(path.join(conn, 'run', 'broker.secret'), 'throwaway');
writeFileSync(path.join(conn, 'conclave.mjs'), '// launcher\n');
writeFileSync(path.join(conn, 'app', '1.0.0', 'deploy', 'client', 'conclave.mjs'), '// build\n');
process.env.CONCLAVE_HOME = conn;
const { isInside, requirePath, protectedFileReason } = await import('./connector/transfers.mjs');
after(() => rmSync(base, { recursive: true, force: true }));

test('isInside folds case on Windows and macOS only', () => {
  assert.equal(isInside('/Users/u/.AGENT-HUB/bridge.json', '/Users/u/.agent-hub', 'darwin'), true);
  assert.equal(isInside('/Users/u/.AGENT-HUB/bridge.json', '/Users/u/.agent-hub', 'linux'), false);
  assert.equal(isInside('C:\\USERS\\U\\.Agent-Hub\\bridge.json', 'c:\\users\\u\\.agent-hub', 'win32'), true);
  assert.equal(isInside('C:/Users/u/.agent-hub', 'C:\\Users\\u\\.agent-hub', 'win32'), true);
  assert.equal(isInside('/Users/u/.agent-hub2/x', '/Users/u/.agent-hub', 'darwin'), false);
  assert.equal(isInside('/Users/u/.agent-hub/../x', '/Users/u/.agent-hub', 'darwin'), false);
});

test('an approved folder reached through a link cannot read or replace bridge.json', async () => {
  const alias = path.join(base, 'alias');
  symlinkSync(path.join(base, 'real'), alias, 'junction');
  const approved = path.join(alias, 'Home'); // a real directory whose parent is a link: checkPath alone accepts it
  const allowed = () => [approved];
  await assert.rejects(() => requirePath(path.join(approved, '.agent-hub', 'bridge.json'), allowed), /connector's own folder/);
  await assert.rejects(() => requirePath(path.join(approved, '.agent-hub', 'new.tmp'), allowed), /connector's own folder/);
  await assert.rejects(() => requirePath(path.join(approved, '.agent-hub'), allowed), /connector's own folder/);
  await requirePath(path.join(approved, 'notes.md'), allowed);
  await requirePath(path.join(approved, '.agent-hub2', 'x.md'), allowed);
});

test('a case variant of the configuration folder is refused', { skip: !['win32', 'darwin'].includes(platform()) && 'case-sensitive file system' }, async () => {
  const allowed = () => [home];
  await assert.rejects(() => requirePath(path.join(home, '.AGENT-HUB', 'bridge.json'), allowed), /connector's own folder/);
  await assert.rejects(() => requirePath(path.join(home, '.Agent-Hub', 'missing.tmp'), allowed), /connector's own folder/);
});

test('a Windows 8.3 short name of the configuration folder is refused', { skip: platform() !== 'win32' && 'Windows only' }, async (t) => {
  const short = path.basename(execSync(`cmd /c for %I in ("${cfg}") do @echo %~sI`).toString().trim());
  if (short.toLowerCase() === '.agent-hub') return t.skip('no 8.3 names on this volume');
  await assert.rejects(() => requirePath(path.join(home, short, 'bridge.json'), () => [home]), /connector's own folder/);
});

test("the connector's own folder is never sent or written: keys, the key store's master key, approvals, the broker secret, builds and the launcher", async () => {
  const allowed = () => [home];
  for (const p of ['keys.json', 'keys.master', 'approvals.json', path.join('run', 'broker.secret'), 'conclave.mjs', path.join('app', '1.0.0', 'deploy', 'client', 'conclave.mjs'), path.join('app', '1.0.1', 'new.mjs'), '']) {
    await assert.rejects(() => requirePath(path.join(conn, p), allowed), /connector's own folder/);
  }
  // Through a link to the home folder, and as a case variant where the file system ignores case.
  const alias = path.join(base, 'alias2');
  symlinkSync(home, alias, 'junction');
  await assert.rejects(() => requirePath(path.join(alias, '.config', 'conclave', 'keys.json'), () => [alias]), /connector's own folder/);
  if (['win32', 'darwin'].includes(platform())) await assert.rejects(() => requirePath(path.join(home, '.Config', 'Conclave', 'KEYS.json'), allowed), /connector's own folder/);
  await requirePath(path.join(home, '.config', 'other', 'x.json'), allowed);
});

test('a received file may not replace git hooks or settings, agent settings, MCP or Codex settings, an instructions override, or a role file (CLAUDE.md, AGENTS.md)', () => {
  for (const p of ['.git/hooks/pre-commit', 'repo/.git/hooks/post-checkout', '.git/config', '.GIT/Config', '.claude/settings.json', '.claude/settings.local.json',
    '.mcp.json', 'sub/.mcp.json', '.codex/config.toml', 'AGENTS.override.md', 'a/agents.override.md', 'GIT~1/hooks/pre-commit', '.git/config.', 'CLAUDE.md', 'AGENTS.md', 'sub/claude.md', 'a/Agents.MD']) {
    assert.ok(protectedFileReason(p), p);
  }
  for (const p of ['notes.md', '.git-notes/config', 'hooks/pre-commit', '.claude/commands/x.md', 'config.toml', 'mcp.json']) {
    assert.equal(protectedFileReason(p), null, p);
  }
});
