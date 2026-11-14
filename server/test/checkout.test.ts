/**
 * Checkout and handouts, phase 1 (docs/checkout.md §3, §10 row 1): guarded states, the checkpoint and handout steps,
 * ready with the team pause and its checkout_* exemption, render bookkeeping, consume and restored, cancel, the expiry
 * sweep, team end, audit and the checkout_open guards on add_agents and Re-enrol PC. Service level, no HTTP.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { EXPIRY_MS } from '../src/checkout/checkout.js';
import { pausable } from '../src/policy/engine.js';
import { tx } from '../src/db/db.js';
import type { Who } from '../src/teams/teams.js';
import { RESTORE_TEMPLATE } from './restoreTemplate.js';
import { testConfig } from './hub.js';

// Every step here writes vault pages and syncs each one to disk: a few seconds alone, five times that when another
// suite or a seed shares the machine. The limit leaves room for that; nothing in this file waits on a timer.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let app: App;
const admin = { kind: 'admin' as const, id: '' };
const sys = { kind: 'system' as const, id: null };
let seq = 0;

/** A running team of a coordinator and n workers, made directly (not onboarded). */
const team = (workers = 1, start = true) => {
  const n = ++seq;
  const mk = (label: string) => {
    const a = app.keys.createAgent(`${label}-${n}`, null, admin);
    app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, admin);
    return a.id;
  };
  const lead = mk('lead');
  const ws = Array.from({ length: workers }, (_, i) => mk(`w${i}`));
  const t = app.teams.create({ name: `Move team ${n}`, goal: 'Move it.', members: [{ agent_id: lead, role: 'coordinator' }, ...ws.map((w) => ({ agent_id: w, role: 'worker' }))] }, admin);
  if (start) app.teams.start(t.id, admin);
  return { id: t.id, lead, workers: ws, all: [lead, ...ws] };
};
const noLeftovers = { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] };
const clean = { integration_branch: 'integration/core', integration_head: 'a'.repeat(40), merge_commits: ['b'.repeat(40)], worktrees_left: 0, clean: true, leftover_check: noLeftovers };
const body = (folder: string) => ({ folder, repo: { remote_name: 'origin', clone_folder: 'core' }, notes: 'Next: finish the parser.' });
/** Checkpoint and write one agent's handout. */
const handIn = (agentId: string) => {
  app.checkouts.checkpointing(agentId);
  app.checkouts.merged(agentId, clean);
  return app.checkouts.write(agentId, body(`f-${agentId}`));
};
const auditOf = (action: string, id?: string) => app.db.prepare(`SELECT * FROM audit_events WHERE action=?${id ? ' AND target_id=?' : ''}`).all(...(id ? [action, id] : [action])) as { details: string; target_id: string }[];
const notices = (agentId: string, kind: string) => app.db.prepare('SELECT * FROM agent_notices WHERE agent_id=? AND kind=?').all(agentId, kind) as { body: string }[];
/** The agent as an MCP session sees it: its team key's rules (team rules included), no cap. */
const who = (agentId: string, teamId: string): Who => {
  const m = app.teams.members(teamId).find((x) => x.agent_id === agentId);
  const credId = m?.credential_id ?? (app.db.prepare("SELECT id FROM credentials WHERE agent_id=? AND kind='session_key' LIMIT 1").get(agentId) as { id: string }).id;
  return { agentId, credId, tokenHash: 'test', rules: app.keys.rules(app.keys.credential(credId)!.policy_id), cap: [] };
};
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as { code: string }).code ?? String(e); } return 'ok'; };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahcko-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  const config: Config = testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client });
  app = await buildApp(config);
  await app.store.ready;
  admin.id = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
});
afterAll(async () => { await app.close(); });

