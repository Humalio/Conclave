// Live layer: real agents (headless Claude Code) against the hub.
// node live.mjs <phase> [--ids a,b] [--limit n]   phases: backfill qa collab impact baseline swap all
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { Hub } from './hub.mjs';
import { runAgent, runWithFeedback, judge, writeMcpConfig, CapReached } from './agent.mjs';
import { tasksOf, tok, RESULTS, writeJson, readJson, ledger, spent, GLOBAL_CAP, sleep } from './lib.mjs';

const PHASE_CAP = { backfill: 3.5, qa: 1.5, collab: 5.0, impact: 2.5, baseline: 2.0, swap: 2.0 };
const CAPS = { haiku: 0.50, sonnet: 1.00 };
const slug = (h) => (h ?? '').toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/ /g, '-');
const strip = (p) => (p ?? '').replace(/^\/vault\//, '');
const f3 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const phaseSpent = (p) => ledger().filter((e) => e.label?.startsWith(`${p}/`)).reduce((s, e) => s + (e.cost ?? 0), 0);
const out = (name) => join(RESULTS, `live-${name}.json`);

const pre = (key, role, model) => `You are a "${role}" agent on Agent Hub (MCP server agent_hub). Your session key is ${key}. First call session_login with it, then session_describe with role "${role}" and model_label "${model}". Pass the session_token on every later call. Never repeat the key.\n\n`;
export const CURATOR = 'Curator loop: call work_next (wait_seconds 0). For each item follow its instructions: a knowledge_job is answered with graph_job_submit (job_id and payload as the item describes; for index_note batches submit each member job), then work_ack the item; ack notices and other items. Handle every job type you are offered. Stop when work_next reports idle twice in a row, or after 60 items. Final answer: jobs done per type, rejected items.';

async function pool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}
const slim = (r) => { const { calls, ...rest } = r; return { ...rest, tool_names: Object.entries(calls.reduce((m, c) => ((m[c.tool] = (m[c.tool] ?? 0) + 1), m), {})) }; };
const usage = (r) => ({ cost: r.cost, turns: r.turns, tool_calls: r.tool_calls, tool_out_tokens: Math.ceil(r.tool_out_bytes / 4), in_tokens: r.input_tokens, out_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, seconds: r.seconds });
const invCount = (hub, since) => { const d = hub.db(); const n = d.prepare('SELECT COUNT(*) n FROM tool_invocations WHERE created_at>=?').get(since).n; d.close(); return n; };
export const gtPaths = (t) => { const s = JSON.stringify(t.ground_truth); return [...s.matchAll(/"(?:path|canonical)":"([^"]+\.md)"/g)].map((m) => m[1]); };

async function ctx(hub) {
  if (!hub.state) throw new Error('no fixture: run backfill first');
  await hub.start();
  return { mcp: writeMcpConfig(hub.state.appKey) };
}

// ───────────────────────── backfill ─────────────────────────
export async function backfill(hub) {
  hub.build();
  await hub.fresh();
  const mcp = writeMcpConfig(hub.state.appKey);
  // lazy coverage: a first file_read enqueues the index job, so read task-relevant notes first
  const all = []; const walk = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === 'Templates') continue; const r = rel ? `${rel}/${e.name}` : e.name; e.isDirectory() ? walk(join(d, e.name), r) : e.name.endsWith('.md') && all.push(r); } };
  walk(Hub.dirs.vault, '');
  const prio = new Set(['impact', 'staleness', 'context_qa', 'entity_merge', 'contradiction', 'summary'].flatMap((c) => tasksOf(c).flatMap(gtPaths)));
  const order = [...all.filter((p) => prio.has(p)), ...all.filter((p) => !prio.has(p))];
  const rd = await hub.session('reader');
  for (const p of order) await rd.call('file_read', { path: `/vault/${p}` });
  await rd.close();
  const res = { notes: all.length, priority_notes: order.filter((p) => prio.has(p)).length, runs: [], stopped: null };
  const pending = async () => { const h = await hub.admin.get('/api/graph/health'); return { h, n: Object.values(h.pending_jobs_by_type ?? {}).reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0) }; };
  let first = true;
  for (let i = 0; i < 12; i++) {
    const p = await pending();
    res.health_before = res.health_before ?? p.h;
    if (p.n === 0) break;
    if (phaseSpent('backfill') >= PHASE_CAP.backfill) { res.stopped = 'phase cap'; break; }
    try {
      const o = { label: `backfill/run${i}`, model: 'haiku', cap: CAPS.haiku, mcp, prompt: pre(hub.key('cur'), 'curator', 'haiku-4.5') + CURATOR, timeoutMs: 15 * 60000 };
      const r = first ? await runWithFeedback(o) : await runAgent(o);   // feedback after the first run and the last one (below)
      first = false; res.runs.push({ ...slim(r), pending_before: p.n }); res._last = r;
    } catch (e) { if (e instanceof CapReached) { res.stopped = 'global cap'; break; } throw e; }
  }
  if (res._last && !res._last.feedback) { const { askFeedback } = await import('./agent.mjs'); res.runs.at(-1).feedback = await askFeedback(res._last, mcp); }
  delete res._last;
  const fin = await pending();
  res.health_after = fin.h; res.pending_after = fin.n; res.spend = phaseSpent('backfill');
  res.entities = await mergeScore(hub);
  await hub.snapshot();
  writeJson(out('backfill'), res);
  return res;
}

