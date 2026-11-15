import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseIgnore, buildPlan, checkPath, extract, frameHeader, planBytes } from './connector/transfers.mjs';

test('gitignore matcher: wildcards, negation, directories, anchoring', () => {
  const ig = parseIgnore('*.log\n!keep.log\nbuild/\n/root.txt\nsrc/**/gen\n');
  assert.equal(ig('a.log', false), true);
  assert.equal(ig('keep.log', false), false);
  assert.equal(ig('build', true), true);
  assert.equal(ig('build', false), null);
  assert.equal(ig('root.txt', false), true);
  assert.equal(ig('x/root.txt', false), null);
  assert.equal(ig('src/a/b/gen', true), true);
});

test('folder plan skips .git, node_modules, .env* and ignored files', async (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ahb-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const w = (rel, data) => { const p = path.join(d, ...rel.split('/')); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, data); };
  w('a.txt', 'a'); w('sub/b.txt', 'bb'); w('x.log', 'no'); w('.gitignore', '*.log\n'); w('.git/HEAD', 'x'); w('node_modules/m.js', 'x'); w('.env', 's'); w('.env.local', 's');
  const plan = await buildPlan([d], false);
  assert.deepEqual(plan.entries.map((e) => e.rel), ['.gitignore', 'a.txt', 'sub/b.txt']);
  const raw = await buildPlan([path.join(d, 'a.txt')], true);
  assert.equal(raw.total, 1);
  await assert.rejects(() => buildPlan([d], true));
  await assert.rejects(() => buildPlan([path.join(d, '.env')], true), /excluded/);
});

test('an invalid later frame cannot publish an earlier file', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ahb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stream = path.join(root, 'transfer');
  const out = path.join(root, 'out');
  const good = Buffer.concat([frameHeader('ok.txt', 2), Buffer.from('ok')]);
  for (const bad of [
    Buffer.from([0x7f, 0xff, 0xff, 0xff]),
    frameHeader('bad.txt', -1),
    frameHeader('../escape', 0),
    frameHeader('ok.txt', 0),
    frameHeader('ok.txt/nested', 0),
    frameHeader('.ah-staging', 0),
    Buffer.alloc(5),
  ]) {
    writeFileSync(stream, Buffer.concat([good, bad, Buffer.alloc(4)]));
    await assert.rejects(() => extract(stream, out, [root]));
    assert.equal(existsSync(out), false);
  }
});

test('publishing replaces the destination entry without writing through a hard link', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ahb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out');
  const original = path.join(root, 'original');
  mkdirSync(out);
  writeFileSync(original, 'original');
  linkSync(original, path.join(out, 'result'));
  const stream = path.join(root, 'transfer');
  writeFileSync(stream, Buffer.concat([frameHeader('result', 3), Buffer.from('new'), Buffer.alloc(4)]));
  assert.equal(await extract(stream, out, [out, root]), 1);
  assert.equal(readFileSync(original, 'utf8'), 'original');
  assert.equal(readFileSync(path.join(out, 'result'), 'utf8'), 'new');
});

test('checks junctions and refuses a source replaced after planning', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ahb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inside = path.join(root, 'inside');
  const outside = path.join(root, 'outside');
  mkdirSync(inside);
  mkdirSync(outside);
  symlinkSync(outside, path.join(inside, 'jump'), 'junction');
  assert.equal(await checkPath(path.join(inside, 'jump', 'missing'), [inside]), false);
  const file = path.join(inside, 'file');
  writeFileSync(file, 'before');
  const plan = await buildPlan([file], true);
  rmSync(file);
  writeFileSync(file, 'second');
  await assert.rejects(async () => { for await (const _ of planBytes(plan)) { /* consume */ } }, /source changed/);
});
