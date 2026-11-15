/**
 * Blueprint browse (docs/blueprint.md §6.1): one page of a Blueprint list from the server, with its exact total, the
 * filters it applied and the named selection it used, so a count on the card and the list it opens never disagree.
 * The named selections are defined here once per kind; the item actions a viewer may take are computed here too.
 * Read-only: archive and unarchive are archive.ts.
 */
import type { Db } from '../db/db.js';
import { KeyError } from '../keys/keys.js';
import { KINDS, RETIRED, OPEN, isOpen } from './kinds.js';
export { OPEN, isOpen };
import { SECTION_KINDS, KIND_ORDER, DECIDED_NOTE, type Item } from './blueprint.js';
import { summarize, type Why } from './summary.js';
import type { TasksSeen } from './coverage.js';
import { DIMS, DIM_IDS, GAPS, GAP_IDS, NO_TASKS, NONE, facetContext, inGap, orderValues, type DimId, type FacetEntry, type GapId, type GapSelection } from './facets.js';

const DAY = 86_400_000;
export const BROWSE_LIMIT = 25;
export const BROWSE_MAX = 100;
/** Search words beyond this many are ignored, as in bp_read. */
const WORDS_MAX = 8;

export type SelectionId = 'open' | 'live' | 'dropped' | 'month' | 'decide' | 'risk';
/** The two selections that follow links and are offered on section 2 only (summary.ts). */
export const SECTION2_SELECTIONS: readonly SelectionId[] = ['decide', 'risk'];
// OPEN and isOpen live in kinds.ts (no imports), so questions.ts can use them without an import cycle through blueprint.ts.

export interface Selection { id: SelectionId; label: string; rule: string }
export const SELECTIONS: Readonly<Record<SelectionId, Selection>> = {
  open: { id: 'open', label: 'Open', rule: 'Work still in play: requirements not verified or dropped, criteria open or failing, hypotheses untested or testing, open questions, risks and issues, planned milestones and releases, papers not yet decided, draft claims, proposed decisions, active lines.' },
  live: { id: 'live', label: 'Not dropped', rule: 'Everything that is not retired (dropped, waived, superseded, rejected, cut or cancelled).' },
  dropped: { id: 'dropped', label: 'Dropped', rule: 'The retired items: dropped, waived, superseded, rejected, cut or cancelled.' },
  month: { id: 'month', label: 'This month', rule: 'Created in the last 30 days.' },
  decide: { id: 'decide', label: 'Waiting on a decision', rule: 'Section 2 only. Unclear requirements (they wait on you); hypotheses testing with a medium or high finding but no verdict, or inconclusive (they wait on the team); open questions that block an open item (they wait on whoever was asked); requirements and hypotheses an open issue blocks. Waiting on you first, then the team, then others.' },
  risk: { id: 'risk', label: 'At risk', rule: 'Section 2 only. Requirements and hypotheses not yet verified or decided that have a failing criterion, a late milestone delivering them (missed, or past its target date), or an open risk of high likelihood or high impact threatening them; the ones already waiting on a decision are not counted twice.' },
};
const REQ_KINDS = ['fr', 'nfr'];

export const isRetired = (kind: string, status: string | null): boolean => !!status && !!RETIRED[kind]?.includes(status);

/** The deterministic order of every list: section order of the kinds, then position, key and id. */
const ORDER = `CASE kind ${KIND_ORDER.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ')} ELSE ${KIND_ORDER.length} END, position, key, id`;

export interface BrowseQuery {
  section?: number; kinds?: string[]; status?: string[]; sel?: SelectionId; team?: string; q?: string; offset?: number; limit?: number;
  /** Group by a dimension in view, and sort (§6.1, Sort and group). */
  g?: string; s?: string;
  /** List analysis (§6.1): dimension filters as `dim:value` pairs, one gap, the count table's two dimensions (`dim*dim`). */
  f?: string[]; gap?: string; x?: string;
  /** The tasks this viewer may read (coverage.ts): without them, no No task gap and no task dimension. */
  tasks?: TasksSeen;
}
export interface FacetValue { value: string; label: string; count: number }
export interface Facet { id: DimId; label: string; multi: boolean; values: FacetValue[] }
export interface GapCount extends Omit<GapSelection, 'kinds'> { count: number }
export type SortId = 'risk' | 'old' | 'name';
export const SORTS: readonly SortId[] = ['risk', 'old', 'name'];
export interface Cross { rows: DimId; cols: DimId; row_values: { value: string; label: string }[]; col_values: { value: string; label: string }[]; cells: number[][]; multi: boolean;
  /** Per row value, the items in that row, each once (a row's cells add up to more when an item sits in two columns). */
  totals: number[];
  /** Per column value, the same: the items in that column, each once. The console needs it to turn the table to fit. */
  col_totals: number[] }
