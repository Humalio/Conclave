import { loadConfig } from './config.js';
import { DemoHost } from './demo/demo.js';

const config = loadConfig();
// The host owns the app so demo mode can rebuild it in this process (docs/showcase.md#demo-mode); otherwise a plain start.
const host = new DemoHost(config);
await host.start();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { host.demo?.stop(); void host.app.close().then(() => process.exit(0)); });
