/**
 * List analysis for Blueprint browse (docs/blueprint.md §6.1): the dimensions a list can be grouped and filtered by, and
 * the gaps, the named selections that say what is missing. Values come from stored fields and links only, never from text.
 * The per-item values are kept per project version, task state and viewer scope, so a browse is one pass over the project.
 */
import type { Db } from '../db/db.js';
import { KINDS, isOpen, milestoneLate } from './kinds.js';
import type { Item, LinkRow } from './blueprint.js';
import { COVERAGE_TESTS, GAP_LISTS, GAP_NAMES, coverageSets, type CoverageSets, type TasksSeen } from './coverage.js';

const DAY = 86_400_000;
const REQ = ['fr', 'nfr'] as const;
/** The value of a multi-valued or optional dimension for an item without one ("No milestone"). */
export const NONE = 'none';

export type GapId = (typeof GAP_LISTS)[number] | 'unclear' | 'stale' | 'unlinked' | 'late' | 'no_owner' | 'no_change';
export interface GapSelection { id: GapId; label: string; rule: string; kinds: readonly string[] }
const OPEN_KINDS = ['fr', 'nfr', 'ac', 'line', 'hypothesis', 'question', 'decision', 'paper', 'claim', 'milestone', 'release', 'risk', 'issue'] as const;
/** The gaps, one named selection each. The first six are Coverage's own lists and read its functions (coverage.ts). */
export const GAPS: Readonly<Record<GapId, GapSelection>> = {
  no_ac: { id: 'no_ac', label: GAP_NAMES.no_ac, rule: 'Requirements not dropped that have no acceptance criterion.', kinds: REQ },
  no_milestone: { id: 'no_milestone', label: GAP_NAMES.no_milestone, rule: 'Agreed or built requirements that no milestone (not dropped) delivers.', kinds: REQ },
  no_task: { id: 'no_task', label: GAP_NAMES.no_task, rule: 'Agreed requirements that no counted task names in its refs.', kinds: REQ },
  passing_no_evidence: { id: 'passing_no_evidence', label: GAP_NAMES.passing_no_evidence, rule: 'Passing acceptance criteria with no evidence.', kinds: ['ac'] },
  decisions_govern_nothing: { id: 'decisions_govern_nothing', label: GAP_NAMES.decisions_govern_nothing, rule: 'Accepted decisions that govern nothing.', kinds: ['decision'] },
  old_questions: { id: 'old_questions', label: GAP_NAMES.old_questions, rule: 'Open questions asked more than 14 days ago.', kinds: ['question'] },
  unclear: { id: 'unclear', label: 'Unclear', rule: 'Requirements not dropped that are marked unclear.', kinds: REQ },
  stale: { id: 'stale', label: 'Stale', rule: 'Hypotheses testing whose last linked finding, or the hypothesis itself when none is linked, is more than 30 days old.', kinds: ['hypothesis'] },
  unlinked: { id: 'unlinked', label: 'Linked to nothing', rule: 'Findings that are evidence for nothing.', kinds: ['finding'] },
  late: { id: 'late', label: 'Late', rule: 'Milestones missed, or planned or in progress past their target date.', kinds: ['milestone'] },
  no_owner: { id: 'no_owner', label: 'No owner', rule: 'Open risks and issues with no owner.', kinds: ['risk', 'issue'] },
  no_change: { id: 'no_change', label: 'No change in 30 days', rule: 'Open items not changed in the last 30 days.', kinds: OPEN_KINDS },
};
export const GAP_IDS = Object.keys(GAPS) as GapId[];

