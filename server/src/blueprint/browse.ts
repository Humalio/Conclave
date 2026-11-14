/**
 * Blueprint browse (docs/blueprint.md §6.1): one page of a Blueprint list from the server, with its exact total, the
 * filters it applied and the named selection it used, so a count on the card and the list it opens never disagree.
 * The named selections are defined here once per kind; the item actions a viewer may take are computed here too.
 * Read-only: archive and unarchive are archive.ts.
 */
import type { Db } from '../db/db.js';
import { KeyError } from '../keys/keys.js';
import { KINDS, RETIRED, RETIRED_SQL, OPEN, isOpen } from './kinds.js';
export { OPEN, isOpen };
import { SECTION_KINDS, KIND_ORDER, DECIDED_NOTE, type Item } from './blueprint.js';
import { summarize, type Why } from './summary.js';

const DAY = 86_400_000;
export const BROWSE_LIMIT = 25;
export const BROWSE_MAX = 100;
/** Search words beyond this many are ignored, as in bp_read. */
const WORDS_MAX = 8;

export type SelectionId = 'open' | 'live' | 'dropped' | 'month' | 'decide' | 'risk';
/** The two selections that follow links and are offered on section 2 only (summary.ts). */
export const SECTION2_SELECTIONS: readonly SelectionId[] = ['decide', 'risk'];
// OPEN and isOpen live in kinds.ts (no imports), so questions.ts can use them without an import cycle through blueprint.ts.
const inSql = (m: Readonly<Record<string, readonly string[]>>) =>
  `(${Object.entries(m).map(([k, s]) => `(kind='${k}' AND status IN (${s.map((x) => `'${x}'`).join(',')}))`).join(' OR ')})`;
/** Built from the constants above only. */
const OPEN_SQL = inSql(OPEN);

export interface Selection { id: SelectionId; label: string; rule: string }
export const SELECTIONS: Readonly<Record<SelectionId, Selection>> = {
  open: { id: 'open', label: 'Open', rule: 'Work still in play: requirements not verified or dropped, criteria open or failing, hypotheses untested or testing, open questions, risks and issues, planned milestones and releases, papers not yet decided, draft claims, proposed decisions, active lines.' },
  live: { id: 'live', label: 'Not dropped', rule: 'Everything that is not retired (dropped, waived, superseded, rejected, cut or cancelled).' },
  dropped: { id: 'dropped', label: 'Dropped', rule: 'The retired items: dropped, waived, superseded, rejected, cut or cancelled.' },
  month: { id: 'month', label: 'This month', rule: 'Created in the last 30 days.' },
  decide: { id: 'decide', label: 'Waiting on a decision', rule: 'Section 2 only. Unclear requirements (they wait on you); hypotheses testing with a medium or high finding but no verdict, or inconclusive (they wait on the team); open questions that block an open item (they wait on whoever was asked); requirements and hypotheses an open issue blocks. Waiting on you first, then the team, then others.' },
  risk: { id: 'risk', label: 'At risk', rule: 'Section 2 only. Requirements and hypotheses not yet verified or decided that have a failing criterion, a late milestone delivering them (missed, or past its target date), or an open risk of high likelihood or high impact threatening them; the ones already waiting on a decision are not counted twice.' },
};
const selSql = (id: SelectionId, now: number): [string, number[]] =>
  id === 'open' ? [OPEN_SQL, []] : id === 'live' ? [`NOT ${RETIRED_SQL}`, []] : id === 'dropped' ? [RETIRED_SQL, []] : ['created_at>=?', [now - 30 * DAY]];
const IN_KEYS = 'key IN (SELECT value FROM json_each(?))';

export const isRetired = (kind: string, status: string | null): boolean => !!status && !!RETIRED[kind]?.includes(status);

/** The deterministic order of every list: section order of the kinds, then position, key and id. */
const ORDER = `CASE kind ${KIND_ORDER.map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ')} ELSE ${KIND_ORDER.length} END, position, key, id`;

export interface BrowseQuery {
  section?: number; kinds?: string[]; status?: string[]; sel?: SelectionId; team?: string; q?: string; offset?: number; limit?: number;
}
export interface BrowseRow {
  key: string; kind: string; title: string; status: string | null; fields: Record<string, unknown>;
  parent: { key: string; title: string } | null; team: { id: string; name: string } | null;
  /** decide and risk lists only: the reasons (summary.ts), the open items a question blocks, and whether it is overdue. */
  why?: Why[]; blocks?: string[]; overdue?: boolean;
}
export interface BrowseResult {
  items: BrowseRow[]; total: number; next: number | null; prev: number | null;
  /** The rows of this page, counted from 1 ("26–50 of 112"); 0 to 0 when the page is empty. */
  range: { from: number; to: number };
  filters: { section: number | null; kind: string[]; status: string[]; sel: SelectionId | null; team: string | null; q: string; limit: number };
  selection: Selection | null; counts: { all: number; open: number; dropped: number; decide?: number; risk?: number }; statuses: string[];
}

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
const bad = (msg: string) => new KeyError('invalid_argument', msg);

