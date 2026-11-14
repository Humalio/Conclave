// Starts the built hub with eval tuning (graph debounce 0). Env: HUB_DIST plus the usual server env. IPC message "quit" closes gracefully.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const dist = process.env.HUB_DIST;
const { buildApp } = await import(pathToFileURL(join(dist, 'app.js')).href);
const { loadConfig } = await import(pathToFileURL(join(dist, 'config.js')).href);
const config = loadConfig();
config.graph = { debounceMs: 0, communityMinMs: 0 };
const app = await buildApp(config);
await app.store.ready;
await app.fastify.listen({ port: config.port, host: config.host });
const quit = () => { void app.close().then(() => process.exit(0)); };
process.on('message', (m) => { if (m === 'quit') quit(); });
process.on('SIGTERM', quit);
if (process.send) process.send('ready');
