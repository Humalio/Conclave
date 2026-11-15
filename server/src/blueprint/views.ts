/**
 * Project Blueprint (docs/blueprint.md §6, §9): what the admin API reads. The card and Overview summary,
 * one item with its links, tasks and history, the Markdown export (with a paper's outline), and the Home attention
 * items (open proposals, escalations, contradicted claims). Read-only; every answer names its project's id and key,
 * so a later per-user scope can check it (docs/multi-user.md).
 */
import type { Db } from '../db/db.js';
import { KeyError } from '../keys/keys.js';
import { Blueprint, SECTION_KINDS, statusMeanings, type Item, type ProjectRow, type ChainLink } from './blueprint.js';
import { projectRequests } from './requests.js';
import { contradicts, papersForHypothesis, papersForMilestone, resultsOf, isRun, reasonText, type MatchReason } from './support.js';
import { issueText, type Warning } from './plain.js';
import { NOT_COUNTED } from '../teams/teams.js';
import { isRetired, isOpen } from './browse.js';
import { parseSystems } from './external.js';
import { coverage, type Coverage, type TasksSeen } from './coverage.js';
import { questions, blockingCount } from './questions.js';

const err = (code: string, msg: string) => new KeyError(code, msg);
/** The JSON export's format name and version (blueprint.md §4.2); a restore reads these. */
export const EXPORT_FORMAT = 'conclave-blueprint';
export const EXPORT_VERSION = 1;
/** The most characters a JSON export may hold, so whatever the hub exports a restore can take back. */
export const EXPORT_JSON_MAX = 1_900_000;
const DAY = 86_400_000;
/** A report older than this greys out on the card (§7). */
export const REPORT_STALE_DAYS = 14;
export const ATTENTION_MAX = 50;
export const HISTORY_MAX = 50;
export const PROJECTS_MAX = 100;

export interface ProjectRef { id: string; key: string; name: string }
const ref = (p: ProjectRow): ProjectRef => ({ id: p.id, key: p.key, name: p.name });
const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
const live = (i: Item) => !i.deleted_at;
const count = (xs: Item[], f: (i: Item) => boolean) => xs.filter(f).length;
const liveOf = (i: Item) => !isRetired(i.kind, i.status);
const actorLabel = (kind: string, id: string | null) => `${kind}${id ? `:${id}` : ''}`;
/** The signed-in user an operator revision names (a decider or an admin), so history reads their name and not just "operator". */
const userName = (db: Db, kind: string, id: string | null): string | null => kind === 'operator' && id ? (db.prepare('SELECT username FROM admin_users WHERE id=?').get(id) as { username: string } | undefined)?.username ?? null : null;

export interface Bar { done: number; total: number }
export interface Measures {
  kind: 'implementation' | 'research';
  /** implementation: FRs verified of live, ACs passing, milestones reached; research: hypotheses decided, lines active, findings this month (§9). */
  bars: Record<string, Bar>;
}
export interface Health { key: string; health: string; at: number; team_id: string | null; age_days: number; stale: boolean; escalate: boolean }
export interface PaperState { key: string; title: string; status: string | null; target_at: number | null; team_id: string | null; supported: number; total: number; ready: boolean; holding: string[] }

export class BlueprintViews {
  constructor(private readonly db: Db, private readonly bp: Blueprint) {}

  mustProject(id: string): ProjectRow {
    const p = this.bp.project(id);
    if (!p) throw err('not_found', 'No such project.');
    return p;
  }
  private teamsOf(projectId: string): { id: string; name: string; status: string }[] {
    return this.db.prepare('SELECT id, name, status FROM teams WHERE project_id=? ORDER BY created_at').all(projectId) as { id: string; name: string; status: string }[];
  }
  private mustTeamIn(p: ProjectRow, teamId: string): { id: string; name: string } {
    const t = this.teamsOf(p.id).find((x) => x.id === teamId);
    if (!t) throw err('invalid_argument', `Team ${teamId} is not part of project ${p.key}.`);
    return t;
  }

  measures(kind: 'implementation' | 'research', items: Item[], now = Date.now()): Measures {
    const st = (k: string) => items.filter((i) => i.kind === k);
    if (kind === 'research') {
      const hs = st('hypothesis').filter(liveOf);
      return { kind, bars: {
        hypotheses: { done: count(hs, (h) => ['confirmed', 'refuted', 'inconclusive'].includes(h.status ?? '')), total: hs.length },
        lines: { done: count(st('line'), (l) => isOpen(l.kind, l.status)), total: st('line').length },
        findings_month: { done: count(st('finding'), (f) => f.created_at >= now - 30 * DAY), total: st('finding').length },
      } };
    }
    // Each total is the browse list it opens (§6.1): the live FRs and NFRs, criteria and milestones.
    const frs = [...st('fr'), ...st('nfr')].filter(liveOf), acs = st('ac').filter(liveOf), ms = st('milestone').filter(liveOf);
    return { kind, bars: {
      frs: { done: count(frs, (f) => f.status === 'verified'), total: frs.length },
      acs: { done: count(acs, (a) => a.status === 'passing'), total: acs.length },
      milestones: { done: count(ms, (m) => m.status === 'reached'), total: ms.length },
    } };
  }

  private health(items: Item[], now: number): Health | null {
    const r = items.filter((i) => i.kind === 'report').sort((a, b) => b.created_at - a.created_at || b.key.localeCompare(a.key))[0];
    if (!r) return null;
    const age = Math.floor((now - r.created_at) / DAY);
    return { key: r.key, health: String(r.fields['health'] ?? 'unknown'), at: r.created_at, team_id: r.team_id, age_days: age, stale: age > REPORT_STALE_DAYS, escalate: r.fields['escalate'] === true };
  }

