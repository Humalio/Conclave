import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sweepOldRuns, startRun, STALE_MS, TMP_KEYS } from '../scripts/test-tmp.mjs';

const DAY = STALE_MS;

describe('one temp folder per test run', () => {
  it('this run already uses its own run folder', () => {
    expect(tmpdir()).toMatch(/conclave-test-\d+-\d+$/);
  });

  it('a run points every temp variable at its folder and deletes it at the end, restoring the variables', () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-base-'));
    const env: Record<string, string | undefined> = { TMPDIR: '/was', TEMP: undefined, TMP: 'C:\\was' };
    const run = startRun({ base, env, pid: 4242, now: 1_000 });
    expect(run.root).toBe(join(base, 'conclave-test-4242-1000'));
    for (const k of TMP_KEYS) expect(env[k]).toBe(run.root);
    mkdirSync(join(run.root, 'hub', 'vault'), { recursive: true });
    writeFileSync(join(run.root, 'hub', 'vault', 'a.md'), 'x');
    run.end();
    expect(existsSync(run.root)).toBe(false);
    expect(env).toEqual({ TMPDIR: '/was', TMP: 'C:\\was' });
    run.end(); // a second end is harmless
  });

  it('a killed run is deleted by a later one: only run folders older than a day whose process is gone, nothing else', () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-sweep-'));
    const now = 10 * DAY;
    const dead = new Set([111, 222]);
    const names = {
      oldDead: `conclave-test-111-${now - DAY - 1}`,
      freshDead: `conclave-test-222-${now - 60_000}`,
      oldAlive: `conclave-test-333-${now - 2 * DAY}`,
      other: 'cwk-abc123',
      oldStyle: 'agent-hub-tests-xyz',
    };
    for (const n of Object.values(names)) mkdirSync(join(base, n));
    writeFileSync(join(base, `conclave-test-111-${now - 3 * DAY}`), 'a file, not a run folder');
    const removed = sweepOldRuns(base, { now, isAlive: (pid: number) => !dead.has(pid) });
    expect(removed).toEqual([names.oldDead]);
    expect(readdirSync(base).sort()).toEqual([names.freshDead, names.oldAlive, names.other, names.oldStyle, `conclave-test-111-${now - 3 * DAY}`].sort());
  });

  it('a helper run started by test-helper.mjs runs in its own folder and leaves nothing behind, also when its tests fail', () => {
    const base = mkdtempSync(join(tmpdir(), 'tt-helper-'));
    const t = join(base, 'probe.test.mjs');
    writeFileSync(t, `import { test } from 'node:test'; import { tmpdir } from 'node:os'; import { mkdtempSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
test('probe', () => { const d = mkdtempSync(join(tmpdir(), 'probe-')); writeFileSync(join(d, 'x'), 'y'); console.log('TMP=' + tmpdir()); if (process.env.PROBE_FAIL) throw new Error('fails'); });\n`);
    const runBase = join(base, 'temp');
    mkdirSync(runBase);
    for (const fail of [false, true]) {
      const env = { ...process.env, TMPDIR: runBase, TEMP: runBase, TMP: runBase, ...(fail ? { PROBE_FAIL: '1' } : {}) };
      const r = spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'test-helper.mjs'), t], { env, encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(fail ? 1 : 0);
      expect(r.stdout).toMatch(/TMP=.*conclave-test-\d+-\d+/);
      expect(readdirSync(runBase)).toEqual([]);
    }
  });
});
