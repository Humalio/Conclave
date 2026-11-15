/**
 * Coverage (docs/blueprint.md §6, Coverage): six gap lists computed from what the hub already stores. It is a view, not
 * an attention surface: nothing here feeds Needs you, For awareness or a notice. The summary's `plain` block, `bp_read
 * {plain: "coverage"}` and the status report's hub facts all read this one function.
 */
import type { Db } from '../db/db.js';
import type { Item, LinkRow } from './blueprint.js';
import { NOT_COUNTED } from '../teams/teams.js';

export interface GapItem { key: string; kind: string; title: string; status: string | null; since?: number }
export interface Gap { count: number; items: GapItem[] }
export interface Coverage {
  no_ac: Gap; no_milestone: Gap; no_task: Gap | null; passing_no_evidence: Gap; decisions_govern_nothing: Gap; old_questions: Gap;
}
/** The tasks a viewer may see: every task of the project, only some teams' tasks, or none (the No task list is then left out). */
export type TasksSeen = 'all' | { teams: readonly string[] } | null;

export const GAP_LISTS = ['no_ac', 'no_milestone', 'no_task', 'passing_no_evidence', 'decisions_govern_nothing', 'old_questions'] as const;
export const GAP_NAMES: Record<(typeof GAP_LISTS)[number], string> = {
  no_ac: 'No acceptance criteria', no_milestone: 'No milestone', no_task: 'No task', passing_no_evidence: 'Passing with no evidence',
  decisions_govern_nothing: 'Decisions governing nothing', old_questions: 'Questions older than 14 days',
};
const MAX = 50;
const DAY = 86_400_000;
const REQ = new Set(['fr', 'nfr']);
/** When a question started waiting: asked_at when it is set, else when it was created. The one overdue rule (Coverage and the Questions view). */
export const questionSince = (i: Pick<Item, 'fields' | 'created_at'>): number => (typeof i.fields['asked_at'] === 'number' ? (i.fields['asked_at'] as number) : i.created_at);

/** The keys that a counted task (not backlog, cancelled or discarded) the viewer may see names in its refs. */
function taskRefs(db: Db, projectId: string, seen: Exclude<TasksSeen, null>): Set<string> {
  const teams = seen === 'all' ? null : [...seen.teams];
  if (teams && !teams.length) return new Set();
  const rows = db.prepare(`SELECT DISTINCT j.value k FROM tasks k JOIN teams t ON t.id=k.team_id,
      json_each(CASE WHEN json_valid(k.plan_refs) THEN k.plan_refs ELSE '[]' END) j
    WHERE t.project_id=? AND k.status NOT IN (SELECT value FROM json_each(?))${teams ? ' AND k.team_id IN (SELECT value FROM json_each(?))' : ''}`)
    .all(...[projectId, JSON.stringify(NOT_COUNTED), ...(teams ? [JSON.stringify(teams)] : [])]) as { k: unknown }[];
  return new Set(rows.map((r) => String(r.k)));
}

/** What the gap rules read, built once per project: requirements with a criterion, those a live milestone delivers, decisions that govern something, and the keys a task the viewer may see names (null without task access). */
export interface CoverageSets { withAc: Set<string>; delivered: Set<string>; governs: Set<string>; refs: Set<string> | null }
type CovItem = Pick<Item, 'key' | 'kind' | 'status' | 'fields' | 'created_at'> & { parent_key: string | null };
export function coverageSets(db: Db, projectId: string, all: readonly CovItem[], links: readonly Pick<LinkRow, 'from_key' | 'to_key' | 'rel'>[], seen: TasksSeen): CoverageSets {
  const live = new Map(all.map((i) => [i.key, i]));
  return {
    withAc: new Set(all.filter((i) => i.kind === 'ac' && i.parent_key).map((i) => i.parent_key!)),
    delivered: new Set(links.filter((l) => l.rel === 'delivers' && live.get(l.from_key)?.kind === 'milestone' && live.get(l.from_key)?.status !== 'dropped').map((l) => l.to_key)),
    governs: new Set(links.filter((l) => l.rel === 'governs').map((l) => l.from_key)),
    refs: seen ? taskRefs(db, projectId, seen) : null,
  };
}
const hasEvidence = (i: Pick<Item, 'fields'>) => String(i.fields['evidence'] ?? '').trim() !== '';
/**
 * Each Coverage list's rule, one function per meaning: Coverage below and browse's gaps (facets.ts, docs/blueprint.md
 * §6.1) both read these, so a gap's count and its Coverage list cannot disagree. No task is false for every item when the
 * viewer may not see tasks; callers leave that list out instead.
 */
