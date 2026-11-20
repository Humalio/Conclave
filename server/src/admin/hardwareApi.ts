/** Admin routes for Hardware (docs/hardware.md#admin-api): machines offered for compute, their waiting lists, flags, pause,
   allowances, and What ran with its analysis for a period. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import type { Hardware } from '../hardware/hardware.js';
import { DAYS, PERIODS, type Period } from '../hardware/hardware.js';

export interface HardwareApiDeps { hardware: Hardware }

const WINDOW = z.object({ days: z.array(z.enum(DAYS)).min(1).max(7), from: z.string().max(5), to: z.string().max(5) }).strict();
const COMPUTE = z.object({
  access: z.string().max(500), timezone: z.string().min(1).max(64), windows: z.array(WINDOW).max(14).default([]),
  memory_gb: z.number().positive().max(100_000).nullable().optional(), cpus: z.number().int().positive().max(100_000).nullable().optional(),
  gpu: z.string().max(120).nullable().optional(), notes: z.string().max(1000).nullable().optional(),
  teams: z.array(z.string().min(1).max(100)).max(100).default([]),
  shared_with_people: z.boolean().optional(),
  allowances: z.record(z.string().min(1).max(100), z.number().min(0.25).max(24).nullable()).optional(),
}).strict();
const ID = z.string().max(100).optional();
const QUERY = z.object({
  period: z.enum(Object.keys(PERIODS) as [Period, ...Period[]]).default('7d'), tz: z.string().max(64).optional(),
  machine: ID, team: ID, agent: ID, q: z.string().max(200).optional(),
}).passthrough();

export function registerHardwareApi(api: FastifyInstance, d: HardwareApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { hardware } = d;
  const param = (req: FastifyRequest, k: string): string => (req.params as Record<string, string>)[k] ?? '';

  api.get('/api/hardware', async (req) => {
    const q = QUERY.parse(req.query ?? {});
    return hardware.overview({ period: q.period, tz: q.tz ?? null, filter: { machine: q.machine || null, team: q.team || null, agent: q.agent || null, q: q.q || null } });
  });
  api.post('/api/hardware/:pcId/pause', async (req) => { hardware.pause(param(req, 'pcId'), actor(req)); return hardware.overview(); });
  api.post('/api/hardware/:pcId/resume', async (req) => { hardware.resume(param(req, 'pcId'), actor(req)); return hardware.overview(); });
  api.put('/api/hardware/:pcId', async (req) => {
    hardware.register(param(req, 'pcId'), COMPUTE.parse(req.body ?? {}), actor(req));
    return hardware.overview();
  });
  api.delete('/api/hardware/:pcId', async (req) => hardware.unregister(param(req, 'pcId'), actor(req)));
  api.post('/api/hardware/preview', async (req) => {
    const b = COMPUTE.extend({ pc_id: z.string().max(100).nullable().optional() }).parse(req.body ?? {});
    const { pc_id, ...c } = b;
    return { text: hardware.preview(pc_id ?? null, c) };
  });
  api.post('/api/hardware/entries/:seq/remove', async (req) => {
    hardware.removeEntry(z.coerce.number().int().positive().parse(param(req, 'seq')), actor(req));
    return hardware.overview();
  });
  api.post('/api/hardware/flags/:id/clear', async (req) => {
    hardware.clearFlag(z.string().max(100).parse(param(req, 'id')), actor(req));
    return hardware.overview();
  });
}
