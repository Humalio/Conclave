#!/usr/bin/env node
// The Early Echo story runner (docs/showcase.md §6). It is the full feature test suite and the dev seed.
//
//   node eval/run.mjs                       throwaway hub on 127.0.0.1, Acts 0–5 at instant speed, coverage gate, report
//   node eval/run.mjs --until 3 --keep      stop after Act 3 and leave the hub running (console review)
//   node eval/run.mjs --from 3 --until 3 --pace 1x --act-pause 2   replay Act 3 at watchable speed (earlier acts instant)
//   node eval/run.mjs --hub                 run against the running dev:hub (.dev/hub.env, .dev/vault); dev:seed runs this
//   node eval/run.mjs --scale               add the optional volume act (three more projects, 30 agents)
//
// Callable in-process: import { runStory } from 'eval/run.mjs' with { hub, onProgress, signal }.
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO, Recorder, assertLocal, assertLocalHub, sleep, startThrowawayHub } from './story/lib.mjs';
import { Context, SKIPPED, StoryError } from './story/context.mjs';
import { gate, renderMarkdown } from './story/coverage.mjs';
import INVARIANTS from './story/invariants.mjs';
import { PROJECTS as PROJECT_NAMES, V } from './story/cast.mjs';
import { seedDemoHandoff } from './story/demo-handoff.mjs';

export const ACTS = ['act0', 'act1', 'act2', 'act3', 'act4', 'act5'];
export const ACT_TITLES = ['Hub setup', 'Kickoff', 'Research', 'Blocker', 'Recovery', 'Disclosure', 'Volume'];

/** Load the acts' step lists: [{ act, steps }]. */
export async function loadActs({ scale = false } = {}) {
  const out = [];
  for (const [i, name] of ACTS.entries()) out.push({ act: i, title: ACT_TITLES[i], steps: (await import(pathToFileURL(join(REPO, 'eval', 'story', `${name}.mjs`)).href)).default });
  if (scale) out.push({ act: 6, title: ACT_TITLES[6], steps: (await import(pathToFileURL(join(REPO, 'eval', 'story', 'scale.mjs')).href)).default });
  return out;
}

/** Parse "2x", "0.5x", "1" → factor; 0 = instant. */
export const parsePace = (v) => { if (v === undefined || v === null || v === '' || v === 'instant') return 0; const n = Number(String(v).replace(/x$/i, '')); if (!(n > 0)) throw new Error(`--pace must be a positive factor like 0.5x, 1x or 2x (got ${v})`); return n; };

/**
 * Run the story.
 * @param {object} o
 * @param {object} [o.hub]      { base, admin: {username,password}, vaultDir, restart?() } — omit for a throwaway hub
 * @param {number} [o.from=0]   first act run at the chosen pace (earlier acts run instantly first)
 * @param {number} [o.until=5]  last act
 * @param {number} [o.pace=0]   0 = instant; 1 = each step holds its beat; 2 = twice as fast
 * @param {number|'key'} [o.actPause]  seconds to hold at each act boundary when paced, or 'key' to wait for Enter
 * @param {boolean} [o.scale]   add the volume act after Act 5
 * @param {(e:object)=>void} [o.onProgress]  { type: 'act'|'step'|'done', act, step, title, index, total }
 * @param {AbortSignal} [o.signal]
 * @param {(act:number, ctx:Context)=>Promise<void>} [o.onActEnd]  hook for the screenshot pass (task 4)
 * @param {boolean} [o.interactive]  prepare the demo operator's live handoff after the scripted story
 * @param {(row:{record:string, episode:string})=>Promise<unknown>} [o.setAside]  set aside the handoff item for the operator who started Replay
 * @param {string} [o.outDir]   where the reports go (default eval/out/<run>)
 * @param {boolean} [o.extras]  after Act 5, seed the dev extras (collaborators, graph data); dev:seed and --keep set it
 */
