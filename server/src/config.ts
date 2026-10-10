import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  dataDir: string;
  dbFile: string;
  vaultDir: string;
  vaultAlias: string;
  port: number;
  host: string;
  pepper: string;
  publicUrl: string;
  production: boolean;
  adminUsername?: string;
  adminPassword?: string;
  publicDir: string;
  logLevel: string;
  /** Browser Origins allowed to call /mcp (default none). */
  allowedOrigins: string[];
  /** Path of the bridge program served by setup_pc (default: found next to the server or in ../bridge). */
  bridgeFile?: string;
  /** Messages one session key may send per hour (default 120). */
  messagesPerHour?: number;
  /** Seconds between full vault scans for external changes (default 60; 0 turns the periodic scan off). */
  vaultScanSeconds?: number;
  /** Watch the vault folder for external changes (default true). */
  vaultWatch?: boolean;
  /** Data channel limits (bytes / counts); defaults in app.ts. */
  channelInlineMax?: number; channelBridgeMax?: number; channelPerKey?: number; channelGlobal?: number; channelBytesPerHour?: number; channelBufferBytes?: number; shareBytesPerHour?: number;
  /** Alert thresholds (src/safety/alerts.ts) and retention (src/safety/retention.ts) overrides; seconds between maintenance runs (0 = off). */
  alerts?: Partial<import('./safety/alerts.js').AlertOpts>;
  retention?: Partial<import('./safety/retention.js').RetentionConfig>;
  maintenanceSeconds?: number;
  /** Knowledge graph tuning (src/graph/graph.ts), e.g. debounceMs. */
  graph?: Partial<import('./graph/graph.js').GraphOpts>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const vaultDir = env.VAULT_DIR;
  if (!vaultDir) throw new Error('VAULT_DIR is required (the folder of your Obsidian vault)');
  let pepper = env.KEY_PEPPER;
  if (!pepper) {
    if (production) throw new Error('KEY_PEPPER is required in production');
    console.warn('WARNING: KEY_PEPPER not set; using an insecure development default');
    pepper = 'dev-only-insecure-pepper';
  }
  const dataDir = resolve(env.DATA_DIR ?? './data');
  const port = Number(env.PORT ?? 8080);
  return {
    dataDir, dbFile: join(dataDir, 'agent-hub.db'), vaultDir: resolve(vaultDir), vaultAlias: env.VAULT_ALIAS ?? 'vault',
    port, host: env.HOST ?? '0.0.0.0', pepper, publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''), production,
    adminUsername: env.ADMIN_USERNAME, adminPassword: env.ADMIN_PASSWORD,
    publicDir: fileURLToPath(new URL('../public', import.meta.url)), logLevel: env.LOG_LEVEL ?? 'info',
    bridgeFile: env.BRIDGE_FILE, messagesPerHour: env.MESSAGES_PER_HOUR ? Number(env.MESSAGES_PER_HOUR) : 120,
    vaultScanSeconds: env.VAULT_SCAN_SECONDS !== undefined ? Number(env.VAULT_SCAN_SECONDS) : 60, vaultWatch: env.VAULT_WATCH !== '0',
    channelBridgeMax: env.CHANNEL_MAX_BYTES ? Number(env.CHANNEL_MAX_BYTES) : undefined, channelBufferBytes: env.CHANNEL_BUFFER_BYTES ? Number(env.CHANNEL_BUFFER_BYTES) : undefined,
    channelBytesPerHour: env.CHANNEL_BYTES_PER_HOUR ? Number(env.CHANNEL_BYTES_PER_HOUR) : undefined, shareBytesPerHour: env.SHARE_BYTES_PER_HOUR ? Number(env.SHARE_BYTES_PER_HOUR) : undefined,
    retention: { ...(env.RETENTION_SHARES_DAYS ? { sharesDays: Number(env.RETENTION_SHARES_DAYS) } : {}), ...(env.RETENTION_CHANNELS_DAYS ? { channelsDays: Number(env.RETENTION_CHANNELS_DAYS) } : {}), ...(env.RETENTION_WORK_ITEMS_DAYS ? { workItemsDays: Number(env.RETENTION_WORK_ITEMS_DAYS) } : {}) },
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/[/]+$/, '')).filter(Boolean),
  };
}
