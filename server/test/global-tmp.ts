import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Test files create throwaway hubs (data + vault) under the OS temp folder and never remove them: about 250 MB per
   run. Point the temp folder of every worker at one parent for this run, then delete that parent when the run ends.
   Workers are forked after this runs, so they inherit the variables and os.tmpdir() returns the parent. */
const KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

export default function setup() {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-tests-'));
  for (const k of KEYS) process.env[k] = root;
  return () => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
