#!/usr/bin/env node
// Regenerates the Early Echo vault's data assets (eval/vault/Assets/data/*.csv and Assets/recordings/live-listen-03.*)
// deterministically from a seeded generator. The SVG diagrams and sketches are hand-written and not touched here.
// Usage: node eval/story/make-assets.mjs   (writes into eval/vault/Assets/; same bytes on every run)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vault'), 'Assets');
const data = join(assets, 'data'), rec = join(assets, 'recordings');
mkdirSync(data, { recursive: true }); mkdirSync(rec, { recursive: true });

// Mulberry32: small, seeded, the same on every platform.
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const noise = (r, a) => (r() * 2 - 1) * a;
const f = (x, d) => x.toFixed(d);
const csv = (name, head, rows) => writeFileSync(join(data, name), [head.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n');

// CAP-012: baseline sessions B-1..B-4 (B-1, B-2 with the face at 20 °C; B-3, B-4 at 40 K), 240 transmissions each at power
// 0.15–0.20. Receive latency about 212 ns, stamp error RMS 0.27 ns warm and 0.29 ns cold, no early replies.
{
  const r = rng(12), rows = [];
  for (const [s, temp, rms] of [['B-1', '293', 0.27], ['B-2', '293', 0.27], ['B-3', '40', 0.29], ['B-4', '40', 0.29]]) {
    for (let tx = 1; tx <= 240; tx += 10) {
      const p = 0.15 + 0.05 * ((tx - 1) / 239);
      rows.push([s, temp, tx, f(p, 3), f(212 + p * 10 + noise(r, 1.1), 1), f(noise(r, rms * 1.7), 2), 0]);
    }
  }
  csv('cap-012-baseline.csv', ['session', 'face_temp_K', 'transmission', 'power', 'receive_latency_ns', 'stamp_error_ns', 'early_replies'], rows);
}

// CAP-014 (start state): block A, transmissions 0..200 at power 0.25, no early reply. The 1.92 kHz strain line stays at the
// noise floor below power 0.32, and no ring site shows anything. Step 3.1 appends block B (power 0.33).
{
  const r = rng(14), rows = [];
  for (let n = 0; n <= 200; n += 10) rows.push([n, '0.25', '', f(0.8 + noise(r, 0.25), 2), 0, n === 0 ? 'start 20 Apr' : n === 200 ? 'block A complete' : '']);
  csv('cap-014-echoes.csv', ['transmission', 'power', 'early_lead_s', 'line_1920hz_ue', 'ring_sites', 'note'], rows);
}

// Dish thermal: bench live listens LL-01, LL-02 and LL-04 (power 0.20, 0.23, 0.28) in Cold bay 2: feeds at 18 K, shroud
// at 40 K, cryo power. Feed temperature rises about 0.3 K at full drive, the shroud stays within 0.4 K, cryo power +9 %.
{
  const r = rng(31), rows = [];
  for (const [ll, p] of [['LL-01', 0.20], ['LL-02', 0.23], ['LL-04', 0.28]]) {
    const peak = Math.sqrt(p / 0.00183) / 20; // bench drive, A (1:20 scale of the full-scale law P = 0.00183 I^2)
    for (let t = 0; t <= 300; t += 10) {
      const i = t <= 90 ? peak * (t / 90) : t <= 100 ? peak : peak * Math.exp(-(t - 100) / 3);
      const rise = 0.3 * (i / peak) * (p / 0.28) + (t > 100 ? 0.3 * Math.exp(-(t - 100) / 80) * (p / 0.28) : 0);
      rows.push([ll, t, f(i, 3), f(18.0 + rise + noise(r, 0.01), 3), f(40.0 + noise(r, 0.12), 3), f(100 + (t <= 100 ? 9 * (t / 100) : 9 * Math.exp(-(t - 100) / 60)) + noise(r, 0.3), 1)]);
    }
  }
  csv('dish-thermal.csv', ['listen', 'time_s', 'bench_drive_A', 'feed_temp_K', 'shroud_temp_K', 'cryo_power_pct'], rows);
}

// Clock drift: CAP-011, 72 h holdover of the relay clock (17–21 Mar). Frequency offset about 0.050 ns/s, jitter 0.27 ns RMS.
{
  const r = rng(11), rows = [];
  for (let h = 0; h <= 72; h += 1) rows.push([h, f(0.050 + noise(r, 0.002), 4), f(0.050 * 11 + noise(r, 0.02), 3), f(0.27 + noise(r, 0.02), 3)]);
  csv('clock-drift.csv', ['hour', 'freq_offset_ns_per_s', 'drift_over_11s_ns', 'jitter_rms_ns'], rows);
}

// live-listen-03 (echo 47): 5 s at 5 kHz from 22:14:05.000, four float32 LE channels per sample (the dish-house microphone
// is archived separately). Times match Recording notes: ticking from 05.58, early reply stamped 06.290, send 07.000 at
// power 0.34 for 3.0 s with a 1.92 kHz line in strain; dish temperature +0.6 K; clock phase flat.
{
  const RATE = 5000, N = RATE * 5, CH = ['transmit_power', 'receiver_strain_ue', 'dish_temp_K', 'clock_phase_ns'];
  const r = rng(47);
  const header = Buffer.alloc(64);
  header.write('EELL03', 0, 'ascii');                 // magic
  header.writeUInt16LE(1, 8);                         // format version
  header.writeUInt16LE(CH.length, 10);                // channels
  header.writeUInt32LE(RATE, 12);                     // samples per second
  header.writeUInt32LE(N, 16);                        // samples per channel
  header.writeDoubleLE(Date.UTC(2191, 2, 3, 22, 14, 5, 0) / 1000, 24); // start, seconds since epoch (proleptic UTC)
  header.write('echo47 LL-03 T9/bay2', 32, 'ascii');
  const body = Buffer.alloc(N * CH.length * 4);
  const send = 2.0, ramp = 0.05, end = 5.0;
  for (let n = 0; n < N; n++) {
    const t = n / RATE;
    // Power is zero until the send, climbs to 0.34 (the drive stayed on the 0.25 profile) and holds to the end of the window.
    const pw = t < send ? 0 : t < send + ramp ? 0.34 * (t - send) / ramp : t < end ? 0.34 + noise(r, 0.002) : 0;
    const ring = t >= send && t < end ? 14 * Math.sin(2 * Math.PI * 1920 * t) : 0;
    const strain = 600 + pw * 120 + ring + noise(r, 1.5);
    const temp = 40 + (t < send ? 0 : 0.6 * Math.min(1, (t - send) / 3)) + noise(r, 0.003);
    const phase = noise(r, 0.27); // flat: the clock did not stumble, it recorded both events in its TSU log
    const o = n * CH.length * 4;
    [pw, strain, temp, phase].forEach((v, k) => body.writeFloatLE(v, o + k * 4));
  }
  writeFileSync(join(rec, 'live-listen-03.bin'), Buffer.concat([header, body]));
  writeFileSync(join(rec, 'live-listen-03.json'), JSON.stringify({
    recording: 'live-listen-03', echo: 47, listen: 'LL-03', stand: 'Tern-9 dish test stand, receiver bay 2', start: '2191-03-03T22:14:05.000',
    format: { magic: 'EELL03', header_bytes: 64, version: 1, sample_rate_hz: RATE, samples_per_channel: N, layout: 'interleaved float32 little-endian, one frame per sample' },
    channels: CH.map((name, i) => ({ index: i, name })),
    events: [
      { t_s: 0.58, at: '22:14:05.580', what: 'dish-house microphone (separate archive): ticking starts, no send yet' },
      { t_s: 1.29, at: '22:14:06.290', what: 'reply stamped on TSU input B (no send yet)' },
      { t_s: 2.0, at: '22:14:07.000', what: 'send command on TSU input A; power climbs to 0.34 (profile 0.25); 1.92 kHz line in strain starts' },
      { t_s: 5.0, at: '22:14:10.000', what: 'end of the 3.0 s send; end of window' },
    ],
    tsu_events: ['22:14:06.290 input B (reply)', '22:14:07.000 input A (send)'],
    notes: 'Raw stand recording, unedited. TSU events come from the timestamp unit log, not from the clock_phase channel. CAP-016 page 3 is withheld; this file is not.',
  }, null, 2) + '\n');
}
console.log('Assets written to', assets);
