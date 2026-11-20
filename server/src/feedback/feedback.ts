/**
 * Agent feedback (docs/feedback.md): reports about the hub itself, filed by agents, backed by many, triaged by the operator.
 *
 * This module owns the data and the rules. The MCP tools (mcp/feedbackTools.ts) and the admin routes (admin/feedbackApi.ts)
 * are thin layers over it. What a reader may see is decided here (summary and detail layers), except link access, which
 * depends on the reader's current permissions and is passed in as a callback.
 */
import { l2 } from '../notices/l2.js';
import { NOT_ALLOWED } from '../policy/engine.js';
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import { RateLimit } from '../db/rateLimit.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Teams, TaskRow } from '../teams/teams.js';
import { sha256Hex } from '../util/crypto.js';
import { newId } from '../util/ids.js';
import { parseRef, RefError, forms } from '../util/refs.js';
import { HUB_VERSION, compareVersions } from '../version.js';

export const KINDS = ['bug', 'limitation', 'wish'] as const;
export const AREAS = ['login', 'instructions', 'errors', 'access', 'messaging', 'teams', 'tasks', 'vault', 'search', 'shares', 'channels', 'bridge', 'graph', 'limits', 'other'] as const;
export const SEVERITIES = ['blocking', 'costly', 'minor'] as const;
export const STATUSES = ['new', 'needs_info', 'accepted', 'fixed', 'wont_fix', 'duplicate', 'withdrawn'] as const;
export const ENTRY_KINDS = ['plus_one', 'evidence', 'answer', 'still_happening', 'withdraw'] as const;
export type Kind = typeof KINDS[number];
export type Area = typeof AREAS[number];
export type Severity = typeof SEVERITIES[number];
export type Status = typeof STATUSES[number];
export type EntryKind = typeof ENTRY_KINDS[number];

/** Statuses a report is still being worked on in. */
export const OPEN_STATUSES: readonly Status[] = ['new', 'needs_info', 'accepted'];
const OPEN_SQL = "('new','needs_info','accepted')";
const BACKING_SQL = "('plus_one','evidence','still_happening')";
const SEV_RANK = "CASE r.severity WHEN 'blocking' THEN 0 WHEN 'costly' THEN 1 ELSE 2 END";
const HOUR = 3_600_000, DAY = 24 * HOUR, MIN = 60_000;
const DENIED = NOT_ALLOWED;
const SYSTEM: Actor = { kind: 'system', id: null };
export const CLOSE_NOTE = 'Linked task done; the fix reaches agents with the next deploy.';
export const UNDO_NOTE = 'A linked task is no longer done.';
/** What the hub knows about a report's linked tasks: backlog tasks do not count; a done task without review blocks the close. */
export interface TaskState { linked: number; counted: number; done: number; unreviewed: number }

/** Rate limits, per agent ID unless noted. Overridable with the settings key feedback.limits. */
export interface Limits { reportsPerHour: number; reportsPerDay: number; entriesPerHour: number; openPerAgent: number; entriesPerReport: number; hubReportsPerDay: number; spamHits: number }
export const DEFAULT_LIMITS: Limits = { reportsPerHour: 5, reportsPerDay: 20, entriesPerHour: 30, openPerAgent: 25, entriesPerReport: 200, hubReportsPerDay: 200, spamHits: 3 };

export class FeedbackError extends KeyError {
  constructor(code: string, message: string, public readonly extra?: Record<string, unknown>) { super(code, message); }
}
const denied = () => new FeedbackError('denied', DENIED);

export interface Cost { extra_calls?: number | null; extra_tokens?: number | null; minutes_lost?: number | null }
export interface ReportRow {
  id: string; kind: Kind; title: string; original_title: string | null; tool: string | null; area: Area; error_code: string | null;
  tried: string; happened: string | null; expected: string | null; workaround: string | null;
  cost_calls: number | null; cost_tokens: number | null; cost_minutes: number | null; severity: Severity;
  fingerprint: string; title_words: string; status: Status; status_note: string | null; guidance: string | null; fixed_in: string | null;
  duplicate_of: string | null; hidden: number; reopen_count: number; status_rev: number; backers: number;
  filer_agent_id: string; filer_credential_id: string | null; filer_app_credential_id: string | null; filer_app: string | null; filer_pc_id: string | null; filer_teams: string;
  client_name: string | null; client_version: string | null; hub_version: string; created_at: number; updated_at: number; last_seen_at: number; status_at: number;
  assigned_agent_id: string | null; assigned_at: number | null; assigned_note: string | null; assigned_read_at: number | null;
  /** The hub closed it because its linked tasks were done; closed_from is the status to return to, fixed_after the hub version the fix comes after. */
  closed_by_task: number; closed_from: Status | null; fixed_after: string | null;
}
interface EntryRow {
  id: string; report_id: string; origin_report_id: string | null; agent_id: string; credential_id: string | null; kind: EntryKind; text: string | null;
  cost_calls: number | null; cost_tokens: number | null; cost_minutes: number | null; hub_version: string | null; app_name: string | null; client_name: string | null; client_version: string | null; created_at: number;
}
export interface Who {
  agentId: string; credId: string; appCredId: string; appName: string | null; machineId: string | null; teams: string[]; client: { name: string; version: string } | null;
}
export interface FileInput {
  kind: Kind; title: string; tool: string | null; area: Area | null; errorCode: string | null; tried: string; happened: string | null; expected: string | null;
  workaround: string | null; cost: Cost | null; severity: Severity; links: string[]; clientReportId: string | null;
}
/** Resolves a stored link to its canonical form if the reader may read it now, else null. */
export type LinkCheck = (link: string) => string | null;

// ───────────── Pure helpers ─────────────

const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might more most no not of on one or our out so some such than that the their then there these they this those to too up us use used using very was we were what when where which while who will with would you your when').split(/\s+/));

/** Lower case, punctuation and numbers removed, stop words dropped, words sorted. */
export function titleWords(title: string): string[] {
  const words = title.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)].sort();
}
export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sb = new Set(b);
  const inter = a.filter((w) => sb.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}
export function fingerprintOf(kind: string, tool: string | null, area: string, errorCode: string | null, title: string): { fingerprint: string; words: string[] } {
  const words = titleWords(title);
  const basis = words.length ? words.join(' ') : title.toLowerCase().trim();
  return { fingerprint: sha256Hex(`${kind}|${tool ?? `area:${area}`}|${errorCode ?? ''}|${basis}`).slice(0, 24), words };
}
/** The area a tool belongs to. */
export function areaOfTool(tool: string): Area {
  if (tool.startsWith('session_')) return 'login';
  if (tool.startsWith('access_')) return 'access';
  if (tool === 'file_search') return 'search';
  if (tool.startsWith('file_')) return 'vault';
  if (/^(message_|room_)/.test(tool) || tool === 'agent_list') return 'messaging';
  if (tool.startsWith('task_') || tool === 'work_next' || tool === 'work_ack') return 'tasks';
  if (tool.startsWith('team_')) return 'teams';
  if (tool.startsWith('share_')) return 'shares';
  if (tool.startsWith('channel_')) return 'channels';
  if (tool.startsWith('setup_')) return 'bridge';
  if (tool.startsWith('graph_')) return 'graph';
  return 'other';
}
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const costOf = (r: { cost_calls: number | null; cost_tokens: number | null; cost_minutes: number | null }) =>
  r.cost_calls === null && r.cost_tokens === null && r.cost_minutes === null ? null : { extra_calls: r.cost_calls, extra_tokens: r.cost_tokens, minutes_lost: r.cost_minutes };
