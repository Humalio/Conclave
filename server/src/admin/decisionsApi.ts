/** Admin routes for decisions (docs/decisions.md): the operator's open questions, answers, and each team's decision log. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { isAdmin } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { Decisions, DecisionView } from '../teams/decisions.js';
import type { Teams } from '../teams/teams.js';
import type { Vault } from '../vault/vault.js';
import type { Db } from '../db/db.js';
import type { Routing } from './routing.js';
import { adminOnly } from './scopes.js';
import { MIRROR_FOLDER, inMirrorFolder } from '../mirror/folder.js';

export interface DecisionsApiDeps { db: Db; decisions: Decisions; teams: Teams; vault: Vault; routing?: Routing }

export function registerDecisionsApi(api: FastifyInstance, d: DecisionsApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { decisions } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  /** The admin's own acts; a member gets the scope hook's answer. */
  const admin = (req: FastifyRequest) => { const a = actor(req); if (!isAdmin(a)) throw adminOnly(); return a as Actor & { kind: 'admin' }; };
  /** Teams whose questions a member sees: granted with tasks, plus the teams they decide for (routed items, §2). */
  const seen = (req: FastifyRequest) => [...new Set([...req.member!.teams('tasks'), ...(d.routing?.decidesFor(req.member!.userId) ?? [])])];
  /**
   * A question as a member sees it (§1.4): no key id, and whoever answered (the admin or a decider) shows as plain
   * `operator`, never a console user id or username.
   */
  const out = (req: FastifyRequest, q: DecisionView): DecisionView => (req.member
    ? { ...q, credential_id: null, answered_by: q.answered_by ? 'operator' : null, answered_by_name: q.answered_by ? 'operator' : null }
    : q);
  /** The actor for an act on a question: the admin (with via when the team has deciders), or one of the team's active deciders. */
  const decider = (req: FastifyRequest): Actor & { kind: 'admin' } => {
    if (!d.routing) return admin(req);
    const q = decisions.get(idOf(req));
    return d.routing.act(req.member ? actor(req) : admin(req), req.member, q.team_id, 'decision not found') as Actor & { kind: 'admin' };
  };

  api.get('/api/decisions', async (req) => {
    const q = z.object({ team: z.string().max(100).optional(), status: z.enum(['open', 'closed', 'all']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query ?? {});
    // Members: questions of teams in granted projects with tasks, filtered before the limit (§2), plus the teams they decide for.
    return { decisions: decisions.list(req.member ? { ...q, teams: seen(req) } : q).map((x) => out(req, x)) };
  });
  /** For the Work badge and the team list: open questions in all, and per team. */
  api.get('/api/decisions/counts', async (req) => {
    const all = decisions.openCounts(), vis = req.member ? new Set(seen(req)) : null;
    const by = vis ? Object.fromEntries(Object.entries(all).filter(([t]) => vis.has(t))) : all;
    return { open: Object.values(by).reduce((a, b) => a + b, 0), by_team: by };
  });
  api.get('/api/decisions/:id', async (req) => {
    const d = decisions.get(idOf(req));
    if (req.member && !seen(req).includes(d.team_id)) throw new KeyError('not_found', 'decision not found');
    return { decision: out(req, d) };
  });
  api.post('/api/decisions/:id/answer', async (req) => {
    const b = body(z.object({ option: z.string().max(8).nullable().optional(), text: z.string().max(4000).nullable().optional() }), req);
    return { decision: out(req, await decisions.answer(idOf(req), b, decider(req))) };
  });
  /** A relayed answer (recorded by the coordinator, L1): confirm it as the operator's, or overturn it with another answer. */
  api.post('/api/decisions/:id/confirm', async (req) => ({ decision: out(req, await decisions.confirmRelay(idOf(req), decider(req))) }));
  api.post('/api/decisions/:id/overturn', async (req) => {
    const b = body(z.object({ option: z.string().max(8).nullable().optional(), text: z.string().max(4000).nullable().optional() }), req);
    return { decision: out(req, await decisions.overturnRelay(idOf(req), b, decider(req))) };
  });
  api.post('/api/decisions/:id/more-info', async (req) => ({ decision: out(req, decisions.needInfo(idOf(req), body(z.object({ note: z.string().min(1).max(2000) }), req).note, decider(req))) }));
  api.post('/api/decisions/:id/decline', async (req) => ({ decision: out(req, await decisions.decline(idOf(req), body(z.object({ note: z.string().max(2000).nullable().optional() }), req).note ?? null, decider(req))) }));
  /** The vault note answered decisions are also appended to, or null for none. */
  api.put('/api/teams/:id/decision-log', async (req) => {
    const t = d.teams.mustTeam(idOf(req));
    const { path } = body(z.object({ path: z.string().max(1024).nullable() }), req);
    let norm: string | null = null;
    if (path && path.trim()) {
      const n = d.vault.normalise(path.trim());
      if (!/\.md$/i.test(n.path)) throw new KeyError('invalid_argument', 'The decision log must be a Markdown note (.md).');
      // The hub writes 99 Conclave/ itself (its Decisions.md included): two hub writers never share one file.
      if (inMirrorFolder(n.rel.join('/'))) throw new KeyError('invalid_argument', `The decision log cannot be in ${MIRROR_FOLDER}/: the hub writes that folder itself. Choose a note in the project folder.`);
      norm = n.path;
    }
    d.db.prepare('UPDATE teams SET decision_log_path=?, updated_at=? WHERE id=?').run(norm, Date.now(), t.id);
    return { team: d.teams.view(d.teams.mustTeam(t.id)) };
  });
}
