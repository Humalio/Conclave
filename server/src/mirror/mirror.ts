/**
 * The vault folder "99 Conclave/" (docs/vault.md): the hub writes read-only Markdown copies of its own records (checkouts
 * and their handouts, team and session pages, reviews and decisions) so the operator can review them in Obsidian. The
 * folder outlives the records it copies (mirror_files belongs to no reset part) and only the hub writes it (the policy
 * engine's reserved prefix). It also runs the deferred purge of handout bodies (docs/checkout.md §3, D63): a body is
 * cleared once its page holds that version, or 7 days after it was due at the latest.
 *
 * Every trigger runs after the transaction that caused it has committed and reads the state back from the database. All
 * work is serialised on one chain and is best effort: a failed write is logged and retried by the next sweep; it never
 * fails or slows the action that caused it. Agent text is L2: every page goes through one filter (scrub, then the leak
 * guard) before it is written.
 */
import type { Db } from '../db/db.js';
import type { Audit, Actor } from '../audit/audit.js';
import { scrub } from '../audit/scrub.js';
import type { Vault } from '../vault/vault.js';
import { VaultError } from '../vault/vault.js';
import type { VaultStore } from '../vault/store.js';
import type { LeakGuard } from '../guard/leakGuard.js';
import type { CheckoutRow, HandoutRow, CheckoutStatus, MergedReport } from '../checkout/checkout.js';
import { checkoutBranchOf } from '../checkout/checkout.js';
import { decisionMarkdown, type Decisions } from '../teams/decisions.js';
import { sha256Hex } from '../util/crypto.js';
import { MIRROR_FOLDER } from './folder.js';
import { promises as fs } from 'node:fs';

/** The text filter every page goes through (audit/scrub.ts), shared with task reviews. */
export { scrub };

export type MirrorKind = 'readme' | 'team' | 'session' | 'checkout' | 'handout' | 'reviews' | 'decisions';
export interface MirrorFileRow { path: string; kind: MirrorKind; ref_id: string; ref_version: number | null; revision: string; written_at: number }
/** The push list as render builds it (CheckoutKeys.pushList): per repo, the branches and heads to push. */
export interface PushRepoLike { url: string; remote_name: string; branches: { branch: string; heads: string[]; tip: string | null; unreviewed?: boolean }[] }

export const SETTING_KEY = 'mirror.enabled';
/** A body whose page could not be written is cleared anyway this long after it was due; the Attention item comes a day before. */
export const PURGE_CAP_MS = 7 * 24 * 3600_000;
export const PURGE_WARN_MS = PURGE_CAP_MS - 24 * 3600_000;
/** Team.md and the session pages are written once per team, this long after a change. */
export const TEAM_DELAY_MS = 5 * 60_000;
export const SWEEP_MS = 3600_000;
export const WITHHELD = '_A section was withheld because it looked like a key._';
const NOTICE = 'Written by the Conclave hub from its records';
const sys: Actor = { kind: 'system', id: null };

// ───── names and the page filter ─────
/**
 * A folder or file name for the vault: `/ \ : * ? " < > |` and control characters become "-" (and `# ^ [ ]`, which
 * break Obsidian wikilinks); trailing dots and spaces are cut (Vault.normalise refuses them). Never empty.
 */