  papers(projectId: string, items: Item[]): PaperState[] {
    const papers = items.filter((i) => i.kind === 'paper' && i.status !== 'dropped');
    const claims = papers.length ? this.bp.claimStates(projectId, { papers: papers.map((i) => i.key) }) : [];
    return papers.map((i) => {
      const pp = Blueprint.readiness(claims.filter((c) => c.parent === i.key));
      return { key: i.key, title: i.title, status: i.status, target_at: (i.fields['target_at'] as number | undefined) ?? null, team_id: i.team_id, supported: pp.supported, total: pp.total, ready: pp.ready, holding: pp.holding };
    }).sort((a, b) => (a.target_at ?? Infinity) - (b.target_at ?? Infinity) || a.key.localeCompare(b.key));
  }

  /**
   * The research workspace (§2.4, §9): every live paper that is not dropped (planned and published alike) and every live
   * hypothesis, optionally one team's part. `milestone` keeps the papers it delivers, `hypothesis` the papers that study it
   * or cite it as evidence in a claim; both keep the papers matching both. Each paper is listed once, with its reasons.
   * The manuscript is returned as written; the API resolves it for the viewer.
   */
  research(projectId: string, f: { team?: string; milestone?: string; hypothesis?: string } = {}) {
    const p = this.mustProject(projectId);
    const want = (key: string | undefined, kind: string) => {
      if (key === undefined) return;
      const it = this.bp.item(p.id, key);
      if (!it || it.kind !== kind) throw err('invalid_argument', `${key} is not a ${kind} of ${p.key}.`);
    };
    want(f.milestone, 'milestone'); want(f.hypothesis, 'hypothesis');
    const items = this.bp.items(p.id, { kinds: ['paper', 'hypothesis', 'claim', 'line'] });
    const inPart = (i: Item) => !f.team || (f.team === 'project' ? i.team_id === null : i.team_id === f.team);
    const papers = this.papers(p.id, items.filter(inPart)).filter((x) => x.status !== 'dropped');
    const links = this.bp.links(p.id), keys = papers.map((x) => x.key);
    const claims = items.filter((i) => i.kind === 'claim').map((c) => ({ key: c.key, parent: c.parent_key, status: c.status }));
    const filters = [f.milestone !== undefined ? papersForMilestone(f.milestone, keys, links) : null, f.hypothesis !== undefined ? papersForHypothesis(f.hypothesis, keys, links, claims) : null].filter((m): m is Map<string, MatchReason[]> => !!m);
    const by = new Map(items.map((i) => [i.key, i]));
    const rows = papers.filter((x) => filters.every((m) => m.has(x.key))).map((x) => ({
      ...x, manuscript: (by.get(x.key)?.fields['manuscript'] as string | undefined) || null,
      studies: links.filter((l) => l.rel === 'studies' && l.from_key === x.key).map((l) => l.to_key),
      reasons: filters.flatMap((m) => m.get(x.key) ?? []).map((r) => ({ ...r, text: reasonText(r) })),
    }));
    const hypotheses = items.filter((i) => i.kind === 'hypothesis' && inPart(i)).map((h) => ({
      key: h.key, title: h.title, status: h.status, line: h.parent_key, line_title: h.parent_key ? by.get(h.parent_key)?.title ?? null : null, team_id: h.team_id,
      criteria: (h.fields['criteria'] as string | undefined) || null, statement: (h.fields['statement'] as string | undefined) || null,
      papers: papersForHypothesis(h.key, keys, links, claims).size,
    })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    return { project: ref(p), filter: { milestone: f.milestone ?? null, hypothesis: f.hypothesis ?? null, team: f.team ?? null }, papers: rows, hypotheses };
  }

  /**
   * A hypothesis's drill-downs (§2.4): the papers about it with their reasons, its results (findings linked to it as
   * evidence, never the rest of its line), its experiment runs (tasks the team tagged `run` that name it) and its dated
   * status moves from its own revisions. The API empties `runs` for a member without the tasks component.
   */
  private hypothesisResearch(p: ProjectRow, it: Item) {
    const links = this.bp.links(p.id), items = this.bp.items(p.id, { kinds: ['paper', 'claim', 'finding'] }), by = new Map(items.map((i) => [i.key, i]));
    const keys = items.filter((i) => i.kind === 'paper' && i.status !== 'dropped').map((i) => i.key);
    const claims = items.filter((i) => i.kind === 'claim').map((c) => ({ key: c.key, parent: c.parent_key, status: c.status }));
    const papers = [...papersForHypothesis(it.key, keys, links, claims)].map(([k, rs]) => ({ key: k, title: by.get(k)!.title, status: by.get(k)!.status, reasons: rs.map((r) => ({ ...r, text: reasonText(r) })) }));
    const results = resultsOf(it.key, links).map((k) => by.get(k)).filter((x): x is Item => !!x && x.kind === 'finding')
      .map((x) => ({ key: x.key, title: x.title, line: x.parent_key, confidence: (x.fields['confidence'] as string | undefined) ?? null, created_at: x.created_at }));
    const tasks = this.db.prepare(`SELECT k.id, k.title, k.status, k.team_id, k.tags, k.plan_refs, k.updated_at FROM tasks k JOIN teams t ON t.id=k.team_id, json_each(CASE WHEN json_valid(k.plan_refs) THEN k.plan_refs ELSE '[]' END) j
      WHERE t.project_id=? AND j.value=? ORDER BY k.created_at DESC LIMIT 50`).all(p.id, it.key) as { id: string; title: string; status: string; team_id: string; tags: string; plan_refs: string; updated_at: number }[];
    const runs = tasks.filter((k) => isRun({ tags: parse<string[]>(k.tags, []), refs: parse<string[]>(k.plan_refs, []) }, it.key)).map((k) => ({ id: k.id, title: k.title, status: k.status, team_id: k.team_id, updated_at: k.updated_at }));
    const revs = this.bp.revisions(it.id).slice().reverse(), changes: { at: number; was: string | null; to: string | null; actor: string }[] = [];
    for (let i = 0; i < revs.length; i++) {
      const was = i ? ((revs[i - 1]!.snapshot['status'] as string | undefined) ?? null) : null, to = (revs[i]!.snapshot['status'] as string | undefined) ?? null;
      if (i === 0 || was !== to) changes.push({ at: revs[i]!.at, was, to, actor: actorLabel(revs[i]!.actor_kind, revs[i]!.actor_id) });
    }
    return { papers, results, runs, changes: changes.reverse() };
  }

  /** What needs the operator in these items: open proposals, unclear FRs/NFRs, failing ACs, claims not supported. */
  private needsMe(projectId: string, items: Item[], teamId?: string): Record<string, number> {
    const proposals = (this.db.prepare(`SELECT COUNT(*) n FROM bp_proposals WHERE project_id=? AND status='open' ${teamId ? 'AND team_id=?' : ''}`).get(...(teamId ? [projectId, teamId] : [projectId])) as { n: number }).n;
    const claims = this.bp.claimStates(projectId, { keys: items.filter((i) => i.kind === 'claim' && i.status !== 'cut').map((c) => c.key) }).map((c) => c.support);
    return {
      proposals,
      unclear: count(items, (i) => (i.kind === 'fr' || i.kind === 'nfr') && i.fields['unclear'] === true && i.status !== 'dropped'),
      failing_acs: count(items, (i) => i.kind === 'ac' && i.status === 'failing'),
      claims_not_supported: claims.filter((s) => s !== 'supported').length,
    };
  }

  /**
   * The card and the Overview (§9): measures, newest report's health and age, next milestone, papers with their ready
   * state (the nearest first), open risks (high impact first, two), what needs the operator; without `team`, one row
   * per team with its part's measures. The only team of a project reads the whole project (scope `project`, FR-PLAN-12).
   */
  summary(projectId: string, teamId?: string, now = Date.now(), o: { only?: Set<string>; tasks?: TasksSeen } = {}) {
    const p = this.mustProject(projectId);
    // Parentage gives no permission (§3): a member sees the ecosystem only with a grant on it.
    const parent = p.parent_id && (!o.only || o.only.has(p.parent_id)) ? this.bp.project(p.parent_id) : undefined;
    const team = teamId ? this.mustTeamIn(p, teamId) : null;
    const all = this.bp.items(p.id);
    const part = !!team && this.bp.soleTeam(p.id) !== team.id;
    const items = part ? all.filter((i) => i.team_id === team!.id) : all;
    const ms = items.filter((i) => i.kind === 'milestone' && (i.status === 'planned' || i.status === 'in_progress'))
      .sort((a, b) => ((a.fields['target_at'] as number | undefined) ?? Infinity) - ((b.fields['target_at'] as number | undefined) ?? Infinity) || a.position - b.position)[0];
    const IMPACT: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const risks = items.filter((i) => i.kind === 'risk' && i.status === 'open')
      .sort((a, b) => (IMPACT[String(a.fields['impact'])] ?? 3) - (IMPACT[String(b.fields['impact'])] ?? 3) || a.key.localeCompare(b.key));
    const papers = this.papers(p.id, items);
    const teams = this.teamsOf(p.id);
    const requests = projectRequests(this.db, p.id, team?.id);
    return {
      project: { ...ref(p), kind: p.kind, status: p.status, version: p.version, report_requested_at: requests[0]?.requested_at ?? null, single_team: !!p.single_team, parent: parent ? ref(parent) : null, ecosystem: this.bp.isEcosystem(p.id), status_meanings: statusMeanings(p) },
      // The teams that contribute (not stopped): the Team select is offered only when there are two or more (§3).
      contributing: this.bp.contributingTeams(p.id).length,
      // Open report and plan requests, one per asked team (F-04): each team answers for its own part.
      report_requests: requests.map((r) => ({ team: { id: r.team_id, name: teams.find((t) => t.id === r.team_id)?.name ?? r.team_id }, scope: r.scope, kind: r.kind, note: r.note, requested_at: r.requested_at })),
      team: team ? { id: team.id, name: team.name } : null,
      scope: part ? 'part' : 'project', teams: teams.length,
      // Items per kind in this part (or the project): the section counts of the Blueprint screen and the team card.
      by_kind: items.reduce<Record<string, number>>((a, i) => { a[i.kind] = (a[i.kind] ?? 0) + 1; return a; }, {}),
      // A team's summary also counts the project-level items (null for the project's own): a team's foundation and appendix show them too.
      shared_by_kind: part ? all.filter((i) => i.team_id === null).reduce<Record<string, number>>((a, i) => { a[i.kind] = (a[i.kind] ?? 0) + 1; return a; }, {}) : null,
      measures: this.measures(p.kind, items, now),
      health: this.health(items, now),
      next_milestone: ms ? { key: ms.key, title: ms.title, status: ms.status, target_at: (ms.fields['target_at'] as number | undefined) ?? null } : null,
      papers, nearest_paper: papers[0] ?? null,
      // Coverage counts only the tasks this viewer may see (the admin: all of them; §6).
      plain: this.plainSummary(p.id, items, { all, tasks: o.tasks === undefined ? 'all' : o.tasks, now }),
      // The card's Dropped row: the retired items of this part (§6.1, selection `dropped`).
      dropped: count(items, (i) => isRetired(i.kind, i.status)),
      // The card's Questions row (§9): open questions, and the open issues and questions that block an open item.
      questions: (() => { const q = questions(items, all, this.bp.links(p.id), p.kind === 'research', 'open', now); return { open: q.counts.open, blocking: blockingCount(q) }; })(),
      risks: { open: risks.length, top: risks.slice(0, 2).map((r) => ({ key: r.key, title: r.title, impact: r.fields['impact'] ?? null, likelihood: r.fields['likelihood'] ?? null })) },
      needs_me: this.needsMe(p.id, items, part ? team!.id : undefined),
      parts: team ? undefined : teams.map((t) => {
        const mine = all.filter((i) => i.team_id === t.id);
        return { team: { id: t.id, name: t.name, status: t.status }, items: mine.length, measures: this.measures(p.kind, mine, now), health: this.health(mine, now), papers: this.papers(p.id, mine).map((x) => ({ key: x.key, ready: x.ready, supported: x.supported, total: x.total })) };
      }),
    };
  }

  /**
   * GET /api/projects/:id/overview (§3): an ecosystem's projects that the viewer may see, each with its health and the
   * date of its newest report (null: "No report yet"), its next milestone and the proposals waiting. A member's view is
   * built only from children they hold a grant on, and counts only the proposals routed to them.
   */
  overview(projectId: string, o: { only?: Set<string>; proposals?: Set<string> } = {}, now = Date.now()) {
    const p = this.mustProject(projectId);
    const children = this.bp.children(p.id).filter((c) => !o.only || o.only.has(c.id));
    return {
      project: { ...ref(p), ecosystem: children.length > 0 || this.bp.isEcosystem(p.id) },
      children: children.map((c) => {
        const s = this.summary(c.id, undefined, now, { only: o.only });
        const waiting = o.proposals
          ? (this.db.prepare("SELECT id FROM bp_proposals WHERE project_id=? AND status='open'").all(c.id) as { id: string }[]).filter((r) => o.proposals!.has(r.id)).length
          : s.needs_me.proposals ?? 0;
        return {
          project: { ...ref(c), kind: c.kind, status: c.status }, teams: s.teams,
          health: s.health,
          next_milestone: s.next_milestone, waiting: { proposals: waiting },
        };
      }),
    };
  }

  /** GET /api/projects: each project with its counts, newest health and its papers' ready state; paged by offset. */
  list(o: { cursor?: number; limit?: number; status?: string; only?: Set<string> } = {}, now = Date.now()) {
    const limit = Math.max(1, Math.min(PROJECTS_MAX, o.limit ?? 50)), offset = Math.max(0, o.cursor ?? 0);
    const all = this.bp.projects().filter((p) => (!o.status || p.status === o.status) && (!o.only || o.only.has(p.id)));
    const page = all.slice(offset, offset + limit).map((p) => {
      const items = this.bp.items(p.id);
      const byKind: Record<string, number> = {};
      for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
      const proposals = (this.db.prepare("SELECT COUNT(*) n FROM bp_proposals WHERE project_id=? AND status='open'").get(p.id) as { n: number }).n;
      return {
        ...ref(p), kind: p.kind, status: p.status, review_policy: p.review_policy, task_intake: p.task_intake, member_board: !!p.member_board, version: p.version, updated_at: p.updated_at,
        single_team: !!p.single_team, parent_id: p.parent_id && (!o.only || o.only.has(p.parent_id)) ? p.parent_id : null, ecosystem: this.bp.isEcosystem(p.id), status_meanings: statusMeanings(p),
        external_systems: parseSystems(p.external_systems),
        teams: this.teamsOf(p.id).map((t) => ({ id: t.id, name: t.name })),
        counts: { items: items.length, by_kind: byKind, open_proposals: proposals },
        health: this.health(items, now),
        papers: this.papers(p.id, items).map((x) => ({ key: x.key, title: x.title, status: x.status, target_at: x.target_at, ready: x.ready, supported: x.supported, total: x.total })),
      };
    });
    return { projects: page, total: all.length, next_cursor: offset + limit < all.length ? offset + limit : null };
  }

  /** One item: fields, links both ways with the other end, tasks that name it, its last 10 revisions; a paper adds its claims, a claim its chain. */
  detail(projectId: string, key: string) {
    const p = this.mustProject(projectId);
    const it = this.bp.item(p.id, key, true);
    if (!it) throw err('not_found', `No item ${key} in ${p.key}.`);
    const other = (k: string) => { const o = this.bp.item(p.id, k); return o ? { key: o.key, kind: o.kind, title: o.title, status: o.status, ...(o.kind === 'milestone' && typeof o.fields['short'] === 'string' && o.fields['short'] ? { short: o.fields['short'] } : {}) } : { key: k, kind: null, title: null, status: null }; };
    const links = this.db.prepare('SELECT * FROM bp_links WHERE project_id=? AND (from_key=? OR to_key=?) ORDER BY rel, from_key, to_key').all(p.id, key, key) as { from_key: string; to_key: string; rel: string; created_at: number }[];
    const tasks = this.db.prepare(`SELECT k.id, k.title, k.status, k.team_id FROM tasks k JOIN teams t ON t.id=k.team_id, json_each(CASE WHEN json_valid(k.plan_refs) THEN k.plan_refs ELSE '[]' END) j
      WHERE t.project_id=? AND j.value=? ORDER BY k.created_at DESC LIMIT 50`).all(p.id, key) as { id: string; title: string; status: string; team_id: string }[];
    const revs = this.bp.revisions(it.id);
    const out: Record<string, unknown> = {
      // What its statuses (and its criteria's) mean here, for the pill's tip (§3, §9).
      project: { ...ref(p), ...(['fr', 'nfr', 'ac'].includes(it.kind) ? { status_meanings: statusMeanings(p) } : {}) },
      item: { key: it.key, kind: it.kind, parent: it.parent_key, title: it.title, body: it.body, fields: it.fields, status: it.status, team_id: it.team_id, position: it.position, rev: it.rev,
        created_by: actorLabel(it.created_by_kind, it.created_by_id), created_at: it.created_at, updated_by: actorLabel(it.updated_by_kind, it.updated_by_id), updated_at: it.updated_at, deleted_at: it.deleted_at,
        archived: !!it.archived },
      // An archived item lists the children archived with it (§6.1), with their fields: no browse read can reach them, so its ACs draw from here.
      children: it.deleted_at ? [] : this.bp.items(p.id, { includeArchived: !!it.archived }).filter((c) => c.parent_key === key)
        .map((c) => ({ key: c.key, kind: c.kind, title: c.title, status: c.status, ...(it.archived ? { fields: c.fields } : {}) })),
      links: {
        out: links.filter((l) => l.from_key === key).map((l) => ({ rel: l.rel, ...other(l.to_key) })),
        in: links.filter((l) => l.to_key === key).map((l) => ({ rel: l.rel, ...other(l.from_key) })),
      },
      // Every task naming the item is listed; done/total count accepted, live work only (like team progress): not backlog, cancelled or discarded.
      tasks: { items: tasks, done: tasks.filter((t) => t.status === 'done').length, total: tasks.filter((t) => !NOT_COUNTED.includes(t.status)).length },
      history: { revisions: revs.slice(0, 10).map((r) => ({ rev: r.rev, at: r.at, actor: actorLabel(r.actor_kind, r.actor_id), actor_name: userName(this.db, r.actor_kind, r.actor_id), note: r.change_note, snapshot: r.snapshot })), total: revs.length },
    };
    // The operator's answer to the question that marked a requirement unclear, kept after the mark is cleared (the revisions hold the ask's id).
    if (it.kind === 'fr' || it.kind === 'nfr') {
      const asks = [it.fields['unclear_ask'], ...revs.map((r) => (r.snapshot['fields'] as Record<string, unknown> | undefined)?.['unclear_ask'])].filter((x, i, a): x is string => typeof x === 'string' && a.indexOf(x) === i);
      for (const id of asks) {
        const a = this.db.prepare("SELECT id, answer_text, answered_at, answered_by FROM decisions WHERE id=? AND status='answered'").get(id) as { id: string; answer_text: string | null; answered_at: number | null; answered_by: string | null } | undefined;
        if (!a) continue;
        const who = a.answered_by ? (this.db.prepare('SELECT username FROM admin_users WHERE id=?').get(a.answered_by) as { username: string } | undefined)?.username ?? null : null;
        out['clarification'] = { text: a.answer_text, by_label: who ?? 'the operator', at: a.answered_at, decision_id: a.id };
        break;
      }
    }
    if (!it.deleted_at) {
      // Plain reading (docs/blueprint.md §2.7): only the server tokenises; the console marks the exact tokens it is given.
      const issues: Warning[] = this.bp.plainIssues(p.id).get(key) ?? [];
      out['plain'] = { ...this.bp.plainOf(p.id, it), issues: issues.map((w) => ({ kind: w.kind, message: w.message, issue: issueText(w) })) };
      const st = this.bp.standing(p.id, key);
      if (st) out['standing'] = st;
      const nx = this.bp.nextStep(p.id, key);
      if (nx) out['next'] = nx;
    }
    if (!it.deleted_at && it.kind === 'hypothesis') out['research'] = this.hypothesisResearch(p, it);
    if (!it.deleted_at && it.kind === 'claim') { const c = this.bp.claim(p.id, key)!; out['support'] = c.support; out['chain'] = this.bp.chain(p.id, key); }
    // Decided in (§9): every decision whose source names this question, with its status; a superseded one names its successor.
    if (!it.deleted_at && it.kind === 'question') {
      out['decided_in'] = this.bp.items(p.id, { kinds: ['decision'] }).filter((d) => d.fields['source'] === `bp:${key}`)
        .map((d) => ({ key: d.key, title: d.title, status: d.status, superseded_by: typeof d.fields['superseded_by'] === 'string' ? d.fields['superseded_by'] : null }));
    }
    if (!it.deleted_at && it.kind === 'paper') {
      const pp = this.bp.paper(p.id, key)!;
      out['paper'] = { ready: pp.ready, supported: pp.supported, total: pp.total, holding: pp.holding, claims: pp.claims.map((c) => ({ ...c, part: this.bp.item(p.id, c.key)?.fields['part'] ?? null, chain: this.bp.chain(p.id, c.key) })) };
    }
    return out;
  }

  /**
   * The codes nobody has defined yet, most used first (at most 50, five keys each), and the acceptance criteria that say
   * nothing to check: the Appendix's Not defined list (§2.3) and the operator's check of a rewrite.
   */
  plainSummary(projectId: string, items: Item[], cov?: { all: Item[]; tasks: TasksSeen; now?: number }): { undefined_codes: { token: string; count: number; keys: string[] }[]; empty_acs: number; coverage?: Coverage } {
    const known = this.bp.glossary(projectId), codes = new Map<string, string[]>();
    for (const i of items) {
      if (i.kind === 'term' || i.kind === 'report') continue;
      for (const c of this.bp.plainOf(projectId, i, known).codes) if (!c.term) (codes.get(c.token) ?? codes.set(c.token, []).get(c.token)!).push(i.key);
    }
    const issues = this.bp.plainIssues(projectId), keys = new Set(items.map((i) => i.key));
    return {
      undefined_codes: [...codes].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 50).map(([token, ks]) => ({ token, count: ks.length, keys: ks.slice(0, 5) })),
      empty_acs: [...issues].filter(([k, ws]) => keys.has(k) && ws.some((w) => w.kind === 'empty_ac')).length,
      ...(cov ? { coverage: coverage(this.db, projectId, items, cov.all, this.bp.links(projectId), cov.tasks, cov.now) } : {}),
    };
  }