/** Entity merge scoring from the hub's entity table after the curators ran. */
export async function mergeScore(hub) {
  const ents = (await hub.admin.get('/api/graph/entities?q=&limit=200')).entities ?? [];
  const find = (text) => ents.find((e) => e.name.toLowerCase() === text.toLowerCase() || (e.aliases ?? []).some((a) => a.toLowerCase() === text.toLowerCase()));
  const nameOf = (p) => p.split('/').pop().replace(/\.md$/, '');
  let mentions = 0, merged = 0, apart = 0, apartBad = 0;
  const rows = [];
  for (const t of tasksOf('entity_merge')) {
    for (const g of t.ground_truth.merge) {
      const canon = find(nameOf(g.canonical));
      for (const m of g.mentions) {
        mentions++;
        const txt = m.text.replace(/\[\[([^\]|\\]*)(?:\\?\|([^\]]*))?\]\]/g, (_, a, b) => b ?? a).replace(/["']/g, '');
        const e = find(txt);
        const ok = !!canon && !!e && (e.id === canon.id || e.merged_into === canon.id || canon.merged_into === e.id);
        if (ok) merged++; rows.push({ task: t.id, canonical: g.canonical, mention: txt, resolved_to_canonical: ok, found_entity: !!e });
      }
    }
    for (const k of t.ground_truth.keep_apart ?? []) {
      const a = find(nameOf(k.a.path)), b = find(nameOf(k.b.path));
      if (!a || !b) continue;
      apart++;
      if (a.id === b.id || a.merged_into === b.id || b.merged_into === a.id) apartBad++;
    }
  }
  return { entities: ents.length, mentions, mention_recall: f3(mentions ? merged / mentions : null), keep_apart_checked: apart, keep_apart_merged: apartBad, merge_precision: apart ? f3(1 - apartBad / apart) : null, rows };
}