export async function runStory(o = {}) {
  const log = o.log ?? (() => {});
  const from = o.from ?? 0, until = o.until ?? 5, pace = o.pace ?? 0;
  const acts = (await loadActs({ scale: !!o.scale })).filter((a) => a.act <= until || (o.scale && a.act === 6 && until >= 5));
  const total = acts.reduce((n, a) => n + a.steps.length, 0);
  const own = !o.hub;
  const hub = o.hub ?? await startThrowawayHub({ log });
  assertLocal(hub.base);
  const rec = new Recorder();
  const ctx = new Context({ hub, rec, signal: o.signal, log });
  const started = Date.now();
  let index = 0, failure = null;
  try {
    for (const a of acts) {
      o.onProgress?.({ type: 'act', act: a.act, title: a.title, index, total });
      log(`\nAct ${a.act}: ${a.title}`);
      const paced = pace > 0 && a.act >= from;
      let actStep = 0;
      for (const st of a.steps) {
        if (o.signal?.aborted) throw o.signal.reason ?? new Error('aborted');
        index++; actStep++;
        rec.begin(st.id, st.title);
        o.onProgress?.({ type: 'step', act: a.act, step: st.id, title: st.title, index, total, act_step: actStep, act_steps: a.steps.length });
        try { const out = await st.run(ctx); if (out === SKIPPED) rec.skip(); else for (const r of st.rows ?? []) rec.row(r); }
        catch (e) { failure = { step: st.id, title: st.title, message: e.message, story: e instanceof StoryError }; throw e; }
        log(`  ✓ ${st.id} ${st.title}`);
        if (paced) await sleep((st.beat ?? 900) / pace, o.signal);
      }
      if (INVARIANTS[a.act]) {
        rec.begin(`${a.act}.inv`, `Invariants after Act ${a.act}`);
        try { await INVARIANTS[a.act](ctx); }
        catch (e) { failure = { step: `${a.act}.inv`, title: `Invariants after Act ${a.act}`, message: e.message, story: e instanceof StoryError }; throw e; }
        log(`  ✓ invariants after Act ${a.act}`);
      }
      await o.onActEnd?.(a.act, ctx);
      if (pace > 0 && a.act >= from && a !== acts.at(-1)) {
        if (o.actPause === 'key') await new Promise((ok) => { const rl = createInterface({ input: process.stdin }); rl.question(`End of Act ${a.act}. Press Enter for Act ${a.act + 1}. `, () => { rl.close(); ok(); }); });
        else if (o.actPause) await sleep(Number(o.actPause) * 1000, o.signal);
      }
    }
  } catch (e) {
    failure ??= { step: rec.current, message: e.message };
  }
  if (o.interactive && !failure && until >= 5 && !o.signal?.aborted) {
    try {
      await seedDemoHandoff(ctx, o.setAside);
    } catch (e) {
      failure = { step: rec.current, message: e.message };
    }
  }
  // Dev-seed extras (console review only, not part of the story or its coverage): two collaborators and more graph data.
  let seed;
  if (o.extras && !failure && until >= 5) seed = await seedExtras(ctx, log);
  // The gate needs the full tool list from the hub, so read it before stopping.
  let tools = [];
  try { const pc = Object.values(ctx.pcs).find((p) => p.conn)?.conn; if (pc) tools = (await pc.listTools()).map((t) => t.name); } catch {}
  const full = !failure && from === 0 && until >= 5;
  const coverage = gate({ rec, tools, full });
  const notes = [];
  if (rec.skipped.length) notes.push(`Skipped, so they count for no row: ${rec.skipped.join(', ')} (the restart needs a throwaway hub the runner controls).`);
  coverage.notes = notes;
  const result = { ok: !failure && (!full || coverage.ok), failure, coverage, pace, from, until, seconds: Math.round((Date.now() - started) / 1000), outcomeLog: rec.outcomeLog(), steps: index, total, seed };
  for (const p of Object.values(ctx.pcs)) await p.conn?.close();
  if (o.outDir !== false) {
    const dir = o.outDir ?? join(REPO, 'eval', 'out', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'coverage.json'), JSON.stringify({ ...result, outcomeLog: undefined, seed: undefined }, null, 2));
    writeFileSync(join(dir, 'coverage.md'), renderMarkdown(result));
    writeFileSync(join(dir, 'outcomes.log'), result.outcomeLog.join('\n') + '\n');
    result.outDir = dir;
  }
  o.onProgress?.({ type: 'done', ok: result.ok, index, total });
  if (own && o.keep) writeFileSync(join(hub.root, 'hub.env'), `ADMIN_USERNAME=${hub.admin.username}
ADMIN_PASSWORD=${hub.admin.password}
`, { mode: 0o600 });
  else if (own) await hub.stop();
  result.hub = own && o.keep ? { base: hub.base, root: hub.root } : undefined;
  return result;
}