export type DimId = 'status' | 'team' | 'kind' | 'priority' | 'area' | 'milestone' | 'task' | 'line' | 'paper' | 'confidence' | 'week' | 'linked' | 'phase' | 'likelihood' | 'impact' | 'owner';
interface DimSpec { label: string; kinds: readonly string[]; multi?: boolean; tasks?: boolean; order?: readonly string[] }
const LMH = ['high', 'medium', 'low'];
const STATUS_KINDS = Object.keys(KINDS).filter((k) => KINDS[k]!.statuses?.length);
export const DIMS: Readonly<Record<DimId, DimSpec>> = {
  status: { label: 'Status', kinds: STATUS_KINDS },
  team: { label: 'Team', kinds: Object.keys(KINDS) },
  kind: { label: 'Kind', kinds: Object.keys(KINDS) },
  priority: { label: 'Priority', kinds: REQ, order: ['must', 'should', 'could'] },
  area: { label: 'Area', kinds: ['fr', 'nfr', 'ac'] },
  milestone: { label: 'Milestone', kinds: ['fr', 'nfr', 'hypothesis', 'paper', 'risk', 'issue'], multi: true },
  task: { label: 'Task', kinds: REQ, tasks: true, order: ['has'] },
  line: { label: 'Line', kinds: ['hypothesis', 'finding'] },
  paper: { label: 'Paper', kinds: ['hypothesis'], multi: true },
  confidence: { label: 'Confidence', kinds: ['finding'], order: LMH },
  week: { label: 'Week', kinds: ['finding'] },
  linked: { label: 'Linked', kinds: ['finding'], order: ['yes'] },
  phase: { label: 'Phase', kinds: ['milestone'] },
  likelihood: { label: 'Likelihood', kinds: ['risk'], order: LMH },
  impact: { label: 'Impact', kinds: ['risk', 'issue'], order: LMH },
  owner: { label: 'Owner', kinds: ['risk', 'issue'] },
};
export const DIM_IDS = Object.keys(DIMS) as DimId[];
/** Why a part of the analysis is left out for this viewer (§6.1, Scope). */
export const NO_TASKS = 'No task needs task access';

type Vals = Partial<Record<DimId, string[]>>;
export interface FacetEntry {
  key: string; kind: string; status: string | null; team_id: string | null; created_at: number; updated_at: number;
  vals: Vals; item: Item;
  /** Newest evidence link from a finding (hypotheses), and whether a finding is evidence for anything. */
  lastFinding: number; evidenceFor: boolean;
}
export interface FacetContext { entries: Map<string, FacetEntry>; sets: CoverageSets; labels: Map<DimId, Map<string, string>>; seen: TasksSeen }

