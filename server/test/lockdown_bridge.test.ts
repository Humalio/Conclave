import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';

const sys = { kind: 'system' as const, id: null };
let app: App, vaultDir = '';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahlb-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = {
    dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir, vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'test-pepper',
    publicUrl: 'http://hub.test', production: false, adminUsername: 'admin', adminPassword: 'correct horse battery', publicDir: join(process.cwd(), 'public'), logLevel: 'silent', allowedOrigins: [],
    vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0,
  };
  app = await buildApp(config);
  await app.store.ready;
});
afterAll(async () => { await app.close(); });

describe('lockdown stops bridge transfers into the vault', () => {
  it('agent and PC scopes refuse the commit of a vault-bound transfer; unlocked it goes through', async () => {
    const agent = app.keys.createAgent('xfer', null, sys);
    const k = app.keys.createSessionKey({ agentId: agent.id, label: 'xfer' }, sys);
    const machineId = 'pc-lock-test';
    const row = (n: number) => ({ id: `chn_lock${n}`, from_agent_id: agent.id, from_credential_id: k.credential.id, from_machine_id: machineId, target_kind: 'vault', target: `/vault/Bridge/f${n}.md`, base_revision: null, purpose: 'x' });
    const commit = (n: number) => (app.channels as any).commit(row(n), Buffer.from(`hello ${n}`)) as Promise<{ status: string; reason: string | null }>;
    app.db.prepare("INSERT OR IGNORE INTO machines(id,name,status,created_at) VALUES (?,?,'active',?)").run(machineId, 'pc', Date.now());

    app.lockdown.set('agent', agent.id, true, null);
    expect(await commit(1)).toMatchObject({ status: 'failed', reason: 'lockdown' });
    expect(existsSync(join(vaultDir, 'Bridge', 'f1.md'))).toBe(false);
    app.lockdown.set('agent', agent.id, false, null);

    app.lockdown.set('pc', machineId, true, null);
    expect(await commit(2)).toMatchObject({ status: 'failed', reason: 'lockdown' });
    expect(existsSync(join(vaultDir, 'Bridge', 'f2.md'))).toBe(false);
    app.lockdown.set('pc', machineId, false, null);

    expect((await commit(3)).status).toBe('done');
    expect(readFileSync(join(vaultDir, 'Bridge', 'f3.md'), 'utf8')).toBe('hello 3');
  });
});
