/**
 * Directives (docs/directives.md): the operator's standing rules, kept in the hub so it is visible which rules reach
 * which agent and which version each agent has read.
 *
 * - Scope: all agents (hub), one project, one team, one role in a team, or one agent. A directive applies to an
 *   agent when the scope covers it; ended teams and archived agents are left out.
 * - Delivery is cheap: login and session_whoami list titles and versions only; a new or changed directive arrives
 *   once as a notice; the text comes with directives_read.
 * - Agents confirm the version they read (directive_ack), so the console shows who is missing one or out of date.
 * - Agents report rules they follow from elsewhere (directives_report); the operator adopts them as directives or
 *   tells the agent to stop following them.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import type { Keys, Agent } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Teams } from '../teams/teams.js';
import { randomToken } from '../util/crypto.js';

export type ScopeKind = 'hub' | 'project' | 'team' | 'role' | 'agent';
export interface DirectiveRow { id: string; title: string; body: string; scope_kind: ScopeKind; scope_ref: string | null; version: number; status: 'active' | 'retired'; source: string | null; created_by: string | null; created_at: number; updated_at: number; reported_by?: string | null; reviewed_at?: number | null }
export interface ReportRow { id: string; agent_id: string; title: string; source: string | null; summary: string; text: string | null; status: 'open' | 'adopted' | 'retired' | 'known'; directive_id: string | null; note: string | null; created_at: number; decided_at: number | null }
export interface Scope { kind: ScopeKind; ref: string | null }

const err = (code: string, msg: string) => new KeyError(code, msg);
/** More specific scopes win when two directives disagree: agent > role > team > project > hub. */
export const SCOPE_RANK: Record<ScopeKind, number> = { agent: 0, role: 1, team: 2, project: 3, hub: 4 };
/** An agent may register this many directives it follows that the operator has not reviewed yet. */
const MAX_UNREVIEWED = 300;
/** Two titles name the same rule when they match ignoring case, spaces and punctuation. */
export const normTitle = (t: string) => t.toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

