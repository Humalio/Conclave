/** Demo mode routes (docs/showcase.md#demo-mode). Registered only when DEMO_MODE is on; otherwise they do not exist. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor, Audit } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { DemoController } from '../demo/demo.js';

export function registerDemoApi(api: FastifyInstance, d: { demo: DemoController; audit: Audit }, actor: (req: FastifyRequest) => Actor): void {
  api.get('/api/demo', async () => ({ ...(await d.demo.info()), state: d.demo.state }));
  api.post('/api/demo/replay', async (req, reply) => {
    const b = z.object({ pace: z.enum(['instant', '0.5x', '1x', '2x']).default('instant'), from: z.number().int().min(0).max(5).default(0), until: z.number().int().min(0).max(5).default(5) }).strict().parse(req.body ?? {});
    if (b.from > b.until) throw new KeyError('invalid_argument', 'Start at an act before or equal to the one it stops at.');
    const state = d.demo.start(b, req.admin!);
    d.audit.event(actor(req), 'demo.replay', { kind: 'system', id: 'demo' }, { pace: b.pace, from: b.from, until: b.until });
    return reply.code(202).send({ state });
  });
  api.post('/api/demo/stop', async (req) => {
    const stopped = d.demo.stop();
    if (stopped) d.audit.event(actor(req), 'demo.stop', { kind: 'system', id: 'demo' }, {});
    return { stopped, state: d.demo.state };
  });
}
