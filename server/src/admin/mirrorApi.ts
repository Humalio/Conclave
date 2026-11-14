/**
 * Admin routes for the vault folder "99 Conclave/" (docs/vault.md): the on/off setting (Settings → Vault) and the
 * import of a saved checkout (scripts/mirror-import-checkout.mjs). Administrator only.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import type { Mirror } from '../mirror/mirror.js';

export function registerMirrorApi(api: FastifyInstance, mirror: Mirror, actor: (req: FastifyRequest) => Actor): void {
  api.get('/api/settings/vault', async () => ({ settings: mirror.settings() }));
  api.put('/api/settings/vault', async (req) => {
    const b = z.object({ mirror_enabled: z.boolean() }).strict().parse(req.body ?? {});
    mirror.setEnabled(b.mirror_enabled, actor(req));
    return { settings: mirror.settings() };
  });
  // The pages of a checkout that ended before this build, from its saved JSON (GET /api/checkouts/:id).
  api.post('/api/vault/mirror/import', async (req) => {
    const r = await mirror.importCheckout(req.body);
    await mirror.idle();
    mirror.audit(actor(req), r.checkout, r.pages.length);
    return r;
  });
}
