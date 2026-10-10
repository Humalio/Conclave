import { defineConfig } from 'vitest/config';
// Timing-sensitive tests (bounded waits, leases, timers) flaked under full CPU contention; cap workers.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'forks', maxWorkers: 2, testTimeout: 20000 } });