  /** An item's revisions, newest first, paged below a revision number. */
  history(projectId: string, key: string, o: { before?: number; limit?: number } = {}) {
    const p = this.mustProject(projectId);
    const it = this.bp.item(p.id, key, true);
    if (!it) throw err('not_found', `No item ${key} in ${p.key}.`);
    const limit = Math.max(1, Math.min(HISTORY_MAX, o.limit ?? 20));
    const all = this.bp.revisions(it.id).filter((r) => o.before === undefined || r.rev < o.before);
    const page = all.slice(0, limit);
    return { project: ref(p), key, revisions: page.map((r) => ({ rev: r.rev, at: r.at, actor: actorLabel(r.actor_kind, r.actor_id), actor_name: userName(this.db, r.actor_kind, r.actor_id), note: r.change_note, snapshot: r.snapshot })),
      next: all.length > limit ? page.at(-1)!.rev : null };
  }

  /**
   * Home attention items (§7, §9): open proposals (oldest first), escalations (a team's newest report asks for the
   * operator) and contradicted paper claims (computed now, so one shows the moment its evidence turns). At most `limit`.
   */
  attention(o: { limit?: number; only?: { projects: Set<string>; proposals: Set<string> } } = {}, now = Date.now()) {
    const limit = Math.max(1, Math.min(ATTENTION_MAX, o.limit ?? 20));
    // A member: granted projects only, and only the proposals routed to them; counts from those only.
    const only = o.only;
    const projects = new Map(this.bp.projects().filter((p) => !only || only.projects.has(p.id)).map((p) => [p.id, p]));
    const teamName = new Map((this.db.prepare('SELECT id, name FROM teams').all() as { id: string; name: string }[]).map((t) => [t.id, t.name]));
    const team = (id: string | null) => (id ? { id, name: teamName.get(id) ?? id } : null);
    const agentLabel = (id: string | null) => (id ? ((this.db.prepare('SELECT label FROM agents WHERE id=?').get(id) as { label: string } | undefined)?.label ?? id) : null);
    type Att = { kind: 'bp_proposal' | 'bp_escalation' | 'bp_contradicted' | 'bp_blocking'; id: string; at: number; project: ProjectRef; team: { id: string; name: string } | null; title: string; [k: string]: unknown };
    // A routed proposal in a project the member may not read stays out, like the project itself.
    const within = only ? ' AND id IN (SELECT value FROM json_each(?)) AND project_id IN (SELECT value FROM json_each(?))' : '';
    const withinArgs = only ? [JSON.stringify([...only.proposals]), JSON.stringify([...projects.keys()])] : [];
    const proposals: Att[] = (this.db.prepare(`SELECT id, project_id, team_id, agent_id, ops, type, replan_id, created_at FROM bp_proposals WHERE status='open'${within} ORDER BY created_at, id LIMIT ?`).all(...withinArgs, ATTENTION_MAX) as { id: string; project_id: string; team_id: string | null; agent_id: string | null; ops: string; type: string; replan_id: string | null; created_at: number }[])
      .filter((r) => projects.has(r.project_id))
      .map((r): Att => {
        const ops = parse<{ op: string; key?: string; from?: string; to?: string }[]>(r.ops, []);
        const keys = [...new Set(ops.map((x) => (x.from ? `${x.from}→${x.to}` : String(x.key))))];
        const title = r.type === 'replan'
          ? `Blueprint re-plan ${r.replan_id ?? ''} submitted: ${team(r.team_id) ? `${team(r.team_id)!.name}'s part` : 'the whole project'}, reviewed as a whole`
          : `Blueprint proposal: ${ops.length} change${ops.length === 1 ? '' : 's'} (${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ` and ${keys.length - 4} more` : ''})`;
        return { kind: 'bp_proposal', id: r.id, at: r.created_at, project: ref(projects.get(r.project_id)!), team: team(r.team_id), agent: { id: r.agent_id, label: agentLabel(r.agent_id) },
          title, type: r.type, ...(r.type === 'replan' ? { replan_id: r.replan_id } : {}), ops: ops.length, keys: keys.slice(0, 10), age_days: Math.floor((now - r.created_at) / DAY) };
      });
    // A team's newest report decides: a later report without escalate clears it.
    const newest = this.db.prepare(`SELECT i.* FROM bp_items i WHERE i.kind='report' AND i.deleted_at IS NULL AND i.archived=0 AND i.team_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM bp_items j WHERE j.project_id=i.project_id AND j.team_id=i.team_id AND j.kind='report' AND j.deleted_at IS NULL AND (j.created_at>i.created_at OR (j.created_at=i.created_at AND j.key>i.key)))`).all() as { project_id: string; team_id: string; key: string; fields: string; created_at: number }[];
    const escalations: Att[] = newest.map((r) => ({ r, f: parse<Record<string, unknown>>(r.fields, {}) })).filter((x) => x.f['escalate'] === true && projects.has(x.r.project_id))
      .map(({ r, f }): Att => ({ kind: 'bp_escalation', id: `${r.project_id}:${r.key}`, at: r.created_at, project: ref(projects.get(r.project_id)!), team: team(r.team_id), key: r.key, health: f['health'] ?? null,
        blockers: Array.isArray(f['blockers']) ? (f['blockers'] as string[]).slice(0, 3) : [], title: `Escalated in ${r.key}` }))
      .sort((a, b) => b.at - a.at);
    const contradicted: Att[] = [];
    // Two queries per project that has claims, whatever their number.
    const withClaims = new Set((this.db.prepare("SELECT DISTINCT project_id FROM bp_items WHERE kind='claim' AND deleted_at IS NULL").all() as { project_id: string }[]).map((r) => r.project_id));
    for (const p of projects.values()) {
      if (!withClaims.has(p.id)) continue;
      for (const c of this.bp.claimStates(p.id)) {
        if (c.status === 'cut' || c.support !== 'contradicted') continue;
        const against = c.evidence.filter(contradicts);
        const at = Math.max(c.updated_at, ...against.map((e) => e.updated_at));
        contradicted.push({ kind: 'bp_contradicted', label: 'paper claim', id: `${p.id}:${c.key}`, at, project: ref(p), team: team(c.team_id), key: c.key, paper: c.parent, by: against.map((e) => `${e.key} ${e.status}`),
          title: `Paper claim ${c.key} contradicted by ${against.map((e) => e.key).join(', ')}` });
      }
    }
    contradicted.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Blocking work (§6): one For awareness row per project and part with open issues or questions that block an open item.
    // Only blocking items come here, never every open question; the row leaves when its blockers stop blocking.
    const blocking: Att[] = [];
    const withBlocks = new Set((this.db.prepare("SELECT DISTINCT project_id FROM bp_links WHERE rel='blocks'").all() as { project_id: string }[]).map((r) => r.project_id));
    for (const p of projects.values()) {
      if (!withBlocks.has(p.id)) continue;
      const all = this.bp.items(p.id), q = questions(all, all, this.bp.links(p.id), p.kind === 'research', 'open', now);
      const rows = [...q.blocking, ...q.items.filter((i) => i.blocks.length)];
      const parts = new Map<string | null, typeof rows>();
      // A project with one team is one part, as on its card.
      const sole = this.bp.soleTeam(p.id), part = (r: { team_id: string | null }) => sole ?? r.team_id;
      for (const r of rows) (parts.get(part(r)) ?? parts.set(part(r), []).get(part(r))!).push(r);
      for (const [tid, L] of parts) {
        L.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
        blocking.push({ kind: 'bp_blocking', id: `${p.id}:${tid ?? 'project'}:blocking`, at: L[0]!.since, project: ref(p), team: team(tid), count: L.length,
          keys: L.slice(0, 10).map((r) => r.key), age_days: Math.floor((now - L[0]!.since) / DAY),
          title: `${L.length} ${L.length === 1 ? 'item blocks' : 'items block'} work in ${p.name}` });
      }
    }
    // Escalations and contradictions first (they are about the work), then proposals waiting on the operator.
    // The list holds at most ATTENTION_MAX proposals; the count is the true one.
    const open = (this.db.prepare(`SELECT COUNT(*) n FROM bp_proposals WHERE status='open'${within}`).get(...withinArgs) as { n: number }).n;
    const all = [...escalations, ...contradicted, ...blocking, ...proposals];
    return { items: all.slice(0, limit), counts: { proposals: open, escalations: escalations.length, contradicted: contradicted.length, blocking: blocking.length }, total: all.length - proposals.length + open };
  }

