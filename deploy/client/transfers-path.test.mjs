import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathAllowed } from './connector/transfers.mjs';

test('posix: inside, outside, traversal, relative, prefix sibling', () => {
  const a = ['/home/u/notes', '/data/share'];
  assert.equal(isPathAllowed('/home/u/notes/a/b.md', a, 'linux'), true);
  assert.equal(isPathAllowed('/home/u/notes', a, 'linux'), true);
  assert.equal(isPathAllowed('/home/u/notes/../secret', a, 'linux'), false);
  assert.equal(isPathAllowed('/home/u/notes-evil/x', a, 'linux'), false);
  assert.equal(isPathAllowed('notes/a', a, 'linux'), false);
  assert.equal(isPathAllowed('/etc/passwd', a, 'linux'), false);
  assert.equal(isPathAllowed('/home/u/notes/a\0b', a, 'linux'), false);
  assert.equal(isPathAllowed('/x', [], 'linux'), false);
  assert.equal(isPathAllowed('/home/u/notes/x', ['relative/dir'], 'linux'), false);
});

test('windows: case-insensitive, drive and separators, traversal', () => {
  const a = ['C:\\Users\\bridge-test\\Notes'];
  assert.equal(isPathAllowed('c:\\users\\BRIDGE-TEST\\notes\\a.md', a, 'win32'), true);
  assert.equal(isPathAllowed('C:/Users/bridge-test/Notes/sub/a.md', a, 'win32'), true);
  assert.equal(isPathAllowed('C:\\Users\\bridge-test\\Notes\\..\\Secret', a, 'win32'), false);
  assert.equal(isPathAllowed('D:\\Users\\bridge-test\\Notes\\a.md', a, 'win32'), false);
  assert.equal(isPathAllowed('C:\\Users\\bridge-test\\Notes2\\a.md', a, 'win32'), false);
  assert.equal(isPathAllowed('C:/Users/bridge-test/Notes/file:stream', a, 'win32'), false);
  assert.equal(isPathAllowed('C:/Users/bridge-test/Notes/NUL.txt', a, 'win32'), false);
  assert.equal(isPathAllowed('C:/Users/bridge-test/Notes/folder. /a.md', a, 'win32'), false);
});

// Task files from the PC (docs/transfers.md, "Task files from the PC"): a send reads only from the agent's own folder,
// by its real path, never .git, .codex, the role file or the connector's own folders.
test('agent folder: the real path decides, links and junctions followed', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { agentPathRefusal } = await import('./connector/transfers.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ah-agentpath-')));
  const folder = join(root, 'agent'), other = join(root, 'other'), conn = join(root, 'connector-home');
  for (const d of [folder, join(folder, 'shots'), join(folder, '.git'), join(folder, '.codex'), other, conn]) mkdirSync(d, { recursive: true });
  for (const f of [join(folder, 'shots', 'a.png'), join(folder, 'CLAUDE.md'), join(folder, 'AGENTS.override.md'), join(folder, '.git', 'config'), join(folder, '.codex', 'config.toml'), join(other, 'secret.png'), join(conn, 'key.json'), join(folder, 'shots', 'CLAUDE.md')]) writeFileSync(f, 'x');
  // A junction (Windows) or a directory link (elsewhere) inside the folder, pointing out of it, and one into its .git.
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(other, join(folder, 'linked'), kind);
  symlinkSync(join(folder, '.git'), join(folder, 'notgit'), kind);
  const refuse = (p) => agentPathRefusal(p, [folder], [conn]);
  assert.equal(await refuse(join(folder, 'shots', 'a.png')), null);
  assert.equal(await refuse(join(folder, 'shots', 'CLAUDE.md')), null, 'a CLAUDE.md below the root is a work file');
  assert.equal(await refuse(join(other, 'secret.png')), 'outside your own folder');
  assert.equal(await refuse(join(folder, 'linked', 'secret.png')), 'outside your own folder');
  assert.equal(await refuse(join(folder, 'notgit', 'config')), 'inside .git or .codex');
  assert.equal(await refuse(join(folder, '.git', 'config')), 'inside .git or .codex');
  assert.equal(await refuse(join(folder, '.codex', 'config.toml')), 'inside .git or .codex');
  assert.equal(await refuse(join(folder, 'CLAUDE.md')), 'a role file');
  assert.equal(await refuse(join(folder, 'AGENTS.override.md')), 'a role file');
  assert.equal(await refuse(join(conn, 'key.json')), 'inside the connector\'s own folder');
  assert.equal(await refuse(join(folder, 'missing.png')), 'no such file');
  assert.equal(await refuse('relative/a.png'), 'not an absolute path');
  // An agent with no folder here sends nothing.
  assert.equal(await agentPathRefusal(join(folder, 'shots', 'a.png'), [], [conn]), 'outside your own folder');
});

test('B2: the connector home (CONCLAVE_HOME or ~/.config/conclave) counts as the connector\'s own folder', async () => {
  const { inConfigDir } = await import('./connector/transfers.mjs');
  const { confDir } = await import('./connector/paths.mjs');
  const { join } = await import('node:path');
  assert.equal(await inConfigDir(join(confDir(), 'keys.json')), true);
  assert.equal(await inConfigDir(join(confDir(), 'sync', 'x.manifest.json')), true);
  assert.equal(await inConfigDir(join(confDir(), '..', 'unrelated-folder-b2', 'a.txt')), false);
});