describe('start', () => {
  it('opens a collecting checkout with one requested handout per member, a notice each, audit and a 48 h expiry', () => {
    const t = team(2);
    const before = Date.now();
    const v = app.checkouts.start(t.id, admin);
    expect(v.id).toMatch(/^cko_/);
    expect(v.status).toBe('collecting');
    expect(v.expires_at).toBeGreaterThanOrEqual(before + EXPIRY_MS);
    expect(v.handouts.map((h) => h.agent_id).sort()).toEqual([...t.all].sort());
    expect(v.handouts.every((h) => h.status === 'requested' && h.id.startsWith('hnd_') && h.body === null)).toBe(true);
    for (const a of t.all) expect(notices(a, 'checkout_requested')[0]!.body).toContain(`checkout/${v.id}`);
    expect(auditOf('checkout.start', v.id)).toHaveLength(1);
    expect(app.teams.team(t.id)!.status).toBe('running'); // the pause comes at ready, not at start (F5)
  });
  it('refuses a second open checkout for the team, and a team that is not running or paused', () => {
    const t = team();
    app.checkouts.start(t.id, admin);
    expect(code(() => app.checkouts.start(t.id, admin))).toBe('checkout_open');
    const draft = team(1, false);
    expect(code(() => app.checkouts.start(draft.id, admin))).toBe('invalid_state');
  });
  it('the schema allows only one open checkout per team', () => {
    const t = team();
    const c = app.checkouts.start(t.id, admin);
    expect(() => app.db.prepare("INSERT INTO checkouts(id,team_id,status,created_at,updated_at,expires_at) VALUES ('cko_dup',?,'ready',0,0,0)").run(t.id)).toThrow();
    app.checkouts.cancel(c.id, null, admin);
    app.db.prepare("INSERT INTO checkouts(id,team_id,status,created_at,updated_at,expires_at) VALUES ('cko_old',?,'restored',0,0,0)").run(t.id); // closed rows do not count
  });
});

describe('checkpoint and handout', () => {
  it('moves requested -> checkpointing -> merged -> written in order, and refuses skipped steps', () => {
    const t = team();
    const c = app.checkouts.start(t.id, admin);
    const w = t.workers[0]!;
    expect(code(() => app.checkouts.write(w, body('x')))).toBe('checkpoint_incomplete');
    expect(code(() => app.checkouts.merged(w, clean))).toBe('invalid_state'); // merged needs checkpointing first
    expect(app.checkouts.checkpointing(w).status).toBe('checkpointing');
    expect(app.checkouts.checkpointing(w).status).toBe('checkpointing'); // repeat is harmless
    expect(app.checkouts.merged(w, clean).status).toBe('merged');
    const h = app.checkouts.write(w, body('core-w'));
    expect(h.status).toBe('written');
    expect(h.version).toBe(1);
    expect(JSON.parse(h.body!).folder).toBe('core-w');
    expect(app.checkouts.checkout(c.id)!.status).toBe('collecting'); // the coordinator has not written yet
    // Replace while collecting.
    expect(app.checkouts.write(w, body('core-w2')).version).toBe(2);
    expect(auditOf('checkout.handout_replaced')).not.toHaveLength(0);
    expect(code(() => app.checkouts.checkpointing(w))).toBe('conflict'); // a written handout does not go back
  });
  it('refuses a handout while the merged report shows dirty work, a worktree or an unapproved leftover', () => {
    const t = team();
    const c = app.checkouts.start(t.id, admin);
    const w = t.workers[0]!;
    app.checkouts.checkpointing(w);
    app.checkouts.merged(w, { ...clean, clean: false });
    expect(code(() => app.checkouts.write(w, body('x')))).toBe('checkpoint_incomplete');
    app.checkouts.merged(w, { ...clean, worktrees_left: 2 });
    expect(code(() => app.checkouts.write(w, body('x')))).toBe('checkpoint_incomplete');
    // An agent cannot approve its own exception.
    app.checkouts.merged(w, { ...clean, leftover_check: { ...noLeftovers, build_output: [{ item: 'node_modules in core-w', reason: 'shared cache', approved: true }] } });
    expect(code(() => app.checkouts.write(w, body('x')))).toBe('checkpoint_incomplete');
    const sha = app.checkouts.view(c.id).handouts.find((h) => h.agent_id === w)!.report_sha256!;
    app.checkouts.approveLeftovers(c.id, w, sha, admin);
    expect(app.checkouts.write(w, body('x')).status).toBe('written');
    expect(auditOf('checkout.leftovers_approved')).not.toHaveLength(0);
  });
  it('validates the report and the body size', () => {
    const t = team();
    app.checkouts.start(t.id, admin);
    const w = t.workers[0]!;
    app.checkouts.checkpointing(w);
    expect(code(() => app.checkouts.merged(w, { clean: true }))).toBe('invalid_argument');
    expect(code(() => app.checkouts.merged(w, 'merged'))).toBe('invalid_argument');
    app.checkouts.merged(w, clean);
    expect(code(() => app.checkouts.write(w, { notes: 'x'.repeat(1501) }))).toBe('invalid_argument');
    expect(code(() => app.checkouts.write(w, { folder: 'f', pad: 'x'.repeat(8000) }))).toBe('too_large');
    expect(code(() => app.checkouts.write(w, ['not', 'an', 'object']))).toBe('invalid_argument');
  });
  it('an agent with no open checkout has no handout to write', () => {
    const t = team();
    expect(code(() => app.checkouts.checkpointing(t.lead))).toBe('not_found');
  });
});

