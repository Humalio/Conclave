/**
 * The vault folder "99 Conclave/" (docs/vault.md, D63): pages from the hub's records, the page filter, the deferred purge
 * of handout bodies with its 7-day cap, the reserved prefix in the policy engine (writes always refused, reads only with
 * a rule that names the folder), the agent walks and the graph skipping it, members, and the admin routes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { authorize, canReach } from '../src/policy/engine.js';
import { cleanName, scrub, PURGE_CAP_MS, PURGE_WARN_MS, WITHHELD } from '../src/mirror/mirror.js';
import { MemberScope } from '../src/admin/memberScope.js';
import { RESTORE_TEMPLATE } from './restoreTemplate.js';
import { testConfig, adminLogin } from './hub.js';

// Every step here writes vault pages and syncs each one to disk: a few seconds alone, five times that when another
// suite or a seed shares the machine. The limit leaves room for that; nothing in this file waits on a timer.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let app: App, base: string, vaultDir: string, appKey: string, appCredId: string;
const admin = { kind: 'admin' as const, id: '' };
const sys = { kind: 'system' as const, id: null };
let seq = 0;
const F = '99 Conclave';

const team = (workers = 1, o: { name?: string; labels?: string[] } = {}) => {
  const n = ++seq;
  const mk = (label: string) => { const a = app.keys.createAgent(label, null, admin); app.keys.createSessionKey({ agentId: a.id, label: `${label} key` }, admin); return a.id; };
  const labels = o.labels ?? [`lead-${n}`, ...Array.from({ length: workers }, (_, i) => `w${i}-${n}`)];
  const ids = labels.map(mk);
  const t = app.teams.create({ name: o.name ?? `Mirror team ${n}`, goal: 'Move it.', members: ids.map((id, i) => ({ agent_id: id, role: i === 0 ? 'coordinator' : 'worker' })) }, admin);
  app.teams.start(t.id, admin);
  return { id: t.id, lead: ids[0]!, workers: ids.slice(1), all: ids };
};
const noLeftovers = { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] };
const clean = { integration_branch: 'integration/core', integration_head: 'a'.repeat(40), merge_commits: ['b'.repeat(40)], worktrees_left: 0, clean: true, leftover_check: noLeftovers };
const handIn = (agentId: string, notes = 'Next: finish the parser.') => {
  app.checkouts.checkpointing(agentId);
  app.checkouts.merged(agentId, clean);
  return app.checkouts.write(agentId, { folder: `f-${agentId}`, repo: { remote_name: 'origin', url: 'https://github.com/acme/core.git', clone_folder: 'core' }, notes });
};
const rowsOf = (kind: string) => app.db.prepare('SELECT * FROM mirror_files WHERE kind=? ORDER BY path').all(kind) as { path: string; ref_id: string; ref_version: number | null; revision: string }[];
const pathOf = (kind: string, ref: string) => (app.db.prepare('SELECT path FROM mirror_files WHERE kind=? AND ref_id=?').get(kind, ref) as { path: string } | undefined)?.path;
const page = (p: string) => readFileSync(join(vaultDir, p), 'utf8');
const allPages = (dir = join(vaultDir, F)): string[] => existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? allPages(p) : [readFileSync(p, 'utf8')]; }) : [];
const revisions = () => (app.db.prepare("SELECT COUNT(*) n FROM file_revisions r JOIN files f ON f.id=r.file_id WHERE f.path LIKE '99 Conclave/%'").get() as { n: number }).n;
const freeze = (on: boolean) => app.db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES ('emergency.writes_disabled',?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(on));
const body = (id: string) => app.checkouts.handout(id)!.body;

async function connect() {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  return async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
}
/** An MCP session whose key holds `rules` (and the file tools). */
async function session(rules: { effect: 'allow' | 'deny'; actions: string[]; resource: string }[]) {
  const a = app.keys.createAgent(`reader-${++seq}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: 'k' }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, ...rules], 'test', sys);
  const call = await connect();
  const token = (await call('session_login', { session_key: k.secret })).structuredContent.session_token as string;
  return (name: string, args: Record<string, unknown> = {}) => call(name, { session_token: token, ...args });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahmir-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'Projects'), { recursive: true });
  writeFileSync(join(vaultDir, 'Projects', 'notes.md'), 'See [[Team]] for the team.');
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}}\n');
  writeFileSync(join(client, 'restore-prompt.md'), RESTORE_TEMPLATE);
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin.id = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const pc = app.keys.createMachine('pc-mirror', null, sys);
  const ak = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys);
  appKey = ak.secret; appCredId = ak.credential.id;
});
afterAll(async () => { await app.close(); });

describe('names and the page filter', () => {
  it('cleans names for every vault OS and for wikilinks', () => {
    expect(cleanName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe('a-b-c-d-e-f-g-h-i-j-k-l-m-n');
    expect(cleanName('Trailing dots... ')).toBe('Trailing dots');
    expect(cleanName('  ')).toBe('Unnamed');
  });
  it('scrubs URL user parts, third-party tokens, Conclave keys and PEM blocks', () => {
    const s = scrub([
      'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/acme/core.git',
      'ghp_abcdefghijklmnopqrstuvwxyz0123 github_pat_ABCDEFGHIJKLMNOPQRSTUV glpat-abcdefghijklmnopqrst xoxb-1234567890-abc sk-abcdefghijklmnopqrstuvwx AKIAABCDEFGHIJKLMNOP',
      'ah_ses_abcdefgh_ijklmnopqrstuvwxyz234567',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n'));
    expect(s).toContain('https://github.com/acme/core.git');
    for (const bad of ['x-access-token', 'ghp_', 'github_pat_', 'glpat-', 'xoxb-', 'sk-abc', 'AKIA', 'ah_ses_', 'MIIEow']) expect(s).not.toContain(bad);
  });
});

describe('pages', () => {
  it('a checkout through each status: README, handout pages, Team.md, the folder index; no restore prompt or pickup id', async () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    await app.mirror.idle();
    const cdir = pathOf('checkout', c.id)!;
    expect(cdir).toMatch(new RegExp(`^${F}/.+/Mirror team \\d+/Checkouts/\\d{4}-\\d\\d-\\d\\d ${c.id}/README\\.md$`));
    expect(page(cdir)).toContain('Collecting handouts (0 of 2 written)');
    expect(page(cdir)).toContain('Edits here are replaced.');
    expect(page(cdir)).toContain(`https://hub.test/#tco/${t.id}`);
    for (const a of t.all) handIn(a);
    await app.mirror.idle();
    expect(page(cdir)).toContain('Ready, waiting for the restore prompt');
    const hs = app.checkouts.handouts(c.id);
    const hp = pathOf('handout', hs[0]!.id)!;
    expect(page(hp)).toContain('Next: finish the parser.');
    expect(page(hp)).toContain('integration/core');
    app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: { target: 'same_user', rotate_agent_keys: false } }, admin);
    await app.mirror.idle();
    expect(page(cdir)).toContain('Rendered');
    expect(page(cdir)).toContain('no push needed (same OS user)');
    app.checkouts.markRestoring(c.id, sys);
    app.checkouts.consume(hs[0]!.id, null, sys);
    await app.mirror.idle();
    expect(page(cdir)).toContain('Restoring on the target (1 of 2 resumed)');
    app.checkouts.consume(hs[1]!.id, null, sys);
    await app.mirror.idle();
    expect(page(cdir)).toContain('every agent resumed on the target');
    expect(page(cdir)).toContain('## Push list'); // kept from the page written while the bodies were there
    expect(page(hp)).toContain('Next: finish the parser.'); // the copy stays after the body is cleared
    expect(body(hs[0]!.id)).toBeNull();
    const index = page(`${F}/README.md`);
    expect(index).toContain('Mirror team');
    for (const p of allPages()) { expect(p).not.toMatch(/onb_|pickup/i); expect(p).not.toContain('Restore prompt'); }
  });
  it('a hub-built handout says so', async () => {
    const t = team(1);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead);
    app.checkouts.proceed(c.id, admin); // ready with the missing handout built by the hub
    await app.mirror.idle();
    const h = app.checkouts.handouts(c.id).find((x) => x.agent_id === t.workers[0])!;
    expect(h.source).toBe('hub');
    expect(page(pathOf('handout', h.id)!)).toContain('Written by: the hub');
    expect(page(pathOf('checkout', c.id)!)).toContain('built by the hub');
  });
  it('a team rename keeps the folder; Team.md and session pages are written', async () => {
    const t = team(1);
    app.checkouts.start(t.id, admin);
    await app.mirror.idle();
    const before = pathOf('team', t.id)!;
    app.db.prepare('UPDATE teams SET name=? WHERE id=?').run('Renamed team', t.id);
    await app.mirror.sweep();
    expect(pathOf('team', t.id)).toBe(before);
    expect(page(before)).toContain('# Renamed team');
    expect(page(before)).toContain('## Members');
    expect(rowsOf('session').filter((r) => r.ref_id.startsWith(t.id)).length).toBe(2);
  });
  it('two labels that clean to the same name get the agent id', async () => {
    const t = team(1, { labels: ['Lead: one', 'Lead/ one'] });
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    await app.mirror.idle();
    const ps = app.checkouts.handouts(c.id).map((h) => pathOf('handout', h.id)!);
    expect(new Set(ps).size).toBe(2);
    expect(ps.some((p) => p.includes(`(${t.workers[0]})`) || p.includes(`(${t.lead})`))).toBe(true);
  });
  it('after a reset a new team with the same name gets " (2)" and the old pages stay', async () => {
    const t = team(0, { name: 'Same name' });
    app.checkouts.start(t.id, admin);
    await app.mirror.idle();
    const old = pathOf('team', t.id)!;
    // A reset of the teams part removes the record; mirror_files and the pages stay.
    app.db.prepare("UPDATE mirror_files SET ref_id='team_gone' WHERE kind='team' AND ref_id=?").run(t.id);
    app.db.prepare("UPDATE teams SET name='Not the same' WHERE id=?").run(t.id); // its row is gone after a real reset
    const t2 = team(0, { name: 'Same name' });
    // A reset also clears the projects, so the new team gets the same project folder name.
    app.db.prepare('UPDATE teams SET project_id=(SELECT project_id FROM teams WHERE id=?) WHERE id=?').run(t.id, t2.id);
    app.db.prepare("UPDATE projects SET status='closed' WHERE id<>(SELECT project_id FROM teams WHERE id=?)").run(t.id); // and the new team's own project is gone
    await app.mirror.sweep();
    expect(old).toBe(`${F}/Same name/Same name/Team.md`);
    expect(pathOf('team', t2.id)).toBe(`${F}/Same name/Same name (2)/Team.md`);
    expect(existsSync(join(vaultDir, old))).toBe(true);
    expect(page(`${F}/README.md`)).toContain('no longer in the hub');
  });
});

