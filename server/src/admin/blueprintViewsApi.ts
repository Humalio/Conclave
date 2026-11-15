/**
 * Saved Blueprint views (docs/dashboard-ux.md, "List analysis"): per user, kept in the hub's per-user settings
 * (`blueprint.views:<user id>` in system_settings) as Home's pinned teams are. No table, no migration.
 *
 * A view holds the filters of one section list and nothing else: never a count or an item. Every value is a closed word
 * (a dimension id, a stored value, a team id, a gap id); the only free text is the search `q` and the view's own name,
 * and the name never enters a link. Views are re-read through the viewer's grants, so a view of a project the user no
 * longer sees is gone from the list. They are not part of any export, and the demo reset removes them with the members.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { KeyError } from '../keys/keys.js';
import { DIM_IDS, GAP_IDS } from '../blueprint/facets.js';

/** At most this many views per section for one user. */
export const MAX_VIEWS_PER_SECTION = 20;
const SECTIONS = [1, 2, 3, 4, 5, 6] as const;
const SORTS = ['risk', 'old', 'name'] as const;
const SELECTIONS = ['open', 'live', 'dropped', 'month', 'all', 'decide', 'risk'] as const;
/** A stored value: letters, digits and the few marks keys and slugs use. No spaces, commas, bars, `&`, `=`, `*` or `:`. */
const WORD = /^[A-Za-z0-9_.\-/]{1,80}$/;
const dim = z.enum(DIM_IDS as [string, ...string[]]);
const filterWord = z.string().max(100).refine((s) => {
  const i = s.indexOf(':');
  return i > 0 && (DIM_IDS as string[]).includes(s.slice(0, i)) && WORD.test(s.slice(i + 1));
}, 'a filter is dimension:value, with a stored value');

/** What a view keeps: the filters, the gap, the table's axes, the group and the sort. */
const filters = {
  q: z.string().max(200).optional(),
  /** The list as the route writes it: kinds and statuses in one comma-joined word list. */
  kind: z.string().regex(/^[a-z_]{1,20}(,[a-z_]{1,20}){0,19}$/).optional(),
  status: z.string().regex(WORD).optional(),
  sel: z.enum(SELECTIONS).optional(),
  team: z.string().regex(WORD).max(100).optional(),
  f: z.array(filterWord).max(16).optional(),
  gap: z.enum(GAP_IDS as [string, ...string[]]).optional(),
  /** The count table's axes as the route writes them (rows*columns), or - when it is hidden. */
  x: z.string().refine((s) => s === '-' || (s.split('*').length === 2 && s.split('*').every((d) => (DIM_IDS as string[]).includes(d))), 'x is rows*columns, or -').optional(),
  g: dim.optional(),
  s: z.enum(SORTS).optional(),
};
const viewIn = z.object({
  id: z.string().regex(/^bv_[a-f0-9]{12}$/).optional(),
  project_id: z.string().min(1).max(100),
  section: z.union(SECTIONS.map((n) => z.literal(n)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>]),
  name: z.string().trim().min(1).max(60),
  pinned: z.boolean().optional(),
  /** What a list answered: read again from the stored view, never taken from the client. */
  created_at: z.number().optional(),
  ...filters,
}).strict();
const putIn = z.object({ views: z.array(viewIn).max(SECTIONS.length * MAX_VIEWS_PER_SECTION) }).strict();

export interface SavedView {
  id: string; project_id: string; section: number; name: string; pinned: boolean; created_at: number;
  q?: string; kind?: string; status?: string; sel?: string; team?: string; f?: string[]; gap?: string;
  x?: string; g?: string; s?: string;
}

const key = (req: FastifyRequest) => `blueprint.views:${req.admin!.id}`;

/** The stored list, as far as it still reads: a damaged value gives no views rather than an error. */
function readStored(db: Db, k: string): SavedView[] {
  const row = db.prepare('SELECT value FROM system_settings WHERE key=?').get(k) as { value: string } | undefined;
  let v: unknown = [];
  try { v = row ? JSON.parse(row.value) : []; } catch { /* unreadable: no views */ }
  return Array.isArray(v) ? v.filter((x): x is SavedView => !!x && typeof x === 'object' && typeof (x as SavedView).id === 'string' && typeof (x as SavedView).project_id === 'string') : [];
}

/** Pinned first, then the order they were kept in. */
const ordered = (vs: SavedView[]): SavedView[] => [...vs.filter((v) => v.pinned), ...vs.filter((v) => !v.pinned)];

export function registerBlueprintViewsApi(api: FastifyInstance, d: { db: Db; sees: (req: FastifyRequest, projectId: string) => boolean }): void {
  const { db } = d;
  /** The views of this user that name a project they still read. */
  const visible = (req: FastifyRequest): SavedView[] => ordered(readStored(db, key(req)).filter((v) => d.sees(req, v.project_id)));

  api.get('/api/blueprint/views', async (req) => {
    const q = z.object({ project: z.string().max(100).optional(), section: z.coerce.number().int().min(1).max(6).optional() }).strict().parse(req.query ?? {});
    return { views: visible(req).filter((v) => (!q.project || v.project_id === q.project) && (!q.section || v.section === q.section)), max_per_section: MAX_VIEWS_PER_SECTION };
  });

  // The user's whole list, in the order they want it (pinned views still list first). A view that names a project the
  // user cannot read is refused like an unknown project.
  api.put('/api/blueprint/views', async (req) => {
    const b = putIn.parse(req.body ?? {});
    const now = Date.now();
    const old = new Map(readStored(db, key(req)).map((v) => [v.id, v]));
    const out: SavedView[] = [];
    for (const v of b.views) {
      if (!d.sees(req, v.project_id)) throw new KeyError('invalid_argument', 'views: no such project');
      const { id, pinned, created_at: _kept, ...rest } = v;
      out.push({ ...rest, id: id ?? `bv_${randomBytes(6).toString('hex')}`, pinned: !!pinned, created_at: (id && old.get(id)?.created_at) || now } as SavedView);
    }
    const ids = new Set<string>();
    for (const v of out) { if (ids.has(v.id)) throw new KeyError('invalid_argument', 'views: the same view twice'); ids.add(v.id); }
    for (const s of SECTIONS) {
      if (out.filter((v) => v.section === s).length > MAX_VIEWS_PER_SECTION) throw new KeyError('invalid_argument', `views: at most ${MAX_VIEWS_PER_SECTION} per section`);
    }
    db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key(req), JSON.stringify(out), now);
    return { views: ordered(out), max_per_section: MAX_VIEWS_PER_SECTION };
  });
}
