import { startRun } from '../scripts/test-tmp.mjs';

/* Test files create throwaway hubs (data + vault) under the OS temp folder and seldom remove them. Every run gets one folder
   (`conclave-test-<pid>-<time>`, scripts/test-tmp.mjs) that the temp variables of every worker point at; it is deleted when
   the run ends, and a killed run's folder is deleted by a later run. Workers are forked after this runs, so they inherit the
   variables and os.tmpdir() returns the run folder. */
export default function setup() {
  const run = startRun();
  return () => run.end();
}
