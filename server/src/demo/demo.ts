/**
 * Demo mode (DEMO_MODE=1, docs/showcase.md#demo-mode): the console's Replay bar resets this hub to the start of the
 * Early Echo story and runs the story runner (eval/run.mjs) in-process against the hub itself.
 *
 * The reset rebuilds the app inside this process: it clears the data with the operator reset (all parts, plus the
 * directives), closes the app, replaces the vault files with a fresh copy of eval/vault, and builds and listens again on
 * the same port. Admin accounts, their sessions and the audit trail survive, so the operator stays signed in and the
 * audit log shows who started each replay. Nothing outside DATA_DIR and VAULT_DIR is touched.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp, type App } from '../app.js';
import type { Config } from '../config.js';
import { KeyError } from '../keys/keys.js';
import { Reset, RESET_PARTS } from '../safety/reset.js';
import { tx } from '../db/db.js';
import { BpRouting } from '../admin/bpRouting.js';
import { NeedsYou } from '../admin/needsYou.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Where the story lives: <repo>/eval locally, /eval in the image (next to /app). DEMO_STORY_DIR overrides it. */
export const storyDir = (): string => resolve(process.env.DEMO_STORY_DIR ?? join(SERVER_ROOT, '..', 'eval'));

/** Marks a vault that demo mode filled and may replace again; hidden from agents (vault DEFAULT_HIDDEN). */
export const DEMO_MARKER = '.conclave-demo';
export const PACES = { instant: 0, '0.5x': 0.5, '1x': 1, '2x': 2 } as const;
export type Pace = keyof typeof PACES;
export interface ReplayOptions { pace: Pace; from: number; until: number }
export type Phase = 'idle' | 'resetting' | 'running' | 'done' | 'failed' | 'stopped';
export interface DemoState {
  phase: Phase; options: ReplayOptions | null; by: string | null; started_at: number | null; finished_at: number | null;
  act: number | null; act_title: string | null; act_step: number | null; act_steps: number | null; step: string | null; caption: string | null; index: number; total: number;
  result: { ok: boolean; message: string | null; coverage: string | null; seconds: number } | null;
  /** When each step started (at most the last 300), so the Home feed can stamp a change with the step that caused it. */
  steps: { step: string; at: number }[];
}
interface StoryModule {
  runStory: (o: Record<string, unknown>) => Promise<{ ok: boolean; failure: { step: string; message: string } | null; coverage: { summary: string }; seconds: number }>;
  loadActs: () => Promise<{ act: number; title: string; steps: unknown[] }[]>;
}

/** Settings the story changes (feedback, onboarding, blueprint limits, pinned teams): a replay starts from their defaults. */
const STORY_SETTINGS_SQL = "key LIKE 'feedback.%' OR key LIKE 'onboarding.%' OR key='blueprint_limits' OR key LIKE 'home.pinned_teams:%'";

/** What the operator reset leaves behind and the story changes: directives, members with their links, and those settings. */
function clearStoryState(db: App['db']): void {
  tx(db, () => {
    db.exec('PRAGMA defer_foreign_keys=ON');
    for (const t of ['directive_acks', 'directive_reports', 'directive_versions', 'directives']) db.prepare(`DELETE FROM "${t}"`).run();
    const members = "(SELECT id FROM admin_users WHERE role='member')";
    for (const sql of [
      `DELETE FROM admin_sessions WHERE admin_id IN ${members}`,
      `DELETE FROM user_setup_links WHERE user_id IN ${members}`,
      `DELETE FROM user_project_grants WHERE user_id IN ${members}`,
      `DELETE FROM user_folder_grants WHERE user_id IN ${members}`,
      `DELETE FROM team_deciders WHERE user_id IN ${members}`,
      "DELETE FROM admin_users WHERE role='member'",
      `DELETE FROM system_settings WHERE ${STORY_SETTINGS_SQL}`,
    ]) db.prepare(sql).run();
  });
}