const slug = (s: string) => s.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
/** ISO week of a time, as 2026-W07. */
export function isoWeek(t: number): string {
  const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const y = d.getUTCFullYear(), w1 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((d.getTime() - w1.getTime()) / DAY - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };

function build(db: Db, projectId: string, seen: TasksSeen): FacetContext {
  const rows = db.prepare('SELECT * FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0').all(projectId) as unknown as (Omit<Item, 'fields'> & { fields: string })[];
  const all: Item[] = rows.map((r) => ({ ...r, fields: parse<Record<string, unknown>>(r.fields, {}) }));
  const links = db.prepare('SELECT from_key, to_key, rel, created_at FROM bp_links WHERE project_id=?').all(projectId) as unknown as Pick<LinkRow, 'from_key' | 'to_key' | 'rel' | 'created_at'>[];
  const sets = coverageSets(db, projectId, all, links, seen);
  const byKey = new Map(all.map((i) => [i.key, i]));
  const labels = new Map<DimId, Map<string, string>>(DIM_IDS.map((d) => [d, new Map()]));
  const label = (d: DimId, v: string, l: string) => { if (!labels.get(d)!.has(v)) labels.get(d)!.set(v, l); };
  // Links that count: both ends live, a milestone not dropped.
  const liveMs = (k: string) => { const m = byKey.get(k); return !!m && m.kind === 'milestone' && m.status !== 'dropped'; };
  const msOf = new Map<string, string[]>(), papersOf = new Map<string, string[]>(), lastFinding = new Map<string, number>(), evidenceFrom = new Set<string>();
  const push = (m: Map<string, string[]>, k: string, v: string) => { const a = m.get(k) ?? []; if (!a.includes(v)) a.push(v); m.set(k, a); };
  for (const l of links) {
    const from = byKey.get(l.from_key), to = byKey.get(l.to_key);
    if (!from || !to) continue;
    if (l.rel === 'delivers' && liveMs(l.from_key)) push(msOf, l.to_key, l.from_key);
    else if ((l.rel === 'threatens' && from.kind === 'risk' && liveMs(l.to_key)) || (l.rel === 'blocks' && from.kind === 'issue' && liveMs(l.to_key))) push(msOf, l.from_key, l.to_key);
    else if (l.rel === 'studies' && from.kind === 'paper' && to.kind === 'hypothesis' && from.status !== 'dropped') push(papersOf, l.to_key, l.from_key);
    else if (l.rel === 'evidence' && from.kind === 'finding') {
      evidenceFrom.add(l.from_key);
      if (to.kind === 'hypothesis') lastFinding.set(l.to_key, Math.max(lastFinding.get(l.to_key) ?? 0, l.created_at));
    }
  }
  const titleOf = (k: string) => { const i = byKey.get(k); return i ? String(i.fields['short'] ?? '').trim() || i.title : k; };
  const entries = new Map<string, FacetEntry>();
  for (const i of all) {
    const f = i.fields, v: Vals = {};
    const one = (d: DimId, x: string, l: string) => { v[d] = [x]; label(d, x, l); };
    const many = (d: DimId, xs: string[] | undefined, none: string) => {
      v[d] = xs?.length ? xs : [NONE];
      for (const x of v[d]!) label(d, x, x === NONE ? none : `${x} ${titleOf(x)}`);
    };
    const enumOf = (d: DimId, x: unknown, none: string) => (typeof x === 'string' && x ? one(d, x, cap(x)) : one(d, NONE, none));
    if (i.status) one('status', i.status, cap(i.status));
    one('team', i.team_id ?? 'project', i.team_id ?? 'Project');
    one('kind', i.kind, i.kind);
    if (i.kind === 'fr' || i.kind === 'nfr') {
      enumOf('priority', f['priority'], 'No priority');
      if (sets.refs) one('task', sets.refs.has(i.key) ? 'has' : NONE, sets.refs.has(i.key) ? 'Has a task' : 'No task');
      many('milestone', msOf.get(i.key), 'No milestone');
    }
    const areaOf = (r: Item | undefined): [string, string] | null =>
      !r ? null : r.kind === 'fr' ? (r.parent_key ? [r.parent_key, `${r.parent_key} ${titleOf(r.parent_key)}`] : null)
        : r.kind === 'nfr' ? (typeof r.fields['category'] === 'string' ? [String(r.fields['category']), cap(String(r.fields['category']))] : null) : null;
    if (i.kind === 'fr' || i.kind === 'nfr' || i.kind === 'ac') {
      const a = areaOf(i.kind === 'ac' ? byKey.get(i.parent_key ?? '') : i);
      if (a) one('area', a[0], a[1]); else one('area', NONE, 'No area');
    }
    if (i.kind === 'hypothesis' || i.kind === 'finding') { if (i.parent_key) one('line', i.parent_key, `${i.parent_key} ${titleOf(i.parent_key)}`); else one('line', NONE, 'No line'); }
    if (i.kind === 'hypothesis') { many('milestone', msOf.get(i.key), 'No milestone'); many('paper', papersOf.get(i.key), 'No paper'); }
    if (i.kind === 'paper') many('milestone', msOf.get(i.key), 'No milestone');
    if (i.kind === 'finding') {
      enumOf('confidence', f['confidence'], 'No confidence');
      const w = isoWeek(i.created_at); one('week', w, w);
      one('linked', evidenceFrom.has(i.key) ? 'yes' : NONE, evidenceFrom.has(i.key) ? 'Linked' : 'Linked to nothing');
    }
    if (i.kind === 'milestone') {
      const ph = typeof f['phase'] === 'string' ? f['phase'].trim() : '';
      if (ph && slug(ph)) one('phase', slug(ph), ph); else one('phase', NONE, 'No phase');
    }
    if (i.kind === 'risk' || i.kind === 'issue') {
      if (i.kind === 'risk') enumOf('likelihood', f['likelihood'], 'Not rated');
      enumOf('impact', f['impact'], 'Not rated');
      // A stakeholder key, or only whether there is an owner: the field may hold a name, which never becomes a value.
      const o = typeof f['owner'] === 'string' ? f['owner'].trim() : '';
      if (/^SH-\d+$/.test(o)) one('owner', o, o); else if (o) one('owner', 'has', 'Has owner'); else one('owner', NONE, 'No owner');
      many('milestone', msOf.get(i.key), 'No milestone');
    }
    entries.set(i.key, {
      key: i.key, kind: i.kind, status: i.status, team_id: i.team_id, created_at: i.created_at, updated_at: i.updated_at, vals: v, item: i,
      lastFinding: lastFinding.get(i.key) ?? 0, evidenceFor: evidenceFrom.has(i.key),
    });
  }
  return { entries, sets, labels, seen };
}

/** Whether an item is in a gap now. The six Coverage lists are Coverage's own tests. */
export function inGap(id: GapId, e: FacetEntry, s: CoverageSets, now: number): boolean {
  switch (id) {
    case 'unclear': return (e.kind === 'fr' || e.kind === 'nfr') && e.status !== 'dropped' && e.item.fields['unclear'] === true;
    case 'stale': return e.kind === 'hypothesis' && e.status === 'testing' && now - Math.max(e.created_at, e.lastFinding) > 30 * DAY;
    case 'unlinked': return e.kind === 'finding' && !e.evidenceFor;
    case 'late': return e.kind === 'milestone' && !!milestoneLate({ status: e.status, target_at: e.item.fields['target_at'] }, now);
    case 'no_owner': return (e.kind === 'risk' || e.kind === 'issue') && isOpen(e.kind, e.status) && !String(e.item.fields['owner'] ?? '').trim();
    case 'no_change': return isOpen(e.kind, e.status) && now - e.updated_at > 30 * DAY;
    default: return COVERAGE_TESTS[id](e.item, s, now);
  }
}

// One cache per database (a test builds many), a few recent projects and viewer scopes each.
const CACHE = new WeakMap<Db, Map<string, { sig: string; ctx: FacetContext }>>();
const CACHE_MAX = 32;
/**
 * The project's per-item values for this viewer scope, rebuilt when the project's version, its items, its links or its
 * tasks change. The signature reads aggregates only, so a cached browse costs four small queries.
 */
export function facetContext(db: Db, projectId: string, seen: TasksSeen): FacetContext {
  const one = (sql: string) => JSON.stringify(Object.values(db.prepare(sql).get(projectId) as Record<string, unknown>));
  const sig = [
    one('SELECT version FROM projects WHERE id=?'),
    one('SELECT COUNT(*), MAX(updated_at), SUM(archived), COUNT(deleted_at) FROM bp_items WHERE project_id=?'),
    one('SELECT COUNT(*), MAX(created_at) FROM bp_links WHERE project_id=?'),
    seen ? one("SELECT COUNT(*), MAX(k.updated_at), SUM(length(k.plan_refs)) FROM tasks k JOIN teams t ON t.id=k.team_id WHERE t.project_id=?") : '-',
  ].join('|');
  const key = `${projectId}|${JSON.stringify(seen)}`;
  let m = CACHE.get(db);
  if (!m) { m = new Map(); CACHE.set(db, m); }
  const hit = m.get(key);
  if (hit && hit.sig === sig) { m.delete(key); m.set(key, hit); return hit.ctx; }
  const ctx = build(db, projectId, seen);
  m.delete(key); m.set(key, { sig, ctx });
  while (m.size > CACHE_MAX) m.delete(m.keys().next().value!);
  return ctx;
}

/** The order of a dimension's values: the kind's own order, then by count, then by label; No … last. */
export function orderValues(d: DimId, vals: { value: string; label: string; count: number }[]): typeof vals {
  const o = DIMS[d].order;
  const rank = (v: string) => (v === NONE ? 1e6 : o ? (o.indexOf(v) < 0 ? o.length : o.indexOf(v)) : 0);
  return vals.sort((a, b) => rank(a.value) - rank(b.value) || (o ? 0 : b.count - a.count) || a.label.localeCompare(b.label));
}
