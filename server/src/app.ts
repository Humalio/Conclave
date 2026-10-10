import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { openDb } from './db/db.js';
import { RateLimit } from './db/rateLimit.js';
import { Audit } from './audit/audit.js';
import { Keys, KeyError } from './keys/keys.js';
import { LeakGuard } from './guard/leakGuard.js';
import { Vault, VaultError } from './vault/vault.js';
import { VaultStore } from './vault/store.js';
import { builtinTemplates } from './policy/catalogue.js';
import { buildMcpServer } from './mcp/tools.js';
import { Setup } from './setup/setup.js';
import { Links } from './links/links.js';
import { Messaging } from './messaging/messaging.js';
import { Teams } from './teams/teams.js';
import { registerBridge } from './bridge/http.js';
import { Shares } from './shares/shares.js';
import { Channels } from './channels/channels.js';
import { Access } from './access/access.js';
import { Lockdown } from './safety/lockdown.js';
import { Alerts, DEFAULT_ALERT_OPTS } from './safety/alerts.js';
import { Maintenance, DEFAULT_RETENTION } from './safety/retention.js';
import { Graph } from './graph/graph.js';
import { bootstrapAdmin, registerAdminApi } from './admin/api.js';

const STATUS: Record<string, number> = { not_found: 404, conflict: 409, lockdown: 423, too_large: 413, binary: 400, patch_failed: 409, invalid_state: 409, paused: 409, invalid_argument: 400, invalid_path: 400, denied: 404 };

