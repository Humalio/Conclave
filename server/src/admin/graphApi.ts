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
    if (!req.member) return { entities: graph.ext.entities(q.q, q.limit) };
    // A member (§2): entities with a live claim sourced in the granted folders of projects granted with the graph
    // component. The name is matched, not aliases, and descriptions and aliases are left out: they may come from sources
    // outside the grant. Claims count those sources only.
    const m = req.member;
    const gfs = [...new Set(m.projects('graph').flatMap((p) => m.grants.get(p)!.folders))];
    if (!gfs.length) return { entities: [] };
    const vis = m.pathSql('f.path');
    const under = "substr('/' || f.path, 1, length(?)) = ?";
    const where = `${vis.sql} AND (${gfs.map(() => under).join(' OR ')})`;
    const args = [...vis.args, ...gfs.flatMap((f) => [f, f])];
    const live = `JOIN kg_claims c ON (c.subject_id=e.id OR c.object_id=e.id) AND c.status<>'invalidated' JOIN files f ON f.id=c.src_file AND f.deleted_at IS NULL`;
    const like = `%${q.q.toLowerCase().replace(/[%_]/g, '')}%`;
    const rows = d.db.prepare(`SELECT e.id, e.name, e.type, e.status, e.merged_into, COUNT(DISTINCT c.id) claims FROM kg_entities e ${live}
      WHERE lower(e.name) LIKE ? AND ${where} GROUP BY e.id ORDER BY e.name LIMIT ?`).all(like, ...args, Math.min(q.limit ?? 50, 200)) as Record<string, unknown>[];
    // merged_into only names an entity the member sees too.
    const targets = [...new Set(rows.map((e) => e.merged_into).filter((x): x is string => typeof x === 'string'))];
    const seen = new Set(targets.length ? (d.db.prepare(`SELECT DISTINCT e.id FROM kg_entities e ${live} WHERE e.id IN (${targets.map(() => '?').join(',')}) AND ${where}`)
      .all(...targets, ...args) as { id: string }[]).map((r) => r.id) : []);
    return { entities: rows.map((e) => ({ ...e, merged_into: typeof e.merged_into === 'string' && seen.has(e.merged_into) ? e.merged_into : null, description: null, aliases: [] })) };
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
