import { loadConfig, type Config } from './config.js';
import { DemoHost } from './demo/demo.js';

// A setting the hub refuses (DEMO_MODE on production, a missing VAULT_DIR, ...) is one plain log line
// that names it, then exit 1, so a deploy's verify step shows why the hub did not start.
let config: Config;
try { config = loadConfig(); } catch (e) {
  console.error(`Conclave hub did not start: ${(e as Error).message}`);
  process.exit(1);
}
// The host owns the app so demo mode can rebuild it in this process (docs/showcase.md#demo-mode); otherwise a plain start.
const host = new DemoHost(config);
await host.start();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { host.demo?.stop(); void host.app.close().then(() => process.exit(0)); });
