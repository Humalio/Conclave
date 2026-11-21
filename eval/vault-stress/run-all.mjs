// Runs the cases in order and prints one line per case file. Usage: node eval/vault-stress/run-all.mjs [c1 c2 ...]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const all = ['c1-writers', 'c2-conflicts', 'c3-names-sizes', 'c4-cutoffs-access', 'c5-external', 'c6-console-restore', 'c8-revoke-restricted'];
const pick = process.argv.slice(2);
const run = pick.length ? all.filter((n) => pick.some((p) => n.startsWith(p))) : all;
process.env.STRESS_RUN ||= 'r' + Date.now().toString(36);
let bad = 0;
for (const n of run) {
  const r = spawnSync(process.execPath, [path.join(dir, n + '.mjs')], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { bad++; console.log(`!! ${n} exited with ${r.status}`); }
}
console.log(bad ? `${bad} case file(s) crashed` : 'all case files ran; read the FAIL lines above and the JSON files in STRESS_OUT');
process.exit(bad ? 1 : 0);
