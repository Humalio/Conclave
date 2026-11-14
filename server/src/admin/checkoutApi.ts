/**
 * Admin routes for checkouts (docs/checkout.md §7). Only the administrator starts, renders, approves and cancels: a
 * checkout creates keys. Pickup, confirm and status are the existing /onboard routes of the checkout's request.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import type { Checkouts } from '../checkout/checkout.js';
import type { CheckoutKeys } from '../checkout/render.js';
import { LEFTOVER_KINDS, DEFAULT_REPO_HOSTS, REPO_HOSTS_MAX } from '../checkout/fields.js';
import type { Teams } from '../teams/teams.js';
import { checkoutStep, type CheckoutStep } from '../checkout/step.js';

export interface CheckoutApiDeps { checkouts: Checkouts; checkoutKeys: CheckoutKeys; teams?: Teams; label?: (agentId: string) => string }

const agentChoice = z.object({ provider: z.string().optional(), model: z.string().nullable().optional(), permissions: z.string().optional() }).strict();
const renderBody = z.object({
  target: z.string(), machine_id: z.string().nullable().optional(), new_pc_name: z.string().nullable().optional(),
  rotate_agent_keys: z.boolean().optional(), accept_unmerged_work: z.boolean().optional(), agents: z.record(z.string(), agentChoice).optional(),
}).strict();

export function registerCheckoutApi(api: FastifyInstance, d: CheckoutApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { checkouts: co, checkoutKeys: ck } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  /* A new PC that enrolled and shows its name and address: only the operator's approval releases its keys. */
  const pcWaits = (c: { id: string; status: string; rendered_at: number | null; updated_at: number }) => {
    if (c.status !== 'rendered' || !(co.view(c.id).choices as { new_pc?: boolean } | null)?.new_pc) return null;
    const g = ck.details(c.id).target, e = g?.enrolment;
    return g?.new_pc && g.approval === 'waiting' && e && (e.status === 'issued' || e.status === 'confirmed')
      ? { pc: g.pc ? { id: g.pc.id, name: g.pc.name } : null, enrolled_from: e.enrolled_from ?? null, at: e.used_at ?? c.rendered_at ?? c.updated_at } : null;
  };
  /* The current step in one sentence, with the operator's one action or who acts next (checkout/step.ts). */
  const stepOf = (id: string): CheckoutStep => {
    const v = co.view(id), pc = pcWaits(co.mustCheckout(id));
    return checkoutStep({ status: v.status, approvePc: pc ? { name: pc.pc?.name ?? null } : null, label: (a) => d.label?.(a) ?? a,
      handouts: v.handouts.map((h) => ({ agent_id: h.agent_id, status: h.status, waiting: h.status === 'merged' ? ((h.report as { leftovers?: { approved?: boolean; refused?: unknown }[] } | null)?.leftovers ?? []).filter((l) => !l.approved && !l.refused).length : 0 })) });
  };
  const full = (id: string) => ({ checkout: { ...co.view(id), step: stepOf(id) }, ...ck.details(id) });

  api.post('/api/teams/:id/checkout', async (req) => full(co.start(idOf(req), actor(req)).id));
  api.get('/api/teams/:id/checkout', async (req) => { const c = co.openFor(idOf(req)); return c ? full(c.id) : { checkout: null }; });
  // Attention (§7): open checkouts with the steps that wait on the operator (needs_operator); without open=1, the latest 50.
  api.get('/api/checkouts', async (req) => {
    const q = req.query as { open?: string; limit?: string };
    const open = q.open === '1' || q.open === 'true';
    const now = co.now();
    return { checkouts: co.list({ open, limit: Math.trunc(Number(q.limit)) || 50 }).map((c) => {
      const t = d.teams?.team(c.team_id);
      const H = co.handouts(c.id);
      const needs = (open || ['collecting', 'ready', 'rendered', 'restoring'].includes(c.status)) ? co.needsOperator(c, now) : [];
      const pc = pcWaits(c);
      if (pc) needs.push({ kind: 'approve_pc', ...pc });
      return { id: c.id, team_id: c.team_id, team: t?.name ?? null, status: c.status, created_at: c.created_at, expires_at: c.expires_at, overdue_at: c.overdue_at,
        handouts: { total: H.length, written: H.filter((h) => h.status === 'written' || h.status === 'consumed').length }, needs_operator: needs, step: stepOf(c.id) };
    }) };
  });
  // The repo host allowlist (§8): the hosts a handout's repo URL may name, checked at checkout_handout and again at render.
  const hostsOut = () => ({ ...co.repoHosts(), default: DEFAULT_REPO_HOSTS, max: REPO_HOSTS_MAX });
  api.get('/api/settings/checkout', async () => ({ settings: hostsOut() }));
  api.put('/api/settings/checkout', async (req) => {
    const b = body(z.object({ repo_hosts: z.array(z.string().max(253)).max(REPO_HOSTS_MAX) }).strict(), req);
    co.setRepoHosts(b.repo_hosts, actor(req));
    return { settings: hostsOut() };
  });
  api.get('/api/checkouts/:id', async (req) => full(idOf(req)));
  api.post('/api/checkouts/:id/proceed', async (req) => { co.proceed(idOf(req), actor(req)); return full(idOf(req)); });
  // The leftover check (§4 step 4): the operator approves an agent's exceptions (all, or the named items), or refuses them
  // with a note so the agent cleans up and reports again. The agent gets a notice either way. report_sha256 ties the
  // decision to the report the operator saw (the view's report_sha256): a newer report is refused with conflict.
  const items = z.array(z.object({ kind: z.enum(LEFTOVER_KINDS), item: z.string().min(1).max(300) }).strict()).min(1).max(300).optional();
  const reportSha256 = z.string().regex(/^[0-9a-f]{64}$/);
  api.post('/api/checkouts/:id/leftovers/:agent/approve', async (req) => {
    const p = req.params as { id: string; agent: string };
    const b = body(z.object({ report_sha256: reportSha256, items }).strict(), req);
    co.approveLeftovers(p.id, p.agent, b.report_sha256, actor(req), b.items);
    return full(p.id);
  });
  api.post('/api/checkouts/:id/leftovers/:agent/refuse', async (req) => {
    const p = req.params as { id: string; agent: string };
    const b = body(z.object({ report_sha256: reportSha256, note: z.string().min(1).max(500), items }).strict(), req);
    co.refuseLeftovers(p.id, p.agent, b.report_sha256, b.note, actor(req), b.items);
    return full(p.id);
  });
  // The prompt (and a code, for another user or a new PC) appears only in this response.
  api.post('/api/checkouts/:id/render', async (req) => {
    const r = ck.render(idOf(req), body(renderBody, req), actor(req));
    return { ...full(idOf(req)), prompt: r.prompt, approval_needed: r.approval_needed };
  });
  api.post('/api/checkouts/:id/approve-pc', async (req) => { ck.approvePc(idOf(req), actor(req)); return full(idOf(req)); });
  // The restore's config scan (§6 step 4): per folder, approve the findings (the restore may trust it) or leave it untrusted.
  // findings_sha256 ties the decision to the findings the operator saw: a newer report is refused with conflict.
  api.post('/api/checkouts/:id/scan/:folder', async (req) => {
    const p = req.params as { id: string; folder: string };
    const b = body(z.object({ decision: z.enum(['approve', 'leave_untrusted']), findings_sha256: reportSha256 }).strict(), req);
    ck.decideScan(p.id, p.folder, b.decision, b.findings_sha256, actor(req));
    return full(p.id);
  });
  api.post('/api/checkouts/:id/cancel', async (req) => {
    const b = body(z.object({ note: z.string().max(500).nullable().optional(), force: z.boolean().optional() }), req);
    co.cancel(idOf(req), b.note ?? null, actor(req), { force: b.force });
    return full(idOf(req));
  });
  api.post('/api/checkouts/:id/finish', async (req) => { co.finish(idOf(req), actor(req)); return full(idOf(req)); });
}