/** Owns the app in demo mode, so a replay can rebuild it on the same port. Without demo mode it is a plain start. */
export class DemoHost {
  app!: App;
  port = 0;
  readonly demo?: DemoController;
  constructor(readonly config: Config, private readonly listenPort = config.port) {
    if (config.demoMode) this.demo = new DemoController(this);
  }
  get base(): string { return `http://127.0.0.1:${this.port}`; }
  async start(): Promise<App> {
    this.app = await buildApp(this.config, { demo: this.demo });
    await this.app.fastify.listen({ port: this.port || this.listenPort, host: this.config.host });
    this.port = (this.app.fastify.server.address() as AddressInfo).port;
    return this.app;
  }
  /**
   * A replay replaces every file in VAULT_DIR, so it only runs on a demo vault: an empty folder, or one a replay filled
   * (it writes DEMO_MARKER). A real vault, for example the operator's bind-mounted Obsidian vault, is refused untouched.
   */
  vaultGuard(): void {
    const vault = resolve(this.config.vaultDir);
    const names = existsSync(vault) ? readdirSync(vault) : [];
    if (names.length && !names.includes(DEMO_MARKER)) {
      throw new KeyError('invalid_state', `VAULT_DIR is not a demo vault: it has files and no ${DEMO_MARKER} marker. A replay replaces every file in it, so it runs only on an empty folder or one a replay filled. Point VAULT_DIR at an empty folder (docs/showcase.md#demo-mode).`);
    }
  }
  /**
   * Back to the story's start state: data cleared (admin accounts, their sessions and the audit trail kept), the settings the
   * story changes put back, members the story created removed, vault replaced, app rebuilt. The app is rebuilt even when the
   * vault copy fails, so the hub never stays down; the error is then thrown.
   */
  async resetAndRebuild(): Promise<void> {
    if (!this.config.demoMode) throw new KeyError('denied', 'Demo mode is off.');
    this.vaultGuard();
    const src = join(storyDir(), 'vault'), vault = resolve(this.config.vaultDir);
    if (!existsSync(src)) throw new KeyError('invalid_state', `The story vault is missing (${src}).`);
    const inside = (a: string, b: string) => { const r = relative(b, a); return r === '' || (!r.startsWith('..') && !r.includes(':')); };
    if (inside(src, vault) || inside(vault, src)) throw new KeyError('invalid_state', 'VAULT_DIR and the story vault overlap; refusing to reset.');
    const app = this.app;
    new Reset(app.db).run(RESET_PARTS.map((p) => p.key));
    clearStoryState(app.db);
    await app.maintenance.gcBlobs(Date.now() + 1);
    await app.close();
    let failure: unknown = null;
    try {
      for (const name of readdirSync(vault)) rmSync(join(vault, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      mkdirSync(vault, { recursive: true });
      cpSync(src, vault, { recursive: true });
      writeFileSync(join(vault, DEMO_MARKER), 'Written by Conclave demo mode (docs/showcase.md#demo-mode). Every Replay replaces all files in this folder.\n');
    } catch (e) { failure = e; }
    await this.start();
    if (failure) throw failure;
  }
}

/** One replay at a time: reset, then the story at the chosen pace; progress for the console; Stop aborts. */
export class DemoController {
  state: DemoState = DemoController.idle();
  private ac: AbortController | null = null;
  private story: Promise<StoryModule> | null = null;
  private acts: { act: number; title: string; steps: number }[] | null = null;
  constructor(private readonly host: DemoHost) {}
  static idle(): DemoState { return { phase: 'idle', options: null, by: null, started_at: null, finished_at: null, act: null, act_title: null, act_step: null, act_steps: null, step: null, caption: null, index: 0, total: 0, result: null, steps: [] }; }
  get running(): boolean { return this.state.phase === 'resetting' || this.state.phase === 'running'; }
  private load(): Promise<StoryModule> {
    // The runner resolves the MCP client from the hub's own node_modules.
    process.env.CONCLAVE_SERVER_DIR ??= SERVER_ROOT;
    return (this.story ??= import(pathToFileURL(join(storyDir(), 'run.mjs')).href) as Promise<StoryModule>);
  }
  /** The story's title and acts, for the bar's start and stop choices. */
  async info(): Promise<{ title: string; acts: { act: number; title: string; steps: number }[] }> {
    if (!this.acts) this.acts = (await (await this.load()).loadActs()).map((a) => ({ act: a.act, title: a.title, steps: a.steps.length }));
    return { title: 'The Early Echo', acts: this.acts };
  }
  start(o: ReplayOptions, operator: { id: string; username: string }): DemoState {
    if (this.running) throw new KeyError('conflict', 'A replay is already running. Stop it first.');
    this.host.vaultGuard(); // refused before anything starts, so the console shows why
    if (!this.host.config.adminUsername || !this.host.config.adminPassword) throw new KeyError('invalid_state', 'Demo mode needs ADMIN_USERNAME and ADMIN_PASSWORD: the story signs in as the operator.');
    this.ac = new AbortController();
    this.state = { ...DemoController.idle(), phase: 'resetting', options: o, by: operator.username, started_at: Date.now() };
    // After the reply: the rebuild closes the server this request came in on.
    setTimeout(() => { void this.run(o, this.ac!.signal, operator.id); }, 50);
    return this.state;
  }
  stop(): boolean {
    if (!this.running || !this.ac) return false;
    this.ac.abort(new Error('Stopped by the operator.'));
    return true;
  }
  private finish(phase: Phase, result: DemoState['result']): void {
    this.state = { ...this.state, phase, finished_at: Date.now(), result };
    this.ac = null;
    try { this.host.app.audit.event({ kind: 'system', id: null }, 'demo.finish', { kind: 'system', id: 'demo' }, { phase, steps: this.state.index, total: this.state.total, message: result?.message?.slice(0, 200) ?? null }); } catch { /* the app may be mid-rebuild */ }
  }
  private async run(o: ReplayOptions, signal: AbortSignal, operatorId: string): Promise<void> {
    const t0 = Date.now();
    try {
      await this.host.resetAndRebuild();
      if (signal.aborted) return this.finish('stopped', { ok: false, message: 'Stopped after the reset.', coverage: null, seconds: Math.round((Date.now() - t0) / 1000) });
      const story = await this.load();
      const acts = (await this.info()).acts;
      this.state = { ...this.state, phase: 'running' };
      const cfg = this.host.config;
      const r = await story.runStory({
        hub: { base: this.host.base, admin: { username: cfg.adminUsername, password: cfg.adminPassword }, vaultDir: cfg.vaultDir, throwaway: false },
        from: o.from, until: o.until, pace: PACES[o.pace], signal, outDir: false, interactive: true,
        setAside: ({ record, episode }: { record: string; episode: string }) => {
          const { db, routing, blueprint, teams, onboarding } = this.host.app;
          const needs = new NeedsYou(db, { routing, blueprint, teams, onboarding, bpRouting: new BpRouting(db, blueprint, routing) });
          return needs.later({ id: operatorId, isAdmin: true, can: () => false }, record, episode, null);
        },
        onProgress: (e: { type: string; act?: number; title?: string; step?: string; index?: number; total?: number; act_step?: number; act_steps?: number }) => {
          if (e.type === 'act') this.state = { ...this.state, act: e.act ?? null, act_title: e.title ?? null, act_step: 0, act_steps: acts.find((a) => a.act === e.act)?.steps ?? null, total: e.total ?? this.state.total };
          if (e.type === 'step') this.state = { ...this.state, steps: [...this.state.steps, { step: e.step ?? '', at: Date.now() }].slice(-300), step: e.step ?? null, caption: e.title ?? null, index: e.index ?? 0, total: e.total ?? 0, act_step: e.act_step ?? (this.state.act_step ?? 0) + 1, act_steps: e.act_steps ?? this.state.act_steps };
        },
      });
      const aborted = signal.aborted;
      this.finish(r.ok ? 'done' : aborted ? 'stopped' : 'failed', { ok: r.ok, message: aborted ? 'Stopped by the operator.' : r.failure ? `Step ${r.failure.step}: ${r.failure.message}` : null, coverage: r.coverage?.summary ?? null, seconds: r.seconds });
    } catch (e) {
      this.finish(signal.aborted ? 'stopped' : 'failed', { ok: false, message: (e as Error).message, coverage: null, seconds: Math.round((Date.now() - t0) / 1000) });
    }
  }
}

