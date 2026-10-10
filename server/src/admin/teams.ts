/** Team builder and team page API (F4). Registered inside the authenticated /api scope. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import type { Actor } from '../audit/audit.js';
import type { Teams } from '../teams/teams.js';

export interface TeamsDeps { db: Db; keys: Keys; teams: Teams }

const role = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/);
const limits = z.object({ tasks_per_hour: z.number().int().min(1).optional(), messages_per_hour: z.number().int().min(1).optional(), writes_per_hour: z.number().int().min(1).optional(), channel_bytes_per_hour: z.number().int().min(1).optional() }).strict();
const member = z.object({ agent_id: z.string(), role, credential_id: z.string().optional() });
const create = z.object({
  name: z.string().trim().min(1).max(80), goal: z.string().trim().min(1).max(4000), members: z.array(member).min(1).max(50), grant_messaging: z.boolean().optional(),
  limits: limits.optional(), checkpoints: z.array(z.enum(['done'])).optional(), lease_minutes: z.number().int().min(1).max(1440).optional(),
  max_review_rounds: z.number().int().min(1).max(20).optional(), stall_minutes: z.number().int().min(1).max(1440).optional(),
});
const patch = z.object({
  name: z.string().trim().min(1).max(80).optional(), goal: z.string().trim().min(1).max(4000).optional(), limits: limits.optional(), checkpoints: z.array(z.enum(['done'])).optional(),
  lease_minutes: z.number().int().min(1).max(1440).optional(), max_review_rounds: z.number().int().min(1).max(20).optional(), stall_minutes: z.number().int().min(1).max(1440).optional(),
});

export function registerTeams(api: FastifyInstance, d: TeamsDeps, actor: (r: FastifyRequest) => Actor): void {
  const { teams } = d;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  const p = (req: FastifyRequest) => req.params as { id: string; taskId?: string; agentId?: string; role?: string };

  api.get('/api/teams', async () => ({ teams: teams.teams().map((t) => teams.summary(t)) }));
  api.post('/api/teams', async (req, reply) => {
    const t = teams.create(body(create, req), actor(req));
    reply.code(201);
    return { team: teams.view(t), warnings: teams.chatWarnings(t.id) };
  });
  api.get('/api/teams/:id', async (req) => ({ team: teams.view(teams.mustTeam(p(req).id)) }));
  api.patch('/api/teams/:id', async (req) => ({ team: teams.view(teams.update(p(req).id, body(patch, req), actor(req))) }));
  api.post('/api/teams/:id/start', async (req) => ({ team: teams.view(teams.start(p(req).id, actor(req))) }));
  api.post('/api/teams/:id/pause', async (req) => ({ team: teams.view(teams.pause(p(req).id, 'admin', actor(req))) }));
  api.post('/api/teams/:id/resume', async (req) => ({ team: teams.view(teams.resume(p(req).id, actor(req))) }));
  api.post('/api/teams/:id/stop', async (req) => ({ team: teams.view(teams.stop(p(req).id, actor(req))) }));
  api.post('/api/teams/:id/members', async (req) => {
    teams.addMember(p(req).id, body(member, req), actor(req));
    return { team: teams.view(teams.mustTeam(p(req).id)), warnings: teams.chatWarnings(p(req).id) };
  });
  api.delete('/api/teams/:id/members/:agentId', async (req) => {
    teams.removeMember(p(req).id, p(req).agentId!, actor(req));
    return { team: teams.view(teams.mustTeam(p(req).id)) };
  });
  api.put('/api/teams/:id/roles/:role', async (req) => {
    teams.setPlaybook(p(req).id, p(req).role!, body(z.object({ playbook: z.string().min(1).max(8000) }), req).playbook, actor(req));
    return { team: teams.view(teams.mustTeam(p(req).id)) };
  });
  api.get('/api/teams/:id/handoff', async (req) => teams.handoff(teams.mustTeam(p(req).id)));
  api.get('/api/teams/:id/tasks/:taskId', async (req) => {
    const t = teams.task(p(req).taskId!);
    if (!t || t.team_id !== p(req).id) return { task: null, events: [] };
    return { task: teams.taskView(t), events: teams.taskEvents(t.id) };
  });
  api.post('/api/teams/:id/tasks/:taskId/approve', async (req) => ({ task: teams.taskView(teams.approve(p(req).id, p(req).taskId!, actor(req))) }));
}
