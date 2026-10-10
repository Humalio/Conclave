import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathAllowed } from '../agent-hub-bridge.mjs';

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