describe('ready and the team pause', () => {
  it('is ready when every handout is written: handouts locked, team paused for the checkout, resume refused, checkout actions exempt', () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    const v = app.checkouts.view(c.id);
    expect(v.status).toBe('ready');
    expect(v.missing).toEqual([]);
    expect(v.paused_team).toBe(true);
    const tm = app.teams.team(t.id)!;
    expect(tm.status).toBe('paused');
    expect(tm.paused_reason).toBe(`checkout:${c.id}`);
    expect(code(() => app.checkouts.write(t.lead, body('late')))).toBe('invalid_state');
    expect(code(() => app.teams.resume(t.id, admin))).toBe('checkout_open');
    expect(auditOf('checkout.ready', c.id)).toHaveLength(1);
  });
  it('the checkout tools\' gate passes for a member of a team the checkout paused; team actions are refused', () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    expect(app.teams.team(t.id)!.status).toBe('paused');
    const w = who(t.workers[0]!, t.id);
    expect(app.checkouts.gate(w).c.id).toBe(c.id);
    expect(code(() => app.teams.checkAsk(w, t.id))).toBe('paused'); // Teams.act requires a running team
    expect(pausable('checkout.handout')).toBe(false);
    // Not a member, or a lockdown: refused.
    const other = team(0);
    expect(code(() => app.teams.checkoutGate(who(other.lead, other.id), t.id))).toBe('denied');
    app.db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES (?, 'true', 0)").run(`emergency.team_disabled.${t.id}`);
    try { expect(code(() => app.checkouts.gate(w))).toBe('lockdown'); }
    finally { app.db.prepare('DELETE FROM system_settings WHERE key=?').run(`emergency.team_disabled.${t.id}`); }
    // The grant comes from the team rules: a cap that denies checkout.* refuses it.
    expect(code(() => app.checkouts.gate({ ...w, cap: [{ id: 'cap1', effect: 'deny', actions: ['checkout.*'], resource: 'team:*' } as never] }))).toBe('denied');
  });
  it('team membership cannot change while a checkout is open', () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    const extra = app.keys.createAgent(`extra-${++seq}`, null, admin);
    app.keys.createSessionKey({ agentId: extra.id, label: 'extra key' }, admin);
    expect(code(() => app.teams.addMember(t.id, { agent_id: extra.id, role: 'worker' }, admin))).toBe('checkout_open');
    expect(code(() => app.teams.removeMember(t.id, t.workers[0]!, admin))).toBe('checkout_open');
    app.db.prepare("INSERT INTO recruit_requests(id,team_id,requested_by,label,role,purpose,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)").run(`rcr_cko${seq}`, t.id, t.lead, 'helper', 'worker', 'help', Date.now());
    expect(code(() => app.teams.approveRecruit(`rcr_cko${seq}`, admin))).toBe('checkout_open');
    expect(app.teams.members(t.id)).toHaveLength(2);
    app.checkouts.cancel(c.id, null, admin);
    expect(app.teams.removeMember(t.id, t.workers[0]!, admin)).toHaveLength(1);
  });
  it('the operator goes on without missing handouts: they are built by the hub, with no notes', () => {
    const t = team(2);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead);
    app.checkouts.checkpointing(t.workers[0]!); // started, never finished
    const v = app.checkouts.proceed(c.id, admin);
    expect(v.status).toBe('ready');
    expect(v.missing.sort()).toEqual([...t.workers].sort());
    for (const w of t.workers) {
      const h = v.handouts.find((x) => x.agent_id === w)!;
      expect(h.status).toBe('written');
      expect(h.source).toBe('hub');
      expect(h.body).toMatchObject({ built_by: 'hub', notes: '', unmerged_work_on_source: true });
    }
    expect(v.handouts.find((x) => x.agent_id === t.lead)!.source).toBe('agent');
    expect(code(() => app.checkouts.proceed(c.id, admin))).toBe('invalid_state');
  });
  it('a missing handout keeps only a complete checkpoint, as refs and heads; otherwise its work is unmerged on the source', () => {
    const t = team(3);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead);
    const [done, dirty, waiting] = t.workers as [string, string, string];
    app.checkouts.checkpointing(done);
    app.checkouts.merged(done, clean); // merged, never wrote
    app.checkouts.checkpointing(dirty);
    app.checkouts.merged(dirty, { ...clean, clean: false });
    app.checkouts.checkpointing(waiting);
    app.checkouts.merged(waiting, { ...clean, leftover_check: { ...noLeftovers, scratch: [{ item: '/tmp/x', reason: 'look later' }] } }); // never approved
    const v = app.checkouts.proceed(c.id, admin);
    const of = (a: string) => v.handouts.find((x) => x.agent_id === a)!.body as Record<string, unknown>;
    expect(of(done)).toMatchObject({ built_by: 'hub', unmerged_work_on_source: false });
    expect(of(done).checkpoint).toEqual({ integration_branch: 'integration/core', integration_head: clean.integration_head, merge_commits: clean.merge_commits });
    for (const a of [dirty, waiting]) {
      expect(of(a)).toMatchObject({ built_by: 'hub', unmerged_work_on_source: true });
      expect(of(a).checkpoint).toBeUndefined(); // no refs from a dirty or unapproved report, and never its leftovers
    }
    expect(JSON.stringify(of(waiting))).not.toContain('/tmp/x');
  });
  it('a team already paused for another reason stays paused after the checkout ends', () => {
    const t = team();
    const c = app.checkouts.start(t.id, admin);
    app.teams.pause(t.id, 'operator', admin);
    app.checkouts.proceed(c.id, admin);
    expect(app.checkouts.checkout(c.id)!.paused_team).toBe(0);
    app.checkouts.cancel(c.id, null, admin);
    expect(app.teams.team(t.id)!.status).toBe('paused');
    expect(app.teams.team(t.id)!.paused_reason).toBe('operator');
  });
});

