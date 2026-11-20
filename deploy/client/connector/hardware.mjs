/**
 * Measuring a compute machine (docs/hardware.md#measuring, docs/connector.md "Measure-only mode"). Only while the machine's
 * user turned it on (`conclave hardware on`), the connector reads the whole machine's CPU %, memory used and total, and per
 * GPU its utilisation and memory (from nvidia-smi when it is there). Numbers only: no process names, command lines, paths or
 * users. The worker samples every 15 seconds and sends each measure-only hub its samples once a minute.
 */
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readSettings } from './settings.mjs';

export const SAMPLE_MS = 15_000;
/** The hub takes at most 120 samples a batch; older ones are dropped first when a hub was unreachable for a while. */
export const SAMPLE_MAX = 120;
const GB = 1024 ** 3;
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Measuring is on only when the user said so; never set reads as off. */
export const hardwareOptIn = (home) => readSettings(home).hardware_opt_in === true;

/** Busy and total CPU time over all cores, from `os.cpus()`. */
export function cpuTimes(cpus) {
  let busy = 0, total = 0;
  for (const c of cpus) { const t = c.times; busy += t.user + t.nice + t.sys + t.irq; total += t.user + t.nice + t.sys + t.irq + t.idle; }
  return { busy, total };
}

/** nvidia-smi's CSV (`utilization.gpu, memory.used, memory.total` in MiB, no header, no units) as numbers; anything else is skipped. */
export function parseNvidiaSmi(out) {
  const gpus = [];
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const f = line.split(',').map((x) => Number(x.trim()));
    if (f.length !== 3 || f.some((x) => !Number.isFinite(x) || x < 0)) continue;
    gpus.push({ util_pct: Math.min(100, f[0]), mem_used_gb: round(f[1] / 1024), mem_total_gb: round(f[2] / 1024) });
    if (gpus.length === 16) break;
  }
  return gpus;
}

const nvidiaSmi = () => {
  const r = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return r.status === 0 ? r.stdout : '';
};

/**
 * A sampler: each call returns one sample of the whole machine, CPU % over the time since the previous call (the first
 * call measures from when the sampler was made). `src` replaces the readings in tests: {cpus, totalmem, freemem, gpu, now}.
 */
export function sampler(src = {}) {
  const cpus = src.cpus ?? os.cpus, totalmem = src.totalmem ?? os.totalmem, freemem = src.freemem ?? os.freemem, gpu = src.gpu ?? nvidiaSmi, now = src.now ?? Date.now;
  let gpuOk = true, prev = cpuTimes(cpus());
  return () => {
    const list = cpus(), cur = cpuTimes(list), dt = cur.total - prev.total;
    const cpu = dt > 0 ? Math.max(0, Math.min(100, (100 * (cur.busy - prev.busy)) / dt)) : 0;
    prev = cur;
    const total = totalmem(), used = total - freemem();
    let gpus = [];
    if (gpuOk) { try { const out = gpu(); gpus = parseNvidiaSmi(out); if (!out) gpuOk = false; } catch { gpuOk = false; } } // no nvidia-smi: stop asking
    const s = { at: now(), cpu_pct: round(cpu, 1), cpu_count: Math.max(1, list.length), mem_used_gb: round(used / GB), mem_total_gb: round(total / GB) };
    return gpus.length ? { ...s, gpus } : s;
  };
}

/** Adds a sample to a hub's queue, keeping the newest SAMPLE_MAX. */
export function queueSample(q, s) { q.push(s); if (q.length > SAMPLE_MAX) q.splice(0, q.length - SAMPLE_MAX); return q; }