export const COVERAGE_TESTS: Readonly<Record<(typeof GAP_LISTS)[number], (i: CovItem, s: CoverageSets, now: number) => boolean>> = {
  no_ac: (i, s) => REQ.has(i.kind) && i.status !== 'dropped' && !s.withAc.has(i.key),
  no_milestone: (i, s) => REQ.has(i.kind) && (i.status === 'agreed' || i.status === 'built') && !s.delivered.has(i.key),
  no_task: (i, s) => !!s.refs && REQ.has(i.kind) && i.status === 'agreed' && !s.refs.has(i.key),
  passing_no_evidence: (i) => i.kind === 'ac' && i.status === 'passing' && !hasEvidence(i),
  decisions_govern_nothing: (i, s) => i.kind === 'decision' && i.status === 'accepted' && !s.governs.has(i.key),
  old_questions: (i, _s, now) => i.kind === 'question' && i.status === 'open' && now - questionSince(i) > 14 * DAY,
};

/**
 * The gaps of `items` (a team's part or the whole project). `all` is every live item of the project and `links` every
 * link of it, so a project-level milestone that delivers a part's requirement counts.
 */
export function coverage(db: Db, projectId: string, items: Item[], all: Item[], links: LinkRow[], seen: TasksSeen, now = Date.now()): Coverage {
  const gap = (list: Item[], since?: (i: Item) => number): Gap => ({
    count: list.length,
    items: list.slice(0, MAX).map((i) => ({ key: i.key, kind: i.kind, title: i.title, status: i.status, ...(since ? { since: since(i) } : {}) })),
  });
  const s = coverageSets(db, projectId, all, links, seen);
  const of = (id: (typeof GAP_LISTS)[number]) => items.filter((i) => COVERAGE_TESTS[id](i, s, now));
  return {
    no_ac: gap(of('no_ac')),
    no_milestone: gap(of('no_milestone')),
    // A viewer who may not see tasks gets no list at all, so the answer never says that hidden tasks exist (SPEC-BLUEPRINT-05).
    no_task: s.refs ? gap(of('no_task')) : null,
    passing_no_evidence: gap(of('passing_no_evidence')),
    decisions_govern_nothing: gap(of('decisions_govern_nothing')),
    old_questions: gap(of('old_questions').sort((a, b) => questionSince(a) - questionSince(b) || a.key.localeCompare(b.key)), questionSince),
  };
}

/** Each list's count: the status report's hub facts (§7). A list the viewer may not see is left out. */
export function coverageCounts(c: Coverage): Partial<Record<(typeof GAP_LISTS)[number], number>> {
  const out: Partial<Record<(typeof GAP_LISTS)[number], number>> = {};
  for (const k of GAP_LISTS) { const g = c[k]; if (g) out[k] = g.count; }
  return out;
}

/** The gaps as plain lines (bp_read and bp_report): one heading per list with gaps, at most `rows` rows each. */
export function coverageText(c: Coverage, rows = 20): string {
  const out: string[] = [];
  for (const k of GAP_LISTS) {
    const g = c[k];
    if (!g?.count) continue;
    out.push(`${GAP_NAMES[k]} · ${g.count}`);
    for (const i of g.items.slice(0, rows)) out.push(`- ${i.key} ${i.title}${i.status ? ` [${i.status}]` : ''}${i.since ? ` · asked ${new Date(i.since).toISOString().slice(0, 10)}` : ''}`);
    if (g.count > rows) out.push(`- and ${g.count - rows} more`);
  }
  if (!out.length) return c.no_task ? 'No gaps: every requirement has criteria, a milestone and a task, and nothing is waiting.' : 'No gaps in the lists you can see.';
  return out.join('\n');
}