export function cleanName(s: string, max = 100): string {
  const x = String(s ?? '').normalize('NFC').replace(/[/\\:*?"<>|#^[\]\x00-\x1f\x7f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[. ]+$/, '');
  return x || 'Unnamed';
}
/** Field names never copied (in "Other facts"). */
const SECRET_FIELD = /key|token|secret|password|totp/i;

const day = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');
const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const parse = <T>(s: string | null | undefined, d: T): T => { if (s == null) return d; try { return JSON.parse(s) as T; } catch { return d; } };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Agent text quoted as written (one quote block, every line). */
const quote = (s: string) => s.split(/\r?\n/).map((l) => `> ${l}`).join('\n');
/** A table cell: one line, no pipes. */
const cell = (s: unknown) => String(s ?? '—').replace(/\r?\n/g, ' ').replace(/\|/g, '/') || '—';
const linkLabel = (s: string) => s.replace(/[[\]|]/g, '');
/** A wikilink to a page the hub wrote (vault-relative path with .md). */
const wl = (path: string, label: string) => `[[${path.replace(/\.md$/i, '')}|${linkLabel(label)}]]`;
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');

interface Page { path: string; kind: MirrorKind; ref: string; refVersion?: number | null; title: string; updated: number; link: string | null; sections: string[] }

const CHECKOUT_WORDS: Record<CheckoutStatus, string> = {
  collecting: 'Collecting handouts', ready: 'Ready, waiting for the restore prompt', rendered: 'Rendered, waiting for the restore prompt to run on the target',
  restoring: 'Restoring on the target', restored: 'Restored on the target', cancelled: 'Cancelled', expired: 'Expired before it was restored',
};
const HANDOUT_WORDS: Record<HandoutRow['status'], string> = {
  requested: 'Asked, the agent has not started', checkpointing: 'Checkpointing', merged: 'Checkpoint reported, handout not written yet',
  written: 'Written', consumed: 'Used: the agent resumed on the target', removed: 'Removed, not used',
};
const TARGET_WORDS: Record<string, string> = { same_user: 'the same OS user on the source PC', same_pc_other_user: 'another OS user on the source PC', other_pc: 'another PC' };

export interface MirrorDeps {
  db: Db; store: VaultStore; vault: Vault; guard: LeakGuard; audit: Audit; decisions: Decisions; publicUrl: string;
  /** Render's push list for a rendered checkout (CheckoutKeys.details), when there is one. */
  pushList?: (checkoutId: string) => PushRepoLike[];
}

export class Mirror {
  /** Injectable clock for tests. */
  now: () => number = Date.now;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly teamTimers = new Map<string, NodeJS.Timeout>();
  private hourly: NodeJS.Timeout | null = null;
  private readonly db: Db;
  constructor(private readonly d: MirrorDeps) { this.db = d.db; }

  // ───── setting and boot ─────
  /** Settings → Vault: the folder on or off (default on). Off stops writing and leaves the files; the protection and the purge cap stay. */
  enabled(): boolean {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(SETTING_KEY) as { value: string } | undefined;
    return r ? parse<unknown>(r.value, true) !== false : true;
  }
  setEnabled(on: boolean, actor: Actor): { enabled: boolean } {
    const before = this.enabled();
    this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(SETTING_KEY, JSON.stringify(!!on), Date.now());
    if (before !== !!on) this.d.audit.event(actor, 'vault.mirror_set', null, { enabled: !!on });
    if (on && !before) void this.sweep();
    return { enabled: this.enabled() };
  }
  settings() { return { mirror_enabled: this.enabled(), folder: MIRROR_FOLDER }; }
  /** The import route's audit event. */
  audit(actor: Actor, checkoutId: string, pages: number): void { this.d.audit.event(actor, 'vault.mirror_import', { kind: 'checkout', id: checkoutId }, { pages }); }
  /** The restricted-folder row (members see the folder only when granted by name): re-added at boot if it is missing. */
  ensureRestricted(): void {
    this.db.prepare('INSERT OR IGNORE INTO vault_folder_flags(path,restricted,set_by,set_at) VALUES (?,1,NULL,?)').run(`/${MIRROR_FOLDER}/`, Date.now());
  }
  /**
   * Boot: the restricted row, then (after the vault's first scan) one sweep, and the hourly timer. With vault scanning
   * off (sweep: false) the hourly timer still runs the purge, so the 7-day cap and its warning hold.
   */
  start(o: { sweep?: boolean } = {}): void {
    this.ensureRestricted();
    const pages = o.sweep !== false;
    if (pages) void this.d.store.ready.then(() => this.sweep());
    this.hourly = setInterval(() => { void this.hourlyTick(pages); }, SWEEP_MS);
    this.hourly.unref();
  }
  /** What the hourly timer runs: the page sweep (which ends with the purge), or the purge alone. */
  hourlyTick(pages: boolean, now?: number): Promise<void> {
    return pages ? this.sweep() : this.run('purge', async () => { this.purge(now); });
  }
  /** Is the hourly timer running (tests)? */
  get ticking(): boolean { return this.hourly !== null; }
  /** Stop timers and wait for the work in flight. */
  async stop(): Promise<void> {
    this.closed = true;
    if (this.hourly) clearInterval(this.hourly);
    for (const t of this.teamTimers.values()) clearTimeout(t);
    this.teamTimers.clear();
    await this.chain;
  }
  /** Resolves once queued work (including setImmediate triggers) has run: tests and the import route. */
  async idle(): Promise<void> {
    for (let i = 0; i < 4; i++) { await new Promise((r) => setImmediate(r)); await this.chain; }
  }
  private run(label: string, fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.closed) return;
      try { await fn(); } catch (e) { console.error(`vault copy: ${label} failed`, e); }
    });
    this.chain = next;
    return next;
  }

  // ───── triggers (all after commit) ─────
  /** A checkout changed (Checkouts.onChange, already deferred past its transaction). */
  checkoutChanged(id: string, expect?: readonly CheckoutStatus[]): Promise<void> {
    return this.run(`checkout ${id}`, async () => {
      const c = this.db.prepare('SELECT * FROM checkouts WHERE id=?').get(id) as unknown as CheckoutRow | undefined;
      if (!c || (expect && !expect.includes(c.status))) return; // rolled back: nothing to copy
      if (this.enabled()) { await this.writeCheckout(c); await this.writeReadme(); }
      this.purge();
      this.scheduleTeam(c.team_id);
    });
  }
  /** A review verdict (Teams.onReviewed): the month's Reviews page is rewritten with it. */
  reviewed(teamId: string): void {
    setImmediate(() => void this.run(`reviews ${teamId}`, async () => {
      if (!this.enabled()) return;
      const t = this.team(teamId);
      if (t) await this.writeReviews(t, month(this.now()));
    }));
    this.scheduleTeam(teamId);
  }
  /** A settled question (Decisions.onSettled). */
  settled(teamId: string): void {
    void this.run(`decisions ${teamId}`, async () => {
      if (!this.enabled()) return;
      const t = this.team(teamId);
      if (t) await this.writeDecisions(t);
    });
    this.scheduleTeam(teamId);
  }
  /** An audit event or task event: Team.md and the session pages of that team, once, 5 minutes later. */
  noteEvent(target: { kind: string; id: string } | null, details: unknown, action?: string): void {
    if (this.closed || !target) return;
    // Paths follow the records at once: a team moved to another project, or a project renamed (its teams, and the teams
    // of any project whose folder name it now shares or no longer shares).
    if (action === 'blueprint.team_assign' && target.kind === 'team') this.relocate([target.id]);
    if (action === 'blueprint.project_update' && target.kind === 'project') {
      this.relocate((this.db.prepare('SELECT id FROM teams WHERE project_id IS NOT NULL ORDER BY created_at, rowid').all() as { id: string }[]).map((r) => r.id));
    }
    let teamId: string | null = null;
    if (target.kind === 'team') teamId = target.id;
    else if (target.kind === 'task') teamId = (this.db.prepare('SELECT team_id FROM tasks WHERE id=?').get(target.id) as { team_id: string | null } | undefined)?.team_id ?? null;
    else if (isObj(details) && typeof details.team === 'string' && /^team_/.test(details.team)) teamId = details.team;
    if (teamId) this.scheduleTeam(teamId);
  }
  scheduleTeam(teamId: string): void {
    if (this.closed || this.teamTimers.has(teamId)) return;
    const t = setTimeout(() => {
      this.teamTimers.delete(teamId);
      void this.run(`team ${teamId}`, async () => {
        if (!this.enabled()) return;
        const row = this.team(teamId);
        if (row) { await this.writeTeamPages(row); await this.writeReadme(); }
      });
    }, TEAM_DELAY_MS);
    t.unref();
    this.teamTimers.set(teamId, t);
  }
  /** Writes every page that is missing or out of date (boot, hourly, the setting turned on), then the purge. */
  sweep(): Promise<void> {
    return this.run('sweep', async () => {
      if (this.enabled()) {
        // Pages that others link to first (checkouts, reviews, decisions), so one sweep settles: the next writes nothing.
        for (const c of this.db.prepare('SELECT * FROM checkouts ORDER BY created_at, rowid').all() as unknown as CheckoutRow[]) {
          try { await this.writeCheckout(c); } catch (e) { console.error('vault copy: checkout sweep failed', c.id, e); }
        }
        for (const t of this.db.prepare('SELECT * FROM teams ORDER BY created_at, rowid').all() as unknown as TeamRowLite[]) {
          try {
            for (const m of this.db.prepare(`SELECT DISTINCT substr(datetime(e.created_at/1000,'unixepoch'),1,7) m FROM task_events e JOIN tasks k ON k.id=e.task_id
              WHERE k.team_id=? AND e.tool IN ('task_review','round_limit')`).all(t.id) as { m: string }[]) await this.writeReviews(t, m.m);
            await this.writeDecisions(t);
            await this.writeTeamPages(t);
          } catch (e) { console.error('vault copy: team sweep failed', t.id, e); }
        }
        await this.writeReadme();
      }
      this.purge();
    });
  }

  // ───── the deferred purge (D63) ─────
  /**
   * Clears each due body whose handout page holds its version, in its own statement; a body whose page could not be
   * written is cleared 7 days after it was due, with an Attention item a day before. Runs after each mirror run and in
   * the hourly sweep, also while the folder is off.
   */
  purge(now = this.now()): { cleared: string[]; capped: string[]; warned: string[] } {
    const rows = this.db.prepare(`SELECT h.id, h.version, h.purge_due, h.agent_id, h.checkout_id, m.ref_version FROM handouts h
      LEFT JOIN mirror_files m ON m.kind='handout' AND m.ref_id=h.id WHERE h.body IS NOT NULL AND h.purge_due IS NOT NULL`).all() as { id: string; version: number; purge_due: number; agent_id: string; checkout_id: string; ref_version: number | null }[];
    const cleared: string[] = [], capped: string[] = [], warned: string[] = [];
    for (const r of rows) {
      if (r.ref_version === r.version) {
        if (this.db.prepare('UPDATE handouts SET body=NULL WHERE id=? AND version=? AND purge_due IS NOT NULL').run(r.id, r.version).changes) cleared.push(r.id);
      } else if (now >= r.purge_due + PURGE_CAP_MS) {
        if (this.db.prepare('UPDATE handouts SET body=NULL WHERE id=? AND purge_due IS NOT NULL').run(r.id).changes) {
          capped.push(r.id);
          this.d.audit.event(sys, 'checkout.handout_purged_uncopied', { kind: 'handout', id: r.id }, { checkout: r.checkout_id, agent: r.agent_id });
        }
      } else if (now >= r.purge_due + PURGE_WARN_MS && !this.db.prepare("SELECT 1 FROM security_alerts WHERE type='handout_purge_soon' AND subject=?").get(r.id)) {
        const label = this.label(r.agent_id), c = this.db.prepare('SELECT team_id FROM checkouts WHERE id=?').get(r.checkout_id) as { team_id: string } | undefined;
        this.d.audit.alert('warning', 'handout_purge_soon', r.id, { team_id: c?.team_id ?? null, team: c?.team_id ?? null, checkout: r.checkout_id, agent: r.agent_id,
          message: `The handout of ${label} will be cleared before its vault copy was written.` });
        warned.push(r.id);
      }
    }
    return { cleared, capped, warned };
  }

  // ───── records ─────
  private team(id: string): TeamRowLite | null { return (this.db.prepare('SELECT * FROM teams WHERE id=?').get(id) as unknown as TeamRowLite) ?? null; }
  private label(agentId: string): string { return (this.db.prepare('SELECT label FROM agents WHERE id=?').get(agentId) as { label: string } | undefined)?.label ?? agentId; }
  private agent(agentId: string): AgentLite | null { return (this.db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as unknown as AgentLite) ?? null; }
  private row(path: string): MirrorFileRow | null { return (this.db.prepare('SELECT * FROM mirror_files WHERE path=?').get(path) as unknown as MirrorFileRow) ?? null; }
  private rowOf(kind: MirrorKind, ref: string): MirrorFileRow | null { return (this.db.prepare('SELECT * FROM mirror_files WHERE kind=? AND ref_id=? ORDER BY written_at LIMIT 1').get(kind, ref) as unknown as MirrorFileRow) ?? null; }
  /** Is the path free for this record: no row for another record, compared without case (Windows and macOS vaults). */
  private pathFree(path: string, kind: MirrorKind, ref: string): boolean {
    const rows = this.db.prepare('SELECT kind, ref_id FROM mirror_files WHERE lower(path)=lower(?)').all(path) as { kind: string; ref_id: string }[];
    return rows.every((r) => r.kind === kind && r.ref_id === ref);
  }
  private folderFree(folder: string): boolean {
    return !this.db.prepare('SELECT 1 FROM mirror_files WHERE substr(lower(path),1,length(?))=lower(?) LIMIT 1').get(`${folder}/`, `${folder}/`);
  }
  /**
   * The project's folder: its name alone; with the key in front only when another live (not closed) project's name cleans
   * to the same folder name, compared without case. Teams with no project go under "No project".
   */
  private projectFolder(t: Pick<TeamRowLite, 'project_id'>): string {
    const p = t.project_id ? this.db.prepare('SELECT id, key, name FROM projects WHERE id=?').get(t.project_id) as { id: string; key: string; name: string } | undefined : undefined;
    if (!p) return 'No project';
    const name = cleanName(p.name), lower = name.toLowerCase();
    const twin = (this.db.prepare("SELECT name FROM projects WHERE id<>? AND status<>'closed'").all(p.id) as { name: string }[]).some((o) => cleanName(o.name).toLowerCase() === lower);
    return twin || lower === 'no project' ? cleanName(`${p.key} ${p.name}`) : name;
  }
  /**
   * Paths follow the records: when the team's project folder is no longer the one its pages sit in (the team moved to
   * another project, the project was renamed, or the folder rule changed), every page the hub wrote under the team's
   * folder moves to the new project folder, with its links to the old folder rewritten. Files the hub did not write
   * stay where they are; old folders are removed once they are empty. Returns the team's folder, or null with no Team.md yet.
   */
  private async placeTeam(t: TeamRowLite): Promise<string | null> {
    const r = this.rowOf('team', t.id);
    if (!r) return null;
    const old = dirOf(r.path), parent = `${MIRROR_FOLDER}/${this.projectFolder(t)}`;
    if (dirOf(old) === parent) return old;
    const base = old.split('/').pop()!;
    const onDisk = (f: string) => this.d.vault.list(f.split('/')).then(() => true, () => false);
    let dest = '';
    for (let n = 1; ; n++) { const f = n === 1 ? `${parent}/${base}` : `${parent}/${base} (${n})`; if (this.folderFree(f) && !(await onDisk(f))) { dest = f; break; } }
    const rows = this.db.prepare('SELECT * FROM mirror_files WHERE substr(path,1,?)=?').all(old.length + 1, `${old}/`) as unknown as MirrorFileRow[];
    const relink = (s: string) => s.split(`[[${old}/`).join(`[[${dest}/`);
    let moved = 0;
    for (const row of rows) {
      const to = dest + row.path.slice(old.length), from = row.path.split('/');
      const cur = await this.d.store.current(from).catch(() => null);
      let rev = row.revision;
      if (cur) {
        // A rename keeps the file's history; then the links into the old folder are rewritten in place.
        rev = (await this.d.store.rename(from, to.split('/'), cur.revision, {})).revision;
        const text = cur.bytes.toString('utf8'), next = relink(text);
        if (next !== text) rev = (await this.d.store.write(to.split('/'), Buffer.from(next, 'utf8'), rev, 'update', {})).revision;
        moved++;
      }
      // A missing file just changes its row: the next write puts the page at the new path.
      this.db.prepare('UPDATE mirror_files SET path=?, revision=? WHERE path=?').run(to, rev, row.path);
    }
    await this.removeEmpty(old, `${MIRROR_FOLDER}`);
    this.d.audit.event(sys, 'vault.mirror_move', { kind: 'team', id: t.id }, { from: old, to: dest, pages: moved });
    return dest;
  }
  /** Removes `folder` and its empty subfolders, then each empty parent up to (not including) `stop`. A folder with anything left in it stays. */
  private async removeEmpty(folder: string, stop: string): Promise<void> {
    const rm = async (f: string): Promise<boolean> => {
      let entries: { name: string; type: string }[];
      try { entries = await this.d.vault.list(f.split('/')); } catch { return false; }
      let empty = true;
      for (const e of entries) if (e.type !== 'folder' || !(await rm(`${f}/${e.name}`))) empty = false;
      if (!empty) return false;
      try { await fs.rmdir(await this.d.vault.resolve(f.split('/'))); return true; } catch { return false; }
    };
    if (!(await rm(folder))) return;
    for (let p = dirOf(folder); p && p !== stop && p.startsWith(`${stop}/`); p = dirOf(p)) if (!(await rm(p))) break;
  }
  /** Teams whose folder may have to move now: a team moved between projects, or a project was renamed. */
  private relocate(teamIds: string[]): void {
    if (!teamIds.length) return;
    setImmediate(() => void this.run('folder move', async () => {
      if (!this.enabled()) return;
      for (const id of teamIds) {
        const t = this.team(id);
        if (!t || !this.rowOf('team', t.id)) continue;
        try { await this.writeTeamPages(t); } catch (e) { console.error('vault copy: folder move failed', id, e); }
      }
      await this.writeReadme();
    }));
  }
  /** The team's folder: where its Team.md was first written (a rename keeps it); a new one gets " (2)" when the name is taken. */
  private teamFolder(t: TeamRowLite): string {
    const r = this.rowOf('team', t.id);
    if (r) return dirOf(r.path);
    const base = `${MIRROR_FOLDER}/${this.projectFolder(t)}/${cleanName(t.name)}`;
    for (let n = 1; ; n++) { const f = n === 1 ? base : `${base} (${n})`; if (this.folderFree(f)) return f; }
  }
  /** A stable path for one record: the one it already has, else `name` in `dir`, with `suffix` when taken. */
  private stablePath(kind: MirrorKind, ref: string, dir: string, name: string, suffix: string, clash: boolean): string {
    const r = this.rowOf(kind, ref);
    if (r) return r.path;
    const plain = `${dir}/${name}.md`, alt = `${dir}/${name} (${suffix}).md`;
    if (!clash && this.pathFree(plain, kind, ref)) return plain;
    if (this.pathFree(alt, kind, ref)) return alt;
    for (let n = 2; ; n++) { const p = `${dir}/${name} (${suffix}) (${n}).md`; if (this.pathFree(p, kind, ref)) return p; }
  }
  private sessionPath(t: TeamRowLite, folder: string, agentId: string): string {
    const name = cleanName(this.label(agentId));
    const others = (this.db.prepare('SELECT agent_id FROM team_members WHERE team_id=? AND agent_id<>?').all(t.id, agentId) as { agent_id: string }[]).map((m) => cleanName(this.label(m.agent_id)).toLowerCase());
    return this.stablePath('session', `${t.id}:${agentId}`, `${folder}/Sessions`, name, agentId, others.includes(name.toLowerCase()));
  }
  /** The path of a member's session page (written or not yet): links do not wait for the page they point to. */
  private sessionLink(t: TeamRowLite, folder: string, agentId: string): string | null {
    if (!this.db.prepare('SELECT 1 FROM team_members WHERE team_id=? AND agent_id=?').get(t.id, agentId)) return null;
    return this.sessionPath(t, folder, agentId);
  }
  private checkoutFolder(c: Pick<CheckoutRow, 'id' | 'created_at'>, teamFolder: string): string {
    const r = this.rowOf('checkout', c.id);
    return r ? dirOf(r.path) : `${teamFolder}/Checkouts/${dateOnly(c.created_at)} ${c.id}`;
  }
  private handoutPath(h: Pick<HandoutRow, 'id' | 'agent_id'>, folder: string, all: Pick<HandoutRow, 'id' | 'agent_id'>[]): string {
    const name = cleanName(this.label(h.agent_id));
    const clash = all.some((x) => x.id !== h.id && cleanName(this.label(x.agent_id)).toLowerCase() === name.toLowerCase()) || name.toLowerCase() === 'readme';
    return this.stablePath('handout', h.id, folder, name, h.agent_id, clash);
  }
  private consoleLink(route: string): string { return `${this.d.publicUrl.replace(/\/+$/, '')}/#${route}`; }

  // ───── writing ─────
  /**
   * The finished page: header, then the sections. Each section is checked by the leak guard as written (so a key split
   * across lines is still found), then scrubbed; a hit for an issued key withholds the section and raises the leak alert.
   */
  private render(p: Page): string {
    const out: string[] = [];
    for (const raw of p.sections) {
      if (this.d.guard.scanString(raw, 'vault_copy')?.issued) { this.leak(p.path); out.push(WITHHELD); continue; }
      out.push(scrub(raw));
    }
    const head = [`# ${scrub(p.title).replace(/\r?\n/g, ' ')}`, '', `> ${NOTICE}, updated ${day(p.updated)}. Edits here are replaced.`, ...(p.link ? [`> [Open in the console](${p.link})`] : []), ''];
    let text = [...head, out.join('\n\n'), ''].join('\n');
    if (this.d.guard.scanString(text, 'vault_copy')?.issued) { this.leak(p.path); text = [...head, WITHHELD, ''].join('\n'); }
    return text;
  }
  private leak(path: string): void {
    this.d.audit.alert('critical', 'key_in_result', null, { tool: 'vault copy', path, message: `A key-like text was kept out of the vault copy ${path}.` });
  }
  /** Writes the page if its text changed since the hub last wrote it (or the file is missing). True when written. */
  private async write(p: Page): Promise<boolean> {
    const bytes = Buffer.from(this.render(p), 'utf8'), rev = `sha256:${sha256Hex(bytes)}`, rel = p.path.split('/');
    const disk = await this.d.vault.revisionOf(rel, 16 * 1024 * 1024);
    const keep = (written: boolean) => {
      this.db.prepare(`INSERT INTO mirror_files(path,kind,ref_id,ref_version,revision,written_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, ref_id=excluded.ref_id, ref_version=excluded.ref_version, revision=excluded.revision, written_at=${written ? 'excluded.written_at' : 'mirror_files.written_at'}`)
        .run(p.path, p.kind, p.ref, p.refVersion ?? null, rev, this.now());
      return written;
    };
    // Unchanged text writes nothing; any other file there (an operator edit in Obsidian) is replaced: its history keeps it.
    if (disk === rev) return keep(false);
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = attempt === 0 ? disk : await this.d.vault.revisionOf(rel, 16 * 1024 * 1024);
      try {
        await this.d.store.write(rel, bytes, base ?? 'absent', base ? 'update' : 'create', {});
        return keep(true);
      } catch (e) { if (!(e instanceof VaultError && e.code === 'conflict')) throw e; }
    }
    throw new VaultError('conflict', `${p.path}: three conflicts in a row`);
  }

  // ───── pages: team, sessions, reviews, decisions, README ─────
  private async ensureTeam(t: TeamRowLite): Promise<string | null> {
    if (this.rowOf('team', t.id)) await this.placeTeam(t);
    else await this.write(this.teamPage(t));
    const r = this.rowOf('team', t.id);
    return r ? dirOf(r.path) : null;
  }
  private async writeTeamPages(t: TeamRowLite): Promise<void> {
    await this.placeTeam(t);
    await this.write(this.teamPage(t));
    const folder = await this.ensureTeam(t);
    if (!folder) return;
    for (const m of this.db.prepare('SELECT * FROM team_members WHERE team_id=? ORDER BY joined_at, rowid').all(t.id) as unknown as MemberLite[]) {
      try { await this.write(this.sessionPage(t, folder, m)); } catch (e) { console.error('vault copy: session page failed', m.agent_id, e); }
    }
  }
  private teamPage(t: TeamRowLite): Page {
    const folder = this.teamFolder(t), path = `${folder}/Team.md`;
    const members = this.db.prepare('SELECT * FROM team_members WHERE team_id=? AND removed_at IS NULL ORDER BY joined_at, rowid').all(t.id) as unknown as MemberLite[];
    const tasks = this.db.prepare("SELECT id, title, status, updated_at FROM tasks WHERE team_id=? AND status NOT IN ('done','cancelled') AND dismissed_at IS NULL ORDER BY created_at, rowid").all(t.id) as { id: string; title: string; status: string; updated_at: number }[];
    const proj = t.project_id ? this.db.prepare('SELECT key, name FROM projects WHERE id=?').get(t.project_id) as { key: string; name: string } | undefined : undefined;
    const S: string[] = [];
    S.push(['## Goal', '', quote(t.goal || '—')].join('\n'));
    S.push(['## Settings', '',
      `- Project: ${proj ? `${proj.key} ${proj.name}` : 'none'}`,
      `- Status: ${t.status}${t.status === 'paused' && t.paused_reason ? ` (${t.paused_reason.startsWith('checkout:') ? 'held by a checkout' : t.paused_reason})` : ''}`,
      `- Delivery: ${t.delivery_mode === 'on_demand' ? 'on demand (agents act when woken)' : 'polling (agents loop on work_next)'}`,
      `- Review rounds: at most ${t.max_review_rounds}`].join('\n'));
    const rows = members.map((m) => {
      const a = this.agent(m.agent_id), sp = this.sessionLink(t, folder, m.agent_id);
      return `| ${sp ? wl(sp, a?.label ?? m.agent_id) : cell(a?.label ?? m.agent_id)} | ${cell(a?.role)} | ${cell(m.role)} | ${cell(this.pcOf(m.credential_id))} | ${day(a?.last_seen_at)} |`;
    });
    S.push(['## Members', '', '| Session | Role | Team role | PC | Last seen |', '| --- | --- | --- | --- | --- |', ...(rows.length ? rows : ['| — | | | | |'])].join('\n'));
    const by = new Map<string, typeof tasks>();
    for (const k of tasks) by.set(k.status, [...(by.get(k.status) ?? []), k]);
    const open = [...by.entries()].map(([s, L]) => [`### ${s.replace(/_/g, ' ')} (${L.length})`, '', ...L.map((k) => `- [${cell(k.title)}](${this.consoleLink(`task/${encodeURIComponent(`${t.id}|${k.id}`)}`)})`)].join('\n'));
    S.push(['## Open tasks', '', open.length ? open.join('\n\n') : 'No open tasks.'].join('\n'));
    const latest = this.db.prepare('SELECT id, created_at, status FROM checkouts WHERE team_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(t.id) as { id: string; created_at: number; status: CheckoutStatus } | undefined;
    const lc = latest ? `${this.checkoutFolder(latest, folder)}/README.md` : null;
    const reviews = (this.db.prepare("SELECT path FROM mirror_files WHERE kind='reviews' AND ref_id LIKE ? ORDER BY path").all(`${t.id}:%`) as { path: string }[]).map((r) => wl(r.path, r.path.split('/').pop()!.replace(/\.md$/, '')));
    const dec = this.rowOf('decisions', t.id);
    S.push(['## Records', '',
      `- Latest checkout: ${latest ? (lc ? wl(lc, `${dateOnly(latest.created_at)} ${latest.id}`) : `${latest.id}`) + ` (${CHECKOUT_WORDS[latest.status].toLowerCase()})` : 'none'}`,
      `- Reviews: ${reviews.length ? reviews.join(', ') : 'none yet'}`,
      `- Decisions: ${dec ? wl(dec.path, 'Decisions') : 'none yet'}`,
      '', `\`${t.id}\``].join('\n'));
    const updated = Math.max(t.updated_at, ...tasks.map((k) => k.updated_at));
    return { path, kind: 'team', ref: t.id, title: t.name, updated, link: this.consoleLink(`team/${t.id}`), sections: S };
  }
  private pcOf(credentialId: string | null): string | null {
    if (!credentialId) return null;
    const m = this.db.prepare(`SELECT m.name FROM credentials c JOIN machines m ON m.id=COALESCE(c.bound_machine_id, c.machine_id) WHERE c.id=?`).get(credentialId) as { name: string } | undefined;
    if (m) return m.name;
    const l = this.db.prepare(`SELECT m.name FROM session_tokens t JOIN credentials a ON a.id=t.app_credential_id JOIN machines m ON m.id=a.machine_id
      WHERE t.session_credential_id=? ORDER BY t.created_at DESC LIMIT 1`).get(credentialId) as { name: string } | undefined;
    return l?.name ?? null;
  }
  private sessionPage(t: TeamRowLite, folder: string, m: MemberLite): Page {
    const a = this.agent(m.agent_id), path = this.sessionPath(t, folder, m.agent_id), label = a?.label ?? m.agent_id;
    const S: string[] = [];
    S.push(['## Session', '',
      `- Label: ${label}`, `- Role: ${a?.role ?? '—'}${a?.role_detail ? '' : ''}`, `- Team role: ${m.role}${m.removed_at ? ` (left the team ${day(m.removed_at)})` : ''}`,
      `- PC: ${this.pcOf(m.credential_id) ?? 'not known'}`, `- Model: ${a?.model_label ?? 'not known'}`,
      `- Joined: ${day(m.joined_at)}`, `- Last seen: ${day(a?.last_seen_at)}`].join('\n'));
    if (a?.role_detail) S.push(['## Role detail', '', quote(a.role_detail)].join('\n'));
    const cur = this.db.prepare("SELECT id, title, status FROM tasks WHERE team_id=? AND assignee_agent_id=? AND status IN ('assigned','in_progress','in_review','changes_requested','blocked') ORDER BY updated_at DESC").all(t.id, m.agent_id) as { id: string; title: string; status: string }[];
    S.push(['## Current work', '', cur.length ? cur.map((k) => `- [${cell(k.title)}](${this.consoleLink(`task/${encodeURIComponent(`${t.id}|${k.id}`)}`)}) (${k.status.replace(/_/g, ' ')})`).join('\n') : 'No task in hand.'].join('\n'));
    const done = this.db.prepare("SELECT id, title, status, updated_at FROM tasks WHERE team_id=? AND assignee_agent_id=? AND status IN ('done','approved') ORDER BY updated_at DESC LIMIT 10").all(t.id, m.agent_id) as { id: string; title: string; status: string; updated_at: number }[];
    const verdict = (taskId: string) => {
      const e = this.db.prepare("SELECT to_status, actor_id FROM task_events WHERE task_id=? AND tool='task_review' ORDER BY id DESC LIMIT 1").get(taskId) as { to_status: string; actor_id: string | null } | undefined;
      return e ? `${e.to_status === 'approved' ? 'approved' : 'changes requested'} by ${e.actor_id ? this.label(e.actor_id) : 'the reviewer'}` : 'no review';
    };
    S.push(['## Last finished tasks', '', done.length ? done.map((k) => `- ${day(k.updated_at).slice(0, 10)} [${cell(k.title)}](${this.consoleLink(`task/${encodeURIComponent(`${t.id}|${k.id}`)}`)}): ${verdict(k.id)}`).join('\n') : 'None yet.'].join('\n'));
    const hs = this.db.prepare('SELECT h.id, h.checkout_id, h.status, c.created_at FROM handouts h JOIN checkouts c ON c.id=h.checkout_id WHERE c.team_id=? AND h.agent_id=? ORDER BY c.created_at').all(t.id, m.agent_id) as { id: string; checkout_id: string; status: HandoutRow['status']; created_at: number }[];
    S.push(['## Handouts', '', hs.length ? hs.map((h) => { const r = this.rowOf('handout', h.id); return `- ${dateOnly(h.created_at)} ${h.checkout_id}: ${r ? wl(r.path, 'handout') : 'not copied yet'} (${HANDOUT_WORDS[h.status].toLowerCase()})`; }).join('\n') : 'None.'].join('\n'));
    S.push(`\`${m.agent_id}\``);
    return { path, kind: 'session', ref: `${t.id}:${m.agent_id}`, title: label, updated: Math.max(m.joined_at, a?.last_seen_at ?? 0, ...done.map((k) => k.updated_at)), link: this.consoleLink(`ses/${m.agent_id}`), sections: S };
  }
  private async writeReviews(t: TeamRowLite, ym: string): Promise<void> {
    const folder = await this.ensureTeam(t);
    if (!folder) return;
    const start = Date.parse(`${ym}-01T00:00:00Z`), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    const ev = this.db.prepare(`SELECT e.id, e.task_id, e.to_status, e.actor_id, e.tool, e.note, e.created_at, k.title, k.assignee_agent_id, k.reviewer_agent_id, k.review_comments
      FROM task_events e JOIN tasks k ON k.id=e.task_id WHERE k.team_id=? AND e.from_status='in_review' AND e.tool IN ('task_review','round_limit') AND e.created_at>=? AND e.created_at<? ORDER BY e.id`)
      .all(t.id, start, end.getTime()) as { id: number; task_id: string; to_status: string; actor_id: string | null; tool: string; note: string | null; created_at: number; title: string; assignee_agent_id: string | null; reviewer_agent_id: string | null; review_comments: string | null }[];
    if (!ev.length) return;
    const S = ev.map((e) => {
      const prior = (this.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND from_status='in_review' AND to_status IN ('changes_requested','blocked') AND tool IN ('task_review','round_limit') AND id<?").get(e.task_id, e.id) as { n: number }).n;
      const last = (this.db.prepare("SELECT MAX(id) id FROM task_events WHERE task_id=? AND tool IN ('task_review','round_limit')").get(e.task_id) as { id: number }).id === e.id;
      const reviewer = e.tool === 'task_review' && e.actor_id ? this.label(e.actor_id) : e.reviewer_agent_id ? this.label(e.reviewer_agent_id) : 'the reviewer';
      const decision = e.to_status === 'approved' ? 'Approved' : e.tool === 'round_limit' ? 'Changes requested (round limit reached; the task is blocked)' : 'Changes requested';
      const comments = (last && e.review_comments) ? e.review_comments : e.note;
      return [`## ${day(e.created_at)} · ${cell(e.title)}`, '',
        `- Task: [${cell(e.title)}](${this.consoleLink(`task/${encodeURIComponent(`${t.id}|${e.task_id}`)}`)})`,
        `- Author: ${e.assignee_agent_id ? this.label(e.assignee_agent_id) : '—'}`, `- Reviewer: ${reviewer}`,
        `- Decision: **${decision}**`, `- Round ${prior + 1} of ${t.max_review_rounds}`,
        ...(comments ? ['', quote(comments)] : []), '', `\`${e.task_id}\``].join('\n');
    });
    await this.write({ path: this.stablePath('reviews', `${t.id}:${ym}`, `${folder}/Reviews`, ym, ym, false), kind: 'reviews', ref: `${t.id}:${ym}`, title: `${t.name} · reviews ${ym}`,
      updated: ev[ev.length - 1]!.created_at, link: this.consoleLink(`tasks/${t.id}`), sections: S });
  }
  private async writeDecisions(t: TeamRowLite): Promise<void> {
    const ids = this.db.prepare("SELECT id FROM decisions WHERE team_id=? AND status IN ('answered','declined') ORDER BY COALESCE(answered_at, updated_at), rowid").all(t.id) as { id: string }[];
    if (!ids.length) return;
    const folder = await this.ensureTeam(t);
    if (!folder) return;
    const views = ids.map((r) => this.d.decisions.get(r.id));
    await this.write({ path: this.stablePath('decisions', t.id, folder, 'Decisions', 'hub', false), kind: 'decisions', ref: t.id, title: `${t.name} · decisions`,
      updated: Math.max(...views.map((v) => v.answered_at ?? v.updated_at)), link: this.consoleLink(`decisions/${t.id}`), sections: views.map((v) => decisionMarkdown(v).trimEnd()) });
  }
  /** The index: projects and teams with links, including teams that are no longer in the hub (from mirror_files). */
  private async writeReadme(): Promise<void> {
    const rows = this.db.prepare("SELECT path, ref_id FROM mirror_files WHERE kind='team' ORDER BY path").all() as { path: string; ref_id: string }[];
    if (!rows.length) return;
    const by = new Map<string, string[]>();
    let updated = 0;
    for (const r of rows) {
      const proj = r.path.split('/')[1] ?? 'No project', t = this.team(r.ref_id);
      if (t) updated = Math.max(updated, t.updated_at);
      const name = t?.name ?? r.path.split('/')[2] ?? r.ref_id;
      by.set(proj, [...(by.get(proj) ?? []), `- ${wl(r.path, name)} — ${t ? t.status : 'no longer in the hub'}`]);
    }
    const S = ['This folder holds read-only copies of what the hub keeps in its records: checkout handouts, team and session pages, reviews and decisions. The hub replaces any edit here. Agents never write here, and read it only when the operator grants it to them by name.',
      ...[...by.entries()].map(([p, L]) => [`## ${p}`, '', ...L].join('\n'))];
    await this.write({ path: `${MIRROR_FOLDER}/README.md`, kind: 'readme', ref: 'readme', title: MIRROR_FOLDER, updated: updated || ((this.db.prepare("SELECT MAX(written_at) w FROM mirror_files WHERE kind='team'").get() as { w: number | null }).w ?? 0), link: this.consoleLink('home'), sections: S });
  }

  // ───── pages: checkout README and handouts ─────
  private async writeCheckout(c: CheckoutRow, snapshot?: { handouts: HandoutRow[]; push?: PushRepoLike[] }): Promise<void> {
    const t = this.team(c.team_id) ?? { id: c.team_id, name: `Team ${c.team_id}`, goal: '', status: 'gone', paused_reason: null, project_id: null, delivery_mode: 'poll', max_review_rounds: 0, created_at: c.created_at, updated_at: c.created_at };
    const teamFolder = this.team(c.team_id) ? await this.ensureTeam(t) : this.teamFolder(t);
    if (!teamFolder) return;
    const folder = this.checkoutFolder(c, teamFolder);
    const H = snapshot?.handouts ?? (this.db.prepare('SELECT * FROM handouts WHERE checkout_id=? ORDER BY created_at, rowid').all(c.id) as unknown as HandoutRow[]);
    // Handout pages first: the README links to them.
    for (const h of H) {
      try {
        const path = this.handoutPath(h, folder, H), row = this.row(path);
        // A purged body never overwrites the page that holds it: the copy is what stays.
        if (h.body === null && row && row.ref_version === h.version) continue;
        await this.write(this.handoutPage(c, t, h, path));
      } catch (e) { console.error('vault copy: handout page failed', h.id, e); }
    }
    await this.write(await this.checkoutPage(c, t, folder, H, snapshot?.push));
  }
  private memberRole(teamId: string, agentId: string): string | null {
    return (this.db.prepare('SELECT role FROM team_members WHERE team_id=? AND agent_id=? ORDER BY joined_at DESC LIMIT 1').get(teamId, agentId) as { role: string } | undefined)?.role ?? null;
  }
  private handoutPage(c: CheckoutRow, t: TeamRowLite, h: HandoutRow, path: string): Page {
    const a = this.agent(h.agent_id), label = a?.label ?? h.agent_id, body = parse<Record<string, unknown> | null>(h.body, null), r = parse<MergedReport | null>(h.report, null);
    const sp = this.sessionLink(t, path.split('/Checkouts/')[0]!, h.agent_id);
    const S: string[] = [];
    S.push(['## Session', '', `- Session: ${sp ? wl(sp, label) : label}`, `- Role: ${a?.role ?? '—'}`, `- Team role: ${this.memberRole(t.id, h.agent_id) ?? '—'}`,
      `- Status: ${HANDOUT_WORDS[h.status]}`, `- Written by: ${h.source === 'hub' ? 'the hub (the agent did not write one: no notes, work left on the source PC)' : 'the agent'}`].join('\n'));
    if (r) {
      const L = r.leftovers ?? [];
      S.push(['## Checkpoint report', '',
        ...(r.no_repo !== undefined ? [`- Nothing to merge: ${r.no_repo}`] : [
          `- Integration branch: ${r.integration_branch ?? '—'} at ${r.integration_head ?? '—'}`,
          `- Merge commits: ${(r.merge_commits ?? []).length ? (r.merge_commits ?? []).join(', ') : 'none'}`]),
        ...(checkoutBranchOf(r, c.id) ? [`- Checkout branch ${checkoutBranchOf(r, c.id)} at ${r.checkout_head} (work not approved yet)`] : []),
        `- Worktrees left: ${r.worktrees_left}`, `- Clean: ${r.clean ? 'yes' : 'no'}`,
        `- Leftovers: ${L.length ? '' : 'none'}`, ...L.map((l) => `  - ${l.kind}: ${l.item} (${l.approved ? 'approved' : l.refused ? `refused: ${l.refused}` : 'waiting'}). Reason: ${l.reason}`)].join('\n'));
    }
    if (body) S.push(...this.bodySections(body, c.id));
    else if (h.status !== 'requested' && h.status !== 'checkpointing' && h.status !== 'merged') S.push('_The handout text was cleared before this copy was written._');
    S.push(['## Version and times', '', `- Version ${h.version}`, `- Asked: ${day(h.created_at)}`, `- Written: ${day(h.written_at)}`,
      ...(h.consumed_at ? [`- Resumed: ${day(h.consumed_at)}`] : []), ...(h.removed_at ? [`- Removed: ${day(h.removed_at)}`] : []), '', `\`${h.id}\``].join('\n'));
    return { path, kind: 'handout', ref: h.id, refVersion: body ? h.version : null, title: `${label} · handout`, updated: Math.max(h.updated_at, h.written_at ?? 0),
      link: this.consoleLink(`tco/${c.team_id}`), sections: S };
  }
  /** The body's local facts as readable sections; fields it does not know go under "Other facts", secret-named ones never. */
  private bodySections(b: Record<string, unknown>, checkoutId: string): string[] {
    const S: string[] = [], known = new Set(['folder', 'repo', 'provider_was', 'notes', 'checkpoint', 'exceptions', 'built_by', 'unmerged_work_on_source']);
    S.push(['## Folder', '', `- ${typeof b.folder === 'string' ? b.folder : 'not known'}`].join('\n'));
    if (isObj(b.repo)) S.push(['## Repository', '', `- Remote: ${b.repo.remote_name ?? '—'}`, `- URL: ${b.repo.url ?? '—'}`, `- Clone folder: ${b.repo.clone_folder ?? '—'}`].join('\n'));
    if (isObj(b.provider_was)) { const p = b.provider_was; S.push(['## Provider before the move', '', `- Provider: ${p.provider ?? '—'}`, `- Model: ${p.model ?? '—'}`, `- Effort: ${p.effort ?? '—'}`, `- Permissions: ${p.permissions ?? '—'}`].join('\n')); }
    if (isObj(b.checkpoint)) {
      const k = b.checkpoint;
      const own = checkoutBranchOf(k, checkoutId);
      S.push(['## Branches', '', ...(typeof k.no_repo === 'string' ? [`- Nothing to merge: ${k.no_repo}`] : [`- ${k.integration_branch ?? '—'} at ${k.integration_head ?? '—'}`]),
        ...(Array.isArray(k.merge_commits) && k.merge_commits.length ? [`- Merge commits: ${k.merge_commits.join(', ')}`] : []),
        ...(own ? [`- ${own} at ${k.checkout_head} (not approved yet)`] : [])].join('\n'));
    } else if (b.unmerged_work_on_source) S.push(['## Branches', '', '- No complete checkpoint: the work stays on the source PC.'].join('\n'));
    if (Array.isArray(b.exceptions) && b.exceptions.length) S.push(['## Worktrees and leftovers', '', ...b.exceptions.filter(isObj).map((x) => `- ${x.kind}: ${x.item}. Reason: ${x.reason}`)].join('\n'));
    S.push(['## Notes', '', typeof b.notes === 'string' && b.notes.trim() ? quote(b.notes) : 'No notes.'].join('\n'));
    const other = Object.entries(b).filter(([k]) => !known.has(k) && !SECRET_FIELD.test(k));
    if (other.length) S.push(['## Other facts', '', ...other.map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(this.dropSecrets(v))}`)].join('\n'));
    return S;
  }
  private dropSecrets(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.dropSecrets(x));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_FIELD.test(k)).map(([k, x]) => [k, this.dropSecrets(x)]));
    return v;
  }
  private async checkoutPage(c: CheckoutRow, t: TeamRowLite, folder: string, H: HandoutRow[], snapshotPush?: PushRepoLike[]): Promise<Page> {
    const path = `${folder}/README.md`, ch = parse<{ target?: string; machine_id?: string | null; rotate_agent_keys?: boolean } | null>(c.choices, null);
    const machine = (id: string | null | undefined) => id ? (this.db.prepare('SELECT name FROM machines WHERE id=?').get(id) as { name: string } | undefined)?.name ?? id : null;
    const by = c.requested_by ? this.db.prepare('SELECT display_name, username FROM admin_users WHERE id=?').get(c.requested_by) as { display_name: string | null; username: string } | undefined : undefined;
    const written = H.filter((h) => h.status === 'written' || h.status === 'consumed').length, resumed = H.filter((h) => h.status === 'consumed').length;
    const words = c.status === 'collecting' ? `${CHECKOUT_WORDS.collecting} (${written} of ${H.length} written)` : c.status === 'restoring' ? `${CHECKOUT_WORDS.restoring} (${resumed} of ${H.length} resumed)` : CHECKOUT_WORDS[c.status];
    const S: string[] = [];
    S.push(['## Status', '', `- Team: ${wl(`${folder.split('/Checkouts/')[0]}/Team.md`, t.name)}`, `- Status: ${words}`,
      `- Asked by: ${by ? by.display_name || by.username : 'the operator'}`,
      ...(c.status === 'cancelled' && c.end_reason && c.end_reason !== 'cancelled' ? [`- Cancel note: ${c.end_reason === 'team_ended' ? 'the team was stopped' : c.end_reason}`] : [])].join('\n'));
    S.push(['## Dates', '', `- Started: ${day(c.created_at)}`, `- Ready: ${day(c.ready_at)}`, `- Rendered: ${day(c.rendered_at)}`, `- Ended: ${day(c.ended_at ?? c.restored_at)}`, `- Expires: ${day(c.expires_at)}`].join('\n'));
    S.push(['## Where', '', `- Source PC: ${machine(c.source_machine_id) ?? 'not known'}`,
      `- Target: ${ch?.target ? `${TARGET_WORDS[ch.target] ?? ch.target}${ch.target !== 'same_user' && (machine(c.target_machine_id) ?? machine(ch.machine_id)) ? ` (${machine(c.target_machine_id) ?? machine(ch.machine_id)})` : ''}` : 'not chosen yet'}`].join('\n'));
    S.push(await this.pushSection(c, path, H, ch?.target, snapshotPush));
    const missing = parse<string[]>(c.missing, []);
    S.push(['## Handouts', '', ...H.map((h) => { const r = this.rowOf('handout', h.id); const lb = this.label(h.agent_id);
      return `- ${r ? wl(r.path, lb) : lb}: ${HANDOUT_WORDS[h.status].toLowerCase()}${h.source === 'hub' ? '; built by the hub: no notes, work left on the source PC' : ''}`; }),
      ...(missing.length ? ['', `The hub built ${missing.length} handout${missing.length === 1 ? '' : 's'}: ${missing.map((a) => this.label(a)).join(', ')}.`] : [])].join('\n'));
    const end = c.status === 'restored' ? `Restored ${day(c.restored_at)}: ${H.some((h) => h.status === 'removed') ? `finished by hand; not resumed: ${H.filter((h) => h.status === 'removed').map((h) => this.label(h.agent_id)).join(', ')}` : 'every agent resumed on the target'}.`
      : c.status === 'cancelled' ? `Cancelled ${day(c.ended_at)}${c.end_reason === 'team_ended' ? ' because the team was stopped' : ''}. The checkpoint merges stay; the team carries on where it was.`
        : c.status === 'expired' ? `Expired ${day(c.ended_at)}, 48 hours after it started or was last rendered. The checkpoint merges stay.` : null;
    if (end) S.push(['## Outcome', '', end].join('\n'));
    S.push(`\`${c.id}\``);
    return { path, kind: 'checkout', ref: c.id, title: `${t.name} · checkout ${dateOnly(c.created_at)}`, updated: c.updated_at, link: this.consoleLink(`tco/${c.team_id}`), sections: S };
  }
  /**
   * The push list from the handouts: render's own list once rendered, else the branches each handout names. Once a body
   * is purged its facts are gone from the database, so the section written while they were there is kept.
   */
  private async pushSection(c: CheckoutRow, path: string, H: HandoutRow[], target: string | undefined, snapshot?: PushRepoLike[]): Promise<string> {
    if (!snapshot && H.some((h) => h.body === null && (h.status === 'consumed' || h.status === 'removed'))) {
      try {
        const cur = (await this.d.vault.readBytes(path.split('/'))).toString('utf8');
        const i = cur.indexOf('\n## Push list\n');
        if (i >= 0) { const j = cur.indexOf('\n## ', i + 1); return cur.slice(i + 1, j < 0 ? undefined : j).trimEnd(); }
      } catch { /* no page yet: build what is left */ }
    }
    let list: PushRepoLike[] = snapshot ?? [];
    if (!snapshot && target && target !== 'same_user' && this.d.pushList) { try { list = this.d.pushList(c.id); } catch { list = []; } }
    const lines: string[] = [];
    if (list.length) {
      for (const r of list) for (const b of r.branches) lines.push(`- ${r.url} (${r.remote_name}): ${b.branch} at ${b.tip ?? b.heads.at(-1) ?? '—'}${b.unreviewed ? ' (not approved yet)' : ''}; push before the restore prompt runs`);
      // Render's list leaves out the agents with nothing to merge: name them, so the page accounts for every member.
      for (const h of H) {
        const b = parse<Record<string, unknown> | null>(h.body, null), k = b && isObj(b.checkpoint) ? b.checkpoint : null;
        if (k && typeof k.no_repo === 'string') lines.push(`- ${this.label(h.agent_id)}: nothing to merge: ${k.no_repo}`);
      }
    } else {
      for (const h of H) {
        const b = parse<Record<string, unknown> | null>(h.body, null);
        const repo = b && isObj(b.repo) ? b.repo : null, k = b && isObj(b.checkpoint) ? b.checkpoint : null;
        if (!k) continue;
        const where = repo?.url ? `${repo.url} (${repo.remote_name ?? 'origin'})` : 'no repo URL';
        const pushed = target === 'same_user' ? 'no push needed (same OS user)' : target ? 'push before the restore prompt runs' : 'decided at render';
        if (typeof k.no_repo === 'string') { lines.push(`- ${this.label(h.agent_id)}: nothing to merge: ${k.no_repo}`); continue; }
        const own = checkoutBranchOf(k, c.id);
        lines.push(`- ${this.label(h.agent_id)}: ${where}: ${k.integration_branch ?? '—'} at ${k.integration_head ?? '—'}${own ? `, ${own} at ${k.checkout_head} (not approved yet)` : ''}; ${pushed}`);
      }
    }
    return ['## Push list', '', lines.length ? lines.join('\n') : 'Nothing to push.'].join('\n');
  }

  // ───── seeding from saved JSON (scripts/mirror-import-checkout.mjs) ─────
  /**
   * Writes the pages of one checkout from a saved copy (GET /api/checkouts/:id as JSON, or its `checkout` part): the case
   * where the checkout ended before this build was deployed and its bodies are gone from the database. The pages land
   * where the live sweep would put them and are kept from then on (a purged body never overwrites its page).
   */
  async importCheckout(json: unknown): Promise<{ checkout: string; pages: string[] }> {
    const v = isObj(json) && isObj(json.checkout) ? json.checkout : json;
    if (!isObj(v) || typeof v.id !== 'string' || !/^cko_[A-Za-z0-9_-]+$/.test(v.id) || typeof v.team_id !== 'string' || !Array.isArray(v.handouts)) throw new VaultError('invalid_argument', 'Not a saved checkout: expected the JSON of GET /api/checkouts/:id.');
    const num = (x: unknown) => {
      if (x == null) return null;
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 8.64e15) throw new VaultError('invalid_argument', `Not a saved checkout: ${JSON.stringify(x)} is not a time.`);
      return x;
    };
    // The live checkout's own pages come from the hub: an imported copy must not stand in for a body the hub still holds.
    if (this.db.prepare('SELECT 1 FROM handouts WHERE checkout_id=? AND body IS NOT NULL').get(v.id)) {
      throw new VaultError('conflict', 'This checkout\'s handouts still hold their text in the hub, which writes their pages itself. Import only a checkout whose handouts were already cleared.');
    }
    const c: CheckoutRow = { id: v.id, team_id: v.team_id, status: v.status as CheckoutStatus, source_machine_id: (v.source_machine_id as string) ?? null, target_machine_id: (v.target_machine_id as string) ?? null,
      request_id: null, choices: v.choices ? JSON.stringify(v.choices) : null, handout_hashes: null, paused_team: 0, missing: JSON.stringify(Array.isArray(v.missing) ? v.missing : []),
      end_reason: (v.end_reason as string) ?? null, requested_by: null, created_at: num(v.created_at) ?? this.now(), updated_at: num(v.ended_at) ?? num(v.restored_at) ?? num(v.created_at) ?? this.now(),
      ready_at: num(v.ready_at), rendered_at: num(v.rendered_at), restoring_at: num(v.restoring_at), restored_at: num(v.restored_at), ended_at: num(v.ended_at), expires_at: num(v.expires_at) ?? 0, overdue_at: num(v.overdue_at) };
    if (!(c.status in CHECKOUT_WORDS)) throw new VaultError('invalid_argument', `Unknown checkout status ${JSON.stringify(v.status)}.`);
    const H: HandoutRow[] = (v.handouts as unknown[]).filter(isObj).map((h) => ({ id: String(h.id), checkout_id: c.id, agent_id: String(h.agent_id), status: h.status as HandoutRow['status'], source: h.source === 'hub' ? 'hub' : 'agent',
      report: h.report == null ? null : JSON.stringify(h.report), body: h.body == null ? null : JSON.stringify(h.body), version: num(h.version) ?? 0, created_at: c.created_at, updated_at: num(h.consumed_at) ?? num(h.written_at) ?? c.created_at,
      checkpointing_at: null, merged_at: null, written_at: num(h.written_at), consumed_at: num(h.consumed_at), removed_at: null, new_credential_id: null, purge_due: null }));
    const push = isObj(json) && Array.isArray(json.push_list) ? (json.push_list as PushRepoLike[]) : [];
    await this.run(`import ${c.id}`, async () => { await this.writeCheckout(c, { handouts: H, push }); await this.writeReadme(); });
    const pages = (this.db.prepare("SELECT path FROM mirror_files WHERE (kind='checkout' AND ref_id=?) OR (kind='handout' AND ref_id IN (SELECT value FROM json_each(?))) ORDER BY path").all(c.id, JSON.stringify(H.map((h) => h.id))) as { path: string }[]).map((r) => r.path);
    return { checkout: c.id, pages };
  }
}

interface TeamRowLite { id: string; name: string; goal: string; status: string; paused_reason: string | null; project_id: string | null; delivery_mode: string; max_review_rounds: number; created_at: number; updated_at: number }
interface MemberLite { team_id: string; agent_id: string; credential_id: string; role: string; joined_at: number; removed_at: number | null }
interface AgentLite { id: string; label: string; model_label: string | null; role: string | null; role_detail: string | null; last_seen_at: number | null }
