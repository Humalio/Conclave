/**
 * The vault reader's routes (docs/vault-sync.md, "Hub routes"). Plain HTTPS outside /mcp and /api. A reader authenticates
 * with its own key (the PC-bound key of its teamless agent); the pairing routes take the code or its nonce. Version 1 only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { RateLimit } from '../db/rateLimit.js';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import type { Vault } from '../vault/vault.js';
import { VaultError } from '../vault/vault.js';
import type { VaultStore } from '../vault/store.js';
import type { Audit } from '../audit/audit.js';
import { SyncError, type ReaderRow, type VaultSync } from './vaultSync.js';

export const PAIR_FAILS_PER_HOUR = 10;
export const PAGE_MAX = 500;
const STATUS: Record<string, number> = { invalid_argument: 400, unauthorized: 401, forbidden: 403, not_found: 404, invalid_state: 409, rate_limited: 429, unsupported: 426 };

export function registerVaultSync(f: FastifyInstance, d: { db: Db; keys: Keys; audit: Audit; sync: VaultSync; vault: Vault; store: VaultStore }): void {
  const { keys, sync } = d;
  const bearer = (req: FastifyRequest) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_argument', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    if (e instanceof SyncError) return reply.code(STATUS[e.code] ?? 400).send({ error: e.code, message: e.message });
    if (e instanceof VaultError) return reply.code(e.code === 'not_found' ? 404 : 400).send({ error: e.code, message: e.message });
    throw e;
  };
  const refuse = (reply: FastifyReply) => reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized', message: 'Invalid key, or this reader was removed.' });
  /** The reader behind the key: active, its key valid, its PC active. Anything else is the same 401 (a paused one says so). */
  const readerOf = (req: FastifyRequest): ReaderRow | 'paused' | null => {
    const k = bearer(req);
    if (!k) return null;
    try {
      const c = keys.verifyKey(k, 'session_key');
      const r = sync.byCredential(c.id);
      if (!r || r.state === 'removed' || r.state === 'pending' || r.agent_id !== c.agent_id) return null;
      const pc = keys.machine(r.machine_id);
      if (!pc || pc.status !== 'active' || c.bound_machine_id !== r.machine_id) return null;
      return r.state === 'paused' ? 'paused' : r;
    } catch (e) { if (e instanceof KeyError) return null; throw e; }
  };
  const authed = (fn: (r: ReaderRow, req: FastifyRequest, reply: FastifyReply) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    const r = readerOf(req);
    if (!r) return refuse(reply);
    if (r === 'paused') return reply.code(403).send({ error: 'paused', message: 'This reader is paused.' });
    try { return await fn(r, req, reply); } catch (e) { return send(reply, e); }
  };
  const version = z.coerce.number().int().optional();
  const v1 = (q: { version?: number | undefined }) => { if (q.version !== undefined && q.version !== 1) throw new SyncError('unsupported', 'Only version 1 of vault sync is supported.'); };
  const limitOf = z.coerce.number().int().min(1).max(PAGE_MAX).default(200);

  const limit = () => new RateLimit(d.db, PAIR_FAILS_PER_HOUR, 3600_000);
  f.post('/vault-sync/v1/pair', async (req, reply) => {
    const scope = `ip:${req.ip}`;
    try {
      const b = z.object({ code: z.string().max(64), nonce: z.string().max(128), version: z.literal(1).optional() }).strict().parse(req.body ?? {});
      const lim = limit();
      if (lim.blocked(scope, 'pair_fail').blocked) throw new SyncError('rate_limited', 'Too many failed pairing attempts from this address. Try again later.');
      try {
        const r = sync.redeem(b.code, b.nonce);
        return { key: r.key, reader: { id: r.reader.id, name: r.reader.name }, version: 1 };
      } catch (e) {
        if (e instanceof SyncError && e.code === 'unauthorized') lim.fail(scope, 'pair_fail');
        throw e;
      }
    } catch (e) { return send(reply, e); }
  });
  f.post('/vault-sync/v1/pair/confirm', async (req, reply) => {
    try {
      const b = z.object({ nonce: z.string().max(128) }).strict().parse(req.body ?? {});
      const lim = limit(), scope = `ip:${req.ip}`;
      if (lim.blocked(scope, 'pair_fail').blocked) throw new SyncError('rate_limited', 'Too many failed pairing attempts from this address. Try again later.');
      try { sync.confirm(b.nonce); } catch (e) { lim.fail(scope, 'pair_fail'); throw e; }
      return { ok: true };
    } catch (e) { return send(reply, e); }
  });

  // The files in scope now (a first listing, and again after `reset`).
  f.get('/vault-sync/v1/files', authed((r, req) => {
    const q = z.object({ after: z.string().max(1000).optional(), limit: limitOf, version }).parse(req.query ?? {});
    v1(q);
    return sync.files(r, q.after ?? null, q.limit);
  }));
  // The changes after a cursor: the current rules are checked on every page.
  f.get('/vault-sync/v1/changes', authed((r, req) => {
    const q = z.object({ cursor: z.string().max(2000).optional(), limit: limitOf, version }).parse(req.query ?? {});
    v1(q);
    const c = sync.changes(r, q.cursor ?? null, q.limit);
    return { changes: c.entries, cursor: c.cursor, more: c.more, reset: c.reset };
  }));
  // One file: refused at once when the rules no longer allow it, whatever the reader listed a moment ago.
  f.get('/vault-sync/v1/files/content', authed(async (r, req, reply) => {
    const q = z.object({ path: z.string().min(1).max(1000), version }).parse(req.query ?? {});
    v1(q);
    let norm;
    try { norm = d.vault.normalise(`/${d.vault.alias}/${q.path}`); } catch { return reply.code(400).send({ error: 'invalid_path', message: 'not a vault path' }); }
    const rel = norm.rel.join('/');
    if (!sync.mayDownload(r, rel)) return reply.code(403).send({ error: 'forbidden', message: 'This reader may not take that file.' });
    const file = d.store.fileByPath(rel);
    if (!file || file.current_revision === null) return reply.code(404).send({ error: 'not_found', message: 'no such file' });
    const bytes = await d.vault.readBytes(norm.rel);
    sync.served1(r, bytes.length);
    if (sync.isExternalOwner(r)) d.audit.event({ kind: 'agent', id: r.agent_id }, 'export.read', { kind: 'vault_file', id: rel }, { what: 'vault_file', path: rel, bytes: bytes.length, reader: r.id });
    return reply.type('application/octet-stream').header('x-conclave-revision', file.current_revision).header('content-length', String(bytes.length)).send(bytes);
  }));
  // A finished run: one audit entry, and the mirror's totals for the console.
  f.post('/vault-sync/v1/runs', authed((r, req) => {
    const b = z.object({ files: z.number().int().min(0).max(1e9), bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), version: z.literal(1).optional() }).strict().parse(req.body ?? {});
    sync.run(r, b);
    return { ok: true };
  }));
}
