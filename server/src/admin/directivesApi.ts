/** Admin routes for directives (docs/directives.md): list with coverage, create, edit, retire, and agents' reports. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import type { Directives } from '../directives/directives.js';

export interface DirectivesApiDeps { directives: Directives }

const scope = z.object({ kind: z.enum(['hub', 'project', 'team', 'role', 'agent']), ref: z.string().max(200).nullable().optional() });

export function registerDirectivesApi(api: FastifyInstance, d: DirectivesApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { directives } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});

  api.get('/api/directives', async (req) => {
    const q = z.object({ status: z.enum(['active', 'retired', 'all']).optional() }).parse(req.query ?? {});
    return { directives: directives.list(q.status ?? 'active'), reports: directives.reports('open'), unreviewed: directives.unreviewed() };
  });
  api.get('/api/directives/unreviewed-count', async () => ({ count: directives.unreviewedCount() }));
  api.get('/api/directives/:id', async (req) => directives.detail(idOf(req)));
  api.post('/api/directives', async (req) => {
    const b = body(z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(20000), scope, source: z.string().max(500).nullable().optional() }), req);
    return { directive: directives.create({ title: b.title, body: b.body, scope: { kind: b.scope.kind, ref: b.scope.ref ?? null }, source: b.source ?? 'console' }, actor(req)) };
  });
  api.patch('/api/directives/:id', async (req) => {
    const b = body(z.object({ title: z.string().min(1).max(120).optional(), body: z.string().min(1).max(20000).optional(), scope: scope.optional(), note: z.string().max(500).nullable().optional() }), req);
    return { directive: directives.update(idOf(req), { title: b.title, body: b.body, scope: b.scope ? { kind: b.scope.kind, ref: b.scope.ref ?? null } : undefined, note: b.note ?? null }, actor(req)) };
  });
  api.post('/api/directives/:id/review', async (req) => ({ directive: directives.review(idOf(req), actor(req)) }));
  api.post('/api/directives/review-all', async (req) => ({ reviewed: directives.reviewAll(actor(req), body(z.object({ agent_id: z.string().max(100).optional() }), req).agent_id) }));
  api.post('/api/directives/merge', async (req) => {
    const b = body(z.object({ ids: z.array(z.string().max(100)).min(2).max(50), title: z.string().min(1).max(120), body: z.string().min(1).max(20000), scope }), req);
    return { directive: directives.merge(b.ids, { title: b.title, body: b.body, scope: { kind: b.scope.kind, ref: b.scope.ref ?? null } }, actor(req)) };
  });
  api.post('/api/directives/:id/retire', async (req) => ({ directive: directives.retire(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)) }));
  api.get('/api/directive-reports', async (req) => ({ reports: directives.reports(z.object({ status: z.enum(['open', 'all']).optional() }).parse(req.query ?? {}).status ?? 'open') }));
  api.post('/api/directive-reports/:id/adopt', async (req) => {
    const b = body(z.object({ title: z.string().min(1).max(120).optional(), body: z.string().min(1).max(20000).optional(), scope: scope.optional(), directive_id: z.string().max(100).optional() }), req);
    return directives.adopt(idOf(req), { title: b.title, body: b.body, scope: b.scope ? { kind: b.scope.kind, ref: b.scope.ref ?? null } : undefined, directive_id: b.directive_id }, actor(req));
  });
  api.post('/api/directive-reports/:id/retire', async (req) => ({ report: directives.dismiss(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)) }));
  api.get('/api/agents/:id/directives', async (req) => directives.agentView(idOf(req)));
  api.get('/api/teams/:id/directives', async (req) => directives.teamView(idOf(req)));
}