describe('render, restoring, consume and restored', () => {
  it('runs ready -> rendered -> restoring -> restored; each handout is consumed once, purged once its vault page is written; the pause lifts', async () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    expect(code(() => app.checkouts.markRestoring(c.id, sys))).toBe('conflict'); // not rendered yet
    const r1 = app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: { target: 'same_user', rotate_agent_keys: true } }, admin);
    expect(r1.status).toBe('rendered');
    const hashes = JSON.parse(r1.handout_hashes!) as Record<string, string>;
    expect(Object.keys(hashes).sort()).toEqual([...t.all].sort());
    // A new render supersedes the earlier one and resets expiry.
    const r2 = app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: { target: 'same_user', rotate_agent_keys: false } }, admin);
    expect(r2.expires_at).toBeGreaterThanOrEqual(r1.expires_at);
    expect(auditOf('checkout.render_superseded', c.id)).toHaveLength(1);
    expect(JSON.parse(auditOf('checkout.rendered', c.id)[0]!.details).handout_hashes).toEqual(hashes);
    expect(app.checkouts.markRestoring(c.id, sys).status).toBe('restoring');
    expect(code(() => app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin))).toBe('invalid_state');
    const hs = app.checkouts.handouts(c.id);
    const first = app.checkouts.consume(hs[0]!.id, null, sys);
    expect(first.restored).toBe(false);
    expect((first.body as { folder: string }).folder).toBe(`f-${hs[0]!.agent_id}`);
    // The deferred purge (D63): the body waits for its vault page.
    expect(app.checkouts.handout(hs[0]!.id)).toMatchObject({ status: 'consumed', purge_due: expect.any(Number) });
    expect(app.checkouts.handout(hs[0]!.id)!.body).not.toBeNull();
    expect(code(() => app.checkouts.consume(hs[0]!.id, null, sys))).toBe('handout_consumed');
    expect(app.teams.team(t.id)!.status).toBe('paused');
    const last = app.checkouts.consume(hs[1]!.id, null, sys);
    expect(last.restored).toBe(true);
    const v = app.checkouts.view(c.id);
    expect(v.status).toBe('restored');
    expect(v.restored_at).not.toBeNull();
    expect(app.teams.team(t.id)!.status).toBe('running');
    expect(auditOf('checkout.restored', c.id)).toHaveLength(1);
    await app.mirror.idle();
    expect(app.checkouts.view(c.id).handouts.every((h) => h.body === null)).toBe(true);
    expect(code(() => app.checkouts.cancel(c.id, null, admin))).toBe('invalid_state');
  });
  it('a reuse move has no confirm: the first resume moves rendered to restoring', () => {
    const t = team(0);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead);
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: { target: 'same_user', rotate_agent_keys: false } }, admin);
    const h = app.checkouts.handouts(c.id)[0]!;
    expect(app.checkouts.consume(h.id, null, sys).restored).toBe(true);
    expect(auditOf('checkout.restoring', c.id)).toHaveLength(1);
  });
  it('refuses a handout that changed after render, and consume before render', () => {
    const t = team(0);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead);
    const h = app.checkouts.handouts(c.id)[0]!;
    expect(code(() => app.checkouts.consume(h.id, null, sys))).toBe('invalid_state');
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin);
    app.db.prepare('UPDATE handouts SET body=? WHERE id=?').run(JSON.stringify({ folder: 'evil' }), h.id);
    expect(code(() => app.checkouts.consume(h.id, null, sys))).toBe('handout_changed');
    expect(app.checkouts.handout(h.id)!.status).toBe('written');
    expect(auditOf('checkout.resume_refused')).not.toHaveLength(0);
  });
});