export interface BrowseRow {
  key: string; kind: string; title: string; status: string | null; fields: Record<string, unknown>;
  parent: { key: string; title: string } | null; team: { id: string; name: string } | null;
  /** g only: the value this row is listed under. */
  group?: string;
  /** decide and risk lists only: the reasons (summary.ts), the open items a question blocks, and whether it is overdue. */
  why?: Why[]; blocks?: string[]; overdue?: boolean;
}
export interface BrowseResult {
  items: BrowseRow[]; total: number; next: number | null; prev: number | null;
  /** The rows of this page, counted from 1 ("26–50 of 112"); 0 to 0 when the page is empty. */
  range: { from: number; to: number };
  filters: { section: number | null; kind: string[]; status: string[]; sel: SelectionId | null; team: string | null; q: string; limit: number; f: string[]; gap: GapId | null; x: string | null; g: DimId | null; s: SortId | null };
  /** Items the selection and status hold before the dimension filters and the gap ("Showing 18 of 112"). */
  of: number;
  /** Rows listed (an item under each of its groups); range and the cursors page over these. */
  rows: number;
  /** g only: the groups of the whole list, in order. */
  groups: FacetValue[] | null;
  selection: Selection | null; counts: { all: number; open: number; dropped: number; decide?: number; risk?: number }; statuses: string[];
  /** List analysis (§6.1): one facet per dimension in view, the gaps in view, the count table when asked. */
  facets: Facet[]; gaps: GapCount[]; cross: Cross | null;
  /** What this viewer is not shown, and why; the filter values left out because they no longer apply. */
  hidden: { id: string; reason: string }[]; ignored: string[];
}

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
const bad = (msg: string) => new KeyError('invalid_argument', msg);

/**
 * One page of a project's Blueprint list, with its analysis. Archived and removed items are never listed, counted or
 * found; status reports are all listed (bp_read keeps only the newest three). Section, kind, team and search are SQL;
 * the selection, the status, the dimension filters and the gap are tested per item on the project's cached values
 * (facets.ts), so every count and the list it opens come from the same tests.
 */
