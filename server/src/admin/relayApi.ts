/** Admin routes for relays (docs/relay.md): register, list with last seen, rotate the secret, remove. The secret is in an answer once. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import { releaseBase, type Relays } from '../relay/relays.js';

export function registerRelayApi(api: FastifyInstance, d: { relays: Relays }, actor: (req: FastifyRequest) => Actor): void {
  const { relays } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  /** Relays are the administrator's: a member never sees or changes one. */
  const admin = (req: FastifyRequest) => { if (req.member) throw new KeyError('admin_only', 'Only an admin can do this.'); return actor(req); };
  const withBase = <T extends { origin: string }>(r: T) => ({ ...r, release_base: releaseBase(r.origin) });
  api.get('/api/relays', async (req) => { admin(req); return { relays: relays.list().map(withBase) }; });
  api.post('/api/relays', async (req) => {
    const a = admin(req);
    const b = z.object({ name: z.string().max(80), origin: z.string().max(200), ca_sha256: z.string().max(100) }).strict().parse(req.body ?? {});
    const r = relays.create({ name: b.name, origin: b.origin, caSha256: b.ca_sha256 }, a);
    return { relay: withBase(r.relay), secret: r.secret };
  });
  api.post('/api/relays/:id/rotate', async (req) => { const a = admin(req); const r = relays.rotate(idOf(req), a); return { relay: withBase(r.relay), secret: r.secret }; });
  api.delete('/api/relays/:id', async (req) => { const a = admin(req); return relays.remove(idOf(req), a); });
}
