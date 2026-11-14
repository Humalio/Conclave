#!/usr/bin/env node
// Local design-review hub: Conclave on 127.0.0.1:8099 (HUB_PORT overrides the port) with data under <repo>/.dev/ and a copy of the
// Early Echo vault (eval/vault). Seed it with the story: npm run dev:seed (eval/run.mjs --hub).
// First run generates an admin password and pepper into .dev/hub.env (never printed). `--reset` wipes .dev/ first.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageClientDir, cleanEnv } from '../../eval/story/lib.mjs';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(serverDir, '..');
const dev = join(repo, '.dev'), dataDir = join(dev, 'data'), vaultDir = join(dev, 'vault'), envFile = join(dev, 'hub.env');
const HOST = '127.0.0.1', PORT = Number(process.env.HUB_PORT || 8099);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) { console.error('HUB_PORT must be a port number from 1024 to 65535.'); process.exit(1); }

const portFree = () => new Promise((ok) => {
  const s = createServer();
  s.once('error', () => ok(false));
  s.listen(PORT, HOST, () => s.close(() => ok(true)));
});
if (!(await portFree())) { console.error(`Port ${PORT} on ${HOST} is already in use (is the hub already running?).`); process.exit(1); }

if (process.argv.includes('--reset')) { rmSync(dev, { recursive: true, force: true }); console.log('Reset: removed .dev/'); }
mkdirSync(dataDir, { recursive: true });
if (!existsSync(vaultDir)) cpSync(join(repo, 'eval', 'vault'), vaultDir, { recursive: true });
// The dev vault is a disposable copy of the story vault: mark it so DEMO_MODE=1 may replay into it (docs/showcase.md#demo-mode).
writeFileSync(join(vaultDir, '.conclave-demo'), 'Local dev vault (.dev/vault): a demo-mode Replay may replace it.\n');
if (!existsSync(envFile)) {
  const rnd = (n) => randomBytes(n).toString('base64url');
  writeFileSync(envFile, `ADMIN_USERNAME=admin\nADMIN_PASSWORD=${rnd(18)}\nKEY_PEPPER=${rnd(32)}\n`, { mode: 0o600 });
}
const secrets = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

// Only what the hub needs to run, so ALLOWED_ORIGINS and the like from this shell never reach it. DEMO_MODE is the one setting passed on, to try Replay here.
const env = {
  ...cleanEnv(), ...(process.env.DEMO_MODE ? { DEMO_MODE: process.env.DEMO_MODE } : {}), NODE_ENV: 'development', HOST, PORT: String(PORT), PUBLIC_URL: `http://${HOST}:${PORT}`, TRUST_PROXY: 'false', LOG_LEVEL: 'warn',
  DATA_DIR: dataDir, VAULT_DIR: vaultDir, GRAPH_DEBOUNCE_MS: '1000', VAULT_SCAN_SECONDS: '5', ADMIN_USERNAME: secrets.ADMIN_USERNAME, ADMIN_PASSWORD: secrets.ADMIN_PASSWORD, KEY_PEPPER: secrets.KEY_PEPPER,
  // The story renders a checkout, which needs a restore template; the story brings its own (the restore client is not shipped yet).
  CLIENT_DIR: stageClientDir(),
};
const tsx = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, 'src/main.ts'], { cwd: serverDir, env, stdio: 'inherit' });
console.log(`Conclave (local design review) at http://${HOST}:${PORT}/`);
console.log(`Credentials: ${envFile}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
