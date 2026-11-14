/** Admin routes for agent feedback (Work → Feedback): list, read, status, merge, edit, hide, delete, export, settings. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { Feedback } from '../feedback/feedback.js';
import { KINDS, SEVERITIES } from '../feedback/feedback.js';

export interface FeedbackApiDeps { feedback: Feedback }

const filters = z.object({
  bucket: z.enum(['new', 'open', 'closed']).optional(), status: z.string().max(20).optional(), kind: z.enum(KINDS).optional(), tool: z.string().max(100).optional(),
  team: z.string().max(100).optional(), agent: z.string().max(100).optional(), assignee: z.string().max(100).optional(), linked: z.enum(['linked', 'not_linked']).optional(), q: z.string().max(200).optional(), sort: z.enum(['impact', 'recent']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const limits = z.object({
  reportsPerHour: z.number().int().min(1).max(1000), reportsPerDay: z.number().int().min(1).max(10000), entriesPerHour: z.number().int().min(1).max(10000),
  openPerAgent: z.number().int().min(1).max(1000), entriesPerReport: z.number().int().min(1).max(100000), hubReportsPerDay: z.number().int().min(1).max(100000), spamHits: z.number().int().min(1).max(100),
}).partial();

export function registerFeedbackApi(api: FastifyInstance, d: FeedbackApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { feedback } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});

  api.get('/api/feedback', async (req) => ({ reports: feedback.list(filters.parse(req.query ?? {})), counts: feedback.counts(), tools: feedback.facets() }));
  // The badge on the Work button, the Overview's urgent items, and the switches.
  api.get('/api/feedback/counts', async () => ({ ...feedback.counts(), urgent: feedback.urgent(), enabled: feedback.enabled() }));
  api.get('/api/feedback/settings', async () => feedback.settings());
  api.put('/api/feedback/settings', async (req) => feedback.setSettings(body(z.object({ enabled: z.boolean().optional(), own_only: z.boolean().optional(), limits: limits.optional() }), req), actor(req)));

  api.get('/api/feedback/export', async (req, reply) => {
    const q = z.object({ format: z.enum(['md', 'json']).default('md'), ids: z.string().max(5000).optional() }).extend(filters.shape).parse(req.query ?? {});
    const ids = q.ids ? q.ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500) : feedback.list(q).map((r) => r.id);
    if (!ids.length) throw new KeyError('not_found', 'nothing to export');
    const { format, ids: _i, ...filter } = q;
    const text = feedback.export(ids, format, actor(req), q.ids ? undefined : filter);
    return reply.type(format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8').send(text);
  });

  api.get('/api/feedback/:id', async (req) => feedback.detail(idOf(req)));
  api.post('/api/feedback/:id/status', async (req) => {
    const b = body(z.object({
      status: z.enum(['new', 'needs_info', 'accepted', 'fixed', 'wont_fix']), note: z.string().max(2000).nullable().optional(),
      guidance: z.string().max(2000).nullable().optional(), fixed_in: z.string().max(40).nullable().optional(),
    }), req);
    feedback.setStatus(idOf(req), b, actor(req));
    return feedback.detail(idOf(req));
  });
  // Assign to one agent, or unassign with agent_id null (docs/feedback.md#assigning-a-report).
  api.post('/api/feedback/:id/assign', async (req) => {
    const b = body(z.object({ agent_id: z.string().min(1).max(100).nullable(), note: z.string().max(2000).nullable().optional() }).strict(), req);
    feedback.assign(idOf(req), b.agent_id, b.note ?? null, actor(req));
    return feedback.detail(idOf(req));
  });
  api.post('/api/feedback/:id/merge', async (req) => {
    const b = body(z.object({ target_id: z.string().min(1).max(100) }), req);
    const r = feedback.merge(idOf(req), b.target_id, actor(req));
    return { moved: r.moved, detail: feedback.detail(idOf(req)) };
  });
  api.patch('/api/feedback/:id', async (req) => {
    const b = body(z.object({ title: z.string().min(1).max(120).optional(), severity: z.enum(SEVERITIES).optional(), hidden: z.boolean().optional(), guidance: z.string().max(2000).nullable().optional() }), req);
    feedback.edit(idOf(req), b, actor(req));
    return feedback.detail(idOf(req));
  });
  api.post('/api/feedback/:id/notes', async (req) => {
    feedback.note(idOf(req), body(z.object({ text: z.string().min(1).max(2000) }), req).text, actor(req));
    return feedback.detail(idOf(req));
  });
  // Linked tasks (docs/feedback.md#linked-tasks): the operator links and unlinks any report and task.
  api.post('/api/feedback/:id/tasks', async (req) => {
    const b = body(z.object({ task_id: z.string().min(1).max(100) }).strict(), req);
    feedback.link(idOf(req), b.task_id, actor(req));
    return feedback.detail(idOf(req));
  });
  api.delete('/api/feedback/:id/tasks/:taskId', async (req) => {
    feedback.unlink(idOf(req), (req.params as { taskId: string }).taskId, actor(req));
    return feedback.detail(idOf(req));
  });
  // "From feedback" on the operator's task screen: every report linked to the task.
  api.get('/api/feedback/by-task/:taskId', async (req) => ({ reports: feedback.reportsOfTask((req.params as { taskId: string }).taskId) }));
  api.delete('/api/feedback/:id', async (req) => { feedback.delete(idOf(req), actor(req)); return { ok: true }; });
}