describe('reviews and decisions', () => {
  it('a review verdict writes the month\'s Reviews page; a settled question writes Decisions.md; Team.md links both', async () => {
    const t = team(1);
    const now = Date.now();
    app.db.prepare('INSERT INTO tasks(id,team_id,title,status,assignee_agent_id,reviewer_agent_id,review_comments,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('task_mirror1', t.id, 'Parser fix', 'approved', t.workers[0], t.lead, 'Looks right.', now, now);
    app.db.prepare('INSERT INTO task_events(task_id,from_status,to_status,actor_kind,actor_id,tool,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('task_mirror1', 'in_review', 'approved', 'agent', t.lead, 'task_review', 'Looks right.', now);
    app.mirror.reviewed(t.id);
    await app.mirror.idle();
    const rp = pathOf('reviews', `${t.id}:${new Date(now).toISOString().slice(0, 7)}`)!;
    expect(page(rp)).toContain('Decision: **Approved**');
    expect(page(rp)).toContain('> Looks right.');
    app.db.prepare('INSERT INTO decisions(id,team_id,agent_id,question,status,answer_text,answered_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('dec_mirror1', t.id, t.lead, 'Ship on Friday?', 'answered', 'Yes, ship it.', now, now, now);
    app.mirror.settled(t.id);
    await app.mirror.idle();
    const dp = pathOf('decisions', t.id)!;
    expect(page(dp)).toContain('Ship on Friday?');
    await app.mirror.sweep();
    const tp = page(pathOf('team', t.id)!);
    expect(tp).toContain(rp.replace(/\.md$/, ''));
    expect(tp).toContain(dp.replace(/\.md$/, ''));
  });
});

describe('secrets', () => {
  it('a token URL, third-party tokens and a Conclave key never reach a page; a split issued key withholds the section and raises the alert', async () => {
    const t = team(0);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead);
    const issued = app.keys.createSessionKey({ agentId: t.lead, label: 'leak' }, admin).secret;
    const h = app.checkouts.handouts(c.id)[0]!;
    const half = Math.floor(issued.length / 2);
    app.db.prepare('UPDATE handouts SET body=? WHERE id=?').run(JSON.stringify({
      folder: 'f', repo: { remote_name: 'origin', url: 'https://oauth2:glpat-abcdefghijklmnopqrst@gitlab.com/acme/core.git', clone_folder: 'core' },
      notes: `token ghp_abcdefghijklmnopqrstuvwxyz0123 and ah_tok_abcdefgh_ijklmnopqrstuvwxyz2345\nkey part ${issued.slice(0, half)}\n${issued.slice(half)}`,
      api_token: 'should-not-appear', note_extra: 'kept',
    }), h.id);
    await app.mirror.checkoutChanged(c.id);
    const p = page(pathOf('handout', h.id)!);
    for (const bad of ['oauth2', 'glpat-', 'ghp_', 'ah_tok_', issued.slice(0, half), 'should-not-appear', 'api_token']) expect(p).not.toContain(bad);
    expect(p).toContain(WITHHELD);
    expect(p).toContain('https://gitlab.com/acme/core.git');
    expect(p).toContain('note_extra: kept');
    expect(app.db.prepare("SELECT 1 FROM security_alerts WHERE type='key_in_result' AND details LIKE '%vault copy%'").get()).toBeTruthy();
  });
});

describe('the deferred purge', () => {
  const ready = (workers = 1) => {
    const t = team(workers);
    const c = app.checkouts.start(t.id, admin);
    for (const a of t.all) handIn(a);
    return { t, c, hs: app.checkouts.handouts(c.id) };
  };
  it('resume, restore, finish, cancel and expiry keep the body while the vault is frozen, and clear it once the page is written', async () => {
    const paths: Record<string, () => string[]> = {
      resume_restore: () => { const { c, hs } = ready(1); app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin); app.checkouts.markRestoring(c.id, sys); for (const h of hs) app.checkouts.consume(h.id, null, sys); return hs.map((h) => h.id); },
      finish: () => { const { c, hs } = ready(1); app.checkouts.recordRender(c.id, { target_machine_id: null, request_id: null, choices: {} }, admin); app.checkouts.markRestoring(c.id, sys); app.checkouts.consume(hs[0]!.id, null, sys); app.checkouts.sweep(app.checkouts.checkout(c.id)!.expires_at); app.checkouts.finish(c.id, admin); return hs.map((h) => h.id); },
      cancel: () => { const { c, hs } = ready(1); app.checkouts.cancel(c.id, null, admin); return hs.map((h) => h.id); },
      expiry: () => { const { c, hs } = ready(1); app.db.prepare('UPDATE checkouts SET expires_at=? WHERE id=?').run(Date.now() - 1, c.id); app.teams.tick(); return hs.map((h) => h.id); },
    };
    for (const [name, run] of Object.entries(paths)) {
      freeze(true);
      const ids = run();
      await app.mirror.idle();
      for (const id of ids) { expect(app.checkouts.handout(id)!.purge_due, name).not.toBeNull(); expect(body(id), name).not.toBeNull(); }
      freeze(false);
      await app.mirror.sweep();
      for (const id of ids) expect(body(id), name).toBeNull();
    }
  });
  it('a handout replaced after its page was written is not purged against the old version', async () => {
    const { c, hs } = ready(0);
    await app.mirror.idle();
    const h = hs[0]!;
    expect(rowsOf('handout').find((r) => r.ref_id === h.id)!.ref_version).toBe(h.version);
    freeze(true);
    app.db.prepare('UPDATE handouts SET version=version+1, purge_due=? WHERE id=?').run(Date.now(), h.id); // replaced, then due, page not rewritten yet
    expect(app.mirror.purge().cleared).not.toContain(h.id);
    expect(body(h.id)).not.toBeNull();
    freeze(false);
    await app.mirror.checkoutChanged(c.id);
    expect(body(h.id)).toBeNull();
  });
  it('the 7-day cap clears an uncopied body, with an Attention item a day before', async () => {
    const { c, hs } = ready(0);
    freeze(true);
    app.checkouts.cancel(c.id, null, admin);
    await app.mirror.idle();
    const due = app.checkouts.handout(hs[0]!.id)!.purge_due!;
    expect(app.mirror.purge(due + PURGE_WARN_MS - 1).warned).toEqual([]);
    expect(app.mirror.purge(due + PURGE_WARN_MS).warned).toEqual([hs[0]!.id]);
    const a = app.db.prepare("SELECT details FROM security_alerts WHERE type='handout_purge_soon' AND subject=?").get(hs[0]!.id) as { details: string };
    expect(JSON.parse(a.details).message).toMatch(/^The handout of .+ will be cleared before its vault copy was written\.$/);
    expect(app.mirror.purge(due + PURGE_WARN_MS + 1000).warned).toEqual([]); // once
    expect(app.mirror.purge(due + PURGE_CAP_MS).capped).toEqual([hs[0]!.id]);
    expect(body(hs[0]!.id)).toBeNull();
    freeze(false);
  });
  it('with vault scanning off (VAULT_SCAN_SECONDS=0) the hourly timer still runs, and its purge applies the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahmir0-'));
    mkdirSync(join(dir, 'vault'), { recursive: true });
    const other = await buildApp(testConfig(dir, { vaultScanSeconds: 0 }));
    try { expect(other.mirror.ticking).toBe(true); } finally { await other.close(); }
    const { c, hs } = ready(0);
    freeze(true);
    app.checkouts.cancel(c.id, null, admin);
    await app.mirror.idle();
    const due = app.checkouts.handout(hs[0]!.id)!.purge_due!;
    await app.mirror.hourlyTick(false, due + PURGE_CAP_MS);
    expect(body(hs[0]!.id)).toBeNull();
    freeze(false);
  });
  it('a sweep that rolls back after its end hook writes no page', async () => {
    const { c } = ready(0);
    await app.mirror.idle();
    const before = page(pathOf('checkout', c.id)!);
    app.db.prepare('UPDATE checkouts SET expires_at=? WHERE id=?').run(Date.now() - 1, c.id);
    app.db.exec('SAVEPOINT rb');
    app.checkouts.sweep();
    expect(app.checkouts.checkout(c.id)!.status).toBe('expired');
    app.db.exec('ROLLBACK TO rb'); app.db.exec('RELEASE rb');
    await app.mirror.idle();
    expect(app.checkouts.checkout(c.id)!.status).toBe('ready');
    expect(page(pathOf('checkout', c.id)!)).toBe(before);
    app.db.prepare('UPDATE checkouts SET expires_at=? WHERE id=?').run(Date.now() + 3600_000, c.id);
  });
});

