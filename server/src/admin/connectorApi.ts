/** Admin routes for the connector (docs/connector.md, "Hub route contract"): timeline, PC actions, Disconnect, versions, messages, usage. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import { ACTION_KINDS, DESTINATION_RE, type Connector } from '../connector/connector.js';
import type { Messaging } from '../messaging/messaging.js';

export function registerConnectorApi(api: FastifyInstance, d: { keys: Keys; connector: Connector; messaging: Messaging }, actor: (req: FastifyRequest) => Actor): void {
  const { keys, connector: cn } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const pc = (req: FastifyRequest) => { const id = idOf(req); if (!keys.machine(id)) throw new KeyError('not_found', 'PC not found'); return id; };

  api.get('/api/pcs/:id/setup-timeline', async (req) => cn.timeline(pc(req)));
  api.get('/api/pcs/:id/actions', async (req) => ({ actions: cn.actions(pc(req)) }));
  api.post('/api/pcs/:id/actions', async (req) => {
    const b = z.object({ kind: z.enum(ACTION_KINDS), checkout_id: z.string().max(100).optional(), destination_id: z.string().regex(DESTINATION_RE).optional(), version: z.string().max(40).optional() }).strict().parse(req.body ?? {});
    return { action: cn.createAction(pc(req), b, actor(req)) };
  });
  api.post('/api/pcs/:id/disconnect', async (req) => {
    z.object({}).strict().parse(req.body ?? {});
    return cn.disconnect(pc(req), actor(req));
  });
  // The agent's woken run and the operator's Stop (docs/connector.md, "The wake"). Admin only, as every route here.
  const agent = (req: FastifyRequest) => { const id = idOf(req); if (!keys.agent(id)) throw new KeyError('not_found', 'agent not found'); return id; };
  api.get('/api/agents/:id/wake', async (req) => ({ run: cn.wakeRunOf(agent(req)) }));
  api.post('/api/agents/:id/wake/stop', async (req) => {
    z.object({}).strict().parse(req.body ?? {});
    return cn.stopRun(agent(req), actor(req));
  });
  api.get('/api/pcs/:id/usage', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).optional() }).parse(req.query ?? {});
    return cn.usage(pc(req), q.days ?? 30);
  });
  // Usage per agent (one line per PC) and per team (one line per current member), admin only like the PC's view.
  const days = (req: FastifyRequest) => z.object({ days: z.coerce.number().int().min(1).max(90).optional() }).parse(req.query ?? {}).days ?? 30;
  api.get('/api/agents/:id/usage', async (req) => {
    const id = idOf(req);
    if (!keys.agent(id)) throw new KeyError('not_found', 'Agent not found');
    return cn.usageOf([id], days(req), 'pc');
  });
  // How full an agent's context is (design 3c), and Reset: the operator may reset any agent (audited in the connector).
  api.get('/api/agents/:id/context', async (req) => {
    const id = idOf(req);
    if (!keys.agent(id)) throw new KeyError('not_found', 'Agent not found');
    return cn.contextOf(id);
  });
  api.get('/api/teams/:id/context', async (req) => {
    const members = cn.teamAgents(idOf(req));
    if (!members) throw new KeyError('not_found', 'Team not found');
    return { agents: cn.contextOfMany(members) };
  });
  api.post('/api/agents/:id/reset', async (req) => {
    z.object({}).strict().parse(req.body ?? {});
    const id = idOf(req);
    if (!keys.agent(id)) throw new KeyError('not_found', 'Agent not found');
    return { ...cn.resetAgent(id, actor(req)), context: cn.contextOf(id) };
  });
  api.get('/api/teams/:id/usage', async (req) => {
    const members = cn.teamAgents(idOf(req));
    if (!members) throw new KeyError('not_found', 'Team not found');
    return cn.usageOf(members, days(req), 'agent');
  });

  api.get('/api/connector/versions', async () => ({ versions: cn.versions() }));
  api.post('/api/connector/versions', async (req) => ({ version: cn.addVersion(z.object({ version: z.string().max(40) }).strict().parse(req.body ?? {}).version, actor(req)) }));
  for (const s of ['approve', 'refuse'] as const) {
    api.post(`/api/connector/versions/:version/${s}`, async (req) => ({ version: cn.decideVersion((req.params as { version: string }).version, s === 'approve' ? 'approved' : 'refused', actor(req)) }));
  }

  // Who has been delivered, shown and has read each message of a conversation: positions per agent, the console works out each message.
  api.get('/api/conversations/:roomId/delivery', async (req) => {
    const roomId = (req.params as { roomId: string }).roomId;
    if (!d.messaging.room(roomId)) throw new KeyError('not_found', 'conversation not found');
    const out = cn.roomDelivery(roomId);
    return { last_seq: out.last_seq, members: out.members.map((m) => ({ ...m, label: keys.agent(m.agent_id)?.label ?? null })) };
  });

  api.get('/api/agents/:id/message-states', async (req) => {
    const id = idOf(req);
    if (!keys.agent(id)) throw new KeyError('not_found', 'Agent not found');
    const q = z.object({ room_id: z.string().max(100).optional() }).parse(req.query ?? {});
    return { states: cn.messageStates(id, q.room_id) };
  });
}