/**
 * One page of a project's Blueprint list. Archived and removed items are never listed, counted or found; status
 * reports are all listed (bp_read keeps only the newest three). Every filter is SQL.
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
  const status = [...new Set(q.status ?? [])];
  // The Filters sheet offers only the statuses of kinds the project holds in view (an implementation project has no
  // hypotheses); any status of a kind in view is still accepted, so a route from before stays valid.
  const held = new Set((db.prepare('SELECT DISTINCT kind FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0 AND kind IN (SELECT value FROM json_each(?))')
    .all(project.id, JSON.stringify(inView)) as { kind: string }[]).map((r) => r.kind));
  const offered: string[] = [];
  for (const k of KIND_ORDER) if (held.has(k)) for (const s of KINDS[k]!.statuses ?? []) if (!offered.includes(s)) offered.push(s);
  for (const s of status) if (!statuses.includes(s)) throw bad(`No ${inView.length === 1 ? inView[0] : 'item in view'} has status ${s}; the statuses are ${statuses.join(', ') || 'none'}.`);
  const team = q.team ?? null;
  if (team && team !== 'project' && !db.prepare('SELECT 1 FROM teams WHERE id=? AND project_id=?').get(team, project.id)) throw bad(`Team ${team} is not part of project ${project.key}.`);
  if (q.sel && SECTION2_SELECTIONS.includes(q.sel) && section !== 2) throw bad(`Unknown selection ${q.sel} here; it is offered for section 2 only. The selections are open, live, dropped and month.`);
  const words = (q.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, WORDS_MAX);

  // The base: everything but the selection and the status, so the counts of All, Open and Dropped share it.
  const where = ['project_id=?', 'deleted_at IS NULL', 'archived=0'], args: (string | number)[] = [project.id];
  const add = (sql: string, ...v: (string | number)[]) => { where.push(sql); args.push(...v); };
  if (secKinds || kinds.length) add('kind IN (SELECT value FROM json_each(?))', JSON.stringify(inView));
  if (team === 'project') add('team_id IS NULL'); else if (team) add('team_id=?', team);
  for (const w of words) add("instr(bp_fold(key || ' ' || title || ' ' || COALESCE(body, '')), ?) > 0", w);
  const base = where.join(' AND ');
  const n = (cond: string, a: (string | number)[]) => (db.prepare(`SELECT COUNT(*) n FROM bp_items WHERE ${cond}`).get(...a) as { n: number }).n;
  const counts: BrowseResult['counts'] = { all: n(base, args), open: n(`${base} AND ${OPEN_SQL}`, args), dropped: n(`${base} AND ${RETIRED_SQL}`, args) };
  // Section 2 also counts its two summary lists with the same filters, so the summary's counts equal the lists they open.
  const sum = section === 2 ? summarize(db, project.id, (db.prepare('SELECT kind FROM projects WHERE id=?').get(project.id) as { kind: string } | undefined)?.kind === 'research', now) : null;
  if (sum) { counts.decide = n(`${base} AND ${IN_KEYS}`, [...args, JSON.stringify(sum.decide)]); counts.risk = n(`${base} AND ${IN_KEYS}`, [...args, JSON.stringify(sum.risk)]); }

  let cond = base, condArgs = [...args];
  let order = ORDER, orderArgs: string[] = [];
  if (q.sel === 'decide' || q.sel === 'risk') {
    const keys = q.sel === 'decide' ? sum!.decide : sum!.risk;
    cond += ` AND ${IN_KEYS}`; condArgs.push(JSON.stringify(keys));
    // decide keeps the summary's own order (waiting on you first); risk keeps the Blueprint's.
    if (q.sel === 'decide') { order = '(SELECT CAST(j.key AS INTEGER) FROM json_each(?) j WHERE j.value=bp_items.key)'; orderArgs = [JSON.stringify(keys)]; }
  } else if (q.sel) { const [s, a] = selSql(q.sel, now); cond += ` AND ${s}`; condArgs.push(...a); }
  if (status.length) { cond += " AND COALESCE(status, '') IN (SELECT value FROM json_each(?))"; condArgs.push(JSON.stringify(status)); }
  const total = n(cond, condArgs);
  const rows = db.prepare(`SELECT id, key, kind, title, status, fields, parent_key, team_id FROM bp_items WHERE ${cond} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...condArgs, ...orderArgs, limit, offset) as { key: string; kind: string; title: string; status: string | null; fields: string; parent_key: string | null; team_id: string | null }[];
  const parentKeys = [...new Set(rows.map((r) => r.parent_key).filter((k): k is string => !!k))];
  const parents = new Map(parentKeys.length
    ? (db.prepare('SELECT key, title FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND key IN (SELECT value FROM json_each(?))').all(project.id, JSON.stringify(parentKeys)) as { key: string; title: string }[]).map((r) => [r.key, r.title])
    : []);
  const teams = new Map((db.prepare('SELECT id, name FROM teams WHERE project_id=?').all(project.id) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const items = rows.map((r): BrowseRow => {
    const v = q.sel === 'decide' || q.sel === 'risk' ? sum?.verdicts.get(r.key) : undefined;
    return {
      key: r.key, kind: r.kind, title: r.title, status: r.status, fields: parse(r.fields, {}),
      parent: r.parent_key ? { key: r.parent_key, title: parents.get(r.parent_key) ?? '' } : null,
      team: r.team_id ? { id: r.team_id, name: teams.get(r.team_id) ?? r.team_id } : null,
      ...(v ? { why: [...v.decide, ...v.risk], blocks: v.blocks, overdue: v.overdue } : {}),
    };
  });
  return {
    items, total, next: offset + limit < total ? offset + limit : null, prev: offset > 0 ? Math.max(0, offset - limit) : null,
    range: { from: items.length ? offset + 1 : 0, to: offset + items.length },
    filters: { section, kind: kinds, status, sel: q.sel ?? null, team, q: words.join(' '), limit },
    selection: q.sel ? SELECTIONS[q.sel] : null, counts, statuses: offered,
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