describe('writes', () => {
  it('unchanged text writes nothing, and a sweep after a restart writes nothing new', async () => {
    await app.mirror.sweep();
    const n = revisions();
    await app.mirror.sweep();
    expect(revisions()).toBe(n);
  });
  it('an operator edit is replaced (its history keeps it)', async () => {
    const p = rowsOf('team')[0]!.path;
    writeFileSync(join(vaultDir, p), 'edited in Obsidian');
    await app.mirror.sweep();
    expect(page(p)).toContain('Edits here are replaced.');
  });
});

describe('who can see it', () => {
  const R = (p: string) => `path:/vault/${p}`;
  const writer = [{ id: 'r1', effect: 'allow' as const, actions: ['fs.*'], resource: 'path:/vault/**' }];
  const named = [{ id: 'r2', effect: 'allow' as const, actions: ['fs.*'], resource: `path:/vault/${F}/**` }];
  it('a Writer key on /vault/** is refused every action under the folder', () => {
    for (const a of ['fs.create', 'fs.update', 'fs.patch', 'fs.delete', 'fs.rename', 'fs.restore', 'fs.list', 'fs.read', 'fs.search', 'fs.history', 'fs.download', 'fs.conflicts']) {
      const d = authorize(writer, [], a, R(`${F}/README.md`));
      expect(d.allowed, a).toBe(false);
      expect(d.source, a).toBe('reserved');
    }
    expect(authorize(writer, [], 'fs.create', R(`${F}/x.md`)).reason).toBe('99 Conclave is written by the hub; write your documents in your project folder.');
    expect(authorize(writer, [], 'fs.read', R('Projects/notes.md')).allowed).toBe(true);
  });
  it('a rule that names the folder gives reads, with a wildcard app cap, but never writes', () => {
    const cap = [{ id: 'c1', effect: 'allow' as const, actions: ['fs.*'], resource: 'path:/vault/**' }];
    expect(authorize(named, cap, 'fs.read', R(`${F}/README.md`)).allowed).toBe(true);
    expect(authorize(named, cap, 'fs.list', R(`${F}`)).allowed).toBe(true);
    for (const a of ['fs.create', 'fs.update', 'fs.delete', 'fs.rename', 'fs.restore']) expect(authorize(named, cap, a, R(`${F}/README.md`)).allowed, a).toBe(false);
  });
  it('canReach: the root still reaches, the folder only with a rule that names it', () => {
    expect(canReach(writer, [], 'fs.list', '/vault')).toBe(true);
    expect(canReach(writer, [], 'fs.list', `/vault/${F}`)).toBe(false);
    expect(canReach(named, [], 'fs.list', `/vault/${F}`)).toBe(true);
  });
  it('over MCP: file tools are refused, the root lists the name, search and backlinks skip the folder', async () => {
    const call = await session(writer);
    const create = await call('file_create', { path: `/vault/${F}/x.md`, content: 'x' });
    expect(create.isError).toBe(true);
    expect(create.content[0]!.text).toContain('99 Conclave is written by the hub');
    for (const [tool, args] of [['file_read', { path: `/vault/${F}/README.md` }], ['file_list', { path: `/vault/${F}` }], ['file_history', { path: `/vault/${F}/README.md` }]] as const) {
      expect((await call(tool, args as Record<string, unknown>)).isError, tool).toBe(true);
    }
    expect((await call('file_rename', { path: '/vault/Projects/notes.md', new_path: `/vault/${F}/notes.md` })).isError).toBe(true);
    const root = await call('file_list', { path: '/vault' });
    expect(JSON.stringify(root.structuredContent)).toContain(F);
    const found = await call('file_search', { path: '/vault', query: 'Edits here are replaced' });
    expect(JSON.stringify(found.structuredContent ?? found.content)).not.toContain(F);
  });
  it('share_promote and a channel receive into the folder are refused (the same write check)', () => {
    for (const a of ['fs.create', 'fs.update']) expect(authorize(writer, writer, a, R(`${F}/Imported/a.txt`)).allowed).toBe(false);
  });
  it('a case variant of the folder name is the same folder (case-insensitive file systems)', async () => {
    for (const v of ['99 conclave', '99 CONCLAVE', '99 Conclave'.replace('C', 'c')]) {
      for (const a of ['fs.create', 'fs.update', 'fs.rename', 'fs.read']) {
        const d = authorize(writer, writer, a, R(`${v}/Decisions.md`)); // share_promote and channel receive use these checks
        expect(d.allowed, `${a} ${v}`).toBe(false);
        expect(d.source, `${a} ${v}`).toBe('reserved');
      }
      expect(canReach(writer, [], 'fs.list', `/vault/${v}`)).toBe(false);
    }
    const call = await session(writer);
    const create = await call('file_create', { path: '/vault/99 conclave/Decisions.md', content: 'fake' });
    expect(create.isError).toBe(true);
    expect(create.content[0]!.text).toContain('99 Conclave is written by the hub');
    expect((await call('file_rename', { path: '/vault/Projects/notes.md', new_path: '/vault/99 CONCLAVE/notes.md' })).isError).toBe(true);
    expect(existsSync(join(vaultDir, 'Projects', 'notes.md'))).toBe(true);
    expect(readdirSync(join(vaultDir, F))).not.toContain('notes.md');
  });
  it('agent walks skip the folder; the operator walk does not', async () => {
    const walk = async (agent: boolean) => { const out: string[] = []; for await (const f of app.vault.walk([], 20000, { agent })) out.push(f.rel.join('/')); return out; };
    expect((await walk(true)).some((p) => p.startsWith(F))).toBe(false);
    expect((await walk(true)).some((p) => p.startsWith('Projects/'))).toBe(true);
    expect((await walk(false)).some((p) => p.startsWith(F))).toBe(true);
  });
  it('a graph write under the folder queues no jobs', async () => {
    const n = (app.db.prepare('SELECT COUNT(*) n FROM kg_sections').get() as { n: number }).n;
    await app.mirror.sweep();
    expect((app.db.prepare("SELECT COUNT(*) n FROM kg_sections s JOIN files f ON f.id=s.file_id WHERE f.path LIKE '99 Conclave/%'").get() as { n: number }).n).toBe(0);
    expect((app.db.prepare('SELECT COUNT(*) n FROM kg_sections').get() as { n: number }).n).toBe(n);
  });
  it('a member sees the folder only when it is granted by name', () => {
    const prj = app.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    const mk = (folders: string[]) => {
      const id = `adm_m${++seq}`;
      app.db.prepare("INSERT INTO admin_users(id,username,password_hash,created_at,role) VALUES (?,?,'x',0,'member')").run(id, id);
      app.db.prepare("INSERT INTO user_project_grants(user_id,project_id,components,vault_folders,granted_at) VALUES (?,?,'[\"vault\"]',?,0)").run(id, prj.id, JSON.stringify(folders));
      return new MemberScope(app.db, id, false);
    };
    expect(app.db.prepare('SELECT restricted FROM vault_folder_flags WHERE path=?').get(`/${F}/`)).toEqual({ restricted: 1 });
    expect(mk(['/Projects/']).canSee(`${F}/README.md`)).toBe(false);
    expect(mk(['/Projects/']).canSee('Projects/notes.md')).toBe(true);
    expect(mk(['/Projects/', `/${F}/`]).canSee(`${F}/README.md`)).toBe(true);
  });
  it('a decision_log_path under the folder is refused', async () => {
    const t = team(0);
    const s = await adminLogin(base);
    const r = await fetch(`${base}/api/teams/${t.id}/decision-log`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf }, body: JSON.stringify({ path: `/vault/${F}/Decisions.md` }) });
    expect(r.status).toBe(400);
  });
});

