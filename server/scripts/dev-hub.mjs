#!/usr/bin/env node
// Local design-review hub: Agent Hub on 127.0.0.1:8099 (HUB_PORT overrides the port) with data under <repo>/.dev/ and a copy of demo/vault.
// First run generates an admin password and pepper into .dev/hub.env (never printed). `--reset` wipes .dev/ first.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
if (!existsSync(vaultDir)) cpSync(join(repo, 'demo', 'vault'), vaultDir, { recursive: true });
if (!existsSync(envFile)) {
  const rnd = (n) => randomBytes(n).toString('base64url');
  writeFileSync(envFile, `ADMIN_USERNAME=admin\nADMIN_PASSWORD=${rnd(18)}\nKEY_PEPPER=${rnd(32)}\n`, { mode: 0o600 });
}
const secrets = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const env = {
  ...process.env, NODE_ENV: 'development', HOST, PORT: String(PORT), PUBLIC_URL: `http://${HOST}:${PORT}`, TRUST_PROXY: 'false', LOG_LEVEL: 'warn',
  DATA_DIR: dataDir, VAULT_DIR: vaultDir, ADMIN_USERNAME: secrets.ADMIN_USERNAME, ADMIN_PASSWORD: secrets.ADMIN_PASSWORD, KEY_PEPPER: secrets.KEY_PEPPER,
};
const tsx = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, 'src/main.ts'], { cwd: serverDir, env, stdio: 'inherit' });
console.log(`Agent Hub (local design review) at http://${HOST}:${PORT}/`);
console.log(`Credentials: ${envFile}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