  /**
   * The blueprint as JSON (blueprint.md §4.2), admin-only: every item, archived reports included, and every link, so
   * nothing is lost for a rebuild. Writers are `{kind, id}`; an operator's console id is left out. Bounded: a project
   * whose export would pass `max` characters is refused with `too_large` rather than cut short.
   */
  exportJson(projectId: string, now = Date.now(), max = EXPORT_JSON_MAX): { name: string; text: string } {
    const p = this.mustProject(projectId);
    const who = (kind: string, id: string | null) => ({ kind, id: kind === 'operator' ? null : id });
    const items = this.bp.items(p.id, { includeArchived: true }).map((i) => ({
      key: i.key, kind: i.kind, parent_key: i.parent_key, title: i.title, body: i.body, status: i.status, fields: i.fields, position: i.position, team_id: i.team_id,
      created_by: who(i.created_by_kind, i.created_by_id), updated_by: who(i.updated_by_kind, i.updated_by_id), ...(i.archived ? { archived: true } : {}),
    }));
    const doc = {
      format: EXPORT_FORMAT, version: EXPORT_VERSION, project: { key: p.key, name: p.name, kind: p.kind, version: p.version }, generated_at: new Date(now).toISOString(),
      items, links: this.bp.links(p.id).map((l) => ({ from: l.from_key, to: l.to_key, rel: l.rel })),
    };
    const text = `${JSON.stringify(doc, null, 1)}\n`;
    if (text.length > max) throw err('too_large', `This Blueprint's JSON export would be ${text.length} characters, over the ${max} an export may hold.`);
    return { name: `${p.key}-blueprint.json`, text };
  }