export function browse(db: Db, project: { id: string; key: string }, q: BrowseQuery, now = Date.now()): BrowseResult {
  const limit = Math.max(1, Math.min(BROWSE_MAX, q.limit ?? BROWSE_LIMIT)), offset = Math.max(0, q.offset ?? 0);
  const section = q.section ?? null;
  const secKinds = section ? SECTION_KINDS[section] : undefined;
  if (section && !secKinds) throw bad('A section is 1 to 6 (foundation, requirements, decisions, planning, tracking, appendix).');
  const kinds = [...new Set(q.kinds ?? [])];
  for (const k of kinds) if (!KINDS[k]) throw bad(`Unknown kind ${k}; kinds are ${KIND_ORDER.join(', ')}.`);
  if (secKinds) for (const k of kinds) if (!secKinds.includes(k)) throw bad(`${k} is not in section ${section}.`);
  const inView = kinds.length ? kinds : secKinds ?? KIND_ORDER;
  // The stored statuses of the kinds in view, in each kind's own order; a status outside them is refused.
  const statuses: string[] = [];
  for (const k of KIND_ORDER) if (inView.includes(k)) for (const s of KINDS[k]!.statuses ?? []) if (!statuses.includes(s)) statuses.push(s);
  // The Filters sheet offers only the statuses of kinds the project holds in view (an implementation project has no
  // hypotheses); any status of a kind in view is still accepted, so a route from before stays valid.
  const held = new Set((db.prepare('SELECT DISTINCT kind FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0 AND kind IN (SELECT value FROM json_each(?))')
    .all(project.id, JSON.stringify(inView)) as { kind: string }[]).map((r) => r.kind));
  const offered: string[] = [];
  for (const k of KIND_ORDER) if (held.has(k)) for (const s of KINDS[k]!.statuses ?? []) if (!offered.includes(s)) offered.push(s);
  const team = q.team ?? null;
  if (team && team !== 'project' && !db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(team, project.id)) throw bad(`Team ${team} is not part of project ${project.key}.`);
  if (q.sel && SECTION2_SELECTIONS.includes(q.sel) && section !== 2) throw bad(`Unknown selection ${q.sel} here; it is offered for section 2 only. The selections are open, live, dropped and month.`);
  const words = (q.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, WORDS_MAX);
  const noStatus = (s: string) => bad(`No ${inView.length === 1 ? inView[0] : 'item in view'} has status ${s}; the statuses are ${statuses.join(', ') || 'none'}.`);

  // The analysis's scope: the dimensions and gaps of the kinds in view that this viewer may read.
  const seen = q.tasks ?? null;
  const ctx = facetContext(db, project.id, seen);
  const viewKinds = new Set(inView);
  const dimsInView = DIM_IDS.filter((d) => (d !== 'kind' || held.size > 1) && (!DIMS[d].tasks || seen) && DIMS[d].kinds.some((k) => viewKinds.has(k)));
  const gapsInView = GAP_IDS.filter((g) => (g !== 'no_task' || seen) && GAPS[g].kinds.some((k) => viewKinds.has(k)));
  const hidden: BrowseResult['hidden'] = [];
  if (!seen && REQ_KINDS.some((k) => viewKinds.has(k))) hidden.push({ id: 'no_task', reason: NO_TASKS }, { id: 'task', reason: NO_TASKS });
  const ignored: string[] = [];

  // Filters by dimension: values of one dimension are either-or, dimensions are all-of. status is one of them.
  const filt = new Map<DimId, Set<string>>();
  const want = (d: DimId, v: string) => { const s = filt.get(d) ?? new Set<string>(); s.add(v); filt.set(d, s); };
  for (const s of new Set(q.status ?? [])) { if (!statuses.includes(s)) throw noStatus(s); want('status', s); }
  for (const pair of q.f ?? []) {
    const at = pair.indexOf(':'), d = pair.slice(0, at) as DimId, v = pair.slice(at + 1);
    if (at < 1 || !v) throw bad(`A filter is dimension:value, such as priority:must; ${pair} is not.`);
    if (!DIMS[d]) throw bad(`Unknown dimension ${d}; the dimensions are ${DIM_IDS.join(', ')}.`);
    if (d === 'status') { if (!statuses.includes(v)) throw noStatus(v); want(d, v); continue; }
    // A value that no longer applies (the dimension is out of view or scope, or no item holds the value) is left out.
    if (!dimsInView.includes(d) || (v !== NONE && !DIMS[d].order?.includes(v) && !ctx.labels.get(d)!.has(v))) { ignored.push(`${d}:${v}`); continue; }
    want(d, v);
  }
  let gap: GapId | null = null;
  if (q.gap) {
    if (!GAPS[q.gap as GapId]) throw bad(`Unknown gap ${q.gap}; the gaps are ${GAP_IDS.join(', ')}.`);
    if (gapsInView.includes(q.gap as GapId)) gap = q.gap as GapId; else ignored.push(`gap:${q.gap}`);
  }
  if (q.s !== undefined && !SORTS.includes(q.s as SortId)) throw bad(`Unknown sort ${q.s}; the sorts are ${SORTS.join(', ')}.`);
  const sort = (q.s as SortId | undefined) ?? null;
  let grp: DimId | null = null;
  if (q.g) {
    if (!DIMS[q.g as DimId]) throw bad(`Unknown dimension ${q.g}; the dimensions are ${DIM_IDS.join(', ')}.`);
    if (dimsInView.includes(q.g as DimId)) grp = q.g as DimId; else ignored.push(`g:${q.g}`);
  }
  let cx: [DimId, DimId] | null = null;
  if (q.x) {
    const [a, b, more] = q.x.split('*') as DimId[];
    if (!a || !b || more !== undefined || a === b) throw bad('The count table takes two different dimensions, such as priority*milestone.');
    for (const d of [a, b]) if (!DIMS[d]) throw bad(`Unknown dimension ${d}; the dimensions are ${DIM_IDS.join(', ')}.`);
    if (dimsInView.includes(a) && dimsInView.includes(b)) cx = [a, b]; else ignored.push(`x:${q.x}`);
  }

  // The base, in the list's order: section, kind, team and search, which every count shares.
  const where = ['project_id=?', 'deleted_at IS NULL', 'archived=0'], args: (string | number)[] = [project.id];
  const add = (sql: string, ...v: (string | number)[]) => { where.push(sql); args.push(...v); };
  if (secKinds || kinds.length) add('kind IN (SELECT value FROM json_each(?))', JSON.stringify(inView));
  if (team === 'project') add('team_id IS NULL'); else if (team) add('team_id=?', team);
  for (const w of words) add("instr(bp_fold(key || ' ' || title || ' ' || COALESCE(body, '')), ?) > 0", w);
  const base = (db.prepare(`SELECT key FROM bp_items WHERE ${where.join(' AND ')} ORDER BY ${ORDER}`).all(...args) as { key: string }[])
    .map((r) => ctx.entries.get(r.key)).filter((e): e is FacetEntry => !!e);
  // Section 2 also counts its two summary lists with the same filters, so the summary's counts equal the lists they open.
  const sum = section === 2 || (sort === 'risk' && ['fr', 'nfr', 'hypothesis'].some((k) => viewKinds.has(k))) ? summarize(db, project.id, (db.prepare('SELECT kind FROM projects WHERE id=?').get(project.id) as { kind: string } | undefined)?.kind === 'research', now) : null;
  const decide = new Set(sum?.decide ?? []), risk = new Set(sum?.risk ?? []);
  const selOk = (e: FacetEntry): boolean => {
    switch (q.sel) {
      case undefined: return true;
      case 'open': return isOpen(e.kind, e.status);
      case 'live': return !isRetired(e.kind, e.status);
      case 'dropped': return isRetired(e.kind, e.status);
      case 'month': return e.created_at >= now - 30 * DAY;
      case 'decide': return decide.has(e.key);
      case 'risk': return risk.has(e.key);
    }
  };
  const has = (e: FacetEntry, d: DimId, set: Set<string>) => !!e.vals[d]?.some((v) => set.has(v));
  const fOk = (e: FacetEntry, but?: DimId, but2?: DimId) => {
    for (const [d, set] of filt) if (d !== but && d !== but2 && !has(e, d, set)) return false;
    return true;
  };
  const rows = base.map((e) => ({ e, sel: selOk(e), gaps: new Set(gapsInView.filter((g) => inGap(g, e, ctx.sets, now))) }));
  const gapOk = (r: (typeof rows)[number]) => !gap || r.gaps.has(gap);
  const listed = rows.filter((r) => r.sel && fOk(r.e) && gapOk(r));
  // decide keeps the summary's own order (waiting on you first); every other list keeps the Blueprint's.
  if (q.sel === 'decide' && !sort) { const at = new Map(sum!.decide.map((k, i) => [k, i])); listed.sort((a, b) => at.get(a.e.key)! - at.get(b.e.key)!); }
  // A sort keeps the Blueprint's order for ties (Array.prototype.sort is stable), so pages never repeat or skip.
  if (sort === 'risk') {
    const LVL: Record<string, number> = { high: 2, medium: 1 };
    const score = (r: (typeof rows)[number]): number[] => {
      const v = sum?.verdicts.get(r.e.key), f = r.e.item.fields;
      return [decide.has(r.e.key) ? 2 : risk.has(r.e.key) ? 1 : 0, v ? v.decide.length + v.risk.length : 0, r.gaps.size, (LVL[String(f['likelihood'])] ?? 0) + (LVL[String(f['impact'])] ?? 0)];
    };
    const sc = new Map(listed.map((r) => [r.e.key, score(r)]));
    listed.sort((a, b) => { const x = sc.get(a.e.key)!, y = sc.get(b.e.key)!; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; });
  } else if (sort === 'old') listed.sort((a, b) => a.e.updated_at - b.e.updated_at);
  else if (sort === 'name') listed.sort((a, b) => a.e.item.title.localeCompare(b.e.item.title) || a.e.key.localeCompare(b.e.key));

  // All, Open and Dropped keep every filter but the selection and the status, as the filter row always had them.
  const forCounts = rows.filter((r) => fOk(r.e, 'status') && gapOk(r));
  const counts: BrowseResult['counts'] = { all: forCounts.length, open: forCounts.filter((r) => isOpen(r.e.kind, r.e.status)).length, dropped: forCounts.filter((r) => isRetired(r.e.kind, r.e.status)).length };
  if (sum) { counts.decide = forCounts.filter((r) => decide.has(r.e.key)).length; counts.risk = forCounts.filter((r) => risk.has(r.e.key)).length; }

  // Each facet's count is the list its value opens: the other filters stay, its own becomes that one value.
  const teamNames = new Map((db.prepare('SELECT id, name FROM teams WHERE project_id=?').all(project.id) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const labelOf = (d: DimId, v: string) => (d === 'team' && v !== 'project' ? teamNames.get(v) ?? v : ctx.labels.get(d)!.get(v) ?? (v === NONE ? 'None' : v));
  const facets: Facet[] = dimsInView.map((d) => {
    const n = new Map<string, number>();
    let multi = false;
    for (const r of rows) {
      if (!r.sel || !gapOk(r) || !fOk(r.e, d) || !r.e.vals[d]) continue;
      const vs = r.e.vals[d]!;
      if (vs.length > 1) multi = true;
      for (const v of vs) n.set(v, (n.get(v) ?? 0) + 1);
    }
    for (const v of filt.get(d) ?? []) if (!n.has(v)) n.set(v, 0);
    return { id: d, label: DIMS[d].label, multi, values: orderValues(d, [...n].map(([value, count]) => ({ value, label: labelOf(d, value), count }))) };
  }).filter((f) => f.values.length > 0);
  // A gap's count keeps every filter and swaps the gap.
  const gapCounts: GapCount[] = gapsInView.map((g) => {
    const { kinds: _k, ...s } = GAPS[g];
    return { ...s, count: rows.filter((r) => r.sel && fOk(r.e) && r.gaps.has(g)).length };
  });
  // A cell keeps every filter but its two dimensions' own.
  let cross: Cross | null = null;
  if (cx) {
    const [a, b] = cx, cell = new Map<string, number>(), ra = new Set<string>(), cb = new Set<string>(), tot = new Map<string, number>(), ctot = new Map<string, number>();
    let multi = false;
    for (const r of rows) {
      if (!r.sel || !gapOk(r) || !fOk(r.e, a, b) || !r.e.vals[a] || !r.e.vals[b]) continue;
      if (r.e.vals[a]!.length > 1 || r.e.vals[b]!.length > 1) multi = true;
      for (const va of r.e.vals[a]!) tot.set(va, (tot.get(va) ?? 0) + 1);
      for (const vb of r.e.vals[b]!) ctot.set(vb, (ctot.get(vb) ?? 0) + 1);
      for (const va of r.e.vals[a]!) for (const vb of r.e.vals[b]!) { ra.add(va); cb.add(vb); const k = `${va}\u0000${vb}`; cell.set(k, (cell.get(k) ?? 0) + 1); }
    }
    const vals = (d: DimId, s: Set<string>) => orderValues(d, [...s].map((value) => ({ value, label: labelOf(d, value), count: 0 }))).map(({ value, label }) => ({ value, label }));
    const rv = vals(a, ra), cv = vals(b, cb);
    cross = { rows: a, cols: b, row_values: rv, col_values: cv, cells: rv.map((x) => cv.map((y) => cell.get(`${x.value}\u0000${y.value}`) ?? 0)), multi, totals: rv.map((x) => tot.get(x.value) ?? 0), col_totals: cv.map((y) => ctot.get(y.value) ?? 0) };
  }

  const total = listed.length;
  const of = rows.filter((r) => r.sel && (!filt.has('status') || has(r.e, 'status', filt.get('status')!))).length;
  // Grouped, an item is listed under each of its values, group by group in the dimension's order; an item the dimension
  // does not apply to (its kind has none) is listed under none.
  let groups: FacetValue[] | null = null;
  let lines: { key: string; group?: string }[] = listed.map((r) => ({ key: r.e.key }));
  if (grp) {
    const by = new Map<string, string[]>();
    for (const r of listed) for (const v of r.e.vals[grp] ?? [NONE]) { const a = by.get(v) ?? []; a.push(r.e.key); by.set(v, a); }
    groups = orderValues(grp, [...by].map(([value, ks]) => ({ value, label: labelOf(grp!, value), count: ks.length })));
    lines = groups.flatMap((gv) => by.get(gv.value)!.map((key) => ({ key, group: gv.value })));
  }
  const slice = lines.slice(offset, offset + limit), pageKeys = [...new Set(slice.map((l) => l.key))];
  type Row = { key: string; kind: string; title: string; status: string | null; fields: string; parent_key: string | null; team_id: string | null };
  const byKey = new Map((pageKeys.length
    ? db.prepare('SELECT id, key, kind, title, status, fields, parent_key, team_id FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0 AND key IN (SELECT value FROM json_each(?))').all(project.id, JSON.stringify(pageKeys)) as Row[]
    : []).map((r) => [r.key, r]));
  const page = pageKeys.map((k) => byKey.get(k)).filter((r): r is Row => !!r);
  const rowOf = (l: { key: string; group?: string }) => { const r = byKey.get(l.key); return r ? { r, group: l.group } : null; };
  const parentKeys = [...new Set(page.map((r) => r.parent_key).filter((k): k is string => !!k))];
  const parents = new Map(parentKeys.length
    ? (db.prepare('SELECT key, title FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND key IN (SELECT value FROM json_each(?))').all(project.id, JSON.stringify(parentKeys)) as { key: string; title: string }[]).map((r) => [r.key, r.title])
    : []);
  const items = slice.map(rowOf).filter((x): x is NonNullable<typeof x> => !!x).map(({ r, group }): BrowseRow => {
    const v = q.sel === 'decide' || q.sel === 'risk' ? sum?.verdicts.get(r.key) : undefined;
    return {
      key: r.key, kind: r.kind, title: r.title, status: r.status, fields: parse(r.fields, {}),
      parent: r.parent_key ? { key: r.parent_key, title: parents.get(r.parent_key) ?? '' } : null,
      team: r.team_id ? { id: r.team_id, name: teamNames.get(r.team_id) ?? r.team_id } : null,
      ...(group !== undefined ? { group } : {}),
      ...(v ? { why: [...v.decide, ...v.risk], blocks: v.blocks, overdue: v.overdue } : {}),
    };
  });
  const fEcho = [...filt].filter(([d]) => d !== 'status').flatMap(([d, s]) => [...s].map((v) => `${d}:${v}`)).sort();
  return {
    items, total, of, rows: lines.length, groups, next: offset + limit < lines.length ? offset + limit : null, prev: offset > 0 ? Math.max(0, offset - limit) : null,
    range: { from: items.length ? offset + 1 : 0, to: offset + items.length },
    filters: { section, kind: kinds, status: [...(filt.get('status') ?? [])], sel: q.sel ?? null, team, q: words.join(' '), limit, f: fEcho, gap, x: cx ? cx.join('*') : null, g: grp, s: sort },
    selection: q.sel ? SELECTIONS[q.sel] : null, counts, statuses: offered,
    facets, gaps: gapCounts, cross, hidden, ignored,
  };
}

export type ItemAction =
  | { id: 'add_as_claim' | 'mark_submitted' | 'add_evidence' | 'cut_claim' | 'archive' | 'unarchive' }
  | { id: 'undo'; rev: number; to: string };
interface Rev { rev: number; note: string | null; snapshot: Record<string, unknown> }

/**
 * The actions this viewer may take on an item (§6.1), from its kind, its state and the viewer's rights. Each one is the
 * admin's today, so a member gets none; the route that carries an action checks it again.
 */
export function itemActions(it: Pick<Item, 'kind' | 'status' | 'fields' | 'deleted_at' | 'archived'>, revisions: Rev[], admin: boolean): ItemAction[] {
  if (!admin || it.deleted_at) return [];
  if (it.archived) return it.kind === 'report' ? [] : [{ id: 'unarchive' }];
  const out: ItemAction[] = [];
  const f = it.fields;
  if ((it.kind === 'hypothesis' && it.status === 'confirmed') || (it.kind === 'finding' && ['medium', 'high'].includes(String(f['confidence'])))
    || ((it.kind === 'fr' || it.kind === 'nfr') && it.status === 'verified')) out.push({ id: 'add_as_claim' });
  if (it.kind === 'paper' && (it.status === 'planned' || it.status === 'drafting')) out.push({ id: 'mark_submitted' });
  if (it.kind === 'claim' && it.status !== 'cut') out.push({ id: 'add_evidence' }, { id: 'cut_claim' });
  // A coordinator's agreement under the team setting can be undone while the item still has the status it set (§4).
  const i = revisions.findIndex((r) => r.note === DECIDED_NOTE);
  const r = revisions[i], prev = revisions[i + 1];
  if (r && prev && it.status === r.snapshot['status'] && prev.snapshot['status'] !== it.status && typeof prev.snapshot['status'] === 'string')
    out.push({ id: 'undo', rev: r.rev, to: prev.snapshot['status'] });
  if (isRetired(it.kind, it.status)) out.push({ id: 'archive' });
  return out;
}