/**
 * Dev-seed extras after Act 5 (docs/multi-user.md MU6), for console review on a local hub only: a colleague and an
 * external partner as collaborators, created through the API, and a small knowledge graph on the Signals Lab notes
 * behind the Echo model research project, written by Quentin (the curator) with the MCP graph tools.
 * Never throws: what could not be seeded comes back in `warnings`.
 * @returns {{ users: {username:string, password?:string, setup_url?:string, note?:string}[], graph: object, warnings: string[] }}
 */
export async function seedExtras(c, log = () => {}) {
  const op = c.op, warnings = [], users = [];
  const warn = (m) => { warnings.push(m); log(`  ! ${m}`); };
  const code = (e) => e?.code ?? e?.error ?? (/\b(conflict|not_found)\b/.exec(e?.message ?? '') ?? [])[1];
  log('\nSeed extras: collaborators and knowledge graph');

  // ── Collaborators ──
  let projects = [], teams = [];
  try { projects = (await op.get('/api/projects?limit=100')).projects ?? []; teams = (await op.get('/api/teams')).teams ?? []; }
  catch (e) { warn(`could not list projects or teams: ${e.message}`); }
  const research = projects.find((p) => p.key === 'EMR') ?? projects.find((p) => p.kind === 'research');
  // The story's case teams may each sit in a project of their own (named after the team); then Case Command's project stands in.
  const drive = projects.find((p) => p.name === PROJECT_NAMES.drive) ?? projects.find((p) => p.id === teams.find((t) => t.name === 'Case Command')?.project_id);
  const live = (t) => t.status !== 'done' && t.status !== 'stopped';
  const decideFor = teams.find((t) => t.project_id === drive?.id && live(t) && t.name === 'Signals Lab') ?? teams.find((t) => t.project_id === drive?.id && live(t));

  /** Create (or, on a re-seed, reset) a user and return how to sign in as them. */
  const makeUser = async (spec) => {
    const out = { username: spec.username };
    let made;
    try { made = await op.post('/api/users', spec); }
    catch (e) {
      if (code(e) !== 'conflict') { warn(`could not create ${spec.username}: ${e.message}`); return null; }
      const u = ((await op.get('/api/users').catch(() => ({ users: [] }))).users ?? []).find((x) => x.username.toLowerCase() === spec.username.toLowerCase());
      if (!u) { warn(`${spec.username} exists but is not listed`); return null; }
      made = { user: u };
      try { out.password = (await op.post(`/api/users/${u.id}/reset-password`)).password; out.note = 'existed; password reset'; }
      catch (e2) { out.note = `existed; password unchanged (reset-password: ${e2.message})`; }
    }
    if (made.password) out.password = made.password;
    else if (made.setup_link?.url && !out.password) {
      // Older hub: no generated password yet. Finish the setup link with a seed password; a 2FA user may need the page.
      const url = made.setup_link.url, token = url.slice(url.indexOf('#setup/') + 7);
      const pw = randomBytes(15).toString('base64url');
      try { await op.post(`/api/setup/${token}`, { password: pw }); out.password = pw; out.note = 'set through the setup link (older hub)'; }
      catch (e) { out.setup_url = url; out.note = `open the setup link to finish (${e.message})`; }
    }
    out.id = made.user?.id;
    users.push(out);
    log(`  ✓ user ${spec.username}${out.note ? ` (${out.note})` : ''}`);
    return out;
  };

  const lena = await makeUser({ username: 'lena', display_name: 'Lena Hartmann', org: 'Corvel Station, Signals Lab' });
  if (lena?.id) {
    const grants = [];
    if (research) grants.push({ project_id: research.id, components: ['tasks', 'feed', 'messages'] });
    if (drive) grants.push({ project_id: drive.id, components: ['tasks', 'feed'] });
    if (!research) warn('no research project (EMR) to grant lena');
    try { if (grants.length) await op.put(`/api/users/${lena.id}/grants`, { grants }); } catch (e) { warn(`lena's grants: ${e.message}`); }
    if (decideFor && drive) {
      try {
        const cur = (await op.get(`/api/teams/${decideFor.id}/deciders`)).deciders ?? [];
        await op.put(`/api/teams/${decideFor.id}/deciders`, { user_ids: [...new Set([...cur, lena.id])] });
        log(`  ✓ lena decides for ${decideFor.name}`);
      } catch (e) { warn(`lena as decider of ${decideFor.name}: ${e.message}`); }
    } else warn('no live team in the case project (or Case Command’s) for lena to decide for');
  }
  const omar = await makeUser({ username: 'omar', display_name: 'Omar Haddad', org: 'Northwind Lab', external: true, totp_required: true });
  if (omar?.id) {
    // One project, read-only: the Blueprint (always on) and the feed, nothing that acts.
    const p = research ?? drive;
    try { if (p) await op.put(`/api/users/${omar.id}/grants`, { grants: [{ project_id: p.id, components: ['feed'] }] }); else warn('no project to grant omar'); }
    catch (e) { warn(`omar's grant: ${e.message}`); }
  }

  // ── Task attachments (docs/dashboard-ux.md, task screen "Attachments"): a brief with screenshots and a mockup, and two
  // review rounds, the second waiting in review with a before/after pair, so every state of the console shows ──
  try { await seedAttachments(c, log); } catch (e) { warn(`task attachments: ${e.message}`); }

  // ── Knowledge graph (Vault > Knowledge): ~10 entities, 10 relations, 2 flags on the Signals Lab notes ──
  const graph = { notes: 0, claims: 0, relations: 0, entities: 0, flags: 0 };
  const Q = c.seats.Quentin ? c.as('Quentin') : null;
  if (!Q?.pc) { warn('Quentin has no PC connection: no graph data seeded'); return { users, graph, warnings }; }
  const SL = 'Signals Lab';
  const cl = (subject, predicate, rest) => ({ subject, predicate, confidence: 0.85, ...rest });
  const NOTES = [
    { file: `${SL}/Echo model v1.md`,
      entities: [['Echo model v1', 'model'], ['Echo model v2', 'model'], ['Echo geometry', 'result'], ['Power law', 'result'], ['Stability analysis', 'result'], ['Echo decay', 'result'], ['CAP-014', 'capture'], ['Echo 47', 'event']],
      claims: [
        cl('Echo model v1', 'composes', { object: 'Echo geometry', text: 'Echo model v1 takes its ring and beam geometry from Echo geometry.', anchor: 'what-the-model-contains' }),
        cl('Echo model v1', 'composes', { object: 'Power law', text: 'Echo model v1 uses the power law P = k I squared.', anchor: 'what-the-model-contains' }),
        cl('Echo model v1', 'composes', { object: 'Stability analysis', text: 'Echo model v1 takes its mode limits from the stability analysis.', anchor: 'what-the-model-contains' }),
        cl('Echo model v1', 'composes', { object: 'Echo decay', text: 'Echo model v1 takes its ring-down from Echo decay.', anchor: 'what-the-model-contains' }),
        cl('Echo model v1', 'does_not_reproduce', { object: 'Echo 47', text: 'Echo model v1 does not reproduce echo 47.', anchor: 'known-gaps', confidence: 0.95 }),
        cl('Echo model v2', 'extends', { object: 'Echo model v1', text: 'Echo model v2 extends validation of v1 above P 0.30.', anchor: 'echo-model-v2-in-preparation', confidence: 0.7 }),
        cl('Echo model v2', 'waits_on', { object: 'CAP-014', text: 'Echo model v2 waits on data from CAP-014, the only planned data above P 0.30.', anchor: 'echo-model-v2-in-preparation', confidence: 0.75 }),
      ],
      relations: [['Echo model v1', 'Echo geometry', 'composes', 0], ['Echo model v1', 'Power law', 'composes', 1], ['Echo model v1', 'Stability analysis', 'composes', 2],
        ['Echo model v1', 'Echo decay', 'composes', 3], ['Echo model v1', 'Echo 47', 'does_not_explain', 4], ['Echo model v2', 'Echo model v1', 'extends', 5], ['Echo model v2', 'CAP-014', 'waits_on', 6]],
      summary: 'Echo model v1 is the model of record: geometry, power law, stability limits and ring-down from four Signals Lab results. Validated below P 0.30 only; it does not reproduce echo 47. v2 waits on CAP-014.' },
    { file: `${SL}/Stability analysis.md`,
      entities: [['Stability analysis', 'result'], ['Mode m = 6', 'concept'], ['Echo 47', 'event']],
      claims: [
        cl('Stability analysis', 'bounds', { object: 'Mode m = 6', text: 'The stability analysis finds mode m = 6 critical near P 0.71.', anchor: 'result' }),
        cl('Stability analysis', 'examines', { object: 'Echo 47', text: 'The stability analysis looks at what it can say about echo 47.', anchor: 'what-stability-analysis-says-about-echo-47', confidence: 0.7 }),
      ],
      relations: [['Stability analysis', 'Mode m = 6', 'bounds', 0], ['Stability analysis', 'Echo 47', 'examines', 1]] },
    { file: `${SL}/Echo decay.md`,
      entities: [['Echo decay', 'result'], ['Ring-down', 'concept']],
      claims: [cl('Echo decay', 'describes', { object: 'Ring-down', text: 'Echo decay describes the fast and slow ring-down stages after a send.', anchor: 'result' })],
      relations: [['Echo decay', 'Ring-down', 'describes', 0]] },
  ];
  for (const n of NOTES) {
    try {
      const text = c.disk.read(n.file);
      const claims = n.claims.map((x) => ({ ...x, quote: c.quoteIn(text, x.anchor) }));
      const r = await Q.ok('graph_upsert', { path: `${V}/${n.file}`, payload: {
        entities: n.entities.map(([name, type]) => ({ name, type })), claims,
        relations: n.relations.map(([src, dst, kind, i]) => ({ src, dst, kind, claims: [i] })),
      } });
      graph.notes++; graph.claims += r.accepted_claims ?? 0; graph.relations += r.relations ?? 0; graph.entities += r.entities_created ?? 0;
      for (const x of r.rejected ?? []) warn(`graph ${n.file}: ${x.item}: ${x.error}`);
      if (n.summary) await Q.ok('graph_summary_write', { path: `${V}/${n.file}`, text: n.summary });
    } catch (e) { warn(`graph ${n.file}: ${e.message}`); }
  }
  for (const f of [
    { path: `${SL}/Echo model v1.md`, anchor: 'validation-status', cause: `${SL}/Stability analysis.md`, kind: 'contradiction', reason: 'v1 is quoted at the long-haul beam (P 0.62) while it is validated below P 0.30 only; the stability analysis puts the critical mode near P 0.71.' },
    { path: `${SL}/Echo decay.md`, anchor: 'downstream', cause: `${SL}/Echo model v1.md`, kind: 'stale', reason: 'Echo model v2 will add a cold-face term; the downstream uses of the ring-down fit assume v1.' },
  ]) {
    try { await Q.ok('graph_flag', { path: `${V}/${f.path}`, anchor: f.anchor, cause_path: `${V}/${f.cause}`, kind: f.kind, reason: f.reason }); graph.flags++; }
    catch (e) { warn(`graph flag on ${f.path}: ${e.message}`); }
  }
  log(`  ✓ graph: ${graph.notes} notes, ${graph.entities} new entities, ${graph.claims} claims, ${graph.relations} relations, ${graph.flags} flags`);
  return { users, graph, warnings };
}

