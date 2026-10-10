/** Admin routes for the knowledge graph: health, budgets, tier map, priority folders (design/13 §8, §9). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Graph } from '../graph/graph.js';

export function registerGraphAdmin(api: FastifyInstance, d: { db: Db; audit: Audit; graph: Graph }, actor: (req: FastifyRequest) => Actor): void {
  const { graph, audit } = d;
  api.get('/api/graph/health', async () => graph.health());
  api.get('/api/graph/budget', async () => ({ budgets: graph.ext.budgets() }));
  api.get('/api/graph/flags', async (req) => {
    const q = z.object({ status: z.enum(['open', 'fixed', 'dismissed']).optional(), kind: z.enum(['stale', 'contradiction']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { flags: graph.ext.flags(q) };
  });
  api.post('/api/graph/flags/:id/resolve', async (req) => {
    const id = z.string().max(100).parse((req.params as { id: string }).id);
    const b = z.object({ status: z.enum(['fixed', 'dismissed']) }).parse(req.body);
    const a = actor(req);
    const flag = graph.ext.resolveFlag(id, 'admin', b.status, { admin: true });
    audit.event(a, 'graph.flag_resolve', { kind: 'graph', id }, b);
    return { flag };
  });
  api.get('/api/graph/jobs', async (req) => {
    const q = z.object({ state: z.enum(['queued', 'leased', 'done', 'parked']).optional(), type: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { jobs: graph.ext.jobs(q) };
  });
  api.get('/api/graph/entities', async (req) => {
    const q = z.object({ q: z.string().max(200).default(''), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return { entities: graph.ext.entities(q.q, q.limit) };
  });
  api.post('/api/graph/refresh', async (req) => {
    const r = graph.ext.refresh();
    audit.event(actor(req), 'graph.refresh', { kind: 'graph', id: 'communities' }, r);
    return r;
  });
  api.put('/api/graph/budget', async (req) => {
    const b = z.object({ scope: z.enum(['vault', 'team', 'session', 'job_type']), ref: z.string().max(100).default(''), period: z.enum(['hour', 'day']),
      tokens_cap: z.number().int().min(0).nullable().optional(), jobs_cap: z.number().int().min(0).nullable().optional() }).parse(req.body);
    graph.setBudget(b.scope, b.ref, b.period, b.tokens_cap ?? null, b.jobs_cap ?? null);
    audit.event(actor(req), 'graph.budget', { kind: 'graph', id: `${b.scope}:${b.ref}` }, b);
    return graph.health();
  });
  api.put('/api/graph/tier', async (req) => {
    const b = z.object({ pattern: z.string().min(1).max(80), tier: z.enum(['light', 'strong']).nullable() }).parse(req.body);
    graph.setTier(b.pattern, b.tier);
    audit.event(actor(req), 'graph.tier', { kind: 'graph', id: b.pattern }, b);
    return graph.health();
  });
  api.put('/api/graph/priority-folders', async (req) => {
    const b = z.object({ folders: z.array(z.string().min(1).max(400)).max(50) }).parse(req.body);
    graph.setSetting('kg.priority_folders', b.folders);
    audit.event(actor(req), 'graph.priority_folders', { kind: 'graph', id: 'priority' }, b);
    return graph.health();
  });
}