const subject = (r: { tool: string | null; area: string }) => r.tool ?? `area:${r.area}`;
const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class Feedback {
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly audit: Audit, private readonly teams: Teams) {}

  // ───────────── Settings ─────────────
  private setting<T>(key: string, dflt: T): T {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined;
    if (!r) return dflt;
    try { return JSON.parse(r.value) as T; } catch { return dflt; }
  }
  private put(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), Date.now());
  }
  enabled(): boolean { return this.setting<boolean>('feedback.enabled', true) !== false; }
  ownOnly(): boolean { return this.setting<boolean>('feedback.own_only', false) === true; }
  limits(): Limits {
    const o = this.setting<Partial<Limits>>('feedback.limits', {});
    const out = { ...DEFAULT_LIMITS };
    for (const k of Object.keys(out) as (keyof Limits)[]) { const v = o[k]; if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v; }
    return out;
  }
  settings() { return { enabled: this.enabled(), own_only: this.ownOnly(), limits: this.limits(), defaults: DEFAULT_LIMITS, hub_version: HUB_VERSION }; }
  setSettings(p: { enabled?: boolean; own_only?: boolean; limits?: Partial<Limits> }, actor: Actor): ReturnType<Feedback['settings']> {
    if (p.enabled !== undefined) this.put('feedback.enabled', p.enabled);
    if (p.own_only !== undefined) this.put('feedback.own_only', p.own_only);
    if (p.limits) this.put('feedback.limits', { ...this.setting<Partial<Limits>>('feedback.limits', {}), ...p.limits });
    this.audit.event(actor, 'feedback.settings', null, { enabled: p.enabled, own_only: p.own_only, limits: p.limits ? Object.keys(p.limits) : undefined });
    return this.settings();
  }
  assertEnabled(): void { if (!this.enabled()) throw new FeedbackError('denied', 'Feedback is turned off on this hub.'); }

  // ───────────── Lookups ─────────────
  report(id: string): ReportRow | null { return (this.db.prepare('SELECT * FROM feedback_reports WHERE id=?').get(id) as unknown as ReportRow) ?? null; }
  private mustReport(id: string): ReportRow { const r = this.report(id); if (!r) throw new FeedbackError('not_found', 'report not found'); return r; }
  private isFiler(r: ReportRow, agentId: string): boolean { return r.filer_agent_id === agentId; }
  /** Filer, or anyone with an entry on the report (before or after a merge). */
  private isMine(r: ReportRow, agentId: string): boolean {
    return this.isFiler(r, agentId) || !!this.db.prepare('SELECT 1 x FROM feedback_entries WHERE (report_id=? OR origin_report_id=?) AND agent_id=? LIMIT 1').get(r.id, r.id, agentId);
  }
  /** May this agent see the summary layer? Hidden reports belong to filer and backers; "own only" narrows it to them for everyone. */
  canSee(r: ReportRow, agentId: string): boolean {
    if (!r.hidden && !this.ownOnly()) return true;
    return this.isMine(r, agentId) || r.assigned_agent_id === agentId;
  }
  /** Agents that count as backers: the filer and everyone with a +1, evidence or still_happening entry. */
  private backingAgents(reportId: string): string[] {
    const r = this.db.prepare('SELECT filer_agent_id a FROM feedback_reports WHERE id=?').get(reportId) as { a: string } | undefined;
    // The assignee's evidence is its account of the work, not a +1: it does not count as backing.
    const rows = this.db.prepare(`SELECT DISTINCT e.agent_id a FROM feedback_entries e JOIN feedback_reports r ON r.id=e.report_id WHERE e.report_id=? AND e.kind IN ${BACKING_SQL}
      AND NOT (e.kind='evidence' AND e.agent_id IS r.assigned_agent_id)`).all(reportId) as { a: string }[];
    return [...new Set([...(r ? [r.a] : []), ...rows.map((x) => x.a)])];
  }
  private recount(reportId: string): void {
    this.db.prepare('UPDATE feedback_reports SET backers=? WHERE id=?').run(this.backingAgents(reportId).length, reportId);
  }

  // ───────────── Rate limits ─────────────
  private limitHit(agentId: string): void {
    const spam = new RateLimit(this.db, this.limits().spamHits, HOUR);
    spam.fail(`agent:${agentId}`, 'fb_limit_hit');
    const st = spam.state(`agent:${agentId}`, 'fb_limit_hit');
    if (st.count >= this.limits().spamHits) this.audit.alert('info', 'feedback_spam', agentId, { agent: agentId, hits: st.count, note: 'one agent keeps hitting its feedback limits' });
  }
  private limited(agentId: string | null, msg: string, retryMs: number | null): never {
    if (agentId) this.limitHit(agentId);
    throw new FeedbackError('rate_limited', msg, retryMs === null ? undefined : { retry_after_s: Math.max(1, Math.ceil(retryMs / 1000)) });
  }
  private checkReportLimits(agentId: string): void {
    const l = this.limits(), now = Date.now();
    const hub = new RateLimit(this.db, l.hubReportsPerDay, DAY).blocked('hub', 'fb_new_hub_d', now);
    if (hub.blocked) {
      this.audit.alert('warning', 'feedback_flood', 'hub', { limit: l.hubReportsPerDay, note: 'the hub-wide daily limit of new feedback reports was reached' });
      throw new FeedbackError('rate_limited', 'The hub has reached its daily limit of new feedback reports. Add to an existing report with feedback_add instead (find one with feedback_find).', { retry_after_s: Math.max(1, Math.ceil(hub.retryAfterMs / 1000)) });
    }
    const h = new RateLimit(this.db, l.reportsPerHour, HOUR).blocked(`agent:${agentId}`, 'fb_new_h', now);
    if (h.blocked) this.limited(agentId, `You filed ${l.reportsPerHour} reports in the last hour. Add to an existing report with feedback_add instead (find one with feedback_find).`, h.retryAfterMs);
    const d = new RateLimit(this.db, l.reportsPerDay, DAY).blocked(`agent:${agentId}`, 'fb_new_d', now);
    if (d.blocked) this.limited(agentId, `You filed ${l.reportsPerDay} reports in the last day. Add to an existing report with feedback_add instead (find one with feedback_find).`, d.retryAfterMs);
    const open = (this.db.prepare(`SELECT COUNT(*) n FROM feedback_reports WHERE filer_agent_id=? AND status IN ${OPEN_SQL}`).get(agentId) as { n: number }).n;
    if (open >= l.openPerAgent) this.limited(agentId, `You have ${open} open reports. File more once some are closed or withdrawn.`, null);
  }
  private countReport(agentId: string): void {
    const l = this.limits();
    new RateLimit(this.db, l.reportsPerHour, HOUR).fail(`agent:${agentId}`, 'fb_new_h');
    new RateLimit(this.db, l.reportsPerDay, DAY).fail(`agent:${agentId}`, 'fb_new_d');
    new RateLimit(this.db, l.hubReportsPerDay, DAY).fail('hub', 'fb_new_hub_d');
  }
  private checkEntryLimit(agentId: string): void {
    const l = this.limits();
    const h = new RateLimit(this.db, l.entriesPerHour, HOUR).blocked(`agent:${agentId}`, 'fb_entry_h');
    if (h.blocked) this.limited(agentId, `You added ${l.entriesPerHour} feedback entries in the last hour.`, h.retryAfterMs);
  }
  private countEntry(agentId: string): void { new RateLimit(this.db, this.limits().entriesPerHour, HOUR).fail(`agent:${agentId}`, 'fb_entry_h'); }

  // ───────────── Writing ─────────────
  private history(reportId: string, actor: Actor, field: string, oldV: string | null, newV: string | null, note: string | null = null): void {
    this.db.prepare('INSERT INTO feedback_history(report_id,actor_kind,actor_id,field,old_value,new_value,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run(reportId, actor.kind, actor.id, field, oldV, newV, note, Date.now());
  }
  private insertLinks(reportId: string, entryId: string | null, links: string[]): void {
    const st = this.db.prepare('INSERT INTO feedback_links(report_id,entry_id,kind,target) VALUES (?,?,?,?)');
    for (const l of links) { const p = parseLink(l); st.run(reportId, entryId, p.kind, p.target); }
  }
  private insertEntry(r: ReportRow, w: Who, kind: EntryKind, text: string | null, cost: Cost | null, links: string[]): string {
    const id = newId.entry();
    this.db.prepare(`INSERT INTO feedback_entries(id,report_id,agent_id,credential_id,kind,text,cost_calls,cost_tokens,cost_minutes,hub_version,app_name,client_name,client_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, r.id, w.agentId, w.credId, kind, text, cost?.extra_calls ?? null, cost?.extra_tokens ?? null, cost?.minutes_lost ?? null, HUB_VERSION, w.appName, w.client?.name ?? null, w.client?.version ?? null, Date.now());
    if (links.length) this.insertLinks(r.id, id, links);
    return id;
  }
  private touch(reportId: string): void {
    const now = Date.now();
    this.db.prepare('UPDATE feedback_reports SET last_seen_at=?, updated_at=? WHERE id=?').run(now, now, reportId);
  }
  /** The filer's calls to the named tool in the 30 minutes before now, newest first, at most 20. Arguments are never copied. */
  private attachCalls(reportId: string, agentId: string, tool: string | null): number {
    if (!tool) return 0;
    const have = (this.db.prepare('SELECT COUNT(*) n FROM feedback_calls WHERE report_id=?').get(reportId) as { n: number }).n;
    if (have >= 60) return 0;
    const rows = this.db.prepare('SELECT id,tool,result,error_code,duration_ms,result_bytes,created_at FROM tool_invocations WHERE agent_id=? AND tool=? AND created_at>=? ORDER BY created_at DESC LIMIT 20')
      .all(agentId, tool, Date.now() - 30 * MIN) as { id: string; tool: string; result: string; error_code: string | null; duration_ms: number; result_bytes: number | null; created_at: number }[];
    const st = this.db.prepare('INSERT OR IGNORE INTO feedback_calls(report_id,invocation_id,agent_id,tool,result,error_code,duration_ms,result_bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const c of rows) st.run(reportId, c.id, agentId, c.tool, c.result, c.error_code, c.duration_ms, c.result_bytes, c.created_at);
    return rows.length;
  }

  /** Change status and tell everyone concerned (once per agent), except the agent that caused the change. */
  private transition(r: ReportRow, to: Status, actor: Actor, o: { note?: string | null; guidance?: string | null; fixedIn?: string | null; duplicateOf?: string | null; reopen?: boolean; clearNote?: boolean; by?: 'operator' | 'filer' | 'hub'; notice?: string } = {}): ReportRow {
    const now = Date.now();
    const note = o.clearNote ? null : o.note === undefined ? r.status_note : o.note;
    const guidance = o.guidance === undefined ? r.guidance : o.guidance;
    const fixedIn = o.fixedIn === undefined ? r.fixed_in : o.fixedIn;
    const recipients = this.backingAgents(r.id).filter((a) => a !== (actor.kind === 'agent' ? actor.id : null));
    tx(this.db, () => {
      this.db.prepare('UPDATE feedback_reports SET status=?, status_note=?, guidance=?, fixed_in=?, duplicate_of=?, status_rev=status_rev+1, reopen_count=reopen_count+?, status_at=?, updated_at=? WHERE id=?')
        .run(to, note, guidance, fixedIn, o.duplicateOf ?? (to === 'duplicate' ? r.duplicate_of : null), o.reopen ? 1 : 0, now, now, r.id);
      this.history(r.id, actor, 'status', r.status, to, o.note ?? null);
    });
    const next = this.mustReport(r.id);
    const body = noticeBody(next, o.by ?? (actor.kind === 'admin' ? 'operator' : 'hub')) + (o.notice ? ` ${o.notice}` : '');
    for (const a of recipients) this.keys.notify(a, 'feedback_update', body, { feedback: r.id, rev: next.status_rev });
    return next;
  }

  /** File a report: merged into a matching one, or created. Retries with the same client_report_id return the first outcome. */
  file(w: Who, i: FileInput): { result: 'created' | 'merged'; report: ReportRow; similar: ReportRow[]; deduplicated?: boolean; reopened?: boolean; note?: string; text_dropped?: boolean } {
    this.assertEnabled();
    if (i.clientReportId) {
      const prev = this.db.prepare('SELECT report_id,outcome FROM feedback_requests WHERE agent_id=? AND client_report_id=?').get(w.agentId, i.clientReportId) as { report_id: string; outcome: 'created' | 'merged' } | undefined;
      const rep = prev && this.report(prev.report_id);
      if (prev && rep) return { result: prev.outcome, report: rep, similar: [], deduplicated: true };
    }
    const area = i.area ?? (i.tool ? areaOfTool(i.tool) : null);
    if (!area) throw new FeedbackError('invalid_argument', 'Give a tool or an area.');
    if (i.kind === 'bug' && !i.happened) throw new FeedbackError('invalid_argument', 'A bug report needs "happened": what happened instead.');
    const { fingerprint, words } = fingerprintOf(i.kind, i.tool, area, i.errorCode, i.title);
    const subj = i.tool ?? `area:${area}`;
    const remember = (result: 'created' | 'merged', id: string) => {
      if (i.clientReportId) this.db.prepare('INSERT OR REPLACE INTO feedback_requests(agent_id,client_report_id,report_id,outcome,created_at) VALUES (?,?,?,?,?)').run(w.agentId, i.clientReportId, id, result, Date.now());
    };

    // One agent, one problem: the same fingerprint from the same agent within 24 h joins its first report, even a closed one.
    const own = this.db.prepare("SELECT * FROM feedback_reports WHERE filer_agent_id=? AND fingerprint=? AND created_at>? AND status NOT IN ('withdrawn','duplicate') ORDER BY created_at LIMIT 1")
      .get(w.agentId, fingerprint, Date.now() - DAY) as unknown as ReportRow | undefined;
    if (own) {
      const m = this.addEvidence(own, w, i, 'own');
      remember('merged', own.id);
      return { result: 'merged', report: m.report, similar: [], reopened: m.reopened, note: m.note, text_dropped: m.text_dropped };
    }

    // Exact fingerprint on an open report this agent may see: a +1 with evidence.
    const exact = (this.db.prepare(`SELECT * FROM feedback_reports WHERE fingerprint=? AND status IN ${OPEN_SQL} ORDER BY created_at`).all(fingerprint) as unknown as ReportRow[])
      .find((r) => this.canSee(r, w.agentId));
    if (exact) {
      const m = this.addEvidence(exact, w, i, 'other');
      remember('merged', exact.id);
      return { result: 'merged', report: m.report, similar: [], note: m.note, text_dropped: m.text_dropped };
    }

    this.checkReportLimits(w.agentId);
    // Close matches (same tool or area and error code, title overlap of at least 0.5), for the agent to look at.
    const similar = (this.db.prepare(`SELECT * FROM feedback_reports WHERE status IN ${OPEN_SQL} AND COALESCE(tool,'area:'||area)=? AND COALESCE(error_code,'')=?`).all(subj, i.errorCode ?? '') as unknown as ReportRow[])
      .filter((r) => this.canSee(r, w.agentId))
      .map((r) => ({ r, j: jaccard(words, r.title_words ? r.title_words.split(' ') : []) }))
      .filter((x) => x.j >= 0.5)
      .sort((a, b) => b.j - a.j || b.r.backers - a.r.backers).slice(0, 3).map((x) => x.r);

    const id = newId.report(), now = Date.now();
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO feedback_reports(id,kind,title,tool,area,error_code,tried,happened,expected,workaround,cost_calls,cost_tokens,cost_minutes,severity,fingerprint,title_words,
        filer_agent_id,filer_credential_id,filer_app_credential_id,filer_app,filer_pc_id,filer_teams,client_name,client_version,hub_version,created_at,updated_at,last_seen_at,status_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, i.kind, i.title, i.tool, area, i.errorCode, i.tried, i.happened, i.expected, i.workaround, i.cost?.extra_calls ?? null, i.cost?.extra_tokens ?? null, i.cost?.minutes_lost ?? null,
          i.severity, fingerprint, words.join(' '), w.agentId, w.credId, w.appCredId, w.appName, w.machineId, JSON.stringify(w.teams), w.client?.name ?? null, w.client?.version ?? null, HUB_VERSION, now, now, now, now);
      if (i.links.length) this.insertLinks(id, null, i.links);
      this.attachCalls(id, w.agentId, i.tool);
      this.history(id, { kind: 'agent', id: w.agentId }, 'status', null, 'new');
    });
    this.countReport(w.agentId);
    remember('created', id);
    this.audit.event({ kind: 'agent', id: w.agentId }, 'feedback.file', { kind: 'feedback', id }, { kind: i.kind, tool: i.tool, area, error_code: i.errorCode, severity: i.severity, fingerprint, outcome: 'created' });
    return { result: 'created', report: this.mustReport(id), similar };
  }

  /**
   * A filing that joins an existing report (exact match, or the filer's own earlier report): a +1 with evidence from a new
   * backer, or plain evidence from an agent already counted. A fixed report is a still_happening, with its version rule.
   */
  private addEvidence(target: ReportRow, w: Who, i: FileInput, how: 'own' | 'other'): { report: ReportRow; reopened?: boolean; note?: string; text_dropped?: boolean } {
    this.checkEntryLimit(w.agentId);
    const text = [`Tried: ${i.tried}`, i.happened ? `Happened: ${i.happened}` : '', i.expected ? `Expected: ${i.expected}` : '', i.workaround ? `Workaround: ${i.workaround}` : ''].filter(Boolean).join('\n').slice(0, 4000);
    let out: { report: ReportRow; reopened?: boolean; note?: string; text_dropped?: boolean };
    if (target.status === 'fixed' && how === 'own') out = this.stillHappening(target, w, text, i.cost, i.links);
    else {
      const backed = this.isFiler(target, w.agentId) || !!this.db.prepare("SELECT 1 x FROM feedback_entries WHERE report_id=? AND agent_id=? AND kind='plus_one'").get(target.id, w.agentId);
      const dropped = this.entryCapReached(target, w.agentId);
      tx(this.db, () => {
        if (!dropped || !backed) this.insertEntry(target, w, backed ? 'evidence' : 'plus_one', dropped ? null : text, dropped ? null : i.cost, dropped ? [] : i.links);
        this.touch(target.id);
        this.recount(target.id);
      });
      out = { report: this.mustReport(target.id), text_dropped: dropped || undefined, note: how === 'own' ? 'You had already filed this problem; your filing was added to your report as evidence.' : undefined };
    }
    this.attachCalls(target.id, w.agentId, i.tool);
    this.countEntry(w.agentId);
    this.audit.event({ kind: 'agent', id: w.agentId }, 'feedback.file', { kind: 'feedback', id: out.report.id }, { kind: i.kind, tool: i.tool, area: i.area ?? (i.tool ? areaOfTool(i.tool) : null), error_code: i.errorCode, severity: i.severity, fingerprint: target.fingerprint, outcome: 'merged', into: out.report.id });
    return out;
  }

  /** Past the per-report entry cap, further evidence and still_happening only count the backer and bump last-seen: their text is dropped. */
  private entryCapReached(r: ReportRow, _agentId: string): boolean {
    const n = (this.db.prepare('SELECT COUNT(*) n FROM feedback_entries WHERE report_id=?').get(r.id) as { n: number }).n;
    return n >= this.limits().entriesPerReport;
  }

  /** A "still happening" on a report: reopens a fixed one when this hub is at or past the fix version. */
  private stillHappening(r: ReportRow, w: Who, text: string | null, cost: Cost | null, links: string[]): { report: ReportRow; reopened?: boolean; note?: string; text_dropped?: boolean } {
    const dropped = this.entryCapReached(r, w.agentId);
    tx(this.db, () => {
      if (!dropped || !this.backingAgents(r.id).includes(w.agentId)) this.insertEntry(r, w, 'still_happening', dropped ? null : text, dropped ? null : cost, dropped ? [] : links);
      this.touch(r.id);
      this.recount(r.id);
    });
    let report = this.mustReport(r.id), reopened = false, note: string | undefined;
    const after = r.status === 'fixed' && !r.fixed_in && r.fixed_after ? compareVersions(HUB_VERSION, r.fixed_after) : null;
    if (after !== null && after <= 0) {
      // Closed by its linked tasks after this version: the fix is not deployed yet.
      note = `Recorded as evidence only: the fix was made after hub version ${r.fixed_after} and reaches agents with the next deploy.`;
    } else if (r.status === 'fixed') {
      const cmp = r.fixed_in ? compareVersions(HUB_VERSION, r.fixed_in) : null;
      if (!r.fixed_in || cmp === null || cmp >= 0) {
        this.clearTaskClose(r.id);
        report = this.transition(report, 'new', { kind: 'agent', id: w.agentId }, { reopen: true, clearNote: true, by: 'hub' });
        reopened = true;
        note = 'The report was reopened as new.';
      } else note = `Recorded as evidence only: the fix is in hub version ${r.fixed_in}, and this hub is ${HUB_VERSION}.`;
    } else if (r.status === 'wont_fix') note = 'Recorded as evidence. The report stays closed (won\'t fix).';
    return { report, reopened: reopened || undefined, note, text_dropped: dropped || undefined };
  }

  /** feedback_add: +1, evidence, an answer, still_happening or a withdrawal. */
  add(w: Who, reportId: string, i: { kind: EntryKind; text: string | null; cost: Cost | null; links: string[] }): { result: string; report: ReportRow; note?: string; text_dropped?: boolean; reopened?: boolean } {
    this.assertEnabled();
    const r = this.report(reportId);
    if (!r || !this.canSee(r, w.agentId)) throw denied();
    const me: Actor = { kind: 'agent', id: w.agentId };
    if (r.status === 'duplicate') throw new FeedbackError('invalid_state', `This report was merged into ${r.duplicate_of}. Add to that one.`);
    if (r.status === 'withdrawn') throw new FeedbackError('invalid_state', 'This report was withdrawn.');

    if (i.kind === 'withdraw') {
      if (!this.isFiler(r, w.agentId)) throw denied();
      if (!OPEN_STATUSES.includes(r.status)) throw new FeedbackError('invalid_state', `This report is already ${r.status}.`);
      tx(this.db, () => { this.insertEntry(r, w, 'withdraw', i.text, null, []); });
      const next = this.transition(r, 'withdrawn', me, { by: 'filer', note: i.text ?? null });
      this.audit.event(me, 'feedback.withdraw', { kind: 'feedback', id: r.id }, {});
      return { result: 'withdrawn', report: next };
    }
    if (i.kind === 'answer') {
      if (!this.isFiler(r, w.agentId)) throw denied();
      if (!i.text) throw new FeedbackError('invalid_argument', 'An answer needs "text".');
      tx(this.db, () => { this.insertEntry(r, w, 'answer', i.text, i.cost, i.links); this.touch(r.id); });
      let next = this.mustReport(r.id);
      if (r.status === 'needs_info') next = this.transition(next, 'new', me, { clearNote: true, by: 'hub' });
      this.audit.event(me, 'feedback.add', { kind: 'feedback', id: r.id }, { entry: 'answer' });
      return { result: 'answered', report: next, note: r.status === 'needs_info' ? 'The report is back in the operator\'s new queue.' : undefined };
    }
    if (i.kind === 'plus_one') {
      const had = this.isFiler(r, w.agentId) || !!this.db.prepare("SELECT 1 x FROM feedback_entries WHERE (report_id=? OR origin_report_id=?) AND agent_id=? AND kind='plus_one'").get(r.id, r.id, w.agentId);
      if (had) return { result: 'already_backed', report: r, note: 'You already back this report.' };
      this.checkEntryLimit(w.agentId);
      const dropped = this.entryCapReached(r, w.agentId);
      tx(this.db, () => { this.insertEntry(r, w, 'plus_one', dropped ? null : i.text, dropped ? null : i.cost, dropped ? [] : i.links); this.touch(r.id); this.recount(r.id); });
      this.countEntry(w.agentId);
      this.audit.event(me, 'feedback.add', { kind: 'feedback', id: r.id }, { entry: 'plus_one' });
      return { result: 'added', report: this.mustReport(r.id), text_dropped: dropped && i.text ? true : undefined };
    }
    // evidence, still_happening
    this.checkEntryLimit(w.agentId);
    let out: { report: ReportRow; reopened?: boolean; note?: string; text_dropped?: boolean };
    if (i.kind === 'still_happening') out = this.stillHappening(r, w, i.text, i.cost, i.links);
    else {
      const dropped = this.entryCapReached(r, w.agentId);
      tx(this.db, () => {
        if (!dropped || !this.backingAgents(r.id).includes(w.agentId)) this.insertEntry(r, w, 'evidence', dropped ? null : i.text, dropped ? null : i.cost, dropped ? [] : i.links);
        this.touch(r.id);
        this.recount(r.id);
      });
      out = { report: this.mustReport(r.id), text_dropped: dropped || undefined };
    }
    if (i.kind === 'evidence' || out.report.tool) this.attachCalls(r.id, w.agentId, r.tool);
    this.countEntry(w.agentId);
    this.audit.event(me, 'feedback.add', { kind: 'feedback', id: r.id }, { entry: i.kind });
    return { result: out.reopened ? 'reopened' : 'added', ...out };
  }

  // ───────────── Reading, for agents ─────────────

  /** The summary layer: what every agent allowed to use feedback may see. The title is the only free text. */
  summary(r: ReportRow, agentId: string) {
    const assigned = r.assigned_agent_id === agentId;
    const hasDecision = assigned || r.status === 'accepted' || r.status === 'fixed' || r.status === 'wont_fix' || r.status === 'needs_info' || r.status === 'duplicate';
    return {
      id: r.id, kind: r.kind, title: r.title, title_trust: 'L2', tool: r.tool, area: r.area, error_code: r.error_code, severity: r.severity, status: r.status,
      backers: r.backers, created_at: iso(r.created_at), last_seen_at: iso(r.last_seen_at), reopen_count: r.reopen_count, mine: this.isMine(r, agentId),
      ...(r.status === 'duplicate' && r.duplicate_of ? { duplicate_of: r.duplicate_of } : {}),
      ...this.linkedFor(r.id, agentId),
      ...(assigned ? { assigned_to_you: true, assignment: { trust: 'L0', note: r.assigned_note, assigned_at: iso(r.assigned_at ?? r.updated_at), read: r.assigned_read_at !== null } } : {}),
      ...(hasDecision && (r.status_note || r.guidance || r.fixed_in) ? { decision: { trust: 'L0', note: r.status_note, guidance: r.guidance, fixed_in: r.fixed_in } } : {}),
    };
  }

  /** The detail layer for the filer (everything of its own) or a backer (its own entries only). */
  detailFor(r: ReportRow, agentId: string, linkOk: LinkCheck) {
    const filer = this.isFiler(r, agentId);
    if (!filer && !this.isMine(r, agentId)) return null;
    const entries = (this.db.prepare('SELECT * FROM feedback_entries WHERE (report_id=? OR origin_report_id=?) ORDER BY created_at, rowid').all(r.id, r.id) as unknown as EntryRow[])
      .filter((e) => filer || e.agent_id === agentId)
      .map((e) => e.agent_id === agentId
        ? { entry_id: e.id, kind: e.kind, mine: true, text: e.text, cost: costOf(e), links: this.linksOf(e.report_id, e.id, linkOk), created_at: iso(e.created_at), hub_version: e.hub_version }
        : { entry_id: e.id, kind: e.kind, mine: false, created_at: iso(e.created_at) });
    const base = { entries };
    if (!filer) return base;
    return {
      trust: 'L2', tried: r.tried, happened: r.happened, expected: r.expected, workaround: r.workaround, cost: costOf(r),
      links: this.linksOf(r.id, null, linkOk), ...base,
    };
  }
  private linksOf(reportId: string, entryId: string | null, linkOk: LinkCheck): string[] {
    const rows = (entryId === null ? this.db.prepare('SELECT kind,target FROM feedback_links WHERE report_id=? AND entry_id IS NULL ORDER BY id').all(reportId)
      : this.db.prepare('SELECT kind,target FROM feedback_links WHERE entry_id=? ORDER BY id').all(entryId)) as { kind: string; target: string }[];
    return rows.map((l) => linkOk(l.kind === 'path' ? l.target : `${l.kind}:${l.target}`)).filter((x): x is string => x !== null);
  }

  /** feedback_read. */
  read(agentId: string, id: string, linkOk: LinkCheck) {
    this.assertEnabled();
    const r = this.report(id);
    if (!r || !this.canSee(r, agentId)) throw denied();
    // Reading the report is what makes an assignment "read"; acknowledging its notice is not (an agent may ack in bulk).
    if (r.assigned_agent_id === agentId && r.assigned_read_at === null) {
      r.assigned_read_at = Date.now();
      this.db.prepare('UPDATE feedback_reports SET assigned_read_at=? WHERE id=? AND assigned_agent_id=? AND assigned_read_at IS NULL').run(r.assigned_read_at, id, agentId);
    }
    return { summary: this.summary(r, agentId), detail: this.detailFor(r, agentId, linkOk) };
  }
  /** linked_tasks for an agent: the count, and id, title and status of the tasks it may read (tasks of its teams). */
  private linkedFor(reportId: string, agentId: string): { linked_tasks?: { count: number; tasks: { id: string; title: string; title_trust: 'L2'; status: string }[] } } {
    const ts = this.tasksOf(reportId);
    if (!ts.length) return {};
    const tasks = ts.filter((t) => t.team_id && this.teams.roleOf(t.team_id, agentId)).map((t) => ({ id: t.id, title: t.title, title_trust: 'L2' as const, status: t.status }));
    return { linked_tasks: { count: ts.length, tasks } };
  }

  // ───────────── Linked tasks ─────────────

  private linkRows(reportId: string) {
    return this.db.prepare('SELECT task_id,linked_by_kind,linked_by_id,created_at FROM feedback_task_links WHERE report_id=? ORDER BY created_at, rowid').all(reportId) as { task_id: string; linked_by_kind: string; linked_by_id: string | null; created_at: number }[];
  }
  private tasksOf(reportId: string): TaskRow[] {
    return this.db.prepare('SELECT t.* FROM feedback_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.report_id=? ORDER BY l.created_at, l.rowid').all(reportId) as unknown as TaskRow[];
  }
  taskState(reportId: string): TaskState {
    const ts = this.tasksOf(reportId), counted = ts.filter((t) => t.status !== 'backlog'), done = counted.filter((t) => t.status === 'done');
    return { linked: ts.length, counted: counted.length, done: done.length, unreviewed: done.filter((t) => this.teams.effectiveReview(t) === 'none').length };
  }
  private static allDone(s: TaskState): boolean { return s.counted > 0 && s.done === s.counted; }
  private clearTaskClose(reportId: string): void {
    this.db.prepare('UPDATE feedback_reports SET closed_by_task=0, closed_from=NULL, fixed_after=NULL WHERE id=?').run(reportId);
  }

  /**
   * May this actor link a report to a task of this team? The operator: any report that is not a duplicate or withdrawn.
   * A coordinator of the team: only a report it may see that is assigned to it or to a member of the team.
   */
  private linkable(reportId: string, teamId: string | null, actor: Actor): ReportRow {
    const r = this.report(reportId);
    if (actor.kind !== 'admin') {
      if (actor.kind !== 'agent' || !actor.id || !teamId || this.teams.roleOf(teamId, actor.id) !== 'coordinator') throw denied();
      if (!r || !this.canSee(r, actor.id)) throw denied();
      const a = r.assigned_agent_id;
      if (!a || (a !== actor.id && !this.teams.roleOf(teamId, a))) throw denied();
    }
    if (!r) throw new FeedbackError('not_found', `Feedback ${reportId} not found.`);
    if (r.status === 'duplicate' || r.status === 'withdrawn') throw new FeedbackError('invalid_state', `Feedback ${r.id} is ${r.status}${r.duplicate_of ? `; link ${r.duplicate_of} instead` : ''}.`);
    return r;
  }
  /** A task change (task_create, task_update) and its link changes as one: a refused link undoes the task change too. */
  applyLinks<T extends { id: string }>(actor: Actor, fn: () => T, add: string[], remove: string[]): T {
    return tx(this.db, () => {
      const t = fn();
      for (const id of remove) this.unlink(id, t.id, actor);
      for (const id of add) this.link(id, t.id, actor);
      return t;
    });
  }

  /** Link a report to a task. Returns false when the link already existed. */
  link(reportId: string, taskId: string, actor: Actor): boolean {
    if (actor.kind !== 'admin') this.assertEnabled();
    const t = this.teams.task(taskId);
    if (!t) throw actor.kind === 'admin' ? new FeedbackError('not_found', 'Task not found.') : denied();
    const r = this.linkable(reportId, t.team_id, actor);
    if (this.db.prepare('SELECT 1 x FROM feedback_task_links WHERE report_id=? AND task_id=?').get(r.id, t.id)) return false;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO feedback_task_links(report_id,task_id,linked_by_kind,linked_by_id,created_at) VALUES (?,?,?,?,?)').run(r.id, t.id, actor.kind === 'admin' ? 'admin' : 'agent', actor.id, Date.now());
      this.history(r.id, actor, 'linked_task', null, t.id, `Linked to task ${JSON.stringify(t.title)}`);
      this.db.prepare('UPDATE feedback_reports SET updated_at=? WHERE id=?').run(Date.now(), r.id);
    });
    this.audit.event(actor, 'feedback.link', { kind: 'feedback', id: r.id }, { task: t.id, action: 'link' });
    this.evaluate(r.id);
    return true;
  }

  /** Remove a link. The operator at any time; a coordinator only a link it made, while the task is not done. */
  unlink(reportId: string, taskId: string, actor: Actor): void {
    if (actor.kind !== 'admin') this.assertEnabled();
    const row = this.db.prepare('SELECT linked_by_kind,linked_by_id FROM feedback_task_links WHERE report_id=? AND task_id=?').get(reportId, taskId) as { linked_by_kind: string; linked_by_id: string | null } | undefined;
    const t = this.teams.task(taskId);
    if (actor.kind !== 'admin') {
      if (!row || row.linked_by_kind !== 'agent' || row.linked_by_id !== actor.id) throw denied();
      if (t?.status === 'done') throw new FeedbackError('invalid_state', 'The task is done: only the operator can remove this link now.');
    }
    if (!row) throw new FeedbackError('not_found', 'That report is not linked to that task.');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM feedback_task_links WHERE report_id=? AND task_id=?').run(reportId, taskId);
      this.history(reportId, actor, 'linked_task', taskId, null, `Unlinked from task ${t ? JSON.stringify(t.title) : taskId}`);
      this.db.prepare('UPDATE feedback_reports SET updated_at=? WHERE id=?').run(Date.now(), reportId);
    });
    this.audit.event(actor, 'feedback.link', { kind: 'feedback', id: reportId }, { task: taskId, action: 'unlink' });
    this.evaluate(reportId);
  }

  /**
   * Close an accepted report whose counted linked tasks are all approved and done (fixed after the current hub version),
   * or undo a close the hub made when that stops being true. A report the operator closed is never touched.
   */
  evaluate(reportId: string): void {
    const r = this.report(reportId);
    if (!r) return;
    const s = this.taskState(r.id), closes = Feedback.allDone(s) && s.unreviewed === 0;
    if (r.status === 'accepted' && closes) {
      this.db.prepare('UPDATE feedback_reports SET closed_by_task=1, closed_from=?, fixed_after=? WHERE id=?').run(r.status, HUB_VERSION, r.id);
      this.transition(r, 'fixed', SYSTEM, { note: CLOSE_NOTE, fixedIn: null, by: 'hub', notice: `The hub closed it because its linked tasks are done: fixed after hub version ${HUB_VERSION}; the fix reaches agents with the next deploy.` });
      this.audit.event(SYSTEM, 'feedback.status', { kind: 'feedback', id: r.id }, { from: r.status, to: 'fixed', closed_by_task: true, fixed_after: HUB_VERSION });
    } else if (r.status === 'fixed' && r.closed_by_task && !closes) {
      const back: Status = r.closed_from ?? 'accepted';
      this.clearTaskClose(r.id);
      this.transition(r, back, SYSTEM, { note: UNDO_NOTE, by: 'hub', notice: UNDO_NOTE });
      this.audit.event(SYSTEM, 'feedback.status', { kind: 'feedback', id: r.id }, { from: 'fixed', to: back, reopened_by_task: true });
    }
  }
  /** A task changed status: re-check every report linked to it. */
  onTaskEvent(taskId: string): void {
    for (const { report_id } of this.db.prepare('SELECT report_id FROM feedback_task_links WHERE task_id=?').all(taskId) as { report_id: string }[]) this.evaluate(report_id);
  }

  /** "From feedback" on a task for an agent: linked reports it may see, never a hidden one. */
  fromFeedback(taskId: string, agentId: string): { id: string; title: string; title_trust: 'L2'; status: string }[] {
    if (!this.enabled()) return [];
    const rows = this.db.prepare('SELECT r.* FROM feedback_task_links l JOIN feedback_reports r ON r.id=l.report_id WHERE l.task_id=? ORDER BY l.created_at, l.rowid').all(taskId) as unknown as ReportRow[];
    return rows.filter((r) => !r.hidden && this.canSee(r, agentId)).map((r) => ({ id: r.id, title: r.title, title_trust: 'L2' as const, status: r.status }));
  }
  /** Every report linked to a task, for the operator's task screen. */
  reportsOfTask(taskId: string): { id: string; title: string; status: string; hidden: boolean; closed_by_task: boolean }[] {
    return (this.db.prepare('SELECT r.id,r.title,r.status,r.hidden,r.closed_by_task FROM feedback_task_links l JOIN feedback_reports r ON r.id=l.report_id WHERE l.task_id=? ORDER BY l.created_at, l.rowid').all(taskId) as { id: string; title: string; status: string; hidden: number; closed_by_task: number }[])
      .map((r) => ({ ...r, hidden: !!r.hidden, closed_by_task: !!r.closed_by_task }));
  }

  /** Reports assigned to the agent that it has not read with feedback_read since (session_whoami). */
  unreadAssigned(agentId: string): number {
    if (!this.enabled()) return 0;
    return (this.db.prepare("SELECT COUNT(*) n FROM feedback_reports WHERE assigned_agent_id=? AND assigned_read_at IS NULL AND status NOT IN ('duplicate','withdrawn')").get(agentId) as { n: number }).n;
  }

  /** feedback_find. With no filter at all it lists the caller's own reports. */
  find(agentId: string, f: { query?: string; tool?: string; area?: string; kind?: string; status?: string; mine?: boolean; assigned?: 'me'; limit?: number; cursor?: string }): { items: ReportRow[]; next_cursor: string | null } {
    this.assertEnabled();
    const where: string[] = [], args: (string | number)[] = [];
    const mineSql = '(r.filer_agent_id=? OR EXISTS (SELECT 1 FROM feedback_entries e WHERE (e.report_id=r.id OR e.origin_report_id=r.id) AND e.agent_id=?))';
    const noFilter = !f.query && !f.tool && !f.area && !f.kind && !f.status && f.mine === undefined && !f.assigned;
    const mine = f.mine ?? noFilter;
    // Reports assigned to the caller: visible to it whatever their visibility, so the filter stands on its own.
    if (f.assigned === 'me') { where.push('r.assigned_agent_id=?'); args.push(agentId); if (f.mine) { where.push(mineSql); args.push(agentId, agentId); } }
    else if (this.ownOnly() || mine) { where.push(mineSql); args.push(agentId, agentId); }
    else { where.push(`(r.hidden=0 OR ${mineSql})`); args.push(agentId, agentId); }
    if (f.tool) { where.push('r.tool=?'); args.push(f.tool); }
    if (f.area) { where.push('r.area=?'); args.push(f.area); }
    if (f.kind) { where.push('r.kind=?'); args.push(f.kind); }
    if (f.status) { where.push('r.status=?'); args.push(f.status); }
    else if (!mine) where.push("r.status NOT IN ('withdrawn','duplicate')");
    const words = (f.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map((w) => w.slice(0, 40));
    for (const w of words) {
      where.push("(lower(r.title) LIKE ? ESCAPE '\\' OR lower(COALESCE(r.tool,'')) LIKE ? ESCAPE '\\' OR lower(r.area) LIKE ? ESCAPE '\\' OR lower(COALESCE(r.error_code,'')) LIKE ? ESCAPE '\\')");
      args.push(like(w), like(w), like(w), like(w));
    }
    const limit = Math.max(1, Math.min(50, f.limit ?? 10));
    let offset = 0;
    if (f.cursor) { const n = Number(Buffer.from(f.cursor, 'base64url').toString()); if (Number.isInteger(n) && n >= 0) offset = n; else throw new FeedbackError('invalid_argument', 'cursor is not valid; use next_cursor from the previous result.'); }
    const order = words.length ? 'r.backers DESC, r.last_seen_at DESC' : 'r.created_at DESC';
    const rows = this.db.prepare(`SELECT r.* FROM feedback_reports r WHERE ${where.join(' AND ')} ORDER BY ${order}, r.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset) as unknown as ReportRow[];
    const more = rows.length > limit;
    return { items: rows.slice(0, limit), next_cursor: more ? Buffer.from(String(offset + limit)).toString('base64url') : null };
  }

  /** The one-line hint "Known: fb_…" for an error whose tool and code match a report with guidance (once per agent, report and day). */
  knownHint(agentId: string, tool: string, code: string): { id: string; guidance: string; status: string } | null {
    if (!this.enabled()) return null;
    const rows = this.db.prepare(`SELECT * FROM feedback_reports WHERE tool=? AND error_code=? AND status IN ('accepted','wont_fix') AND guidance IS NOT NULL AND guidance<>'' ORDER BY backers DESC, last_seen_at DESC`).all(tool, code) as unknown as ReportRow[];
    const now = Date.now();
    for (const r of rows) {
      if (!this.canSee(r, agentId)) continue;
      const h = this.db.prepare('SELECT hinted_at FROM feedback_hints WHERE agent_id=? AND report_id=?').get(agentId, r.id) as { hinted_at: number } | undefined;
      if (h && h.hinted_at > now - DAY) continue;
      this.db.prepare('INSERT INTO feedback_hints(agent_id,report_id,hinted_at) VALUES (?,?,?) ON CONFLICT(agent_id,report_id) DO UPDATE SET hinted_at=excluded.hinted_at').run(agentId, r.id, now);
      // The operator's guidance (L0), never the filer's title (L2): the hint lands inside an error the agent acts on.
      const g = r.guidance!.replace(/\s+/g, ' ').trim();
      return { id: r.id, guidance: g.length > 300 ? `${g.slice(0, 300)}…` : g, status: r.status };
    }
    return null;
  }

  // ───────────── Operator ─────────────

  /** Impact order: backers, then severity, then last seen. */
  list(f: { bucket?: 'new' | 'open' | 'closed'; status?: string; kind?: string; tool?: string; team?: string; agent?: string; assignee?: string; linked?: 'linked' | 'not_linked'; q?: string; sort?: 'impact' | 'recent'; limit?: number }) {
    const where: string[] = [], args: (string | number)[] = [];
    if (f.bucket === 'new') where.push("r.status='new'");
    else if (f.bucket === 'open') where.push("r.status IN ('needs_info','accepted')");
    else if (f.bucket === 'closed') where.push("r.status IN ('fixed','wont_fix','duplicate','withdrawn')");
    if (f.status) { where.push('r.status=?'); args.push(f.status); }
    if (f.kind) { where.push('r.kind=?'); args.push(f.kind); }
    if (f.tool) { where.push('(r.tool=? OR r.area=?)'); args.push(f.tool, f.tool); }
    if (f.team) { where.push('EXISTS (SELECT 1 FROM json_each(r.filer_teams) j WHERE j.value=?)'); args.push(f.team); }
    if (f.agent) { where.push('(r.filer_agent_id=? OR EXISTS (SELECT 1 FROM feedback_entries e WHERE (e.report_id=r.id OR e.origin_report_id=r.id) AND e.agent_id=?))'); args.push(f.agent, f.agent); }
    if (f.assignee) { where.push('r.assigned_agent_id=?'); args.push(f.assignee); }
    if (f.linked === 'linked') where.push('EXISTS (SELECT 1 FROM feedback_task_links l WHERE l.report_id=r.id)');
    else if (f.linked === 'not_linked') where.push('NOT EXISTS (SELECT 1 FROM feedback_task_links l WHERE l.report_id=r.id)');
    for (const w of (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("(lower(r.title) LIKE ? ESCAPE '\\' OR lower(COALESCE(r.tool,'')) LIKE ? ESCAPE '\\' OR lower(r.area) LIKE ? ESCAPE '\\' OR lower(COALESCE(r.error_code,'')) LIKE ? ESCAPE '\\' OR r.id LIKE ? ESCAPE '\\')");
      args.push(like(w), like(w), like(w), like(w), like(w));
    }
    const order = f.sort === 'recent' ? 'r.last_seen_at DESC' : `r.backers DESC, ${SEV_RANK}, r.last_seen_at DESC`;
    const rows = this.db.prepare(`SELECT r.*,
      (COALESCE(r.cost_calls,0)+(SELECT COALESCE(SUM(e.cost_calls),0) FROM feedback_entries e WHERE e.report_id=r.id)) sum_calls,
      (COALESCE(r.cost_tokens,0)+(SELECT COALESCE(SUM(e.cost_tokens),0) FROM feedback_entries e WHERE e.report_id=r.id)) sum_tokens,
      (COALESCE(r.cost_minutes,0)+(SELECT COALESCE(SUM(e.cost_minutes),0) FROM feedback_entries e WHERE e.report_id=r.id)) sum_minutes
      FROM feedback_reports r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}, r.rowid DESC LIMIT ?`).all(...args, Math.max(1, Math.min(500, f.limit ?? 200))) as unknown as (ReportRow & { sum_calls: number; sum_tokens: number; sum_minutes: number })[];
    const label = (id: string) => this.keys.agent(id)?.label ?? id;
    return rows.map((r) => ({
      ...this.taskFlags(r),
      id: r.id, kind: r.kind, title: r.title, tool: r.tool, area: r.area, error_code: r.error_code, severity: r.severity, status: r.status, backers: r.backers,
      reopen_count: r.reopen_count, hidden: !!r.hidden, created_at: r.created_at, last_seen_at: r.last_seen_at, status_at: r.status_at,
      filer: { agent_id: r.filer_agent_id, label: label(r.filer_agent_id) }, duplicate_of: r.duplicate_of,
      assignee: r.assigned_agent_id ? { agent_id: r.assigned_agent_id, label: label(r.assigned_agent_id), read_at: r.assigned_read_at } : null,
      cost_sum: { extra_calls: r.sum_calls, extra_tokens: r.sum_tokens, minutes_lost: r.sum_minutes },
    }));
  }

  /** The linked-task facts the console shows on a row and the detail: counts, the single task's status, Task done, Closed by task. */
  private taskFlags(r: ReportRow) {
    const s = this.taskState(r.id);
    const one = s.linked === 1 ? (this.db.prepare('SELECT t.status FROM feedback_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.report_id=?').get(r.id) as { status: string }).status : null;
    return {
      linked_tasks: s.linked ? { count: s.linked, counted: s.counted, done: s.done, status: one } : null,
      task_done: OPEN_STATUSES.includes(r.status) && Feedback.allDone(s),
      closed_by_task: r.status === 'fixed' && !!r.closed_by_task,
    };
  }

  /** Tools and areas that have reports, for the list's filter. */
  facets(): string[] { return (this.db.prepare('SELECT DISTINCT COALESCE(tool, area) v FROM feedback_reports ORDER BY v').all() as { v: string }[]).map((r) => r.v); }

  counts() {
    const row = this.db.prepare(`SELECT
      SUM(status='new') n, SUM(status IN ('needs_info','accepted')) o, SUM(status IN ('fixed','wont_fix','duplicate','withdrawn')) c FROM feedback_reports`).get() as { n: number | null; o: number | null; c: number | null };
    return { new: row.n ?? 0, open: row.o ?? 0, closed: row.c ?? 0 };
  }
  /** Blocking reports still waiting for a decision that three or more agents backed within a day (Overview's urgent items). */
  urgent(now = Date.now()) {
    const since = now - DAY;
    const rows = this.db.prepare("SELECT * FROM feedback_reports WHERE status='new' AND severity='blocking'").all() as unknown as ReportRow[];
    return rows.map((r) => {
      const agents = new Set<string>();
      if (r.created_at >= since) agents.add(r.filer_agent_id);
      for (const e of this.db.prepare(`SELECT DISTINCT agent_id FROM feedback_entries WHERE report_id=? AND kind IN ${BACKING_SQL} AND created_at>=?`).all(r.id, since) as { agent_id: string }[]) agents.add(e.agent_id);
      return { id: r.id, title: r.title, tool: r.tool, area: r.area, agents: agents.size, last_seen_at: r.last_seen_at };
    }).filter((x) => x.agents >= 3).sort((a, b) => b.agents - a.agents);
  }

  /** Everything the operator sees about one report. */
  detail(id: string) {
    const r = this.mustReport(id);
    const label = (a: string) => this.keys.agent(a)?.label ?? a;
    const teamsOf = (a: string) => this.teams.teamsOf(a).map((t) => ({ id: t.id, name: t.name }));
    const entries = (this.db.prepare('SELECT * FROM feedback_entries WHERE (report_id=? OR origin_report_id=?) ORDER BY created_at, rowid').all(id, id) as unknown as EntryRow[]).map((e) => ({
      id: e.id, kind: e.kind, agent_id: e.agent_id, agent_label: label(e.agent_id), text: e.text, cost: costOf(e), hub_version: e.hub_version, created_at: e.created_at,
      from_report: e.origin_report_id, links: (this.db.prepare('SELECT kind,target FROM feedback_links WHERE entry_id=? ORDER BY id').all(e.id) as { kind: string; target: string }[]).map(linkText),
    }));
    const firstAt = new Map<string, number>();
    firstAt.set(r.filer_agent_id, r.created_at);
    const info = new Map<string, { app: string | null; client: string | null }>([[r.filer_agent_id, { app: r.filer_app, client: r.client_name ? `${r.client_name}${r.client_version ? ` ${r.client_version}` : ''}` : null }]]);
    for (const e of entries) if (['plus_one', 'evidence', 'still_happening'].includes(e.kind) && !firstAt.has(e.agent_id) && !(e.kind === 'evidence' && e.agent_id === r.assigned_agent_id)) {
      firstAt.set(e.agent_id, e.created_at);
      const raw = this.db.prepare('SELECT app_name,client_name,client_version FROM feedback_entries WHERE id=?').get(e.id) as { app_name: string | null; client_name: string | null; client_version: string | null };
      info.set(e.agent_id, { app: raw.app_name, client: raw.client_name ? `${raw.client_name}${raw.client_version ? ` ${raw.client_version}` : ''}` : null });
    }
    const backers = [...firstAt.entries()].map(([a, at]) => ({ agent_id: a, label: label(a), filer: a === r.filer_agent_id, since: at, teams: teamsOf(a), app: info.get(a)?.app ?? null, client: info.get(a)?.client ?? null }));
    const calls = this.db.prepare("SELECT * FROM feedback_calls WHERE report_id=? OR report_id IN (SELECT id FROM feedback_reports WHERE duplicate_of=?) ORDER BY created_at DESC LIMIT 100").all(id, id) as { invocation_id: string; agent_id: string; tool: string; result: string; error_code: string | null; duration_ms: number; result_bytes: number | null; created_at: number }[];
    let sameError: { calls: number; agents: number; days: number } | null = null;
    if (r.tool && r.error_code) {
      const s = this.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT agent_id) a FROM tool_invocations WHERE tool=? AND error_code=? AND created_at>=?').get(r.tool, r.error_code, Date.now() - 7 * DAY) as { n: number; a: number };
      sameError = { calls: s.n, agents: s.a, days: 7 };
    }
    const n = this.db.prepare(`SELECT COUNT(*) notified, COALESCE(SUM(EXISTS (SELECT 1 FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE c.agent_id=n.agent_id AND t.notice_acked_seq>=n.seq)),0) seen
      FROM agent_notices n WHERE n.ref_feedback_id=? AND n.ref_state=?`).get(id, String(r.status_rev)) as { notified: number; seen: number };
    const pc = r.filer_pc_id ? this.keys.machine(r.filer_pc_id) : null;
    return {
      report: { ...r, hidden: !!r.hidden, title_words: undefined, cost: costOf(r) },
      assignee: r.assigned_agent_id ? { agent_id: r.assigned_agent_id, label: label(r.assigned_agent_id), since: r.assigned_at, note: r.assigned_note, read_at: r.assigned_read_at, on_demand: this.onDemand(r.assigned_agent_id) } : null,
      filer: { agent_id: r.filer_agent_id, label: label(r.filer_agent_id), app: r.filer_app, pc_id: r.filer_pc_id, pc: pc?.name ?? null, teams: JSON.parse(r.filer_teams) as string[], client: r.client_name ? `${r.client_name}${r.client_version ? ` ${r.client_version}` : ''}` : null },
      backers, entries,
      links: (this.db.prepare('SELECT kind,target FROM feedback_links WHERE report_id=? AND entry_id IS NULL ORDER BY id').all(id) as { kind: string; target: string }[]).map(linkText),
      history: (this.db.prepare('SELECT * FROM feedback_history WHERE report_id=? ORDER BY id').all(id) as { actor_kind: string; actor_id: string | null; field: string; old_value: string | null; new_value: string | null; note: string | null; created_at: number }[])
        .map((h) => ({ ...h, actor_label: h.actor_kind === 'agent' && h.actor_id ? label(h.actor_id) : h.actor_kind })),
      hub_evidence: { calls: calls.map((c) => ({ ...c, agent_label: label(c.agent_id) })), same_error_7d: sameError },
      notices: { notified: n.notified, seen: Number(n.seen) },
      duplicates: (this.db.prepare("SELECT id,title FROM feedback_reports WHERE duplicate_of=?").all(id) as { id: string; title: string }[]),
      linked_tasks: this.linkRows(id).map((l) => {
        const t = this.teams.task(l.task_id), team = t?.team_id ? this.teams.team(t.team_id) : null;
        return { task_id: l.task_id, title: t?.title ?? l.task_id, status: t?.status ?? null, team_id: t?.team_id ?? null, team_name: team?.name ?? null,
          review: t ? this.teams.effectiveReview(t) : null, linked_by: l.linked_by_kind === 'agent' && l.linked_by_id ? label(l.linked_by_id) : 'operator', linked_by_kind: l.linked_by_kind, linked_at: l.created_at };
      }),
      task_flags: this.taskFlags(r),
    };
  }

  /** In a live team: until its connector wakes it, the operator has to tell its session (one delivery model). */
  private onDemand(agentId: string): boolean {
    return !!this.db.prepare("SELECT 1 x FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.agent_id=? AND m.removed_at IS NULL AND t.status IN ('draft','running','paused') LIMIT 1").get(agentId);
  }

  /**
   * Assign the report to one agent, or unassign it (agentId null). The new assignee gets a feedback_assigned notice with
   * the report, the operator's note and guidance (L0) and the decision; the previous assignee is told once that it is no
   * longer assigned. The assignment grants nothing beyond reading this report's summary layer.
   */
  assign(id: string, agentId: string | null, note: string | null, actor: Actor): ReportRow {
    const r = this.mustReport(id);
    if (r.status === 'duplicate' || r.status === 'withdrawn') throw new FeedbackError('invalid_state', `The report is ${r.status}; assign ${r.status === 'duplicate' ? r.duplicate_of : 'another report'} instead.`);
    if (agentId) {
      const a = this.keys.agent(agentId);
      if (!a || a.status === 'archived') throw new FeedbackError('invalid_argument', 'No such agent, or it is archived.');
    }
    const prev = r.assigned_agent_id, clean = note?.trim() || null;
    if (prev === agentId && clean === r.assigned_note) return r;
    const now = Date.now();
    tx(this.db, () => {
      this.db.prepare('UPDATE feedback_reports SET assigned_agent_id=?, assigned_at=?, assigned_note=?, assigned_read_at=NULL, updated_at=? WHERE id=?').run(agentId, agentId ? now : null, agentId ? clean : null, now, id);
      this.history(id, actor, 'assignee', prev, agentId, clean);
    });
    const next = this.mustReport(id);
    if (agentId) this.keys.notify(agentId, 'feedback_assigned', assignBody(next, clean));
    if (prev && prev !== agentId) this.keys.notify(prev, 'feedback_unassigned', unassignBody(r, agentId ? 'the operator reassigned it' : 'the operator unassigned it'));
    this.audit.event(actor, 'feedback.assign', { kind: 'feedback', id }, { from: prev, to: agentId });
    return next;
  }

  setStatus(id: string, i: { status: Status; note?: string | null; guidance?: string | null; fixed_in?: string | null }, actor: Actor): ReportRow {
    const r = this.mustReport(id);
    if (!['new', 'needs_info', 'accepted', 'fixed', 'wont_fix'].includes(i.status)) throw new FeedbackError('invalid_argument', 'status must be new, needs_info, accepted, fixed or wont_fix. Use merge for duplicates.');
    if (r.status === 'duplicate' || r.status === 'withdrawn') throw new FeedbackError('invalid_state', `The report is ${r.status}; its status cannot be changed.`);
    const note = i.note?.trim() || null;
    if ((i.status === 'fixed' || i.status === 'wont_fix' || i.status === 'needs_info') && !note) throw new FeedbackError('invalid_argument', i.status === 'fixed' ? 'Say what changed.' : i.status === 'wont_fix' ? 'Give a reason.' : 'Ask the question.');
    const fixedIn = i.status === 'fixed' ? (i.fixed_in?.trim() || null) : null;
    // The operator's decision replaces a close the hub made: from now on the operator's rule applies.
    this.clearTaskClose(r.id);
    const next = this.transition(r, i.status, actor, { note, guidance: i.guidance === undefined ? undefined : (i.guidance?.trim() || null), fixedIn, by: 'operator' });
    this.audit.event(actor, 'feedback.status', { kind: 'feedback', id }, { from: r.status, to: i.status, fixed_in: fixedIn });
    return next;
  }

  /** Mark `id` a duplicate of `targetId`: backers move to the target (counted once per agent), entries stay readable from both. */
  merge(id: string, targetId: string, actor: Actor): { report: ReportRow; target: ReportRow; moved: number } {
    const dup = this.mustReport(id), target = this.mustReport(targetId);
    if (id === targetId) throw new FeedbackError('invalid_argument', 'A report cannot be a duplicate of itself.');
    if (dup.status === 'duplicate') throw new FeedbackError('invalid_state', `The report is already a duplicate of ${dup.duplicate_of}.`);
    if (target.status === 'duplicate') throw new FeedbackError('invalid_argument', `${targetId} is itself a duplicate of ${target.duplicate_of}. Merge into that one.`);
    if (target.status === 'withdrawn') throw new FeedbackError('invalid_argument', 'The target report was withdrawn.');
    const agents = this.backingAgents(dup.id);
    const before = this.backingAgents(target.id);
    const next = this.transition(dup, 'duplicate', actor, { duplicateOf: targetId, note: `Merged into ${targetId}.`, by: 'operator' });
    let linksMoved = 0;
    tx(this.db, () => {
      this.db.prepare(`UPDATE feedback_entries SET kind='evidence' WHERE report_id=? AND kind='plus_one' AND agent_id IN
        (SELECT agent_id FROM feedback_entries WHERE report_id=? AND kind='plus_one' UNION SELECT filer_agent_id FROM feedback_reports WHERE id=?)`).run(dup.id, targetId, targetId);
      this.db.prepare('UPDATE feedback_entries SET origin_report_id=COALESCE(origin_report_id, report_id), report_id=? WHERE report_id=?').run(targetId, dup.id);
      // The duplicate's filer becomes a backer of the target (counted once per agent).
      if (target.filer_agent_id !== dup.filer_agent_id && !this.db.prepare("SELECT 1 x FROM feedback_entries WHERE report_id=? AND agent_id=? AND kind='plus_one'").get(targetId, dup.filer_agent_id)) {
        this.db.prepare('INSERT INTO feedback_entries(id,report_id,origin_report_id,agent_id,credential_id,kind,text,hub_version,app_name,client_name,client_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(newId.entry(), targetId, dup.id, dup.filer_agent_id, dup.filer_credential_id, 'plus_one', null, dup.hub_version, dup.filer_app, dup.client_name, dup.client_version, Date.now());
      }
      this.recount(targetId);
      this.db.prepare('UPDATE feedback_reports SET last_seen_at=MAX(last_seen_at,?), updated_at=? WHERE id=?').run(dup.last_seen_at, Date.now(), targetId);
      this.history(targetId, actor, 'merged_from', null, dup.id);
      // Linked tasks move to the surviving report (a task linked to both stays once).
      linksMoved = this.db.prepare('INSERT OR IGNORE INTO feedback_task_links(report_id,task_id,linked_by_kind,linked_by_id,created_at) SELECT ?,task_id,linked_by_kind,linked_by_id,created_at FROM feedback_task_links WHERE report_id=?').run(targetId, dup.id).changes as number;
      this.db.prepare('DELETE FROM feedback_task_links WHERE report_id=?').run(dup.id);
      this.clearTaskClose(dup.id);
    });
    if (linksMoved) this.evaluate(targetId);
    if (dup.assigned_agent_id) {
      const who = dup.assigned_agent_id;
      this.db.prepare('UPDATE feedback_reports SET assigned_agent_id=NULL, assigned_at=NULL, assigned_note=NULL, assigned_read_at=NULL WHERE id=?').run(dup.id);
      this.history(dup.id, actor, 'assignee', who, null, `Merged into ${targetId}.`);
      if (!target.assigned_agent_id) {
        this.db.prepare('UPDATE feedback_reports SET assigned_agent_id=?, assigned_at=?, assigned_note=?, assigned_read_at=NULL WHERE id=?').run(who, Date.now(), dup.assigned_note, targetId);
        this.history(targetId, actor, 'assignee', null, who, `Carried over from ${dup.id}.`);
        this.keys.notify(who, 'feedback_assigned', `Feedback ${dup.id} was merged into ${targetId}; the assignment moved with it. ` + assignBody(this.mustReport(targetId), dup.assigned_note));
        this.audit.event(actor, 'feedback.assign', { kind: 'feedback', id: targetId }, { from: null, to: who, carried_from: dup.id });
      } else if (target.assigned_agent_id !== who) {
        this.keys.notify(who, 'feedback_unassigned', unassignBody(dup, `the operator merged it into another report, which someone else is working on`));
      }
      this.recount(targetId);
    }
    const moved = this.backingAgents(targetId).filter((a) => !before.includes(a)).length;
    this.audit.event(actor, 'feedback.merge', { kind: 'feedback', id }, { duplicate: id, target: targetId, backers_moved: moved, agents: agents.length, links_moved: linksMoved });
    return { report: next, target: this.mustReport(targetId), moved };
  }

  edit(id: string, p: { title?: string; severity?: Severity; hidden?: boolean; guidance?: string | null }, actor: Actor): ReportRow {
    const r = this.mustReport(id);
    const now = Date.now();
    if (p.title !== undefined && p.title !== r.title) {
      if (/[\r\n]/.test(p.title) || !p.title.trim() || p.title.length > 120) throw new FeedbackError('invalid_argument', 'The title is one line of at most 120 characters.');
      this.db.prepare('UPDATE feedback_reports SET title=?, original_title=COALESCE(original_title, ?), updated_at=? WHERE id=?').run(p.title.trim(), r.title, now, id);
      this.history(id, actor, 'title', r.title, p.title.trim());
      this.audit.event(actor, 'feedback.edit', { kind: 'feedback', id }, { field: 'title' });
    }
    if (p.severity !== undefined && p.severity !== r.severity) {
      this.db.prepare('UPDATE feedback_reports SET severity=?, updated_at=? WHERE id=?').run(p.severity, now, id);
      this.history(id, actor, 'severity', r.severity, p.severity);
      this.audit.event(actor, 'feedback.edit', { kind: 'feedback', id }, { field: 'severity' });
    }
    if (p.hidden !== undefined && p.hidden !== !!r.hidden) {
      this.db.prepare('UPDATE feedback_reports SET hidden=?, updated_at=? WHERE id=?').run(p.hidden ? 1 : 0, now, id);
      this.history(id, actor, 'hidden', r.hidden ? 'hidden' : 'visible', p.hidden ? 'hidden' : 'visible');
      this.audit.event(actor, 'feedback.edit', { kind: 'feedback', id }, { field: 'visibility' });
    }
    // Guidance without a status change: agents see it in the report's decision and in the hint after the same error (knownHint).
    if (p.guidance !== undefined) {
      const g = p.guidance?.trim() || null;
      if (g !== null && g.length > 2000) throw new FeedbackError('invalid_argument', 'Guidance is at most 2000 characters.');
      if (g !== r.guidance) {
        this.db.prepare('UPDATE feedback_reports SET guidance=?, updated_at=? WHERE id=?').run(g, now, id);
        this.history(id, actor, 'guidance', r.guidance, g);
        this.audit.event(actor, 'feedback.edit', { kind: 'feedback', id }, { field: 'guidance' });
      }
    }
    return this.mustReport(id);
  }
  /** An operator's note on the report's timeline. Only the console and the JSON export show it; agents never read the history. */
  note(id: string, text: string, actor: Actor): void {
    this.mustReport(id);
    const t = text.trim();
    if (!t || t.length > 2000) throw new FeedbackError('invalid_argument', 'A note is 1 to 2000 characters.');
    this.history(id, actor, 'note', null, null, t);
    this.db.prepare('UPDATE feedback_reports SET updated_at=? WHERE id=?').run(Date.now(), id);
    this.audit.event(actor, 'feedback.note', { kind: 'feedback', id }, {});
  }

  delete(id: string, actor: Actor): void {
    const r = this.mustReport(id);
    this.audit.event(actor, 'feedback.delete', { kind: 'feedback', id }, { kind: r.kind, tool: r.tool });
    // Entries that moved to another report in a merge came from this one: they go too, and the other report is recounted.
    const others = (this.db.prepare('SELECT DISTINCT report_id FROM feedback_entries WHERE origin_report_id=? AND report_id<>?').all(id, id) as { report_id: string }[]).map((x) => x.report_id);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM feedback_requests WHERE report_id=?').run(id);
      this.db.prepare('DELETE FROM feedback_entries WHERE origin_report_id=? AND report_id<>?').run(id, id);
      this.db.prepare('UPDATE feedback_entries SET origin_report_id=NULL WHERE origin_report_id=?').run(id);
      this.db.prepare('UPDATE feedback_reports SET duplicate_of=NULL WHERE duplicate_of=?').run(id);
      this.db.prepare('DELETE FROM feedback_reports WHERE id=?').run(id);
      for (const o of others) this.recount(o);
    });
  }

  /** Export as Markdown or JSON, with the free text. The call is audited as an export. */
  export(ids: string[], format: 'md' | 'json', actor: Actor, filter?: Record<string, unknown>): string {
    const details = ids.map((id) => this.detail(id));
    this.audit.event(actor, 'feedback.export', null, { ids: ids.slice(0, 50), count: ids.length, filter: filter ?? null, format });
    if (format === 'json') return JSON.stringify(details.map((d) => ({ ...d.report, backers_list: d.backers.map((b) => ({ agent: b.agent_id, label: b.label, filer: b.filer })), entries: d.entries, links: d.links, history: d.history, hub_evidence: d.hub_evidence })), null, 2);
    const fence = (s: string | null) => (s ? s.replace(/\r\n/g, '\n') : '');
    return details.map((d) => {
      const r = d.report;
      const lines = [
        `## ${r.id}: ${r.title}`, '',
        `- Kind: ${r.kind}; severity: ${r.severity}; status: ${r.status}${r.reopen_count ? `; reopened ${r.reopen_count}x` : ''}`,
        `- Tool: ${r.tool ?? '-'}; area: ${r.area}; error code: ${r.error_code ?? '-'}`,
        `- Backers: ${r.backers}; filed ${new Date(r.created_at).toISOString()} by ${d.filer.label} (${d.filer.agent_id}); hub version ${r.hub_version}`,
        ...(d.report.cost ? [`- Estimated cost (agents' estimates): ${[d.report.cost.extra_calls !== null && `${d.report.cost.extra_calls} extra calls`, d.report.cost.extra_tokens !== null && `${d.report.cost.extra_tokens} extra tokens`, d.report.cost.minutes_lost !== null && `${d.report.cost.minutes_lost} minutes`].filter(Boolean).join(', ')}`] : []),
        '', '### What the agent tried', '', fence(r.tried),
        ...(r.happened ? ['', '### What happened', '', fence(r.happened)] : []),
        ...(r.expected ? ['', '### Expected', '', fence(r.expected)] : []),
        ...(r.workaround ? ['', '### Workaround', '', fence(r.workaround)] : []),
        ...(r.status_note || r.guidance ? ['', '### Decision', '', ...(r.status_note ? [`Note: ${r.status_note}`] : []), ...(r.guidance ? [`Guidance: ${r.guidance}`] : []), ...(r.fixed_in ? [`Fixed in: ${r.fixed_in}`] : [])] : []),
        ...(d.entries.length ? ['', '### Entries', '', ...d.entries.map((e) => `- ${new Date(e.created_at).toISOString()} ${e.kind} by ${e.agent_label}${e.text ? `: ${e.text.replace(/\s+/g, ' ')}` : ''}`)] : []),
        ...(d.hub_evidence.calls.length ? ['', '### Hub evidence', '', ...d.hub_evidence.calls.map((c) => `- ${c.invocation_id} ${c.tool} ${c.result}${c.error_code ? ` (${c.error_code})` : ''} ${c.duration_ms} ms`)] : []),
      ];
      return lines.join('\n');
    }).join('\n\n---\n\n') + '\n';
  }
}

