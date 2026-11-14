/**
 * Admin routes of the Project Blueprint (docs/blueprint.md §6), behind the /api cookie and CSRF hook, bounded
 * and paged; the operator writes as `operator` and is never held by lockdown or pause. Members (docs/multi-user.md)
 * read granted projects only, and a team's decider decides the proposals routed to that team and takes the
 * operator acts of its part (bpRouting.ts); the rest stays admin-only. The import route is the docs import (§8).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Actor } from '../audit/audit.js';
import { Audit, isAdmin } from '../audit/audit.js';
import { KeyError } from '../keys/keys.js';
import { adminOnly } from './scopes.js';
import { Blueprint, type BpActor, type Item, type Op } from '../blueprint/blueprint.js';
import { statusMeanings, MEANING_KINDS } from '../blueprint/blueprint.js';
import { BlueprintViews } from '../blueprint/views.js';
import { browse, itemActions, BROWSE_MAX } from '../blueprint/browse.js';
import { BlueprintArchive } from '../blueprint/archive.js';
import { citedSources, issueText } from '../blueprint/plain.js';
import type { Sources, Source } from '../blueprint/sources.js';
import type { Meetings } from '../blueprint/meetings.js';
import { questions, QUESTION_STATUS } from '../blueprint/questions.js';
import { DEFAULT_LIMITS, LIMIT_SETTINGS, MAX_OPS, MAX_BODY, type BpLimits } from '../blueprint/kinds.js';
import { MAX_RESTORE_TEXT } from '../blueprint/restore.js';
import { parseSystems, refsOf, refUrl, SYSTEMS_MAX, TEMPLATE_MAX } from '../blueprint/external.js';
import type { Routing } from './routing.js';
import type { BpRouting } from './bpRouting.js';
import { Keywords } from '../teams/keywords.js';

export interface BlueprintApiDeps { db: Db; blueprint: Blueprint; routing?: Routing; bpRouting?: BpRouting; sources?: Sources; meetings?: Meetings }

const SETTINGS_KEY = 'blueprint_limits';

const asApi = (l: BpLimits) => Object.fromEntries(Object.entries(LIMIT_SETTINGS).map(([k, s]) => [k, l[s.key]]));
/** The stored limits (API names), or {} when the operator never changed them. */
function stored(db: Db): Record<string, number> {
  const r = db.prepare('SELECT value FROM system_settings WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined;
  try { const v = r ? JSON.parse(r.value) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const toService = (api: Record<string, number>): Partial<BpLimits> => {
  const out: Partial<BpLimits> = {};
  for (const [k, v] of Object.entries(api)) { const s = LIMIT_SETTINGS[k]; if (s && Number.isInteger(v) && v >= 1 && v <= s.max) out[s.key] = v; }
  return out;
};
/** At start: the operator's limits over the defaults. */
export function loadBlueprintLimits(db: Db, bp: Blueprint): void { bp.setLimits(toService(stored(db))); }

const limitsBody = z.object(Object.fromEntries(Object.entries(LIMIT_SETTINGS).map(([k, s]) => [k, z.number().int().min(1).max(s.max).nullable().optional()]))).strict();
const opSchema = z.union([
  z.object({ op: z.literal('upsert'), kind: z.string().max(20), key: z.string().min(1).max(60), parent_key: z.string().max(60).nullable().optional(), title: z.string().max(400).optional(),
    body: z.string().max(MAX_BODY).nullable().optional(), fields: z.record(z.string(), z.unknown()).optional(), status: z.string().max(20).nullable().optional(), team_id: z.string().max(100).nullable().optional(),
    position: z.number().int().min(0).max(1_000_000).optional() }).strict(),
  z.object({ op: z.literal('remove'), key: z.string().min(1).max(60) }).strict(),
  z.object({ op: z.enum(['link', 'unlink']), from: z.string().min(1).max(60), to: z.string().min(1).max(60), rel: z.string().max(20) }).strict(),
  z.object({ op: z.literal('move'), key: z.string().min(1).max(60), parent_key: z.string().max(60).nullable().optional(), position: z.number().int().min(0).max(1_000_000).optional() }).strict(),
]);
/**
 * Opaque cursors (F-25): a list answers `next_cursor` and takes it back as `cursor`; its content is the hub's business and
 * a cursor from another list is refused. Leaving `limit` out gives a full page (bp_read's 100 for the blueprint).
 */
const cursorOf = (list: string, at: number | null): string | null => (at === null ? null : Buffer.from(`${list}:${at}`).toString('base64url'));
const cursorIn = (list: string) => z.string().max(100).optional().transform((s, ctx) => {
  if (s === undefined) return undefined;
  const m = /^([a-z]+):(\d{1,9})$/.exec(Buffer.from(s, 'base64url').toString());
  if (!m || m[1] !== list) { ctx.addIssue({ code: 'custom', message: 'cursor is a next_cursor from this list' }); return z.NEVER; }
  return Number(m[2]);
});
const list = (max: number) => z.string().max(max * 24).optional().transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, max) : undefined));

