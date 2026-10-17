import { defineConfig } from 'vitest/config';
// Timing-sensitive tests (bounded waits, leases, timers) flaked under full CPU contention; cap workers.
// global-tmp gives each run its own temp parent and deletes it afterwards, so the throwaway hubs tests create don't pile up.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'forks', maxWorkers: 2, testTimeout: 20000, globalSetup: ['test/global-tmp.ts'] } });