function linkText(l: { kind: string; target: string }): string { return l.kind === 'path' ? l.target : `${l.kind}:${l.target}`; }

/** Parse a link with the shared reference grammar (util/refs.ts): `task:<id>`, `share:<id>` or `share:<id>@v<n>`, or a vault path. */
export function parseLink(raw: string): { kind: 'task' | 'share' | 'path'; target: string } {
  const ALLOW = ['task', 'share', 'path'] as const;
  let r;
  try { r = parseRef(raw, ALLOW); } catch (e) { if (e instanceof RefError) throw new FeedbackError('invalid_argument', `A link is ${forms(ALLOW)}.`); throw e; }
  if (r.kind === 'task') return { kind: 'task', target: r.id };
  if (r.kind === 'share') return { kind: 'share', target: r.version ? `${r.id}@v${r.version}` : r.id };
  return { kind: 'path', target: (r as { path: string }).path };
}

/** The notice text for a status change: report ID, title (L2 data), new status, and the operator's note or guidance (L0). */
/** The feedback_unassigned notice: which report and why, never who has it now. */
function unassignBody(r: ReportRow, why: string): string {
  return `Feedback ${r.id} (title ${l2(r.title)}) is no longer assigned to you: ${why}. Stop working on it.`;
}

/** The feedback_assigned notice: what to work on, the operator's words (L0), and what to do when done. */
function assignBody(r: ReportRow, note: string | null): string {
  const parts = [`The operator assigned feedback ${r.id} to you (title ${l2(r.title)}; status ${r.status}, severity ${r.severity}${r.tool ? `, tool ${l2(r.tool, 80)}` : ''}${r.error_code ? `, error ${l2(r.error_code, 80)}` : ''}).`];
  if (note) parts.push(`Operator note on the assignment (L0): ${note}`);
  if (r.status_note) parts.push(`Operator decision note (L0): ${r.status_note}`);
  if (r.guidance) parts.push(`Operator guidance (L0): ${r.guidance}`);
  parts.push('Read it with feedback_read. When you have done the work, say what you did with feedback_add (kind: evidence); the operator marks it fixed.');
  return parts.join(' ');
}

function noticeBody(r: ReportRow, by: 'operator' | 'filer' | 'hub'): string {
  const head = `Feedback ${r.id} (title ${l2(r.title)}) is now ${r.status}${by === 'filer' ? ', withdrawn by the agent that filed it' : ''}.`;
  const parts = [head];
  if (r.status === 'duplicate' && r.duplicate_of) parts.push(`It continues as ${r.duplicate_of}.`);
  if (r.status === 'fixed' && r.fixed_in) parts.push(`Fixed in hub version ${r.fixed_in}.`);
  if (by === 'operator' && r.status_note) parts.push(`Operator note (L0): ${r.status_note}`);
  if (by === 'operator' && r.guidance) parts.push(`Operator guidance (L0): ${r.guidance}`);
  if (r.status === 'needs_info') parts.push('Answer with feedback_add (kind: answer) if you filed it.');
  return parts.join(' ');
}