  /**
   * The blueprint as Markdown (§6, §8): sections in order, tracks with what sits in them, links as key lists. With
   * `paper`, that paper's framing and its claims with support and evidence: the writer's outline.
   */
  exportMarkdown(projectId: string, paperKey?: string, now = Date.now()): { name: string; text: string } {
    const p = this.mustProject(projectId);
    // The export is where archived items live on (§6, §6.1): it lists them with the live ones, marked "archived".
    const items = this.bp.items(p.id, { includeArchived: true });
    const links = this.bp.links(p.id);
    const by = new Map(items.map((i) => [i.key, i]));
    const kids = (k: string) => items.filter((i) => i.parent_key === k).sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
    const date = (n: unknown) => (typeof n === 'number' ? new Date(n).toISOString().slice(0, 10) : null);
    const one = (s: string) => s.replace(/\s+/g, ' ').trim();
    const linkLine = (k: string) => {
      const out = links.filter((l) => l.from_key === k).map((l) => `${l.rel} ${l.to_key}`), inn = links.filter((l) => l.to_key === k).map((l) => `${l.rel} ← ${l.from_key}`);
      return [...out, ...inn].length ? `  - Links: ${[...out, ...inn].join('; ')}` : '';
    };
    const fieldLine = (i: Item) => {
      const f = Object.entries(i.fields).filter(([k, v]) => k !== 'auto' && v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
        .map(([k, v]) => `${k}: ${/(_at)$/.test(k) && typeof v === 'number' ? date(v) : typeof v === 'object' ? one(JSON.stringify(v)) : one(String(v))}`);
      return f.length ? `  - ${f.join(' · ')}` : '';
    };
    const head = `# ${p.name} (${p.key}) · Blueprint`;
    const gen = `<!-- generated by the hub at version ${p.version} on ${new Date(now).toISOString().slice(0, 10)}; edit in the hub -->`;

    if (paperKey) {
      const pp = this.bp.paper(p.id, paperKey);
      if (!pp) throw err('not_found', `No paper ${paperKey} in ${p.key}.`);
      const L = [gen, '', `# ${pp.item.title} (${pp.item.key})`, '', `Project ${p.name} (${p.key}) · status ${pp.item.status} · ${pp.supported} of ${pp.total} claims supported · ${pp.ready ? 'ready to write' : 'not ready'}`];
      const f = pp.item.fields;
      const meta = [f['venue'] && `Venue: ${one(String(f['venue']))}`, f['type'] && `Type: ${f['type']}`, f['target_at'] && `Deadline: ${date(f['target_at'])}`,
        Array.isArray(f['authors']) && (f['authors'] as string[]).length && `Authors: ${(f['authors'] as string[]).join(', ')}`, f['manuscript'] && `Manuscript: ${f['manuscript']}`].filter(Boolean);
      if (meta.length) L.push('', ...meta.map((m) => `- ${m}`));
      if (pp.item.body) L.push('', '## Framing', '', pp.item.body);
      const parts = ['intro', 'method', 'results', 'discussion', null];
      const claims = pp.claims.map((c) => ({ ...c, part: (by.get(c.key)?.fields['part'] as string | undefined) ?? null }));
      const chainLine = (c: ChainLink, depth: number): string[] => [`${'  '.repeat(depth)}- ${c.key} (${c.kind}${c.status ? `, ${c.status}` : ''}${c.confidence ? `, ${c.confidence}` : ''}): ${one(c.title)}`, ...(c.from ?? []).flatMap((x) => chainLine(x, depth + 1))];
      for (const part of parts) {
        const cs = claims.filter((c) => c.part === part && c.status !== 'cut');
        if (!cs.length) continue;
        L.push('', `## ${part ? part[0]!.toUpperCase() + part.slice(1) : 'Unplaced claims'}`);
        for (const c of cs) {
          L.push('', `### ${c.key} · ${c.support}${c.status === 'final' ? ' · final' : ''}`, '', one(c.title));
          const chain = this.bp.chain(p.id, c.key);
          L.push('', ...(chain.length ? chain.flatMap((x) => chainLine(x, 0)) : ['- No evidence linked yet.']));
        }
      }
      const cut = claims.filter((c) => c.status === 'cut');
      if (cut.length) L.push('', '## Cut', '', ...cut.map((c) => `- ${c.key}: ${one(c.title)}`));
      return { name: `${p.key}-${paperKey}-outline.md`, text: L.join('\n') + '\n' };
    }

    const TITLES = ['', 'Project Foundation', 'Product Requirements', 'Technical Decisions & Architecture', 'Planning & Execution', 'Tracking & Governance', 'Appendix'];
    const archived = items.filter((i) => i.archived).length, reports = items.filter((i) => i.archived && i.kind === 'report').length;
    const also = [reports ? `${reports} archived status report${reports === 1 ? '' : 's'}` : '', archived - reports ? `${archived - reports} archived item${archived - reports === 1 ? '' : 's'}` : ''].filter(Boolean);
    const L = [gen, '', head, '', `Kind ${p.kind} · status ${p.status} · version ${p.version} · ${items.length - archived} items${also.map((s) => ` · ${s}`).join('')}`];
    const claims = this.bp.claimStates(p.id), support = new Map(claims.map((c) => [c.key, c.support]));
    const render = (i: Item, depth: number): string[] => {
      const pad = '  '.repeat(depth);
      const extra = (i.kind === 'claim' ? ` · ${support.get(i.key)}` : '') + (i.kind === 'paper' ? (() => { const pp = Blueprint.readiness(claims.filter((c) => c.parent === i.key)); return ` · ${pp.supported} of ${pp.total} supported${pp.ready ? ' · ready' : ''}`; })() : '');
      const out = [`${pad}- **${i.key}** ${one(i.title)}${i.status ? ` · ${i.status}` : ''}${extra}${i.archived ? ' · archived' : ''}`];
      const fl = fieldLine(i), ll = linkLine(i.key);
      if (fl) out.push(pad + fl);
      if (ll) out.push(pad + ll);
      if (i.body && i.kind !== 'architecture') out.push(...i.body.split('\n').map((x) => `${pad}  > ${x}`));
      for (const c of kids(i.key)) out.push(...render(c, depth + 1));
      return out;
    };
    for (let s = 1; s <= 6; s++) {
      const kinds = SECTION_KINDS[s]!;
      const top = items.filter((i) => kinds.includes(i.kind) && (i.parent_key === null || !by.has(i.parent_key)))
        .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.position - b.position || a.key.localeCompare(b.key));
      if (!top.length) continue;
      L.push('', `## ${s}. ${TITLES[s]}`);
      const arch = top.find((i) => i.kind === 'architecture');
      if (arch?.body) L.push('', '### Architecture', '', arch.body);
      const rest = top.filter((i) => i.kind !== 'architecture');
      if (rest.length) L.push('', ...rest.flatMap((i) => render(i, 0)));
    }
    return { name: `${p.key}-blueprint.md`, text: L.join('\n') + '\n' };
  }
}
