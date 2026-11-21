/**
 * Old setup left on a PC (connector/migrate.mjs `legacyLeftovers`, `leftoversOffer`; `conclave check`; the check-in flag in
 * connector/worker.mjs), run with `npm run test:helper`. The migration journal and the user environment are stand-ins in a
 * temporary home: nothing here touches the real registry or a real key.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.CONCLAVE_KEY_STORE = 'file';
import { legacyLeftovers, leftoversOffer, finish, migrationState } from './connector/migrate.mjs';
import { legacyLeftoversCached } from './connector/worker.mjs';

const tmp = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), 'conclave-left-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const journal = (h, status, extra = {}) => { mkdirSync(join(h, 'migration'), { recursive: true }); writeFileSync(join(h, 'migration', 'state.json'), JSON.stringify({ status, files: [], folders: [], ...extra })); };
const env = (value) => { const e = { value, unsets: 0, get: () => e.value, unset() { e.unsets++; e.value = null; } }; return e; };

test('nothing is left on a PC that never moved and has no old CA setting', () => {
  const h = home();
  assert.equal(legacyLeftovers(h, env(null)), false);
  assert.equal(leftoversOffer(h, env(null)), null);
});

test('a move that is not finished leaves its rollback copies: reported, and offered', () => {
  for (const status of ['applied', 'applying']) {
    const h = home(); journal(h, status);
    assert.equal(legacyLeftovers(h, env(null)), true, status);
    const o = leftoversOffer(h, env(null));
    assert.match(o, /conclave migrate --finish --remove-legacy-ca/);
    assert.match(o, /never runs it/);
  }
});

test('a finished or rolled-back move leaves nothing by itself', () => {
  for (const status of ['finished', 'rolled_back']) { const h = home(); journal(h, status); assert.equal(legacyLeftovers(h, env(null)), false, status); }
});

test('the old CA setting naming this home\'s hub-ca.pem counts; one naming another file does not', () => {
  const h = home(); journal(h, 'finished');
  assert.equal(legacyLeftovers(h, env(join(h, 'hub-ca.pem'))), true);
  assert.match(leftoversOffer(h, env(join(h, 'hub-ca.pem'))), /NODE_EXTRA_CA_CERTS/);
  assert.equal(legacyLeftovers(h, env(join(tmpdir(), 'their-own-ca.pem'))), false);
  assert.equal(legacyLeftovers(h, { get() { throw new Error('registry unreadable'); } }), false, 'a failed read is not reported');
});

test('the offer is only words: asking never changes the journal, the files or the environment', () => {
  const h = home(); journal(h, 'applied'); const e = env(join(h, 'hub-ca.pem'));
  const before = readFileSync(join(h, 'migration', 'state.json'), 'utf8');
  leftoversOffer(h, e); legacyLeftovers(h, e);
  assert.equal(readFileSync(join(h, 'migration', 'state.json'), 'utf8'), before);
  assert.equal(e.unsets, 0);
  assert.equal(migrationState(h).status, 'applied');
});

test('--finish --remove-legacy-ca can still clear the old CA setting after a plain --finish, and keeps the finished journal', () => {
  const h = home(); journal(h, 'finished', { hub_key: 'hub_x' });
  const e = env(join(h, 'hub-ca.pem'));
  const plain = finish(h, { userEnv: e });
  assert.equal(plain.ok, false, 'without the flag a finished move has nothing to do');
  const r = finish(h, { removeLegacyCa: true, userEnv: e });
  assert.equal(r.ok, true);
  assert.equal(migrationState(h).status, 'finished');
  assert.ok(!r.lines.some((l) => /rollback copies were removed/.test(l)), 'the copies are not announced twice');
  assert.equal(finish(home(), { removeLegacyCa: true, userEnv: e }).ok, false, 'a PC that never moved has nothing to finish');
});

test('the check-in flag is read once a minute, not on every call', () => {
  let reads = 0;
  const read = () => { reads++; return reads === 1; };
  const h = '/memo/home-' + Math.random();
  assert.equal(legacyLeftoversCached(h, 1_000_000, read), true);
  assert.equal(legacyLeftoversCached(h, 1_030_000, read), true);
  assert.equal(reads, 1);
  assert.equal(legacyLeftoversCached(h, 1_061_000, read), false);
  assert.equal(reads, 2);
});
