/**
 * The hub has no OAuth. An MCP client whose header login fails gets a 401 and then probes OAuth
 * discovery and the spec's default endpoints; on the hub's own port those must answer 404, never
 * a redirect or a page, so the client reports the missing header rather than an OAuth error.
 * deploy/caddy/lan.Caddyfile does the same on its plain-HTTP site.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig } from './hub.js';

let app: App;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahoauth-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir, graph: { debounceMs: 0, verifyRate: 0 } });
  app = await buildApp(config);
  await app.store.ready;
});
afterAll(async () => { await app.close(); });

describe('OAuth probes on the hub port', () => {
  it('POST /mcp without a header is a plain 401 Bearer challenge', async () => {
    const r = await app.fastify.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer');
    expect(r.headers.location).toBeUndefined();
  });

  const probes: [string, string][] = [
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/.well-known/oauth-protected-resource/mcp'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/.well-known/oauth-authorization-server/mcp'],
    ['GET', '/.well-known/openid-configuration'],
    ['GET', '/mcp/.well-known/openid-configuration'],
    ['GET', '/authorize?response_type=code&client_id=x'],
    ['POST', '/register'],
    ['POST', '/token'],
    ['POST', '/revoke'],
  ];
  for (const [method, url] of probes) {
    it(`${method} ${url} answers 404 without a redirect`, async () => {
      const r = await app.fastify.inject({ method: method as 'GET' | 'POST', url, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode).toBe(404);
      expect(r.headers.location).toBeUndefined();
    });
  }
});
