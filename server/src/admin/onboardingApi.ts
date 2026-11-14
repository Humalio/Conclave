/** Admin routes for onboarding (docs/onboarding.md#admin-api): Add PC, Re-enrol, codes, settings, the one approval, capability. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import type { Config } from '../config.js';
import type { Onboarding, ApproveIn } from '../onboarding/onboarding.js';
import { renderPrompt, type ClientFiles } from '../onboarding/http.js';

export interface OnboardingApiDeps { keys: Keys; onboarding: Onboarding; files: ClientFiles; config: Config }

const folder = z.object({ path: z.string(), access: z.enum(['read', 'write']) });
const role = z.object({ name: z.string(), team_role: z.enum(['coordinator', 'worker', 'reviewer', 'stakeholder']), count: z.number().int(), job: z.string(), reviews: z.array(z.string()).optional(), folders: z.array(folder).optional() });
const rule = z.object({ title: z.string(), source: z.string(), text: z.string(), category: z.string().optional(), role: z.enum(['coordinator', 'worker', 'reviewer', 'stakeholder']).optional() });
// Bounds are checked by the hub (onboarding.ts), with field-level problems; the schema only fixes the shape.
const requirement = z.object({ kind: z.enum(['fr', 'nfr']), title: z.string(), text: z.string(), category: z.enum(['perf', 'sec', 'rel', 'use', 'ops']).optional(), acs: z.array(z.string()).optional(), module: z.string().optional() });
/** The kept research records; the hub's request rules check each field (docs/onboarding.md#the-request). */
const research = z.object({ lines: z.array(z.record(z.string(), z.unknown())), papers: z.array(z.record(z.string(), z.unknown())) });
const standard = z.object({ key: z.string(), title: z.string().optional(), text: z.string().optional() });
const team = z.object({ name: z.string().optional(), goal: z.string().optional(), delivery_mode: z.enum(['on_demand', 'poll']).optional(), close_on_approve: z.boolean().optional(), coordinator_reviews: z.boolean().optional(),
  lease_minutes: z.number().int().optional(), stall_minutes: z.number().int().optional(), max_review_rounds: z.number().int().optional() });

export function registerOnboardingApi(api: FastifyInstance, d: OnboardingApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { keys, onboarding: ob, files, config } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  const prompt = (code: string, pc: string) => renderPrompt(files, { hubUrl: config.publicUrl, lanUrl: config.lanUrl, code, pc });

  // Add PC: the code appears only in this response (and in Re-enrol's).
  api.post('/api/pcs/add', async (req) => {
    const b = body(z.object({ name: z.string(), description: z.string().max(500).nullable().optional() }), req);
    const r = ob.addPc(b.name, b.description ?? null, actor(req));
    return { pc: r.pc, key: { id: r.key.id, label: r.key.label, onboarding_enabled_at: r.key.onboarding_enabled_at }, code: r.code, prompt: prompt(r.code, r.pc.name) };
  });
  api.post('/api/pcs/:id/re-enrol', async (req) => {
    const r = ob.reEnrol(idOf(req), actor(req));
    return { pc: r.pc, key: { id: r.key.id, label: r.key.label }, code: r.code, prompt: prompt(r.code, r.pc.name), reopened: r.reopened };
  });
  api.get('/api/onboarding/pcs', async () => ({ pcs: ob.pcStates() }));
  api.get('/api/pcs/:id/enrolment', async (req) => ({ enrolment: ob.enrolment(idOf(req)) }));
  api.delete('/api/pcs/:id/enrolment', async (req) => ob.revokeCode(idOf(req), actor(req)));

  api.get('/api/settings/onboarding', async () => ({ settings: ob.settings() }));
  api.put('/api/settings/onboarding', async (req) => {
    const n = z.number().int().optional();
    const b = body(z.object({ max_roles: n, max_agents: n, max_per_role: n, max_rules: n, max_requirements: n, file_per_hour: n, file_per_day: n }).strict(), req);
    return { settings: ob.setSettings(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)), actor(req)) };
  });

  api.get('/api/onboarding', async (req) => ({ requests: ob.list((req.query as { status?: string }).status) }));
  api.get('/api/onboarding/:id', async (req) => ob.detail(idOf(req)));
  api.post('/api/onboarding/:id/approve', async (req) => {
    const b = body(z.object({
      version: z.number().int(),
      edits: z.object({ project: z.object({ name: z.string(), existing: z.boolean(), kind: z.enum(['implementation', 'research']).optional(), more_teams: z.boolean().optional() }).optional(), team: team.optional(), roles: z.array(role).optional(), rules: z.array(rule).optional(), requirements: z.array(requirement).optional(), research: research.optional(), standard: z.array(standard).optional() }).optional(),
      agents: z.array(z.object({ slot: z.string(), include: z.boolean().optional(), template_id: z.string().nullable().optional(), bound: z.boolean().optional() })).optional(),
      start_when_set_up: z.boolean().optional(), confirm_root_write: z.boolean().optional(),
      // The owner of the agents the approval creates (docs/authorization.md#agent-owners); omitted: unowned.
      owner_id: z.string().min(1).max(100).nullable().optional(),
    }), req);
    return ob.approve(idOf(req), b as ApproveIn, actor(req)); // research records: checked field by field by the request rules
  });
  api.post('/api/onboarding/:id/needs-changes', async (req) => ob.needsChanges(idOf(req), body(z.object({ note: z.string().min(1).max(500) }), req).note, actor(req)));
  api.post('/api/onboarding/:id/deny', async (req) => ob.deny(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)));
  api.post('/api/onboarding/:id/cancel', async (req) => ob.cancel(idOf(req), body(z.object({ note: z.string().max(500).nullable().optional() }), req).note ?? null, actor(req)));
  api.post('/api/onboarding/:id/reissue-pickup', async (req) => ob.reissuePickup(idOf(req), actor(req)));
  // The operator sets a team's source after setup, on its Setup card (docs/onboarding.md#setup-progress); checked like the request's.
  api.put('/api/onboarding/:id/source', async (req) => ({ setup: ob.setSource(idOf(req), body(z.object({ source: z.unknown() }).strict(), req).source, actor(req)) }));

  api.put('/api/keys/:id/onboarding', async (req) => ({ key: keys.setOnboarding(idOf(req), true, actor(req)) }));
  api.delete('/api/keys/:id/onboarding', async (req) => ({ key: keys.setOnboarding(idOf(req), false, actor(req)) }));
}
