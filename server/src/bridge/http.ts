/**
 * Bridge HTTP endpoints (not MCP): pair, poll (jobs), and the channel byte streams (state, chunk up/down, done).
 * They take the PC's bridge key or, for the connector's service (docs/transfers.md), the PC's app key; pairing is the
 * stand-alone bridge's only.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Setup } from '../setup/setup.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { RateLimit } from '../db/rateLimit.js';
import type { Channels, BridgeReply } from '../channels/channels.js';

export const MAX_POLL_S = 25;

export function registerBridge(f: FastifyInstance, setup: Setup, pairLimit: RateLimit, channels: Channels, keys?: Keys): { releaseAll: () => void } {
  const waiters = new Set<() => void>();
  const unauthorized = (reply: FastifyReply) => reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized', message: 'Invalid bridge key or PC suspended.' });

  f.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 1024 * 1024 + 1024 }, (_r, body, done) => done(null, body));
  const bearer = (req: { headers: { authorization?: string } }) => { const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? ''); return m ? m[1]! : null; };
  /** The PC behind a bridge key or an app key (the connector's service), or null. A suspended PC's keys are refused. */
  const authKey = (k: string | null): { keyRowId: string | null; machine: { id: string } } | null => {
    if (!k) return null;
    try {
      if (k.startsWith('ah_app_')) {
        if (!keys) return null;
        const c = keys.verifyKey(k, 'app_key');
        const pc = c.machine_id ? keys.machine(c.machine_id) : null;
        return pc ? { keyRowId: null, machine: pc } : null;
      }
      return setup.verifyBridgeKey(k);
    } catch (e) { if (e instanceof KeyError) return null; throw e; }
  };
  const authBridge = (req: { headers: { authorization?: string } }) => authKey(bearer(req));
  const send = (reply: FastifyReply, r: BridgeReply) => {
    if (r.status === 499) return reply.code(499).send();
    if (r.status === 204) return reply.code(204).send();
    if (r.data) return reply.code(200).header('x-ah-total', String(r.total ?? '')).header('x-ah-eof', r.eof ? '1' : '0').type('application/octet-stream').send(r.data);
    return reply.code(r.status).send(r.body ?? {});
  };
  const aborter = (reply: FastifyReply) => {
    const ac = new AbortController();
    if (reply.raw.destroyed) ac.abort();
    else reply.raw.once('close', () => ac.abort());
    return ac.signal;
  };
  const Q = z.object({ offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), role: z.enum(['send', 'receive']).optional() });

  f.put('/bridge/channels/:id/chunk', async (req, reply) => {
    const auth = authBridge(req); if (!auth) return unauthorized(reply);
    const q = Q.safeParse(req.query ?? {});
    const header = req.headers['x-ah-total'];
    const total = header === undefined ? null : Number(header);
    if (!q.success || (total !== null && (typeof header !== 'string' || !/^\d+$/.test(header) || !Number.isSafeInteger(total))) || !Buffer.isBuffer(req.body)) {
      return reply.code(400).send({ error: 'invalid_chunk' });
    }
    return send(reply, await channels.put(auth.machine.id, (req.params as { id: string }).id, q.data.offset ?? 0, req.body, total, aborter(reply)));
  });
  f.get('/bridge/channels/:id/chunk', async (req, reply) => {
    const auth = authBridge(req); if (!auth) return unauthorized(reply);
    const q = Q.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalid_chunk' });
    return send(reply, await channels.get_chunk(auth.machine.id, (req.params as { id: string }).id, q.data.offset ?? 0, aborter(reply)));
  });
  f.get('/bridge/channels/:id', async (req, reply) => {
    const auth = authBridge(req); if (!auth) return unauthorized(reply);
    const q = Q.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    return send(reply, channels.state(auth.machine.id, (req.params as { id: string }).id, q.data.role));
  });
  f.post('/bridge/channels/:id/done', async (req, reply) => {
    const auth = authBridge(req); if (!auth) return unauthorized(reply);
    const b = z.object({ sha256: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i).optional(), error: z.string().max(1000).optional(), role: z.enum(['send', 'receive']).optional(), committed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'invalid_request' });
    return send(reply, await channels.done(auth.machine.id, (req.params as { id: string }).id, b.data.role ?? '', b.data));
  });

  f.post('/bridge/pair', async (req, reply) => {
    const parsed = z.object({ pairing_code: z.string().min(4).max(40), os: z.string().max(20).optional(), version: z.string().max(40).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    const now = Date.now();
    if (pairLimit.blocked(req.ip, 'pair_fail', now).blocked) return reply.code(429).send({ error: 'rate_limited', message: 'Too many failed pairing attempts.' });
    try {
      const r = setup.pair(b.pairing_code, b.os, b.version);
      return { bridge_key: r.bridgeKey, pc: { id: r.machine.id, name: r.machine.name }, poll_url: '/bridge/poll' };
    } catch (e) {
      if (e instanceof KeyError && ['invalid', 'suspended'].includes(e.code)) {
        pairLimit.fail(req.ip, 'pair_fail', now);
        return reply.code(401).send({ error: 'invalid_pairing_code', message: 'Invalid or expired pairing code.' });
      }
      if (e instanceof KeyError && e.code === 'invalid_argument') return reply.code(400).send({ error: 'invalid_request' });
      throw e;
    }
  });

  f.post('/bridge/poll', async (req, reply) => {
    const presented = bearer(req);
    const auth = authKey(presented);
    if (!auth) return unauthorized(reply);
    const parsed = z.object({ version: z.string().max(40).optional(), wait_s: z.number().min(0).max(MAX_POLL_S).optional(), home: z.string().max(500).optional(), os: z.string().max(20).optional(), running: z.array(z.string().max(100)).max(50).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    channels.noteBridge(auth.machine.id, b);
    setup.heartbeat(auth.keyRowId, auth.machine.id, b.version ?? null);
    const waitMs = (b.wait_s ?? MAX_POLL_S) * 1000;
    const running = b.running ?? [];
    if (waitMs > 0 && channels.jobsFor(auth.machine.id, running).length === 0) {
      await new Promise<void>((resolve) => {
        let off = () => {};
        const done = () => { clearTimeout(t); off(); waiters.delete(done); req.socket.off('close', done); resolve(); };
        const t = setTimeout(done, waitMs);
        off = channels.onJobs(auth.machine.id, done);
        waiters.add(done);
        req.socket.once('close', done);
      });
      if (req.socket.destroyed) return reply;
      if (!authKey(presented)) return unauthorized(reply);
      setup.heartbeat(auth.keyRowId, auth.machine.id, b.version ?? null);
    }
    return { jobs: channels.jobsFor(auth.machine.id, running), allowed_folders: setup.approvedFolders(auth.machine.id), poll_after_ms: 0 };
  });

  return { releaseAll: () => { for (const w of [...waiters]) w(); } };
}