describe('admin routes', () => {
  it('the setting turns writing off and on (default on); the import writes a saved checkout', async () => {
    const s = await adminLogin(base);
    const H = { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf };
    expect(await (await fetch(`${base}/api/settings/vault`, { headers: H })).json()).toEqual({ settings: { mirror_enabled: true, folder: F } });
    expect((await fetch(`${base}/api/settings/vault`, { method: 'PUT', headers: H, body: JSON.stringify({ mirror_enabled: false }) })).status).toBe(200);
    const t = team(0);
    const c = app.checkouts.start(t.id, admin);
    await app.mirror.idle();
    expect(pathOf('checkout', c.id)).toBeUndefined();
    await fetch(`${base}/api/settings/vault`, { method: 'PUT', headers: H, body: JSON.stringify({ mirror_enabled: true }) });
    await app.mirror.idle();
    expect(pathOf('checkout', c.id)).toBeDefined();
    // A saved checkout whose bodies are gone from the database: the import writes them, and they are kept.
    handIn(t.lead, 'Saved notes from the backup.');
    const saved = await (await fetch(`${base}/api/checkouts/${c.id}`, { headers: H })).json();
    app.checkouts.cancel(c.id, null, admin);
    app.db.prepare('UPDATE handouts SET body=NULL WHERE checkout_id=?').run(c.id);
    app.db.prepare("DELETE FROM mirror_files WHERE kind='handout' AND ref_id IN (SELECT id FROM handouts WHERE checkout_id=?)").run(c.id);
    const r = await (await fetch(`${base}/api/vault/mirror/import`, { method: 'POST', headers: H, body: JSON.stringify(saved) })).json() as { pages: string[] };
    expect(r.pages.length).toBe(2);
    const hp = r.pages.find((p) => !p.endsWith('README.md'))!;
    expect(page(hp)).toContain('Saved notes from the backup.');
    await app.mirror.checkoutChanged(c.id);
    expect(page(hp)).toContain('Saved notes from the backup.');
    expect((await fetch(`${base}/api/vault/mirror/import`, { method: 'POST', headers: H, body: '{"x":1}' })).status).toBe(400);
  });
  it('the import refuses a checkout whose handouts still hold their text, and a time that is not a date', async () => {
    const s = await adminLogin(base);
    const H = { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf };
    const t = team(0);
    const c = app.checkouts.start(t.id, admin);
    handIn(t.lead, 'Live notes.');
    await app.mirror.idle();
    const saved = await (await fetch(`${base}/api/checkouts/${c.id}`, { headers: H })).json() as { checkout: Record<string, unknown> };
    const live = await fetch(`${base}/api/vault/mirror/import`, { method: 'POST', headers: H, body: JSON.stringify(saved) });
    expect(live.status).toBe(409);
    expect(body((app.db.prepare('SELECT id FROM handouts WHERE checkout_id=?').get(c.id) as { id: string }).id)).not.toBeNull();
    for (const bad of [1e300, -1, 'soon']) {
      const x = { ...saved, checkout: { ...saved.checkout, id: `cko_gone${++seq}`, created_at: bad } };
      expect((await fetch(`${base}/api/vault/mirror/import`, { method: 'POST', headers: H, body: JSON.stringify(x) })).status, String(bad)).toBe(400);
    }
    app.checkouts.cancel(c.id, null, admin);
  });
  it('the routes are admin only and need the CSRF token', async () => {
    const s = await adminLogin(base);
    const H = { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf };
    const u = await (await fetch(`${base}/api/users`, { method: 'POST', headers: H, body: JSON.stringify({ username: `mirror-member${++seq}`, role: 'member' }) })).json() as { user: { username: string }; password: string };
    const first = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.user.username, password: u.password }) });
    const m0 = { cookie: first.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await first.json()) as { csrf: string }).csrf };
    const pw = 'a member passphrase for the mirror test';
    expect((await fetch(`${base}/api/me/password`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: m0.cookie, 'x-csrf-token': m0.csrf }, body: JSON.stringify({ current: u.password, new: pw }) })).status).toBe(200);
    const m = await adminLogin(base, u.user.username, pw);
    const M = { 'content-type': 'application/json', cookie: m.cookie, 'x-csrf-token': m.csrf };
    expect((await fetch(`${base}/api/settings/vault`, { headers: M })).status).toBe(403);
    expect((await fetch(`${base}/api/settings/vault`, { method: 'PUT', headers: M, body: JSON.stringify({ mirror_enabled: false }) })).status).toBe(403);
    expect((await fetch(`${base}/api/vault/mirror/import`, { method: 'POST', headers: M, body: '{}' })).status).toBe(403);
    const noCsrf = { 'content-type': 'application/json', cookie: s.cookie };
    expect((await fetch(`${base}/api/settings/vault`, { method: 'PUT', headers: noCsrf, body: JSON.stringify({ mirror_enabled: false }) })).status).toBe(403);
    expect((await fetch(`${base}/api/vault/mirror/import`, { method: 'POST', headers: noCsrf, body: '{}' })).status).toBe(403);
    expect(app.mirror.enabled()).toBe(true);
  });
});