export async function buildApp(config: Config) {
  const db = openDb(config.dbFile);
  const audit = new Audit(db);
  const keys = new Keys(db, config.pepper, audit);
  const vault = new Vault(config.vaultDir, config.vaultAlias);
  const store = new VaultStore(db, vault, audit, config.dataDir);
  store.start({ scanSeconds: config.vaultScanSeconds ?? 60, watch: config.vaultWatch !== false });
  const guard = new LeakGuard({ knownKeyIds: () => keys.allKeyIds() });
  const loginLimit = new RateLimit(db, 10, 10 * 60 * 1000);
  const setup = new Setup(db, config.pepper, audit, keys, config.publicUrl, config.bridgeFile);
  const links = new Links(db, keys, audit);
  const messaging = new Messaging(db, keys, links);
  const teams = new Teams(db, keys, links, messaging, audit);
  const shares = new Shares(db, keys, messaging, teams, store);
  if (config.shareBytesPerHour) shares.bytesPerHour = config.shareBytesPerHour;
  const channels = new Channels(db, keys, teams, setup, store, vault, shares, guard, audit, {
    inlineMax: config.channelInlineMax ?? 1024 * 1024, bridgeMax: config.channelBridgeMax ?? 20 * 1024 ** 3, perKey: config.channelPerKey ?? 4, global: config.channelGlobal ?? 32,
    bytesPerHour: config.channelBytesPerHour ?? 50 * 1024 ** 3, bufferBytes: config.channelBufferBytes ?? 8 * 1024 * 1024, tmpDir: join(config.dataDir, 'tmp'), expireMs: 10 * 60_000,
  });
  const access = new Access(db, keys, audit);
  const lockdown = new Lockdown(db, vault.alias);
  channels.lockdown = lockdown;
  const graph = new Graph(db, store, vault, teams, keys, config.graph, audit);
  const alerts = new Alerts(db, audit, keys, vault, config.alerts ? { ...DEFAULT_ALERT_OPTS, ...config.alerts } : DEFAULT_ALERT_OPTS);
  const maintenance = new Maintenance(db, store, access, alerts, config.retention ? { ...DEFAULT_RETENTION, ...config.retention } : DEFAULT_RETENTION);
  if (config.maintenanceSeconds !== 0) maintenance.start((config.maintenanceSeconds ?? 60) * 1000);
  const upkeep = setInterval(() => { try { teams.tick(true); channels.sweep(); } catch (e) { fastify.log.error(e); } }, 30_000);
  upkeep.unref();
  const pairLimit = new RateLimit(db, 10, 10 * 60 * 1000);
  const sys = { kind: 'system' as const, id: null };

  // Seed the built-in templates on first start.
  if (keys.templates().length === 0) {
    for (const t of builtinTemplates(config.vaultAlias)) keys.createTemplate(t.name, t.description, t.rules, sys);
  }
  bootstrapAdmin(db, audit, config);

  const fastify = Fastify({ logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] }, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await fastify.register(cookie);
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try { done(null, JSON.parse(body as string)); } catch { done(Object.assign(new Error('invalid JSON'), { statusCode: 400 }), undefined); }
  });

  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_argument', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    if (err instanceof KeyError || err instanceof VaultError) return reply.code(STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    fastify.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Internal error.' });
  });

  fastify.addHook('onSend', async (req, reply, payload) => {
    if (!req.url.startsWith('/mcp')) {
      reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
      if (!req.url.startsWith('/api')) reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    }
    return payload;
  });

  fastify.get('/health', async () => ({ ok: true }));

  // ── static console ──
  const asset = (name: string, type: string) => {
    fastify.get(name === 'index.html' ? '/' : `/${name}`, async (_req, reply) => reply.type(type).send(readFileSync(join(config.publicDir, name))));
  };
  asset('index.html', 'text/html; charset=utf-8');
  asset('app.js', 'text/javascript; charset=utf-8');
  asset('style.css', 'text/css; charset=utf-8');
  asset('fonts/geist.woff2', 'font/woff2');
  asset('fonts/geist-mono.woff2', 'font/woff2');

  registerAdminApi(fastify, { db, keys, audit, vault, store, config, loginLimit, setup, links, messaging, teams, phase5: { access, lockdown, alerts, shares, channels, maintenance }, graph });
  const bridge = registerBridge(fastify, setup, pairLimit, channels);
  fastify.addHook('preClose', async () => { bridge.releaseAll(); messaging.releaseAll(); teams.releaseAll(); clearInterval(upkeep); maintenance.stop(); });

  // ── MCP (stateless) ──
  const unauthorized = (reply: import('fastify').FastifyReply, msg: string) => reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized', message: msg });
  const originOk = (req: import('fastify').FastifyRequest) => {
    const o = req.headers.origin;
    return o === undefined || config.allowedOrigins.includes(String(o).replace(/[/]+$/, ''));
  };
  fastify.post('/mcp', async (req, reply) => {
    if (!originOk(req)) return reply.code(403).send({ error: 'forbidden_origin', message: 'Origin not allowed.' });
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    const keyId = m ? /^ah_app_([a-z2-7]{12})_/.exec(m[1]!)?.[1] ?? null : null;
    if (!m) { audit.auth({ subject: 'app_key', outcome: 'invalid', source: req.ip }); return unauthorized(reply, 'Missing app key.'); }
    let app;
    try { app = keys.verifyKey(m[1]!, 'app_key'); }
    catch (e) {
      const code = e instanceof KeyError ? e.code : 'invalid';
      audit.auth({ subject: 'app_key', keyId, outcome: ['invalid', 'unknown', 'suspended', 'expired', 'revoked'].includes(code) ? code : 'invalid', source: req.ip });
      return unauthorized(reply, 'Invalid app key.');
    }
    const server = buildMcpServer({ db, keys, audit, guard, vault, store, loginLimit, setup, links, messaging, teams, messagesPerHour: config.messagesPerHour ?? 120, shares, channels, access, lockdown, alerts, graph }, app, req.ip);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = async (_req: unknown, reply: import('fastify').FastifyReply) => reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed', message: 'Use POST.' });
  fastify.get('/mcp', notAllowed);
  fastify.delete('/mcp', notAllowed);

  return { fastify, db, keys, audit, vault, store, config, setup, links, messaging, teams, shares, channels, access, lockdown, alerts, maintenance, graph, close: async () => { await fastify.close(); await store.stop(); db.close(); } };
}
export type App = Awaited<ReturnType<typeof buildApp>>;
