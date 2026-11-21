import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/db', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
import { existsSync, copyFileSync } from 'node:fs';
if (existsSync('../bridge/agent-hub-bridge.mjs')) { mkdirSync('dist/bridge', { recursive: true }); copyFileSync('../bridge/agent-hub-bridge.mjs', 'dist/bridge/agent-hub-bridge.mjs'); }
if (existsSync('../deploy/client')) { mkdirSync('dist/client', { recursive: true }); for (const f of ['restore-prompt.md']) if (existsSync(`../deploy/client/${f}`)) copyFileSync(`../deploy/client/${f}`, `dist/client/${f}`); }