/* A placeholder screenshot: a tinted page with grey bars where text would be, as a real PNG the hub sniffs as an image. */
function seedPng(w, h, tint, bars) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const bar = bars.find(([top, right]) => y >= top * h && y < top * h + Math.max(6, h * 0.03) && right !== undefined);
    for (let x = 0; x < w; x++) {
      const on = bar && x > w * 0.06 && x < w * (1 - bar[1]), o = y * (w * 3 + 1) + 1 + x * 3;
      const px = on ? [150, 156, 168] : y < h * 0.08 ? tint.map((v) => v - 24) : tint;
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const SEED_MOCKUP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rename team</title><style>
body{font:14px system-ui,sans-serif;margin:16px;color:#1c2230;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e9ef;background:#1b2029}}
.s{max-width:380px;border:1px solid #dfe3ea;border-radius:10px;padding:14px}
input{width:100%;box-sizing:border-box;font:inherit;padding:6px 8px;border:1px solid #c33;border-radius:6px}
.e{color:#a8261b;font-size:13px;margin-top:4px}.b{margin-top:12px;text-align:right}
.b span{display:inline-block;padding:5px 12px;border-radius:8px;background:#ad412c;color:#fff}
</style></head><body><div class="s"><b>Rename team</b><p>New name</p><input value="Relay Reviewers" aria-label="New name">
<div class="e">Another team is already called "Relay Reviewers". Pick a different name.</div><div class="b"><span>Rename</span></div></div>
<script>document.body.textContent = 'scripts ran'</script></body></html>
`;
/**
 * Task attachments for the console (docs/dashboard-ux.md): Hesper briefs a task with two screenshots and a mockup; Vesna
 * hands in a round, Halden asks for changes, and Vesna's second round (a before/after pair, two more screenshots, an
 * SVG and a text file) waits in review. Through the MCP tools, as agents attach.
 */
async function seedAttachments(c, log) {
  if (!['Hesper', 'Vesna', 'Halden'].every((n) => c.seats[n])) { log('  ! no Hesper, Vesna and Halden: no attachments seeded'); return; }
  const H = c.as('Hesper'), J = c.as('Vesna'), N = c.as('Halden');
  const b64 = (buf) => ({ content: buf.toString('base64'), encoding: 'base64' });
  const shot = (path, tint, bars, w = 720, h = 450) => ({ path, ...b64(seedPng(w, h, tint, bars)) });
  const text = [[0.16, 0.4], [0.26, 0.1], [0.36, 0.25], [0.5, 0.5], [0.6, 0.2]];
  const k = (await H.ok('task_create', { team_id: c.T('mh'), title: 'The operator can rename a team from its settings', reviewer: c.A('Halden'),
    description: 'The Rename sheet should check the name and rename the team room too. See the mockup for the sheet and the error states.',
    attachments: [shot('sheet-1440-light.png', [207, 217, 242], text), shot('sheet-error-390-dark.png', [233, 220, 196], text.slice(0, 3), 390, 640), { path: 'rename-sheet.html', ...b64(Buffer.from(SEED_MOCKUP)) }] })).task;
  await H.ok('task_assign', { task_id: k.id, agent_id: c.A('Vesna') });
  await J.ok('task_start', { task_id: k.id });
  const v1 = (await J.ok('task_submit', { task_id: k.id, summary: 'Renaming checks the name and renames the team room. Screenshots at 1440 and 390.',
    attachments: ['settings-1440.png', 'settings-390.png', 'error-1440.png', 'error-390.png'].map((p, i) => shot(p, [[211, 234, 219], [207, 217, 242], [234, 209, 214], [233, 220, 196]][i], text.slice(0, 2 + i))) })).task.version;
  await N.ok('task_review', { task_id: k.id, decision: 'request_changes', comments: 'Show the settings page before and after, and the room once renamed.', version: v1 });
  await J.ok('task_start', { task_id: k.id });
  await J.ok('task_submit', { task_id: k.id, summary: 'Renaming now checks the name (1 to 80 characters, no clash with another team) and renames the team room. Members get a notice.\n\nFive tests added. Screenshots from the local dev hub at 1440 and 390, light and dark.',
    attachments: [shot('before-settings-1440.png', [234, 209, 214], text.slice(0, 2)), shot('after-settings-1440.png', [211, 234, 219], text), shot('error-390-dark.png', [207, 217, 242], text.slice(0, 1), 390, 640),
      shot('room-renamed.png', [233, 220, 196], text.slice(1, 3)), { path: 'diagram.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ad412c"/></svg>' },
      { path: 'test-output.txt', content: ' ✓ test/team-rename.test.ts (5 tests)\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n' }] });
  log('  ✓ task attachments: a brief with a mockup, and two review rounds');
}

/* The seeded members' sign-ins (docs/getting-started.md, Local design review hub): never printed. They go to members.env beside
   hub.env (.dev/ is git-ignored), readable by the owner only, one "username=password" line each; a member still on a setup link
   gets "username.setup_url=<url>". Scripts that sign in as a member read them with readLogins. */
export const LOGINS_FILE = 'members.env';
export function writeLogins(dir, users) {
  const file = join(dir, LOGINS_FILE);
  const lines = users.flatMap((u) => (u.password ? [`${u.username}=${u.password}`] : u.setup_url ? [`${u.username}.setup_url=${u.setup_url}`] : []));
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, ['# Seeded test members of the local dev hub (eval/run.mjs). Never print, copy or share these.', ...lines, ''].join('\n'), { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode otherwise
  return file;
}
export function readLogins(dir) {
  const file = join(dir, LOGINS_FILE);
  if (!existsSync(file)) throw new Error(`No ${file}: seed the local hub first (npm run dev:seed).`);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='));
  return Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

/** The running dev:hub (server/scripts/dev-hub.mjs): .dev/hub.env and .dev/vault. */
function devHub() {
  const dev = join(REPO, '.dev'), envFile = join(dev, 'hub.env');
  if (!existsSync(envFile)) throw new Error('No .dev/hub.env: start the local hub first (npm run dev:hub -- --reset).');
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const base = `http://127.0.0.1:${Number(process.env.HUB_PORT || 8099)}`;
  return { base: assertLocal(base), admin: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }, vaultDir: join(dev, 'vault'), throwaway: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const flag = (name) => args.includes(name);
  const actArg = (v, d) => (v === undefined ? d : Number(v));
  const o = {
    from: actArg(opt('--from'), 0), until: actArg(opt('--until'), 5), pace: parsePace(opt('--pace')),
    actPause: opt('--act-pause') === 'key' ? 'key' : opt('--act-pause'), scale: flag('--scale') || /^(1|true|yes)$/i.test(process.env.SEED_SCALE ?? ''),
    keep: flag('--keep'), extras: flag('--hub') || flag('--keep'), hub: flag('--hub') ? await assertLocalHub(devHub()) : undefined, log: (...m) => console.log(...m),
  };
  if (!(o.from >= 0 && o.until <= 5 && o.from <= o.until)) { console.error('--from and --until take act numbers 0–5, with from ≤ until.'); process.exit(2); }
  const r = await runStory(o);
  console.log(`\n${r.ok ? '✓' : '✗'} ${r.steps}/${r.total} steps in ${r.seconds} s${r.pace ? ` at ${r.pace}x` : ''}. Coverage: ${r.coverage.summary}`);
  if (r.failure) console.error(`✗ step ${r.failure.step}${r.failure.title ? ` (${r.failure.title})` : ''}: ${r.failure.message}`);
  if (!r.coverage.ok && r.coverage.full) for (const m of r.coverage.missing) console.error(`✗ not covered: ${m}`);
  if (r.outDir) console.log(`Report: ${r.outDir}`);
  if (r.seed) {
    // The generated passwords are never printed: they go to members.env beside hub.env, and only where they went is shown.
    const where = writeLogins(r.hub?.root ?? join(REPO, '.dev'), r.seed.users);
    console.log(`\nCollaborators: ${r.seed.users.map((u) => u.username + (u.password || u.setup_url ? '' : ' (password unchanged)') + (u.note ? ` [${u.note}]` : '')).join(', ')}`);
    console.log(`Their sign-ins are in ${where} (not shown here).`);
    const g = r.seed.graph;
    console.log(`Knowledge graph extras: ${g.entities} new entities, ${g.claims} claims, ${g.relations} relations, ${g.flags} flags.`);
    for (const w of r.seed.warnings) console.error(`! seed: ${w}`);
  }
  if (r.hub) console.log(`Hub left running at ${r.hub.base}; console credentials in ${join(r.hub.root, 'hub.env')}. Stop it with Ctrl+C.`);
  if (r.hub) await new Promise(() => {});
  process.exit(r.ok ? 0 : 1);
}