export class Directives {
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly teams: Teams, private readonly audit: Audit) {}

  private row(id: string): DirectiveRow | null { return (this.db.prepare('SELECT * FROM directives WHERE id=?').get(id) as unknown as DirectiveRow) ?? null; }
  private must(id: string): DirectiveRow { const d = this.row(id); if (!d) throw err('not_found', 'directive not found'); return d; }

  /** Does this scope cover the agent? */
  covers(s: Scope, a: Agent): boolean {
    if (a.archived_at || a.status === 'archived') return false;
    const live = () => this.teams.teamsOf(a.id).filter((t) => t.status !== 'done' && t.status !== 'stopped');
    switch (s.kind) {
      case 'hub': return true;
      case 'project': return !!s.ref && (a.project ?? '') === s.ref;
      case 'agent': return s.ref === a.id;
      case 'team': return live().some((t) => t.id === s.ref);
      case 'role': { const [team, role] = String(s.ref).split('|'); return live().some((t) => t.id === team && t.my_role === role); }
    }
  }
  /** Agents a scope covers (for notices and coverage). */
  agentsIn(s: Scope): Agent[] { return this.keys.agents().filter((a) => this.covers(s, a)); }

  /** The directives in force for an agent, most specific first, with the version it last read. */
  forAgent(agentId: string): (DirectiveRow & { acked_version: number | null; acked_at: number | null })[] {
    const a = this.keys.agent(agentId); if (!a) return [];
    const acks = new Map((this.db.prepare('SELECT directive_id, version, acked_at FROM directive_acks WHERE agent_id=?').all(agentId) as { directive_id: string; version: number; acked_at: number }[]).map((r) => [r.directive_id, r]));
    return (this.db.prepare("SELECT * FROM directives WHERE status='active' ORDER BY created_at").all() as unknown as DirectiveRow[])
      .filter((d) => this.covers({ kind: d.scope_kind, ref: d.scope_ref }, a))
      .sort((x, y) => SCOPE_RANK[x.scope_kind] - SCOPE_RANK[y.scope_kind] || x.created_at - y.created_at)
      .map((d) => ({ ...d, acked_version: acks.get(d.id)?.version ?? null, acked_at: acks.get(d.id)?.acked_at ?? null }));
  }
  /** One line per directive for login and whoami: cheap enough to send with every login. */
  summaryFor(agentId: string): { id: string; title: string; version: number; scope: string; read: 'current' | 'outdated' | 'unread' }[] {
    return this.forAgent(agentId).map((d) => ({ id: d.id, title: d.title, version: d.version, scope: this.scopeLabel(d),
      read: d.acked_version === null ? 'unread' : d.acked_version >= d.version ? 'current' : 'outdated' }));
  }
  scopeLabel(d: { scope_kind: ScopeKind; scope_ref: string | null }): string {
    switch (d.scope_kind) {
      case 'hub': return 'all agents';
      case 'project': return `project ${d.scope_ref}`;
      case 'team': return `team ${this.teams.team(d.scope_ref ?? '')?.name ?? d.scope_ref}`;
      case 'role': { const [t, r] = String(d.scope_ref).split('|'); return `${r}s of team ${this.teams.team(t ?? "")?.name ?? t}`; }
      case 'agent': return `agent ${this.keys.agent(d.scope_ref ?? '')?.label ?? d.scope_ref}`;
    }
  }

  // ───── the agent side ─────
  read(agentId: string, id?: string) {
    const L = this.forAgent(agentId);
    if (!id) return L;
    const d = L.find((x) => x.id === id);
    if (!d) throw err('not_found', 'No such directive in force for you.');
    return [d];
  }
  ack(agentId: string, id: string, version: number): { id: string; version: number } {
    const d = this.forAgent(agentId).find((x) => x.id === id);
    if (!d) throw err('not_found', 'No such directive in force for you.');
    if (version !== d.version) throw err('invalid_argument', `The current version is ${d.version}; read it with directives_read first.`);
    this.db.prepare('INSERT INTO directive_acks(directive_id,agent_id,version,acked_at) VALUES (?,?,?,?) ON CONFLICT(directive_id,agent_id) DO UPDATE SET version=excluded.version, acked_at=excluded.acked_at')
      .run(id, agentId, version, Date.now());
    return { id, version };
  }
  /**
   * The agent follows a rule the hub does not know: it is registered at once as a directive in force for that agent
   * (and counts as read by it), marked not reviewed. The operator may keep, edit, merge or retire it later; the agent
   * is not asked to wait. Reporting the same title again updates the agent's own unreviewed directive.
   */
  report(agentId: string, a: { title: string; source?: string; summary: string; text?: string }): ReportRow & { directive_id: string; version: number } {
    const title = a.title.trim(), body = (a.text?.trim() || a.summary.trim()), now = Date.now(), actor: Actor = { kind: 'agent', id: agentId };
    const mine = (this.db.prepare("SELECT * FROM directives WHERE status='active' AND reported_by=? AND scope_kind='agent' AND scope_ref=?").all(agentId, agentId) as unknown as DirectiveRow[])
      .find((d) => normTitle(d.title) === normTitle(title));
    let d: DirectiveRow;
    if (mine) {
      d = mine;
      if (!mine.reviewed_at && body !== mine.body) {
        const v = mine.version + 1;
        tx(this.db, () => {
          this.db.prepare('UPDATE directives SET body=?, source=COALESCE(?,source), version=?, updated_at=? WHERE id=?').run(body, a.source?.trim() || null, v, now, mine.id);
          this.db.prepare('INSERT INTO directive_versions(directive_id,version,title,body,scope_kind,scope_ref,change_note,changed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(mine.id, v, mine.title, body, 'agent', agentId, 'updated by the reporting agent', agentId, now);
        });
        d = this.must(mine.id);
      }
    } else {
      const unreviewed = (this.db.prepare("SELECT COUNT(*) n FROM directives WHERE status='active' AND reported_by=? AND reviewed_at IS NULL").get(agentId) as { n: number }).n;
      if (unreviewed >= MAX_UNREVIEWED) throw err('rate_limited', `You already registered ${unreviewed} rules the operator has not reviewed yet.`);
      const id = `dir_${randomToken(10)}`;
      tx(this.db, () => {
        this.db.prepare("INSERT INTO directives(id,title,body,scope_kind,scope_ref,version,status,source,created_by,created_at,updated_at,reported_by,reviewed_at) VALUES (?,?,?,'agent',?,1,'active',?,?,?,?,?,NULL)")
          .run(id, title, body, agentId, a.source?.trim() || null, agentId, now, now, agentId);
        this.db.prepare("INSERT INTO directive_versions(directive_id,version,title,body,scope_kind,scope_ref,change_note,changed_by,created_at) VALUES (?,1,?,?,'agent',?,?,?,?)").run(id, title, body, agentId, `reported${a.source ? ' from ' + a.source.trim() : ''}`, agentId, now);
      });
      d = this.must(id);
      this.audit.event(actor, 'directive.report', { kind: 'directive', id }, { title: title.slice(0, 200), source: a.source ?? null });
    }
    // The agent already follows it: it counts as read at this version.
    this.db.prepare('INSERT INTO directive_acks(directive_id,agent_id,version,acked_at) VALUES (?,?,?,?) ON CONFLICT(directive_id,agent_id) DO UPDATE SET version=excluded.version, acked_at=excluded.acked_at').run(d.id, agentId, d.version, now);
    const rid = `drp_${randomToken(10)}`;
    this.db.prepare("INSERT INTO directive_reports(id,agent_id,title,source,summary,text,status,directive_id,created_at,decided_at) VALUES (?,?,?,?,?,?,'adopted',?,?,?)")
      .run(rid, agentId, title, a.source?.trim() || null, a.summary.trim(), a.text?.trim() || null, d.id, now, now);
    return { ...this.report_(rid), directive_id: d.id, version: d.version };
  }
  /** Reports filed before directives were registered automatically: register them now (once, at start). */
  registerOpenReports(): number {
    const open = this.db.prepare("SELECT * FROM directive_reports WHERE status='open' ORDER BY created_at").all() as unknown as ReportRow[];
    for (const r of open) {
      try { const x = this.report(r.agent_id, { title: r.title, source: r.source ?? undefined, summary: r.summary, text: r.text ?? undefined });
        this.db.prepare("UPDATE directive_reports SET status='adopted', directive_id=?, decided_at=? WHERE id=?").run(x.directive_id, Date.now(), r.id);
        this.db.prepare('DELETE FROM directive_reports WHERE id=?').run(x.id); // the old report row is the record
      } catch (e) { console.error('registering report failed', r.id, e); }
    }
    return open.length;
  }
  /** The operator keeps an agent-registered directive as it is. */
  review(id: string, actor: Actor): DirectiveRow {
    const d = this.must(id);
    if (!d.reviewed_at) { this.db.prepare('UPDATE directives SET reviewed_at=? WHERE id=?').run(Date.now(), id); this.audit.event(actor, 'directive.review', { kind: 'directive', id }, {}); }
    return this.must(id);
  }
  /** Mark every not-reviewed directive as reviewed (optionally of one agent). */
  reviewAll(actor: Actor, agentId?: string): number {
    const r = this.db.prepare(`UPDATE directives SET reviewed_at=? WHERE status='active' AND reviewed_at IS NULL ${agentId ? 'AND reported_by=?' : ''}`).run(...[Date.now(), ...(agentId ? [agentId] : [])]);
    this.audit.event(actor, 'directive.review_all', { kind: 'system', id: 'directives' }, { count: Number(r.changes), agent: agentId ?? null });
    return Number(r.changes);
  }
  /**
   * Merge several directives (usually the same rule reported by several agents) into one with the given title, text
   * and scope. The others retire; their agents are told to follow the merged one, which counts as reviewed.
   */
  merge(ids: string[], a: { title: string; body: string; scope: Scope }, actor: Actor): DirectiveRow {
    const src = ids.map((i) => this.must(i)).filter((x) => x.status === 'active');
    if (src.length < 2) throw err('invalid_argument', 'Choose two or more directives in force to merge.');
    const merged = this.create({ title: a.title, body: a.body, scope: a.scope, source: [...new Set(src.map((x) => x.source).filter(Boolean))].join('; ') || 'merged' }, actor, true);
    const now = Date.now();
    for (const x of src) {
      this.db.prepare("UPDATE directives SET status='retired', updated_at=? WHERE id=?").run(now, x.id);
      for (const ag of this.agentsIn({ kind: x.scope_kind, ref: x.scope_ref })) {
        this.keys.notify(ag.id, 'directive_changed', `Directive "${x.title}" (${x.id}) is merged into "${merged.title}" (${merged.id}, v${merged.version}, for ${this.scopeLabel(merged)}). Follow that one: directives_read {id: "${merged.id}"}, then directive_ack.`);
      }
    }
    this.audit.event(actor, 'directive.merge', { kind: 'directive', id: merged.id }, { from: src.map((x) => x.id) });
    return merged;
  }
  unreviewedCount(): number { return (this.db.prepare("SELECT COUNT(*) n FROM directives WHERE status='active' AND reviewed_at IS NULL").get() as { n: number }).n; }
  /** Directives agents registered that the operator has not reviewed, with the reporter and others reporting the same rule. */
  unreviewed() {
    const rows = this.db.prepare("SELECT * FROM directives WHERE status='active' AND reviewed_at IS NULL ORDER BY created_at").all() as unknown as DirectiveRow[];
    return rows.map((d) => ({ ...d, scope_label: this.scopeLabel(d), reported_by_label: d.reported_by ? this.keys.agent(d.reported_by)?.label ?? d.reported_by : null, project: d.reported_by ? this.keys.agent(d.reported_by)?.project ?? null : null, key: normTitle(d.title) }));
  }
  private report_(id: string): ReportRow { const r = this.db.prepare('SELECT * FROM directive_reports WHERE id=?').get(id) as unknown as ReportRow | undefined; if (!r) throw err('not_found', 'report not found'); return r; }

  // ───── the operator side ─────
  private checkScope(s: Scope): Scope {
    if (s.kind === 'hub') return { kind: 'hub', ref: null };
    const ref = (s.ref ?? '').trim();
    if (!ref) throw err('invalid_argument', 'This scope needs a target.');
    if (s.kind === 'team' && !this.teams.team(ref)) throw err('invalid_argument', 'No such team.');
    if (s.kind === 'role') { const [t, r] = ref.split('|'); if (!this.teams.team(t ?? '') || !r) throw err('invalid_argument', 'A role scope is "<team id>|<role>".'); }
    if (s.kind === 'agent' && !this.keys.agent(ref)) throw err('invalid_argument', 'No such agent.');
    return { kind: s.kind, ref };
  }
  private announce(d: DirectiveRow, what: string, skip?: Set<string>): void {
    for (const a of this.agentsIn({ kind: d.scope_kind, ref: d.scope_ref })) {
      if (skip?.has(a.id)) continue;
      this.keys.notify(a.id, 'directive_changed', `${what} "${d.title}" (${d.id}, v${d.version}, for ${this.scopeLabel(d)}). Read it with directives_read {id: "${d.id}"} and confirm with directive_ack {id: "${d.id}", version: ${d.version}}.`);
    }
  }
  create(a: { title: string; body: string; scope: Scope; source?: string | null }, actor: Actor, quietFor?: boolean): DirectiveRow {
    const title = a.title.trim(), body = a.body.trim();
    if (!title || !body) throw err('invalid_argument', 'A directive needs a title and its text.');
    const s = this.checkScope(a.scope), now = Date.now(), id = `dir_${randomToken(10)}`;
    tx(this.db, () => {
      this.db.prepare("INSERT INTO directives(id,title,body,scope_kind,scope_ref,version,status,source,created_by,created_at,updated_at,reviewed_at) VALUES (?,?,?,?,?,1,'active',?,?,?,?,?)")
        .run(id, title, body, s.kind, s.ref, a.source ?? null, actor.id, now, now, now);
      this.db.prepare('INSERT INTO directive_versions(directive_id,version,title,body,scope_kind,scope_ref,change_note,changed_by,created_at) VALUES (?,1,?,?,?,?,?,?,?)').run(id, title, body, s.kind, s.ref, 'created', actor.id, now);
    });
    const d = this.must(id);
    this.audit.event(actor, 'directive.create', { kind: 'directive', id }, { title, scope: this.scopeLabel(d) });
    if (!quietFor) this.announce(d, 'New directive');
    else this.announce(d, 'Directive (merged from rules your team reported)');
    return d;
  }
  update(id: string, a: { title?: string; body?: string; scope?: Scope; note?: string | null }, actor: Actor): DirectiveRow {
    const d = this.must(id);
    if (d.status !== 'active') throw err('invalid_state', 'Retired directives cannot be edited.');
    const title = a.title?.trim() || d.title, body = a.body?.trim() || d.body, s = a.scope ? this.checkScope(a.scope) : { kind: d.scope_kind, ref: d.scope_ref };
    if (title === d.title && body === d.body && s.kind === d.scope_kind && s.ref === d.scope_ref) return d;
    const before = new Set(this.agentsIn({ kind: d.scope_kind, ref: d.scope_ref }).map((x) => x.id)), now = Date.now(), v = d.version + 1;
    tx(this.db, () => {
      this.db.prepare('UPDATE directives SET title=?, body=?, scope_kind=?, scope_ref=?, version=?, updated_at=?, reviewed_at=? WHERE id=?').run(title, body, s.kind, s.ref, v, now, now, id);
      this.db.prepare('INSERT INTO directive_versions(directive_id,version,title,body,scope_kind,scope_ref,change_note,changed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, v, title, body, s.kind, s.ref, a.note ?? null, actor.id, now);
    });
    const nd = this.must(id);
    this.audit.event(actor, 'directive.update', { kind: 'directive', id }, { version: v, note: a.note ?? null });
    this.announce(nd, body !== d.body ? `Changed directive${a.note ? ` (${a.note})` : ''}:` : 'Directive now applies to you:');
    // Agents the new scope no longer covers are told to stop following it.
    const now_ = new Set(this.agentsIn({ kind: nd.scope_kind, ref: nd.scope_ref }).map((x) => x.id));
    for (const aid of before) if (!now_.has(aid)) this.keys.notify(aid, 'directive_changed', `Directive "${d.title}" (${id}) no longer applies to you. Stop following it.`);
    return nd;
  }
  retire(id: string, note: string | null, actor: Actor): DirectiveRow {
    const d = this.must(id);
    if (d.status === 'retired') return d;
    this.db.prepare("UPDATE directives SET status='retired', updated_at=? WHERE id=?").run(Date.now(), id);
    for (const a of this.agentsIn({ kind: d.scope_kind, ref: d.scope_ref })) this.keys.notify(a.id, 'directive_changed', `Directive "${d.title}" (${id}) is retired${note ? `: ${note}` : ''}. Stop following it.`);
    this.audit.event(actor, 'directive.retire', { kind: 'directive', id }, { note });
    return this.must(id);
  }
  /** Adopt a report: a new directive with the given scope (or link it to an existing one), and the reporter is told. */
  adopt(reportId: string, a: { title?: string; body?: string; scope?: Scope; directive_id?: string }, actor: Actor): { report: ReportRow; directive: DirectiveRow } {
    const r = this.report_(reportId);
    if (r.status !== 'open') throw err('invalid_state', `The report is ${r.status}.`);
    let d: DirectiveRow;
    if (a.directive_id) d = this.must(a.directive_id);
    else {
      const body = a.body?.trim() || r.text?.trim() || '';
      if (!body) throw err('invalid_argument', 'Give the directive\'s text: the agent did not send it.');
      d = this.create({ title: a.title?.trim() || r.title, body, scope: a.scope ?? { kind: 'agent', ref: r.agent_id }, source: r.source ?? `reported by ${this.keys.agent(r.agent_id)?.label ?? r.agent_id}` }, actor);
    }
    this.db.prepare("UPDATE directive_reports SET status=?, directive_id=?, decided_at=? WHERE id=?").run(a.directive_id ? 'known' : 'adopted', d.id, Date.now(), reportId);
    this.keys.notify(r.agent_id, 'directive_changed', `"${r.title}", which you reported following, is now hub directive ${d.id} ("${d.title}", v${d.version}). Follow the hub's version from now on: directives_read {id: "${d.id}"}.`);
    return { report: this.report_(reportId), directive: d };
  }
  /** The operator does not want this rule followed: the reporter is told to stop. */
  dismiss(reportId: string, note: string | null, actor: Actor): ReportRow {
    const r = this.report_(reportId);
    if (r.status !== 'open') throw err('invalid_state', `The report is ${r.status}.`);
    this.db.prepare("UPDATE directive_reports SET status='retired', note=?, decided_at=? WHERE id=?").run(note, Date.now(), reportId);
    this.keys.notify(r.agent_id, 'directive_changed', `Stop following "${r.title}"${r.source ? ` (${r.source})` : ''}: the operator retired it${note ? `: ${note}` : '.'}`);
    this.audit.event(actor, 'directive.report_retire', { kind: 'directive_report', id: reportId }, { note });
    return this.report_(reportId);
  }

  // ───── views for the console ─────
  /** Each directive with how many covered agents read the current version. */
  list(status: 'active' | 'retired' | 'all' = 'active') {
    const rows = this.db.prepare(`SELECT * FROM directives ${status === 'all' ? '' : 'WHERE status=?'} ORDER BY status, updated_at DESC`).all(...(status === 'all' ? [] : [status])) as unknown as DirectiveRow[];
    return rows.map((d) => { const c = this.coverage(d); return { ...d, scope_label: this.scopeLabel(d), reported_by_label: d.reported_by ? this.keys.agent(d.reported_by)?.label ?? d.reported_by : null, agents: c.length, current: c.filter((x) => x.read === 'current').length, outdated: c.filter((x) => x.read === 'outdated').length, unread: c.filter((x) => x.read === 'unread').length }; });
  }
  coverage(d: DirectiveRow): { agent_id: string; label: string; read: 'current' | 'outdated' | 'unread'; version: number | null; acked_at: number | null }[] {
    const acks = new Map((this.db.prepare('SELECT agent_id, version, acked_at FROM directive_acks WHERE directive_id=?').all(d.id) as { agent_id: string; version: number; acked_at: number }[]).map((r) => [r.agent_id, r]));
    return this.agentsIn({ kind: d.scope_kind, ref: d.scope_ref }).map((a) => { const k = acks.get(a.id);
      return { agent_id: a.id, label: a.label, read: !k ? 'unread' as const : k.version >= d.version ? 'current' as const : 'outdated' as const, version: k?.version ?? null, acked_at: k?.acked_at ?? null }; });
  }
  detail(id: string) {
    const d = this.must(id);
    const same = d.status === 'active' ? (this.db.prepare("SELECT id, title, reported_by, scope_kind, scope_ref FROM directives WHERE status='active' AND id<>?").all(id) as { id: string; title: string; reported_by: string | null; scope_kind: ScopeKind; scope_ref: string | null }[]).filter((x) => normTitle(x.title) === normTitle(d.title)).map((x) => ({ ...x, reported_by_label: x.reported_by ? this.keys.agent(x.reported_by)?.label ?? x.reported_by : null, scope_label: this.scopeLabel(x) })) : [];
    return { same, directive: { ...d, scope_label: this.scopeLabel(d), reported_by_label: d.reported_by ? this.keys.agent(d.reported_by)?.label ?? d.reported_by : null }, coverage: d.status === 'active' ? this.coverage(d) : [],
      versions: this.db.prepare('SELECT version, title, change_note, created_at FROM directive_versions WHERE directive_id=? ORDER BY version DESC').all(id),
      reports: this.db.prepare('SELECT * FROM directive_reports WHERE directive_id=? ORDER BY created_at DESC').all(id) };
  }
  reports(status: 'open' | 'all' = 'open') {
    const rows = this.db.prepare(`SELECT * FROM directive_reports ${status === 'open' ? "WHERE status='open'" : ''} ORDER BY created_at DESC LIMIT 200`).all() as unknown as ReportRow[];
    return rows.map((r) => ({ ...r, agent_label: this.keys.agent(r.agent_id)?.label ?? r.agent_id, project: this.keys.agent(r.agent_id)?.project ?? null }));
  }
  /** For the agent screen: in force with read state, plus open and decided reports by that agent. */
  agentView(agentId: string) {
    return { directives: this.forAgent(agentId).map((d) => ({ id: d.id, title: d.title, version: d.version, scope_label: this.scopeLabel(d), acked_version: d.acked_version, acked_at: d.acked_at, reported_by: d.reported_by ?? null, reviewed: !!d.reviewed_at })),
      reports: this.db.prepare('SELECT * FROM directive_reports WHERE agent_id=? ORDER BY created_at DESC LIMIT 50').all(agentId) };
  }
  /** For the team row: directives that reach the team's members, and how many members are missing or out of date. */
  teamView(teamId: string) {
    const members = new Set(this.teams.members(teamId).map((m) => m.agent_id));
    const L = this.list('active').map((d) => ({ d, cov: this.coverage(d).filter((c) => members.has(c.agent_id)) })).filter((x) => x.cov.length);
    return { count: L.length, behind: L.reduce((n, x) => n + x.cov.filter((c) => c.read !== 'current').length, 0), open_reports: (this.db.prepare(`SELECT COUNT(*) n FROM directives WHERE status='active' AND reviewed_at IS NULL AND reported_by IN (${[...members].map(() => '?').join(',') || "''"})`).get(...members) as { n: number }).n };
  }
}