describe('cancel, expiry and team end', () => {
  it('cancel removes handouts and purges them once their vault pages are written, lifts the pause and tells the members', async () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    expect(app.teams.team(t.id)!.status).toBe('paused');
    const v = app.checkouts.cancel(c.id, 'changed my mind', admin);
    expect(v.status).toBe('cancelled');
    expect(v.end_reason).toBe('changed my mind');
    expect(v.handouts.every((h) => h.status === 'removed')).toBe(true);
    await app.mirror.idle();
    expect(app.checkouts.view(c.id).handouts.every((h) => h.body === null)).toBe(true);
    expect(app.teams.team(t.id)!.status).toBe('running');
    for (const a of t.all) expect(notices(a, 'checkout_ended')).toHaveLength(1);
    expect(code(() => app.checkouts.cancel(c.id, null, admin))).toBe('invalid_state');
    // A new checkout can start once the old one is closed.
    expect(app.checkouts.start(t.id, admin).status).toBe('collecting');
  });
  it('the sweep in Teams.tick expires past-due checkouts before restoring', async () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin);
    app.db.prepare('UPDATE checkouts SET expires_at=? WHERE id=?').run(Date.now() - 1, c.id);
    app.teams.tick();
    const v = app.checkouts.view(c.id);
    expect(v.status).toBe('expired');
    expect(v.handouts.every((h) => h.status === 'removed')).toBe(true);
    expect(app.teams.team(t.id)!.status).toBe('running');
    expect(auditOf('checkout.expired', c.id)).toHaveLength(1);
    await app.mirror.idle();
    expect(app.checkouts.view(c.id).handouts.every((h) => h.body === null)).toBe(true);
  });
  it('a collecting checkout expires 48 hours after start, not before', () => {
    const t = team();
    const c = app.checkouts.start(t.id, admin);
    const at = app.checkouts.checkout(c.id)!.expires_at;
    expect(app.checkouts.sweep(at - 1).expired).not.toContain(c.id);
    expect(app.checkouts.sweep(at).expired).toContain(c.id);
  });
  it('a restoring checkout past due keeps its consumed handouts and raises one Attention alert instead', () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin);
    app.checkouts.markRestoring(c.id, sys);
    const hs = app.checkouts.handouts(c.id);
    app.checkouts.consume(hs[0]!.id, null, sys);
    const due = app.checkouts.checkout(c.id)!.expires_at;
    expect(app.checkouts.sweep(due).overdue).toEqual([c.id]);
    expect(app.checkouts.sweep(due + 1000).overdue).toEqual([]); // once
    const v = app.checkouts.view(c.id);
    expect(v.status).toBe('restoring');
    expect(v.overdue_at).not.toBeNull();
    expect(app.checkouts.handout(hs[1]!.id)!.body).not.toBeNull(); // not purged silently
    expect(app.db.prepare("SELECT * FROM security_alerts WHERE type='checkout_overdue' AND subject=?").all(c.id)).toHaveLength(1);
    // The operator then cancels by hand. One agent already runs on the target, so the team stays paused on the source.
    expect(app.checkouts.cancel(c.id, null, admin).status).toBe('cancelled');
    expect(app.db.prepare("SELECT status FROM security_alerts WHERE type='checkout_overdue' AND subject=?").all(c.id)).toEqual([{ status: 'closed' }]);
    expect(app.checkouts.handout(hs[0]!.id)!.status).toBe('consumed');
    expect(app.teams.team(t.id)!.status).toBe('paused');
    expect(JSON.parse(auditOf('checkout.cancelled', c.id)[0]!.details).pause_kept).toBe(true);
    expect(notices(t.lead, 'checkout_ended').at(-1)!.body).toContain('stays paused');
    app.teams.resume(t.id, admin); // nothing holds the team now: the operator resumes by hand
    expect(app.teams.team(t.id)!.status).toBe('running');
  });
  it('a forced cancel while restoring lifts the pause', () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin);
    app.checkouts.markRestoring(c.id, sys);
    app.checkouts.cancel(c.id, null, admin, { force: true });
    expect(app.teams.team(t.id)!.status).toBe('running');
  });
  it('finish by hand: an overdue restoring checkout is restored, handouts not resumed are removed, the pause lifts', async () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin);
    app.checkouts.markRestoring(c.id, sys);
    const hs = app.checkouts.handouts(c.id);
    app.checkouts.consume(hs[0]!.id, null, sys);
    expect(code(() => app.checkouts.finish(c.id, admin))).toBe('invalid_state'); // not overdue yet
    app.checkouts.sweep(app.checkouts.checkout(c.id)!.expires_at);
    const v = app.checkouts.finish(c.id, admin);
    expect(v.status).toBe('restored');
    expect(v.handouts.find((h) => h.id === hs[1]!.id)).toMatchObject({ status: 'removed' });
    await app.mirror.idle();
    expect(app.checkouts.handout(hs[1]!.id)!.body).toBeNull();
    expect(app.teams.team(t.id)!.status).toBe('running');
    expect(JSON.parse(auditOf('checkout.finished', c.id)[0]!.details).not_resumed).toEqual([hs[1]!.agent_id]);
    expect(code(() => app.checkouts.finish(c.id, admin))).toBe('invalid_state');
  });
  it('a sweep inside a caller\'s transaction rolls back a failed expiry instead of committing half of it', () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    const due = app.checkouts.checkout(c.id)!.expires_at;
    app.checkouts.onEnded = () => { throw new Error('phase 2 hook failed'); };
    try {
      const out = tx(app.db, () => app.checkouts.sweep(due));
      expect(out.expired).toEqual([]);
    } finally { app.checkouts.onEnded = undefined; }
    const v = app.checkouts.view(c.id);
    expect(v.status).toBe('ready');
    expect(v.handouts.every((h) => h.status === 'written' && h.body !== null)).toBe(true);
    expect(app.teams.team(t.id)!.status).toBe('paused');
    expect(auditOf('checkout.sweep_failed', c.id)).toHaveLength(1);
    expect(app.checkouts.sweep(due).expired).toEqual([c.id]); // and it expires on the next sweep
  });
  it('stopping the team cancels its open checkout', () => {
    const t = team();
    const c = app.checkouts.start(t.id, admin);
    app.teams.stop(t.id, admin);
    const v = app.checkouts.view(c.id);
    expect(v.status).toBe('cancelled');
    expect(v.end_reason).toBe('team_ended');
  });
});

