// Measuring a compute machine (connector/hardware.mjs, docs/hardware.md#measuring): the sampler with fixed readings, the
// nvidia-smi parser, the batch cap and the opt-in switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampler, parseNvidiaSmi, queueSample, cpuTimes, hardwareOptIn, SAMPLE_MAX } from './connector/hardware.mjs';
import { setSwitch, readSettings, SWITCHES } from './connector/settings.mjs';

const GB = 1024 ** 3;
const core = (user, idle) => ({ model: 'x', speed: 1, times: { user, nice: 0, sys: 0, irq: 0, idle } });

test('CPU % is the busy share since the previous reading, over all cores', () => {
  let reading = [core(100, 900), core(100, 900)];
  const next = sampler({ cpus: () => reading, totalmem: () => 32 * GB, freemem: () => 20 * GB, gpu: () => '', now: () => 1000 });
  reading = [core(400, 1000), core(200, 1200)]; // busy +400 of +800
  assert.deepEqual(next(), { at: 1000, cpu_pct: 50, cpu_count: 2, mem_used_gb: 12, mem_total_gb: 32 });
  assert.equal(next().cpu_pct, 0); // nothing moved since: 0, not a division by zero
  assert.deepEqual(cpuTimes([core(3, 7)]), { busy: 3, total: 10 });
});

test('GPUs come from nvidia-smi as numbers; a machine without it is not asked again', () => {
  assert.deepEqual(parseNvidiaSmi('87, 6144, 24576\r\n3, 512, 8192\n'), [
    { util_pct: 87, mem_used_gb: 6, mem_total_gb: 24 }, { util_pct: 3, mem_used_gb: 0.5, mem_total_gb: 8 }]);
  assert.deepEqual(parseNvidiaSmi('[N/A], 10, 20\nGPU 0: name\n\n'), []);
  let asked = 0;
  const next = sampler({ cpus: () => [core(1, 1)], totalmem: () => GB, freemem: () => GB, gpu: () => { asked++; return ''; }, now: () => 1 });
  assert.equal(next().gpus, undefined);
  next();
  assert.equal(asked, 1);
  const withGpu = sampler({ cpus: () => [core(1, 1)], totalmem: () => GB, freemem: () => 0, gpu: () => '50, 1024, 2048', now: () => 1 })();
  assert.deepEqual(withGpu.gpus, [{ util_pct: 50, mem_used_gb: 1, mem_total_gb: 2 }]);
  assert.deepEqual(Object.keys(withGpu).sort(), ['at', 'cpu_count', 'cpu_pct', 'gpus', 'mem_total_gb', 'mem_used_gb']);
});

test('a hub that was unreachable keeps only the newest samples', () => {
  const q = [];
  for (let i = 0; i < SAMPLE_MAX + 5; i++) queueSample(q, { at: i });
  assert.equal(q.length, SAMPLE_MAX);
  assert.equal(q[0].at, 5);
});

test('conclave hardware on|off is a switch in preferences.json; never set reads as off', () => {
  const home = mkdtempSync(join(tmpdir(), 'cnhw-'));
  assert.equal(SWITCHES.hardware, 'hardware_opt_in');
  assert.equal(readSettings(home).hardware_opt_in, null);
  assert.equal(hardwareOptIn(home), false);
  setSwitch(home, 'hardware', true);
  assert.equal(hardwareOptIn(home), true);
  setSwitch(home, 'hardware', false);
  assert.equal(readSettings(home).hardware_opt_in, false);
});
