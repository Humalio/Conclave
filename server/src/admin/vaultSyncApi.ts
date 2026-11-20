/** Admin routes for vault readers (docs/vault-sync.md): the console's list, create, edit scope, pause, resume, remove, revoke code. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import { SyncError, type VaultSync } from '../vaultsync/vaultSync.js';

const Scope = z.array(z.object({ effect: z.enum(['allow', 'deny']), resource: z.string().max(500) }).strict()).min(1).max(100);

export function registerVaultSyncApi(api: FastifyInstance, d: { sync: VaultSync }, actor: (req: FastifyRequest) => Actor): void {
  const { sync } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  /** Reader management is the administrator's: a member never sees or changes a reader. */
  const admin = (req: FastifyRequest) => { if (req.member) throw new KeyError('admin_only', 'Only an admin can do this.'); return actor(req); };
  const run = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof SyncError) throw new KeyError(e.code === 'unauthorized' ? 'forbidden' : e.code, e.message);
      throw e;
    }
  };
  api.get('/api/vault-readers', async (req) => { admin(req); return { readers: sync.list() }; });
  api.get('/api/vault-readers/:id', async (req) => { admin(req); return run(() => ({ reader: sync.get(idOf(req)) })); });
  api.post('/api/vault-readers', async (req) => {
    const a = admin(req);
    const b = z.object({ name: z.string().max(80), pc_id: z.string().max(100), owner: z.string().max(100).nullable().optional(), scope: Scope }).strict().parse(req.body ?? {});
    return run(() => sync.create({ name: b.name, machineId: b.pc_id, owner: b.owner ?? null, scope: b.scope }, a));
  });
  api.patch('/api/vault-readers/:id', async (req) => {
    const a = admin(req);
    const b = z.object({ scope: Scope }).strict().parse(req.body ?? {});
    return run(() => ({ reader: sync.editScope(idOf(req), b.scope, a) }));
  });
  api.post('/api/vault-readers/:id/pause', async (req) => { const a = admin(req); return run(() => ({ reader: sync.pause(idOf(req), a) })); });
  api.post('/api/vault-readers/:id/resume', async (req) => { const a = admin(req); return run(() => ({ reader: sync.resume(idOf(req), a) })); });
  api.delete('/api/vault-readers/:id', async (req) => { const a = admin(req); return run(() => sync.remove(idOf(req), a)); });
}
