/**
 * Shared fixtures for test hubs: the config every suite builds a hub from, and the operator sign-in.
 * Suites pass only what differs from these defaults.
 */
import { join } from 'node:path';
import type { Config } from '../src/config.js';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'correct horse battery';

/** A quiet hub on an OS-chosen port under `dir` (data in `dir/data`, vault in `dir/vault`), with no scans, watchers or maintenance. */
export function testConfig(dir: string, over: Partial<Config> = {}): Config {
  return {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir: join(dir, 'vault'), vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: ADMIN_USERNAME, adminPassword: ADMIN_PASSWORD, publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0,
    ...over,
  };
}

/** Sign in to the admin API at `base`: the session cookie and the CSRF token. */
export async function adminLogin(base: string, username = ADMIN_USERNAME, password = ADMIN_PASSWORD, totp?: string): Promise<{ cookie: string; csrf: string }> {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, ...(totp ? { totp } : {}) }) });
  return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as { csrf: string }).csrf };
}