describe('checkout_open guards on onboarding', () => {
  const request = (n: number) => ({
    kind: 'new_team', project: { name: `Cko Proj ${n}`, existing: false }, team: { name: `Cko Team ${n}`, goal: 'Moves.' },
    roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'dev', team_role: 'worker', count: 1, job: 'Builds.' }],
    prompt: 'a team', client: { app: 'claude-code', os: 'windows' },
  });
  /** A team onboarded from a PC, running. */
  const onboarded = () => {
    const n = ++seq;
    const { pc, key } = app.onboarding.addPc(`cko-pc-${n}`, null, admin);
    const f = app.onboarding.file(key, request(n));
    app.onboarding.approve(f.request_id, { version: f.version }, admin);
    const p = app.onboarding.pickup(key, f.request_id, '127.0.0.1');
    const done = app.onboarding.confirm(key, p.pickup_id, p.agents.map((a) => a.session_var), 'https', '127.0.0.1');
    return { pc: pc.id, key, team: done.team_id!, n };
  };
  const addAgents = (o: { team: string; n: number }) => ({ kind: 'add_agents', project: { name: `Cko Proj ${o.n}`, existing: true }, team: { id: o.team },
    roles: [{ name: 'tester', team_role: 'worker', count: 1, job: 'Tests.' }], prompt: 'one more', client: { app: 'claude-code', os: 'windows' } });

  it('records the source PC, and refuses Re-enrol PC and adding agents while the checkout is open', () => {
    const o = onboarded();
    expect(app.teams.team(o.team)!.status).toBe('running');
    const c = app.checkouts.start(o.team, admin);
    expect(c.source_machine_id).toBe(o.pc);
    expect(code(() => app.onboarding.reEnrol(o.pc, admin))).toBe('checkout_open');
    expect(code(() => app.onboarding.file(o.key, addAgents(o)))).toBe('checkout_open');
    expect(auditOf('checkout.guard_refused', c.id).length).toBe(2);
    app.checkouts.cancel(c.id, null, admin);
    const f = app.onboarding.file(o.key, addAgents(o));
    expect(f.state).toBe('submitted');
    // A pending add-agents request blocks a new checkout; one started before approval blocks the approval.
    expect(code(() => app.checkouts.start(o.team, admin))).toBe('invalid_state');
  });
  it('refuses approval and pickup of an add-agents request once a checkout is open', () => {
    const o = onboarded();
    const f = app.onboarding.file(o.key, addAgents(o));
    // Open a checkout anyway (as if it raced the filing): insert directly, the service would refuse it.
    app.db.prepare("INSERT INTO checkouts(id,team_id,status,created_at,updated_at,expires_at) VALUES (?,?,'collecting',?,?,?)").run(`cko_race${o.n}`, o.team, Date.now(), Date.now(), Date.now() + EXPIRY_MS);
    expect(code(() => app.onboarding.approve(f.request_id, { version: f.version }, admin))).toBe('checkout_open');
    app.db.prepare("UPDATE checkouts SET status='cancelled' WHERE id=?").run(`cko_race${o.n}`);
    app.onboarding.approve(f.request_id, { version: f.version }, admin);
    app.db.prepare("INSERT INTO checkouts(id,team_id,status,created_at,updated_at,expires_at) VALUES (?,?,'collecting',?,?,?)").run(`cko_race2${o.n}`, o.team, Date.now(), Date.now(), Date.now() + EXPIRY_MS);
    expect(code(() => app.onboarding.pickup(o.key, f.request_id, '127.0.0.1'))).toBe('checkout_open');
  });
});
