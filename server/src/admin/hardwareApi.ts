/** Admin routes for Hardware (docs/hardware.md#admin-api): machines offered for compute, their waiting lists and flags. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import type { Hardware } from '../hardware/hardware.js';
import { DAYS } from '../hardware/hardware.js';

export interface HardwareApiDeps { hardware: Hardware }

const WINDOW = z.object({ days: z.array(z.enum(DAYS)).min(1).max(7), from: z.string().max(5), to: z.string().max(5) }).strict();
const COMPUTE = z.object({
  access: z.string().max(500), timezone: z.string().min(1).max(64), windows: z.array(WINDOW).max(14).default([]),
  memory_gb: z.number().positive().max(100_000).nullable().optional(), cpus: z.number().int().positive().max(100_000).nullable().optional(),
  gpu: z.string().max(120).nullable().optional(), notes: z.string().max(1000).nullable().optional(),
  teams: z.array(z.string().min(1).max(100)).max(100).default([]),
}).strict();

export function registerHardwareApi(api: FastifyInstance, d: HardwareApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { hardware } = d;
  const param = (req: FastifyRequest, k: string): string => (req.params as Record<string, string>)[k] ?? '';

  api.get('/api/hardware', async () => hardware.overview());
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
