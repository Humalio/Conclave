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
const { isInside, requirePath } = await import('./connector/transfers.mjs');
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
  await assert.rejects(() => requirePath(path.join(approved, '.agent-hub', 'bridge.json'), allowed), /bridge configuration/);
  await assert.rejects(() => requirePath(path.join(approved, '.agent-hub', 'new.tmp'), allowed), /bridge configuration/);
  await assert.rejects(() => requirePath(path.join(approved, '.agent-hub'), allowed), /bridge configuration/);
  await requirePath(path.join(approved, 'notes.md'), allowed);
  await requirePath(path.join(approved, '.agent-hub2', 'x.md'), allowed);
});

test('a case variant of the configuration folder is refused', { skip: !['win32', 'darwin'].includes(platform()) && 'case-sensitive file system' }, async () => {
  const allowed = () => [home];
  await assert.rejects(() => requirePath(path.join(home, '.AGENT-HUB', 'bridge.json'), allowed), /bridge configuration/);
  await assert.rejects(() => requirePath(path.join(home, '.Agent-Hub', 'missing.tmp'), allowed), /bridge configuration/);
});

test('a Windows 8.3 short name of the configuration folder is refused', { skip: platform() !== 'win32' && 'Windows only' }, async (t) => {
  const short = path.basename(execSync(`cmd /c for %I in ("${cfg}") do @echo %~sI`).toString().trim());
  if (short.toLowerCase() === '.agent-hub') return t.skip('no 8.3 names on this volume');
  await assert.rejects(() => requirePath(path.join(home, short, 'bridge.json'), () => [home]), /bridge configuration/);
});