describe('folders follow the project (fix 9)', () => {
  const op = { kind: 'operator' as const, id: null };
  it('a project folder is the project name alone; the key comes in only when two live projects clean to the same name', async () => {
    const a = team(0, { name: 'Fold alpha' });
    await app.mirror.sweep();
    expect(pathOf('team', a.id)).toBe(`${F}/Fold alpha/Fold alpha/Team.md`);
    const twin = app.blueprint.createProject({ key: 'FAX', name: 'fold Alpha' }, op);
    await app.mirror.sweep();
    const key = (app.db.prepare('SELECT p.key FROM projects p JOIN teams t ON t.project_id=p.id WHERE t.id=?').get(a.id) as { key: string }).key;
    expect(pathOf('team', a.id)).toBe(`${F}/${key} Fold alpha/Fold alpha/Team.md`);
    expect(existsSync(join(vaultDir, F, 'Fold alpha'))).toBe(false);
    // Closing the twin frees the plain name again, at once.
    app.blueprint.updateProject(twin.id, { status: 'closed' }, op);
    await app.mirror.idle();
    expect(pathOf('team', a.id)).toBe(`${F}/Fold alpha/Fold alpha/Team.md`);
    expect(existsSync(join(vaultDir, F, `${key} Fold alpha`))).toBe(false);
  });

  it('a team moved to another project, then that project renamed: the hub\'s pages move each time, links follow, other files stay', async () => {
    const t = team(1, { name: 'Harbor Stakeholders' });
    app.checkouts.start(t.id, admin);
    handIn(t.workers[0]!);
    await app.mirror.idle();
    await app.mirror.sweep();
    const oldTeam = pathOf('team', t.id)!, oldFolder = oldTeam.replace(/\/Team\.md$/, '');
    expect(oldFolder).toBe(`${F}/Harbor Stakeholders/Harbor Stakeholders`);
    const handout = rowsOf('handout').find((r) => r.path.startsWith(`${oldFolder}/`))!;
    writeFileSync(join(vaultDir, oldFolder, 'Operator notes.md'), 'Mine, not the hub\'s.');

    const p = app.blueprint.createProject({ key: 'TD', name: 'Twin demo' }, op);
    app.blueprint.assignTeam(t.id, p.id, [], op);
    await app.mirror.idle();
    const moved = `${F}/Twin demo/Harbor Stakeholders`;
    expect(pathOf('team', t.id)).toBe(`${moved}/Team.md`);
    const hp = pathOf('handout', handout.ref_id)!;
    expect(hp.startsWith(`${moved}/Checkouts/`)).toBe(true);
    expect(existsSync(join(vaultDir, handout.path))).toBe(false);
    expect(page(hp)).toContain(`[[${moved}/Sessions/`);
    expect(page(hp)).not.toContain(`[[${oldFolder}/`);
    expect(app.db.prepare('SELECT 1 FROM mirror_files WHERE path LIKE ?').get(`${oldFolder}/%`)).toBeUndefined();
    // The operator's own file stays, so its folder stays; the emptied Checkouts and Sessions folders are gone.
    expect(readFileSync(join(vaultDir, oldFolder, 'Operator notes.md'), 'utf8')).toBe('Mine, not the hub\'s.');
    expect(existsSync(join(vaultDir, oldFolder, 'Checkouts'))).toBe(false);
    expect(existsSync(join(vaultDir, oldFolder, 'Sessions'))).toBe(false);

    app.blueprint.updateProject(p.id, { name: 'Harbor' }, op);
    await app.mirror.idle();
    const renamed = `${F}/Harbor/Harbor Stakeholders`;
    expect(pathOf('team', t.id)).toBe(`${renamed}/Team.md`);
    expect(pathOf('handout', handout.ref_id)!.startsWith(`${renamed}/Checkouts/`)).toBe(true);
    expect(existsSync(join(vaultDir, F, 'Twin demo'))).toBe(false);
    const readme = page(`${F}/README.md`);
    expect(readme).toContain(`[[${renamed}/Team|Harbor Stakeholders]]`);
    expect(readme).not.toContain('Twin demo');
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='vault.mirror_move' AND target_id=?").get(t.id)).toEqual({ n: 2 });
  });

  it('at startup, pages under the old "<KEY> <Name>" folders move to the project-name folder once', async () => {
    const t = team(0, { name: 'Boot moved' });
    await app.mirror.sweep();
    const now = pathOf('team', t.id)!, key = (app.db.prepare('SELECT p.key FROM projects p JOIN teams t ON t.project_id=p.id WHERE t.id=?').get(t.id) as { key: string }).key;
    // The layout before this build: the same pages under "<KEY> <Name>".
    const legacy = now.replace(`${F}/Boot moved/`, `${F}/${key} Boot moved/`);
    mkdirSync(join(vaultDir, legacy, '..'), { recursive: true });
    writeFileSync(join(vaultDir, legacy), page(now));
    await app.store.reconcile([legacy, now]);
    const { rmSync } = await import('node:fs');
    rmSync(join(vaultDir, F, 'Boot moved'), { recursive: true });
    await app.store.reconcile([now]);
    app.db.prepare("UPDATE mirror_files SET path=replace(path, ?, ?) WHERE path LIKE ?").run(`${F}/Boot moved/`, `${F}/${key} Boot moved/`, `${F}/Boot moved/%`);
    await app.mirror.sweep();
    expect(pathOf('team', t.id)).toBe(now);
    expect(existsSync(join(vaultDir, now))).toBe(true);
    expect(existsSync(join(vaultDir, F, `${key} Boot moved`))).toBe(false);
    const n = (app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='vault.mirror_move' AND target_id=?").get(t.id) as { n: number }).n;
    await app.mirror.sweep();
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='vault.mirror_move' AND target_id=?").get(t.id) as { n: number }).n).toBe(n);
  });
});