// ───────────────────────── context_qa ─────────────────────────
async function qaOne(hub, mcp, t, mode) {
  const gt = t.ground_truth, restricted = gt.key === 'restricted';
  const base = mode === 'baseline';
  const keyName = base ? (restricted ? 'base_r' : 'base') : (restricted ? 'qa_r' : 'qa');
  const how = base ? 'Use only file_search, file_list and file_read to find the answer.' : `Use graph_context first (budget_tokens ${gt.budget_tokens}); read a cited section with file_read only when you need to verify.`;
  const prompt = pre(hub.key(keyName), 'analyst', 'sonnet') + `Question: ${t.prompt}\n${how} If the notes you may read do not contain the answer, say so. Final answer: the answer only, one or two sentences.`;
  const r = await runWithFeedback({ label: `${mode === 'baseline' ? 'baseline' : 'qa'}/${t.id}`, model: 'sonnet', cap: CAPS.sonnet, mcp, prompt, timeoutMs: 8 * 60000,
    disallow: base ? ['mcp__agent_hub__graph_*'] : [], allow: base ? ['mcp__agent_hub__session_*', 'mcp__agent_hub__file_*'] : ['mcp__agent_hub__*'] });
  const ans = r.final || '';
  const low = ans.toLowerCase();
  const must = (gt.answer_must_contain ?? []).every((x) => low.includes(x.toLowerCase()));
  const mustNot = (gt.answer_must_not_contain ?? []).some((x) => low.includes(x.toLowerCase()));
  const everything = r._full.map((x) => x.text).join('\n') + '\n' + ans;
  const leak = restricted && (/Private\//.test(r._full.filter((x) => x.tool !== 'session_login').map((x) => x.text).join('\n')) || (gt.forbidden_sources ?? []).some((p) => everything.includes(p)) || mustNot);
  const packs = r._full.filter((x) => x.tool === 'graph_context').map((x) => tok(x.text));
  const read = (gt.sources ?? []).map((s) => s.path);
  const sourceRecall = read.length ? read.filter((p) => everything.includes(p)).length / read.length : null;
  let j = { correct: null };
  if (ans) { try { j = await judge(t.prompt, gt.answer, ans); } catch (e) { if (e instanceof CapReached) j = { correct: null, reason: 'cap' }; else throw e; } }
  return { id: t.id, mode, key: gt.key, difficulty: t.difficulty, answer: ans.slice(0, 600), exact_match: must && !mustNot, semantic_correct: j.correct, judge_reason: j.reason, private_leak: leak,
    pack_tokens: packs[0] ?? null, pack_within_budget: packs.length ? packs.every((p) => p <= gt.budget_tokens) : null, source_recall: f3(sourceRecall),
    naive_tokens_est: t.cost.naive_tokens_est, best_case_tokens_est: t.cost.best_case_tokens_est, ...usage(r), error: r.error, feedback: r.feedback };
}
export async function qa(hub, mode = 'graph', ids = null) {
  const { mcp } = await ctx(hub);
  const phase = mode === 'baseline' ? 'baseline' : 'qa';
  const tasks = tasksOf('context_qa').filter((t) => !ids || ids.includes(t.id));
  const res = { mode, tasks: [], stopped: null };
  await pool(tasks, 3, async (t) => {
    if (res.stopped) return;
    if (phaseSpent(phase) >= PHASE_CAP[phase]) { res.stopped = 'phase cap'; return; }
    try { res.tasks.push(await qaOne(hub, mcp, t, mode)); } catch (e) { if (e instanceof CapReached) res.stopped = 'global cap'; else res.tasks.push({ id: t.id, error: String(e.message) }); }
  });
  res.tasks.sort((a, b) => a.id.localeCompare(b.id));
  res.spend = phaseSpent(phase);
  writeJson(out(phase), res);
  return res;
}

// ───────────────────────── impact / staleness (curator runs) ─────────────────────────
export function scoreFlags(flags, gtItems, okItems = [], mustNot = [], ambiguous = []) {
  const fl = flags.map((f) => ({ path: strip(f.path), anchor: f.anchor || '', verdict: f.kind === 'contradiction' ? 'contradicts' : 'stale' }));
  const hitSec = (g, f) => f.path === g.path && (f.anchor === '' || g.section === 'frontmatter' || !g.section || f.anchor === slug(g.section));
  const hit = (g) => fl.some((f) => hitSec(g, f) && (!g.verdict || g.verdict === f.verdict));
  const hitPath = (g) => fl.some((f) => f.path === g.path);
  const amb = new Set(ambiguous.map((a) => a.path));
  const scored = fl.filter((f) => !amb.has(f.path));
  const tp = gtItems.filter(hit);
  const goodFlags = scored.filter((f) => gtItems.some((g) => hitSec(g, f) && (!g.verdict || g.verdict === f.verdict)));
  const p = scored.length ? goodFlags.length / scored.length : null, r = gtItems.length ? tp.length / gtItems.length : null;
  const k = (d) => { const s = gtItems.filter((g) => g.detect === d); return s.length ? s.filter(hit).length / s.length : null; };
  return { flagged: fl.length, precision: f3(p), recall: f3(r), f1: f3(p != null && r != null && p + r ? (2 * p * r) / (p + r) : 0), recall_path: f3(gtItems.length ? gtItems.filter(hitPath).length / gtItems.length : null),
    recall_k1: f3(k('K1')), recall_k3: f3(k('K3')), must_not_violations: scored.filter((f) => mustNot.some((m) => m.path === f.path)).map((f) => f.path),
    ok_flagged: scored.filter((f) => okItems.some((o) => o.path === f.path)).length, missed: gtItems.filter((g) => !hit(g)).map((g) => `${g.path}#${g.section}`) };
}
async function curatorTask(hub, mcp, cat, t, model, tag) {
  await hub.restore();
  await hub.applySetup(t.setup);
  const r = await runWithFeedback({ label: `${tag}/${t.id}`, model, cap: CAPS[model], mcp, prompt: pre(hub.key('cur'), 'curator', `${model}-4.5`) + CURATOR, timeoutMs: 10 * 60000 });
  const flags = (await hub.admin.get('/api/graph/flags?limit=500')).flags ?? [];
  const gt = t.ground_truth;
  const sc = cat === 'impact' ? scoreFlags(flags, gt.affected ?? [], gt.ok_candidates ?? [], gt.must_not_flag ?? [], gt.ambiguous ?? [])
    : scoreFlags(flags, (gt.stale ?? []).map((s) => ({ ...s, verdict: null })), gt.still_correct ?? [], gt.still_correct ?? [], gt.ambiguous ?? []);
  const jobs = (await hub.admin.get('/api/graph/jobs?limit=500')).jobs ?? [];
  const byType = jobs.reduce((m, j) => ((m[`${j.type}:${j.state}`] = (m[`${j.type}:${j.state}`] ?? 0) + 1), m), {});
  return { id: t.id, category: cat, model, ...sc, jobs: byType, flags_raw: flags.map((f) => ({ path: f.path, anchor: f.anchor, kind: f.kind, reason: String(f.reason ?? '').slice(0, 160) })), ...usage(r), curator_tokens: r.input_tokens + r.output_tokens, error: r.error, feedback: r.feedback };
}
export async function impact(hub, { model = 'haiku', ids = null, tag = 'impact', phase = 'impact', file = 'impact' } = {}) {
  const { mcp } = await ctx(hub);
  const tasks = [...tasksOf('impact').map((t) => ['impact', t]), ...tasksOf('staleness').map((t) => ['staleness', t])].filter(([, t]) => !ids || ids.includes(t.id));
  const res = { model, tasks: [], stopped: null };
  for (const [cat, t] of tasks) {
    if (phaseSpent(phase) >= PHASE_CAP[phase]) { res.stopped = 'phase cap'; break; }
    try { res.tasks.push(await curatorTask(hub, mcp, cat, t, model, tag)); } catch (e) { if (e instanceof CapReached) { res.stopped = 'global cap'; break; } res.tasks.push({ id: t.id, error: String(e.message) }); }
    writeJson(out(file), res);
  }
  res.spend = phaseSpent(phase);
  writeJson(out(file), res);
  return res;
}
export const SWAP_IDS = ['impact-01', 'impact-02', 'impact-03', 'impact-05', 'impact-07', 'stale-01', 'stale-02', 'stale-03'];
export const swap = (hub) => impact(hub, { model: 'sonnet', ids: SWAP_IDS, tag: 'swap', phase: 'swap', file: 'swap' });

// ───────────────────────── collab ─────────────────────────
export async function check(hub, c, runs, t0, ids) {
  const db = hub.db();
  const id = (w) => ids[w];
  const finalOf = (w) => (runs.find((r) => r.who === w)?.run.final ?? '');
  try {
    switch (c.op) {
      case 'vault': {
        const p = hub.vaultPath(c.path);
        if (!existsSync(p)) return { ok: false, why: `missing ${c.path}` };
        const s = readFileSync(p, 'utf8');
        const miss = (c.contains ?? []).filter((x) => !s.includes(x)), bad = (c.not_contains ?? []).filter((x) => s.includes(x));
        return { ok: !miss.length && !bad.length, why: miss.length ? `${c.path} lacks ${JSON.stringify(miss)}` : bad.length ? `${c.path} still has ${JSON.stringify(bad)}` : `${c.path} ok` };
      }
      case 'message': {
        const rows = db.prepare("SELECT m.body FROM messages m WHERE m.sender_agent_id=? AND m.created_at>=? AND m.room_id IN (SELECT room_id FROM room_memberships WHERE agent_id=?)").all(id(c.from), t0, id(c.to));
        const okRows = rows.filter((r) => (c.contains ?? []).every((x) => r.body.toLowerCase().includes(x.toLowerCase())));
        return { ok: okRows.length >= (c.min ?? 1), why: `${okRows.length}/${rows.length} messages ${c.from}->${c.to} match` };
      }
      case 'message_count': {
        const n = db.prepare('SELECT COUNT(*) n FROM messages WHERE sender_agent_id=? AND created_at>=? AND body LIKE ?').get(id(c.from), t0, `%${c.body_like}%`).n;
        return { ok: n === c.exactly, why: `${n} stored messages (want ${c.exactly})` };
      }
      case 'final': {
        const s = finalOf(c.who).toLowerCase();
        const miss = (c.contains ?? []).filter((x) => !s.includes(x.toLowerCase())), bad = (c.not_contains ?? []).filter((x) => s.includes(x.toLowerCase()));
        return { ok: !miss.length && !bad.length, why: miss.length ? `${c.who} final lacks ${JSON.stringify(miss)}` : bad.length ? `${c.who} final has ${JSON.stringify(bad)}` : 'ok' };
      }
      case 'task': {
        const rows = db.prepare('SELECT * FROM tasks WHERE title LIKE ? AND created_at>=?').all(`%${c.title_like}%`, t0);
        const tk = rows[0];
        if (!tk) return { ok: false, why: 'no such task' };
        const problems = [];
        if (!c.status.includes(tk.status)) problems.push(`status ${tk.status}`);
        if (c.assignee && tk.assignee_agent_id !== id(c.assignee)) problems.push('wrong assignee');
        if (c.reviewer && tk.reviewer_agent_id !== id(c.reviewer)) problems.push('wrong reviewer');
        if (tk.reviewer_agent_id && tk.reviewer_agent_id === tk.assignee_agent_id) problems.push('reviewer = submitter');
        if (c.min_changes_requested) { const n = db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND to_status='changes_requested'").get(tk.id).n; if (n < c.min_changes_requested) problems.push(`changes_requested ${n}`); }
        return { ok: !problems.length, why: problems.length ? problems.join(', ') : `task ${tk.status}, rounds ${tk.review_rounds}` };
      }
      case 'invocation': {
        const n = db.prepare('SELECT COUNT(*) n FROM tool_invocations WHERE tool=? AND (result=? OR error_code=?) AND created_at>=?').get(c.tool, c.result, c.result, t0).n;
        return { ok: n >= c.min, why: `${n} ${c.tool} calls with result ${c.result}` };
      }
      case 'share': {
        const v = db.prepare("SELECT COUNT(*) n FROM share_versions WHERE status='published' AND created_at>=?").get(t0).n;
        const cm = db.prepare("SELECT COUNT(*) n FROM share_feedback WHERE kind='comment' AND created_at>=?").get(t0).n;
        return { ok: v >= c.min_versions && cm >= c.min_comments, why: `${v} published versions, ${cm} comments` };
      }
      case 'no_leak': {
        const r = runs.find((x) => x.who === c.who).run;
        const texts = r._full.filter((x) => x.tool !== 'session_login').map((x) => x.text).join('\n') + '\n' + r.final;
        const hits = c.patterns.filter((p) => texts.includes(p));
        return { ok: !hits.length, why: hits.length ? `leaked ${JSON.stringify(hits)}` : 'no forbidden text in tool results or answer' };
      }
      case 'flag': {
        const fl = (await hub.admin.get('/api/graph/flags?limit=500')).flags.filter((f) => strip(f.path) === c.path);
        return { ok: fl.some((f) => c.status.includes(f.status)), why: fl.length ? `flags: ${fl.map((f) => f.status).join(',')}` : 'no flag raised' };
      }
      default: return { ok: false, why: `unknown check ${c.op}` };
    }
  } finally { db.close(); }
}
export async function collab(hub, ids = null) {
  const { mcp } = await ctx(hub);
  const res = { tasks: [], stopped: null };
  for (const t of tasksOf('collab').filter((x) => !ids || ids.includes(x.id))) {
    if (phaseSpent('collab') >= PHASE_CAP.collab) { res.stopped = 'phase cap'; break; }
    try {
      await hub.restore();
      for (const op of t.setup) await hub.applySetup([op], op.who ?? 'setup');
      const aid = { A: hub.agentId('coord'), B: hub.agentId('wrk'), R: hub.agentId('rev'), C: hub.agentId('cur') };
      const idsByRole = { coord: aid.A, wrk: aid.B, rev: aid.R, cur: aid.C };
      const t0 = Date.now() - 1000;
      const inv0 = invCount(hub, t0);
      const sub = (s) => s.replace(/\{([ABRC])\}/g, (_, k) => aid[k]).replace('{TEAM}', hub.state.teamId);
      const runs = await Promise.all(t.agents.map(async (a) => {
        const prompt = pre(hub.key(a.who), a.role, `${a.model}-4.5`) + `Team id: ${hub.state.teamId}. Agent ids: coordinator ${aid.A}, worker ${aid.B}, reviewer ${aid.R}, curator ${aid.C}. Do not take actions beyond your task.\n\n` + sub(a.prompt);
        const run = await runAgent({ label: `collab/${t.id}/${a.who}`, model: a.model, cap: CAPS[a.model], mcp, prompt, timeoutMs: t.timeout_s * 1000 });
        return { who: a.who, run };
      }));
      const tools = db_tool_counts(hub, t0);
      const results = [];
      for (const c of t.checks) results.push({ ...c, ...(await check(hub, c, runs, t0, idsByRole)) });
      const agents = [];
      for (const r of runs) { const { askFeedback } = await import('./agent.mjs'); r.run.feedback = await askFeedback(r.run, mcp); agents.push({ who: r.who, ...slim(r.run), feedback: r.run.feedback, final: r.run.final.slice(0, 500) }); }
      res.tasks.push({ id: t.id, title: t.title, pass: results.every((x) => x.ok), checks: results.map((x) => ({ op: x.op, ok: x.ok, why: x.why })), agents, hub_tool_calls: invCount(hub, t0) - inv0, hub_tools: tools, cost: agents.reduce((s, a) => s + a.cost + (a.feedback?.cost ?? 0), 0) });
    } catch (e) { if (e instanceof CapReached) { res.stopped = 'global cap'; break; } res.tasks.push({ id: t.id, pass: false, error: String(e.stack ?? e).slice(0, 400) }); }
    writeJson(out('collab'), res);
  }
  res.spend = phaseSpent('collab');
  writeJson(out('collab'), res);
  return res;
}
function db_tool_counts(hub, since) {
  const d = hub.db();
  const rows = d.prepare('SELECT tool, result, COUNT(*) n FROM tool_invocations WHERE created_at>=? GROUP BY tool, result').all(since);
  d.close();
  return rows.map((r) => `${r.tool}:${r.result}=${r.n}`);
}

// ───────────────────────── CLI ─────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [phase = 'all', ...rest] = process.argv.slice(2);
  const arg = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
  const ids = arg('--ids')?.split(',') ?? null;
  const hub = new Hub();
  const step = async (name, fn) => { console.log(`[${new Date().toISOString().slice(11, 19)}] ${name} (spent $${spent().toFixed(2)})`); try { await fn(); } catch (e) { console.log(`${name} failed: ${e.message}`); } };
  try {
    if (phase === 'backfill' || phase === 'all') await step('backfill', () => backfill(hub));
    if (phase === 'qa' || phase === 'all') await step('qa', () => qa(hub, 'graph', ids));
    if (phase === 'collab' || phase === 'all') await step('collab', () => collab(hub, ids));
    if (phase === 'impact' || phase === 'all') await step('impact', () => impact(hub, { ids }));
    if (phase === 'baseline' || phase === 'all') await step('baseline', () => qa(hub, 'baseline', ids));
    if (phase === 'swap' || phase === 'all') await step('swap', () => swap(hub));
    if (phase === 'post') { const { detPost } = await import('./det.mjs'); await hub.start(); writeJson(join(RESULTS, 'det-post.json'), await detPost(hub)); }
  } finally { await hub.stop(); }
  console.log(`done, total spend $${spent().toFixed(2)} of $${GLOBAL_CAP}`);
}
void sleep; void readJson;