export function registerBlueprintApi(api: FastifyInstance, d: BlueprintApiDeps, actor: (req: FastifyRequest) => Actor): void {
  const { db, blueprint: bp } = d;
  const views = new BlueprintViews(db, bp);
  const archiver = new BlueprintArchive(db, bp);
  // Audit only inserts into the append-only table, so an instance over the same db records exactly like the hub's.
  const audit = new Audit(db);
  const K = new Keywords(db);
  // Console user ids in answers to members (item and revision labels, a proposal's decided_by) are replaced by plain
  // `operator` for every /api route, by the hook in api.ts.
  const op = (req: FastifyRequest): BpActor => { const a = actor(req); if (!isAdmin(a)) throw adminOnly(); return { kind: 'operator', id: a.id }; };
  const params = (req: FastifyRequest) => req.params as { id: string; key?: string };
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  // A member reads only projects granted with `blueprint`; any other answers exactly like an unknown id (docs/multi-user.md).
  const project = (req: FastifyRequest) => {
    const p = views.mustProject(params(req).id);
    if (req.member && !req.member.has(p.id, 'blueprint')) throw new KeyError('not_found', 'No such project.');
    return p;
  };
  const pref = (p: { id: string; key: string; name: string }) => ({ id: p.id, key: p.key, name: p.name });
  /**
   * The actor of a routed act on a team's part: an active decider of that team acts with `via: decider`; a
   * member who can see the item but does not decide for it gets 403 not_decider; anything else answers like an unknown
   * id. The admin acts always, recorded `admin_override` or `admin_fallback` when the team has deciders.
   */
  const routed = (req: FastifyRequest, teamId: string | null, visible: boolean, notFound: string): Actor => {
    const a = actor(req);
    if (!req.member) return d.routing ? d.routing.act(a, undefined, teamId) : a;
    if (teamId && d.routing?.isDecider(req.member.userId, teamId)) return { ...a, via: { via: 'decider', team: teamId } };
    if (visible) throw new KeyError('not_decider', 'Only a decider of this team can do this; the admin decides the rest.');
    throw new KeyError('not_found', notFound);
  };
  const bpActor = (a: Actor): BpActor => ({ kind: 'operator', id: a.id });

  // ───── projects ─────
  api.get('/api/projects', async (req) => {
    const q = z.object({ status: z.enum(['active', 'paused', 'closed']).optional(), cursor: cursorIn('projects'), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(req.query ?? {});
    const r = views.list({ ...q, limit: q.limit ?? 100, ...(req.member ? { only: new Set(req.member.projects('blueprint')) } : {}) });
    // Keywords are for the operator's console (docs/proposals/team-keywords.md): admins only.
    const pk = req.member ? null : K.allProjects();
    return { ...r, projects: pk ? r.projects.map((p) => ({ ...p, keywords: pk.get(p.id) ?? [], missed_warnings: missedWarnings(p.id) })) : r.projects, next_cursor: cursorOf('projects', r.next_cursor) };
  });
  const kwList = z.array(z.string().max(100)).max(20).optional();
  // Missed milestones show For awareness only where the project switched them on (migration 0123); admins see the setting.
  const missedWarnings = (id: string) => !!(db.prepare('SELECT missed_warnings FROM projects WHERE id=?').get(id) as { missed_warnings: number } | undefined)?.missed_warnings;
  const projectOut = (p: { id: string; external_systems?: string | null; status_meanings?: string }) => ({ ...p, external_systems: parseSystems(p.external_systems), keywords: K.ofProject(p.id), missed_warnings: missedWarnings(p.id), status_meanings: statusMeanings(p) });
  // The operator's outside systems (§3); the service checks names and templates and says what is wrong.
  const systemsIn = z.array(z.object({ system: z.string().max(24), url_template: z.string().max(TEMPLATE_MAX).nullable().optional() }).strict()).max(SYSTEMS_MAX).nullable().optional();
  // What each status means (§3): a sentence per status of fr, nfr and ac; the service checks the statuses and the length.
  const meaningsBody = z.object(Object.fromEntries(MEANING_KINDS.map((k) => [k, z.record(z.string().max(20), z.string().max(1000)).refine((m) => Object.keys(m).length <= 10, 'At most 10 statuses.').optional()]))).strict().optional();
  const setKw = (req: FastifyRequest, id: string, list: string[]) => {
    const before = K.ofProject(id), after = K.setProject(id, list);
    if (before.join('\n') !== after.join('\n')) audit.event(actor(req), 'project.keywords', { kind: 'project', id }, { keywords: after });
  };
  api.post('/api/projects', async (req) => {
    const { keywords, ...b } = body(z.object({ key: z.string().max(8), name: z.string().max(200), kind: z.enum(['implementation', 'research']).optional(), single_team: z.boolean().optional(), parent_id: z.string().max(100).nullable().optional(), keywords: kwList }).strict(), req);
    const a = op(req);
    if (keywords) K.valid(keywords); // refused before the project exists
    const p = bp.createProject(b, a);
    bp.deps.audit?.event(actor(req), 'blueprint.project_create', { kind: 'project', id: p.id }, { key: p.key, kind: p.kind, ...(p.single_team ? { single_team: true } : {}), ...(p.parent_id ? { parent_id: p.parent_id } : {}) });
    if (keywords) setKw(req, p.id, keywords);
    return { project: projectOut(p) };
  });
  api.patch('/api/projects/:id', async (req) => {
    const { keywords, ...b } = body(z.object({ name: z.string().max(200).optional(), kind: z.enum(['implementation', 'research']).optional(), status: z.enum(['active', 'paused', 'closed']).optional(), review_policy: z.enum(['required', 'per_task', 'none']).optional(), task_intake: z.enum(['backlog', 'open']).optional(), member_board: z.boolean().optional(), single_team: z.boolean().optional(), parent_id: z.string().max(100).nullable().optional(), external_systems: systemsIn, keywords: kwList, status_meanings: meaningsBody }).strict(), req);
    const id = project(req).id, a = op(req);
    if (keywords) K.valid(keywords); // refused before anything changes
    const p = bp.updateProject(id, b, a);
    if (keywords) setKw(req, id, keywords);
    return { project: projectOut(p) };
  });
  // The known keywords (hub setting): editing the list takes a removed keyword off every project and team.
  const kwOut = () => ({ keywords: K.known(), default: K.defaults(), usage: K.usage() });
  api.get('/api/settings/keywords', async (req) => { op(req); return kwOut(); });
  api.put('/api/settings/keywords', async (req) => {
    op(req);
    const { keywords } = body(z.object({ keywords: z.array(z.string().max(100)).max(50) }).strict(), req);
    const before = K.known(), r = K.setKnown(keywords);
    if (before.join('\n') !== r.keywords.join('\n')) audit.event(actor(req), 'keywords.update', { kind: 'setting', id: 'keywords.known' }, { keywords: r.keywords, removed: r.removed });
    return { ...kwOut(), removed: r.removed };
  });
  api.put('/api/teams/:id/project', async (req) => {
    const b = body(z.object({ project_id: z.string().max(100), owns: z.array(z.string().max(60)).max(200).default([]) }).strict(), req);
    const r = bp.assignTeam(params(req).id, b.project_id, b.owns, op(req));
    return { team_id: params(req).id, project: r.project, project_id: r.project.id, owns: r.owns, released: r.released, moved_from: r.moved_from };
  });

  // ───── reading the blueprint ─────
  api.get('/api/projects/:id/blueprint', async (req) => {
    const q = z.object({
      section: z.coerce.number().int().min(1).max(6).optional(), track: z.string().max(60).optional(), team: z.string().max(100).optional(), kind: list(20), status: list(20),
      q: z.string().max(200).optional(), detail: z.enum(['index', 'full']).optional(), cursor: cursorIn('items'), limit: z.coerce.number().int().min(1).max(100).optional(),
      external: z.string().max(130).optional(),
    }).strict().parse(req.query ?? {});
    const p = project(req);
    if (q.team && q.team !== 'project' && !db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(q.team, p.id)) throw new KeyError('invalid_argument', `Team ${q.team} is not part of project ${p.key}.`);
    const r = bp.read(p.id, null, { scope: 'project', section: q.section, track: q.track, team: q.team, kinds: q.kind, status: q.status, q: q.q, external: q.external, detail: q.detail, cursor: q.cursor, limit: q.limit ?? 100 });
    // Per item, only when there is something: the codes nobody defined and an empty acceptance criterion (§2.3), and every issue in short words (E2).
    const known = bp.glossary(p.id), issues = bp.plainIssues(p.id);
    const items = r.items.map((i) => {
      const row = bp.item(p.id, i.key);
      const undef = row ? bp.plainOf(p.id, row, known).codes.filter((c) => !c.term).map((c) => c.token) : [];
      const ws = issues.get(i.key) ?? [];
      return undef.length || ws.length ? { ...i, plain: { undef, empty_ac: ws.some((w) => w.kind === 'empty_ac'), issues: ws.map(issueText) } } : i;
    });
    // A section's first page carries the counts of its browse list (§6.1: All, Open, Dropped and the statuses it offers),
    // so the console's filter row needs no request of its own.
    const counts = q.section && !q.cursor ? (({ counts: c, statuses }) => ({ counts: c, statuses }))(browse(db, p, { section: q.section, team: q.team, limit: 1 })) : undefined;
    return { ...r, items, next_cursor: cursorOf('items', r.next_cursor), project_id: p.id, ...(counts ? { browse: counts } : {}) };
  });
  // Keys may hold a slash (FR-TEAM-04/AC1, PAP-1/C3): the client encodes it (%2F).
  api.get('/api/projects/:id/items/:key', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    const p = project(req), out = views.detail(p.id, params(req).key!);
    // What this viewer may do with it (§6.1); the route of each action checks it again.
    const di = out['item'] as Omit<Item, 'archived'> & { archived: boolean };
    out['actions'] = itemActions({ ...di, archived: di.archived ? 1 : 0 }, (out['history'] as { revisions: { rev: number; note: string | null; snapshot: Record<string, unknown> }[] }).revisions, !req.member && isAdmin(actor(req)));
    // The tasks that name an item are part of the `tasks` component, and so are a hypothesis's experiment runs. A milestone's
    // progress comes from these counts, so a viewer without the component sees none (§6.1).
    if (req.member && !req.member.has(p.id, 'tasks')) {
      out['tasks'] = { items: [], done: 0, total: 0 };
      if (out['research']) out['research'] = { ...(out['research'] as Record<string, unknown>), runs: [] };
    }
    // Every source the item cites, resolved for this viewer (E4): a member gets missing for anything outside their grant.
    const it = out['item'] as { team_id: string | null; body: string | null; fields: Record<string, unknown>; deleted_at: number | null };
    if (d.sources && !it.deleted_at) out['sources'] = await d.sources.resolve(p.id, it.team_id, citedSources(it), req.member);
    // The note it came from (§2.7): its `source` resolved to a vault note for this viewer, with the note's title and date.
    const from = d.meetings && out['sources'] ? await d.meetings.from(it.fields, out['sources'] as Source[]) : null;
    if (from) out['from'] = from;
    // Outside references (§2.2), each linked only through the operator's URL template for its system.
    const systems = parseSystems(p.external_systems);
    out['external'] = refsOf(it.fields).map((r) => ({ ...r, url: refUrl(r, systems) }));
    return out;
  });
  // The Meetings view (§9): the vault notes live items cite in `source`, newest first; a note this viewer can't read is left out.
  api.get('/api/projects/:id/meetings', async (req) => {
    const q = z.object({ team: z.string().max(100).optional() }).strict().parse(req.query ?? {});
    const p = project(req);
    if (q.team && q.team !== 'project' && !db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(q.team, p.id)) throw new KeyError('invalid_argument', `Team ${q.team} is not part of project ${p.key}.`);
    const notes = d.meetings ? await d.meetings.list(p.id, { team: q.team }, req.member) : [];
    return { notes, items: notes.reduce((n, x) => n + x.items.length, 0), project_id: p.id };
  });
  // The Questions view (§6, §9): the questions of the part or project with what groups them, and the issues that block work.
  api.get('/api/projects/:id/questions', async (req) => {
    const q = z.object({ team: z.string().max(100).optional(), status: z.enum(QUESTION_STATUS).optional() }).strict().parse(req.query ?? {});
    const p = project(req);
    if (q.team && q.team !== 'project' && !db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(q.team, p.id)) throw new KeyError('invalid_argument', `Team ${q.team} is not part of project ${p.key}.`);
    const all = d.blueprint.items(p.id), team = q.team === 'project' ? null : q.team;
    const part = q.team === undefined || q.team === '' ? all : all.filter((i) => i.team_id === team);
    return { ...questions(part, all, d.blueprint.links(p.id), p.kind === 'research', q.status ?? 'open'), project_id: p.id };
  });
  // The research workspace (§6, §9): papers and hypotheses, filtered by milestone or hypothesis with the reason for each
  // match. A manuscript is resolved like a source for this viewer, so a member sees its path only where they may read it.
  api.get('/api/projects/:id/research', async (req) => {
    const key = z.string().min(1).max(60).optional();
    const q = z.object({ team: z.string().max(100).optional(), milestone: key, hypothesis: key }).strict().parse(req.query ?? {});
    const p = project(req);
    if (q.team && q.team !== 'project' && !db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(q.team, p.id)) throw new KeyError('invalid_argument', `Team ${q.team} is not part of project ${p.key}.`);
    const r = views.research(p.id, q);
    const papers = await Promise.all(r.papers.map(async (x) => {
      if (!x.manuscript) return { ...x, manuscript: null };
      const [m] = d.sources ? await d.sources.resolve(p.id, x.team_id, [x.manuscript], req.member) : [];
      // The text is the paper's own field (Blueprint content); only the vault path that opens it is gated.
      return { ...x, manuscript: m ? { text: m.text, where: m.where, ...(m.path ? { path: m.path } : {}) } : { text: x.manuscript, where: 'missing' } };
    }));
    return { ...r, papers, project_id: p.id };
  });
  api.get('/api/projects/:id/items/:key/history', async (req) => {
    const q = z.object({ cursor: cursorIn('history'), limit: z.coerce.number().int().min(1).max(50).optional() }).strict().parse(req.query ?? {});
    const { next, ...r } = views.history(project(req).id, params(req).key!, { before: q.cursor, limit: q.limit ?? 50 });
    return { ...r, next_cursor: cursorOf('history', next) };
  });

  // One page of a Blueprint list (§6.1): the rows, the exact total, the cursors and the filters the hub applied.
  api.get('/api/projects/:id/browse', async (req) => {
    const q = z.object({
      section: z.coerce.number().int().min(1).max(6).optional(), kind: list(20), status: list(20), sel: z.enum(['open', 'live', 'dropped', 'month', 'decide', 'risk']).optional(),
      team: z.string().max(100).optional(), q: z.string().max(200).optional(), cursor: cursorIn('browse'), limit: z.coerce.number().int().min(1).max(BROWSE_MAX).optional(),
    }).strict().parse(req.query ?? {});
    const p = project(req);
    const { next, prev, ...r } = browse(db, p, { section: q.section, kinds: q.kind, status: q.status, sel: q.sel, team: q.team, q: q.q, offset: q.cursor, limit: q.limit });
    // may_archive: whether this viewer may archive what the list shows (the admin only, §6.1); the route checks it again.
    return { ...r, next_cursor: cursorOf('browse', next), prev_cursor: cursorOf('browse', prev), project_id: p.id, may_archive: !req.member && isAdmin(actor(req)) };
  });
  // Archive a dropped item with its subtree, or bring it back (§6.1), one write each. Rights as for any operator write that
  // is not a decider's status move (§1.3): the admin's (op), and the route scope is admin. The kind table decides what may
  // go: only a retired status (RETIRED in kinds.ts), never a status report; archive.ts checks both again in the transaction.
  for (const to of ['archive', 'unarchive'] as const) {
    api.post(`/api/projects/:id/items/:key/${to}`, async (req) => {
      const b = body(z.object({ check: z.boolean().optional(), note: z.string().max(2000).nullable().optional() }).strict(), req);
      const p = project(req), a = op(req);
      const r = archiver.apply(p.id, params(req).key!, to, a, b);
      if (r.done) audit.event(actor(req), `blueprint.${to}`, { kind: 'project', id: p.id }, { key: p.key, item: params(req).key!, items: r.keys.length, version: r.version });
      return { project_id: p.id, ...r };
    });
  }

  // ───── writing, proposals, requests ─────
  api.post('/api/projects/:id/ops', async (req) => {
    const b = body(z.object({ version: z.number().int().min(0), ops: z.array(opSchema).min(1).max(MAX_OPS), note: z.string().max(2000).nullable().optional(), team_id: z.string().max(100).nullable().optional() }).strict(), req);
    const p = project(req), watch = bp.supportWatch(p.id, b.ops as Op[]);
    // A decider writes only the operator acts of §1.3 in their team's part; everything else is the admin's (D2).
    const team = d.bpRouting?.actTeam(p.id, b.ops as Op[], b.team_id) ?? null;
    if (req.member && !team) throw new KeyError('not_decider', 'A decider makes the operator\'s status moves in their team\'s part (agree, drop or reopen a requirement, decide a decision entry, move a paper on), except on items an open re-plan marks; the admin makes every other change.');
    if (!req.member) op(req);
    const who = routed(req, team, true, 'No such project.');
    const r = bp.write(p.id, { version: b.version, ops: b.ops as Op[], note: b.note?.trim() || (req.member ? 'decider' : 'operator'), team_id: b.team_id ?? null }, bpActor(who));
    bp.deps.audit?.event(who, 'blueprint.write', { kind: 'project', id: p.id }, { key: p.key, version: r.version, ops: b.ops.length });
    return { project_id: p.id, ...r, support_changed: watch(r) };
  });
  api.get('/api/projects/:id/proposals', async (req) => {
    const q = z.object({ status: z.enum(['open', 'applied', 'rejected', 'withdrawn', 'stale']).optional(), cursor: cursorIn('proposals'), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(req.query ?? {});
    const p = project(req);
    const limit = q.limit ?? 100, offset = q.cursor ?? 0;
    if (!req.member) { // newest first, paged in SQL
      const r = bp.proposalsPage(p.id, { status: q.status, limit, offset });
      return { project: pref(p), proposals: r.proposals, total: r.total, next_cursor: cursorOf('proposals', offset + limit < r.total ? offset + limit : null) };
    }
    // A decider lists the proposals routed to the teams they decide for now, filtered before paging.
    const mine = new Set(d.routing?.decidesFor(req.member.userId) ?? []);
    const list = mine.size ? bp.proposals(p.id, { status: q.status }) : [];
    const routes = d.bpRouting?.routes(p.id, list) ?? new Map<string, string | null>();
    const all = list.filter((x) => { const t = routes.get(x.id); return !!t && mine.has(t); }).reverse(); // newest first
    return { project: pref(p), proposals: all.slice(offset, offset + limit), total: all.length, next_cursor: cursorOf('proposals', offset + limit < all.length ? offset + limit : null) };
  });
  const decided = (r: { proposal: { project_id: string } }) => ({ project_id: r.proposal.project_id, ...r });
  /**
   * The actor deciding a proposal: routed to the deciders of the team that owns everything it touches (§1.3). A member
   * sees only proposals routed to them, so any other answers like an unknown proposal. Audited with `via`.
   */
  const decider = (req: FastifyRequest): Actor => {
    const pr = bp.proposal(params(req).id);
    if (!req.member) op(req);
    if (!pr) { if (req.member) throw new KeyError('not_found', 'No such proposal.'); return actor(req); }
    if (req.member && !req.member.has(pr.project_id, 'blueprint')) throw new KeyError('not_found', 'No such proposal.');
    return routed(req, d.bpRouting?.proposalTeam(pr) ?? null, false, 'No such proposal.');
  };
  const audited = (who: Actor, what: 'applied' | 'rejected' | 'stale', pr: { id: string; project_id: string }) => {
    if (who.via) bp.deps.audit?.event(who, 'blueprint.proposal_decide', { kind: 'bp_proposal', id: pr.id }, { project: pr.project_id, status: what });
  };
  api.post('/api/proposals/:id/apply', async (req) => {
    const b = body(z.object({ note: z.string().max(2000).nullable().optional() }).strict(), req);
    const who = decider(req), r = bp.applyProposal(params(req).id, bpActor(who), b.note ?? null);
    audited(who, r.proposal.status === 'stale' ? 'stale' : 'applied', r.proposal);
    return decided(r);
  });
  api.post('/api/proposals/:id/reject', async (req) => {
    const b = body(z.object({ note: z.string().max(2000).nullable().optional() }).strict(), req);
    const who = decider(req), pr = bp.rejectProposal(params(req).id, bpActor(who), b.note ?? null);
    audited(who, 'rejected', pr);
    return decided({ proposal: pr });
  });
  api.post('/api/projects/:id/report-request', async (req) => {
    const b = body(z.object({ note: z.string().trim().max(500).optional(), team_id: z.string().max(100).optional() }).strict(), req);
    const p = project(req);
    if (!req.member) op(req);
    // A decider asks their own team for a report on its part; the admin asks one team or every running team.
    if (req.member && !b.team_id) throw new KeyError('invalid_argument', 'Name the team (team_id) whose part you ask a report for.');
    const inProject = !!b.team_id && !!db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(b.team_id, p.id);
    if (b.team_id && !inProject) throw new KeyError(req.member ? 'not_found' : 'invalid_argument', req.member ? 'team not found' : `Team ${b.team_id} is not part of project ${p.key}.`);
    const who = b.team_id ? routed(req, b.team_id, true, 'team not found') : actor(req);
    const r = bp.requestReport(p.id, b.note || null, bpActor(who), { ...(b.team_id ? { teamId: b.team_id } : {}), as: who, ...(req.member ? { by: 'A decider of your team' } : {}) });
    return { project: r.project, project_id: r.project.id, teams: r.teams };
  });

  // ───── start over: re-plans ─────
  const rpParams = (req: FastifyRequest) => req.params as { id: string };
  const withDiff = (id: string) => { const r = bp.replan(id); if (!r) throw new KeyError('not_found', 'No such re-plan.'); return { project_id: r.project_id, replan: r, diff: bp.replanDiff(id) }; };
  api.post('/api/projects/:id/replan', async (req) => {
    const b = body(z.object({ team_id: z.string().max(100).nullable().optional(), kinds: z.array(z.string().max(20)).min(1).max(20).optional(), note: z.string().max(1000).nullable().optional() }).strict(), req);
    const r = bp.startReplan(project(req).id, b, op(req));
    return { project_id: r.replan.project_id, replan: r.replan, reset: r.reset };
  });
  api.get('/api/projects/:id/replans', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    const p = project(req), list = bp.replans(p.id), open = list.filter((r) => r.status === 'open');
    return { project: pref(p), project_id: p.id, replans: list, open: open.map((r) => ({ ...r, diff: bp.replanDiff(r.id) })) };
  });
  api.get('/api/replans/:id', async (req) => { z.object({}).strict().parse(req.query ?? {}); op(req); return withDiff(rpParams(req).id); });
  api.get('/api/replans/:id/snapshot.md', async (req, reply) => {
    op(req);
    const s = bp.replanSnapshot(rpParams(req).id);
    if (!s) throw new KeyError('not_found', 'No such re-plan.');
    const p = bp.project(s.replan.project_id)!;
    return reply.type('text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${p.key}-${s.replan.id}-snapshot.md"`).header('x-project-id', p.id).send(s.text);
  });
  api.post('/api/replans/:id/cancel', async (req) => {
    const b = body(z.object({ note: z.string().max(1000).nullable().optional() }).strict(), req);
    const r = bp.cancelReplan(rpParams(req).id, op(req), b.note ?? null);
    return { project_id: r.replan.project_id, ...r };
  });
  api.post('/api/replans/:id/submit', async (req) => {
    const b = body(z.object({ note: z.string().max(2000).nullable().optional() }).strict(), req);
    const r = bp.submitReplanAsOperator(rpParams(req).id, op(req), b.note ?? null);
    return { project_id: r.replan.project_id, ...r, diff: bp.replanDiff(r.replan.id) };
  });

  // ───── export, summary, Home ─────
  api.get('/api/projects/:id/export.md', async (req, reply) => {
    const q = z.object({ paper: z.string().regex(/^PAP-\d+$/).optional() }).strict().parse(req.query ?? {});
    const p = project(req);
    if (req.member && !req.member.mayExport(p.id)) throw new KeyError('export_denied', 'Exports are not part of your access to this project.');
    const r = views.exportMarkdown(p.id, q.paper);
    // A member's export is audited (docs/multi-user.md §3); the admin's is not.
    if (req.member) audit.event(actor(req), 'export.read', { kind: 'project', id: p.id }, { what: 'blueprint', project_id: p.id, ...(q.paper ? { paper: q.paper } : {}), bytes: Buffer.byteLength(r.text) });
    return reply.type('text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${r.name}"`).header('x-project-id', p.id).send(r.text);
  });
  // The lossless JSON export (blueprint.md §4.2) carries agent and team ids: the admin's alone (scope `admin`), and
  // refused here too should a member ever reach it.
  api.get('/api/projects/:id/export.json', async (req, reply) => {
    z.object({}).strict().parse(req.query ?? {});
    if (!isAdmin(actor(req))) throw adminOnly();
    const p = project(req);
    const r = views.exportJson(p.id);
    return reply.type('application/json; charset=utf-8').header('content-disposition', `attachment; filename="${r.name}"`).header('x-project-id', p.id).send(r.text);
  });
  // Restore from an export in one write (§4.2): the admin's alone; check returns the plan and writes nothing.
  api.post('/api/projects/:id/restore', async (req) => {
    const b = body(z.object({
      text: z.string().min(1).max(MAX_RESTORE_TEXT), team_id: z.string().max(100).nullable().optional(), tracks: z.array(z.string().min(1).max(60)).max(200).optional(),
      remove_missing: z.boolean().optional(), check: z.boolean().optional(), note: z.string().max(2000).nullable().optional(),
      // Applying names the base version the check returned; backup, authors and team_map are for authorship and team remap.
      version: z.number().int().min(0).optional(), backup: z.string().max(124).nullable().optional(),
      authors: z.record(z.string().max(100), z.string().min(1).max(100)).refine((m) => Object.keys(m).length <= 500, 'At most 500 authors.').optional(),
      team_map: z.record(z.string().max(100), z.string().min(1).max(100)).refine((m) => Object.keys(m).length <= 200, 'At most 200 teams.').optional(),
    }).strict(), req);
    const p = project(req), a = op(req);
    const r = bp.restore(p.id, b, a);
    if (r.status === 'applied' && r.result && !r.retried) bp.deps.audit?.event(actor(req), 'blueprint.restore', { kind: 'project', id: p.id }, { key: p.key, version: r.result.version, format: r.plan.format, added: r.plan.added.length, restored: r.plan.restored.length, changed: r.plan.changed.length, removed: r.plan.removed.length, verified: r.plan.authors.verified, l2: r.plan.authors.l2, digest: r.plan.digest, ...(b.backup ? { backup: b.backup } : {}), ...(b.team_id ? { team_id: b.team_id } : {}) });
    const { ops: _ops, ...plan } = r.plan; // the ops can be thousands; the counts are what the operator reviews
    return { project_id: p.id, ...r, plan };
  });
  api.get('/api/projects/:id/summary', async (req) => {
    const q = z.object({ team: z.string().max(100).optional() }).strict().parse(req.query ?? {});
    const p = project(req);
    // Coverage's No task list counts only tasks this viewer may see: a member needs the `tasks` component (§6).
    return views.summary(p.id, q.team, Date.now(), req.member ? { only: new Set(req.member.projects('blueprint')), tasks: req.member.has(p.id, 'tasks') ? 'all' : null } : {});
  });
  // Project settings (docs/blueprint.md §3): what a change of kind changes and keeps, before the save.
  api.get('/api/projects/:id/kind-effects', async (req) => {
    const q = z.object({ kind: z.enum(['implementation', 'research']) }).strict().parse(req.query ?? {});
    op(req);
    return bp.kindEffects(project(req).id, q.kind);
  });
  // Rules (docs/blueprint.md §4 Rules, ADR-006): each team's state of every rule, and the changes they applied. Reading
  // follows the project's grant; turning one on, pausing it or turning it off is the operator's, audited.
  api.get('/api/projects/:id/rules', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    return { rules: bp.rules(project(req).id) };
  });
  api.put('/api/projects/:id/rules', async (req) => {
    const b = body(z.object({ team_id: z.string().min(1).max(100), rule: z.enum(['release_notes']), state: z.enum(['on', 'paused', 'off']) }).strict(), req);
    const a = op(req), p = project(req);
    const r = bp.setRule(p.id, b.team_id, b.rule, b.state, a.id);
    if (r.was !== r.state) audit.event(actor(req), 'blueprint.rule', { kind: 'project', id: p.id }, { team: b.team_id, rule: b.rule, was: r.was, state: r.state });
    return { rule: bp.rules(p.id).find((x) => x.team_id === b.team_id && x.rule === b.rule) };
  });
  api.get('/api/projects/:id/rules/applied', async (req) => {
    const q = z.object({ team_id: z.string().max(100).optional(), since: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict().parse(req.query ?? {});
    const p = project(req);
    return { project: pref(p), changes: bp.appliedByRules(p.id, { ...(q.team_id ? { team: q.team_id } : {}), ...(q.since ? { since: q.since } : {}), ...(q.limit ? { limit: q.limit } : {}) }), rules: bp.rules(p.id).filter((x) => !q.team_id || x.team_id === q.team_id) };
  });
  // An ecosystem's projects, each read only after the viewer's grant on it is checked (docs/multi-user.md).
  api.get('/api/projects/:id/overview', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    const p = project(req);
    return views.overview(p.id, req.member ? { only: new Set(req.member.projects('blueprint')), proposals: new Set((d.bpRouting?.routedTo(req.member.userId) ?? []).map((x) => x.id)) } : {});
  });
  api.get('/api/blueprint/attention', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }).strict().parse(req.query ?? {});
    // A member: granted projects only, and the proposals routed to them.
    const only = req.member ? { projects: new Set(req.member.projects('blueprint')), proposals: new Set((d.bpRouting?.routedTo(req.member.userId) ?? []).map((p) => p.id)) } : undefined;
    return views.attention({ limit: q.limit ?? 50, ...(only ? { only } : {}) });
  });

  // ───── Settings: limits ─────
  api.get('/api/settings/blueprint', async () => ({ limits: asApi(bp.limits), defaults: asApi(DEFAULT_LIMITS), max: Object.fromEntries(Object.entries(LIMIT_SETTINGS).map(([k, s]) => [k, s.max])) }));
  api.put('/api/settings/blueprint', async (req) => {
    const b = body(z.object({ limits: limitsBody }).strict(), req);
    // null resets one limit to its default; a value left out keeps the current one.
    const next: Record<string, number> = { ...stored(db) };
    for (const [k, v] of Object.entries(b.limits)) { if (v === null) delete next[k]; else if (v !== undefined) next[k] = v as number; }
    db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(SETTINGS_KEY, JSON.stringify(next), Date.now());
    bp.setLimits(toService(next));
    // A lowered reports_per_project archives the reports over it now (§6).
    bp.archiveAllReports();
    bp.deps.audit?.event(actor(req), 'blueprint.limits', null, b.limits);
    return { limits: asApi(bp.limits), defaults: asApi(DEFAULT_LIMITS) };
  });
}
