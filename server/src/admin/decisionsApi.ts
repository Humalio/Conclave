/** Admin routes for decisions (docs/decisions.md): the operator's open questions, answers, and each team's decision log. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import type { Decisions } from '../teams/decisions.js';
import type { Teams } from '../teams/teams.js';
import type { Vault } from '../vault/vault.js';
import type { Db } from '../db/db.js';

export interface DecisionsApiDeps { db: Db; decisions: Decisions; teams: Teams; vault: Vault }

export function registerDecisionsApi(api: FastifyInstance, d: DecisionsApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { decisions } = d;
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  const admin = (req: FastifyRequest) => { const a = actor(req); if (a.kind !== 'admin') throw new KeyError('denied', 'administrator only'); return a as Actor & { kind: 'admin' }; };

  api.get('/api/decisions', async (req) => {
    const q = z.object({ team: z.string().max(100).optional(), status: z.enum(['open', 'closed', 'all']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query ?? {});
    return { decisions: decisions.list(q) };
  });
  /** For the Work badge and the team list: open questions in all, and per team. */
  api.get('/api/decisions/counts', async () => { const by = decisions.openCounts(); return { open: Object.values(by).reduce((a, b) => a + b, 0), by_team: by }; });
  api.get('/api/decisions/:id', async (req) => ({ decision: decisions.get(idOf(req)) }));
  api.post('/api/decisions/:id/answer', async (req) => {
    const b = body(z.object({ option: z.string().max(8).nullable().optional(), text: z.string().max(4000).nullable().optional() }), req);
    return { decision: await decisions.answer(idOf(req), b, admin(req)) };
  });
  api.post('/api/decisions/:id/more-info', async (req) => ({ decision: decisions.needInfo(idOf(req), body(z.object({ note: z.string().min(1).max(2000) }), req).note, actor(req)) }));
  api.post('/api/decisions/:id/decline', async (req) => ({ decision: await decisions.decline(idOf(req), body(z.object({ note: z.string().max(2000).nullable().optional() }), req).note ?? null, actor(req)) }));
  /** The vault note answered decisions are also appended to, or null for none. */
  api.put('/api/teams/:id/decision-log', async (req) => {
    const t = d.teams.mustTeam(idOf(req));
    const { path } = body(z.object({ path: z.string().max(1024).nullable() }), req);
    let norm: string | null = null;
    if (path && path.trim()) {
      const n = d.vault.normalise(path.trim());
      if (!/\.md$/i.test(n.path)) throw new KeyError('invalid_argument', 'The decision log must be a Markdown note (.md).');
      norm = n.path;
    }
    d.db.prepare('UPDATE teams SET decision_log_path=?, updated_at=? WHERE id=?').run(norm, Date.now(), t.id);
    return { team: d.teams.view(d.teams.mustTeam(t.id)) };
  });
}
