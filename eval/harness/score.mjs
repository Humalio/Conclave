// node score.mjs <task-id|category> [--answers <file>]
// Scores from hub state (+ answers JSON: {"<task-id>": "answer"} for QA/summary, {"<role>": "final answer"} for collab).
// Appends to the local results directory and prints one line.
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Hub, ROLES, ROLES_DIR } from './hub.mjs';
import { Admin, tasksOf, RESULTS, readJson, writeJson, BASE } from './lib.mjs';
import { scoreFlags, check, mergeScore } from './live.mjs';

const CATS = ['impact', 'staleness', 'context_qa', 'entity_merge', 'contradiction', 'summary', 'collab'];
const [target, ...rest] = process.argv.slice(2);
if (!target) { console.error('usage: score.mjs <task-id|category> [--answers <file>]'); process.exit(2); }
const ai = rest.indexOf('--answers');
const answers = ai >= 0 ? JSON.parse(readFileSync(rest[ai + 1], 'utf8')) : {};
const f3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const hub = new Hub();
hub.admin = await new Admin(hub.state.adminUser, hub.state.adminPass).login();
const all = CATS.flatMap((c) => tasksOf(c).map((t) => ({ ...t, category: t.category ?? c })));
const tasks = CATS.includes(target) ? all.filter((t) => t.category === target) : all.filter((t) => t.id === target);
if (!tasks.length) { console.error('unknown task or category'); process.exit(2); }

// usage per role: calls and result bytes (call.mjs log) + hub-side invocation count
const usage = {};
for (const role of Object.keys(ROLES)) {
  const f = join(ROLES_DIR, `${role}.usage.jsonl`);
  const rows = existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const meta = readJson(join(ROLES_DIR, `${role}.json`), null);
  const d = hub.db();
  const inv = meta ? d.prepare('SELECT COUNT(*) n FROM tool_invocations WHERE credential_id=? AND created_at>=?').get(meta.cred_id, hub.state.started ?? 0).n : 0;
  d.close();
  if (rows.length || inv) usage[role] = { calls: rows.length, errors: rows.filter((r) => r.error).length, result_bytes: rows.reduce((s, r) => s + r.bytes, 0), result_tokens_est: Math.ceil(rows.reduce((s, r) => s + r.bytes, 0) / 4), hub_invocations: inv };
}

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const recs = [];
for (const t of tasks) {
  const gt = t.ground_truth ?? {};
  let r = { id: t.id, category: t.category };
  if (t.category === 'impact' || t.category === 'staleness') {
    const flags = (await hub.admin.get('/api/graph/flags?limit=500')).flags ?? [];
    r = { ...r, ...(t.category === 'impact' ? scoreFlags(flags, gt.affected ?? [], gt.ok_candidates ?? [], gt.must_not_flag ?? [], gt.ambiguous ?? [])
      : scoreFlags(flags, (gt.stale ?? []).map((s) => ({ ...s, verdict: null })), gt.still_correct ?? [], gt.still_correct ?? [], gt.ambiguous ?? [])) };
  } else if (t.category === 'context_qa') {
    const a = String(answers[t.id] ?? ''), low = a.toLowerCase();
    const must = (gt.answer_must_contain ?? []).filter((x) => !low.includes(x.toLowerCase()));
    const bad = (gt.answer_must_not_contain ?? []).filter((x) => low.includes(x.toLowerCase()));
    const forb = (gt.forbidden_sources ?? []).filter((p) => a.includes(p));
    r = { ...r, key: gt.key, answered: !!a, exact_match: !!a && !must.length && !bad.length, missing: must, forbidden_found: bad, private_leak: gt.key === 'restricted' && (bad.length > 0 || forb.length > 0), semantic_correct: null, answer: a.slice(0, 300), reference: gt.answer };
  } else if (t.category === 'entity_merge') {
    const m = await mergeScore(hub); delete m.rows; r = { ...r, ...m };
  } else if (t.category === 'contradiction') {
    const flags = ((await hub.admin.get('/api/graph/flags?limit=500')).flags ?? []).filter((f) => f.kind === 'contradiction').map((f) => f.path?.replace(/^\/vault\//, ''));
    const paths = (gt.claims ?? []).map((c) => c.path);
    r = { ...r, claims: paths.length, claims_flagged: paths.filter((p) => flags.includes(p)).length, detected: paths.length > 0 && paths.every((p) => flags.includes(p)), false_flags: t.id === 'contra-08' ? flags.length : null };
  } else if (t.category === 'summary') {
    const a = String(answers[t.id] ?? ''), low = a.toLowerCase();
    // heuristic: a fact counts when every number/currency token in its text appears in the summary
    const covered = (gt.required_facts ?? []).filter((f) => { const nums = (f.fact.match(/[€\d][\d.,%€]*/g) ?? []); return nums.length ? nums.every((n) => low.includes(n.toLowerCase())) : f.fact.toLowerCase().split(/\W+/).filter((w) => w.length > 4).slice(0, 3).every((w) => low.includes(w)); });
    r = { ...r, answered: !!a, required_coverage: f3(gt.required_facts?.length ? covered.length / gt.required_facts.length : null), words: words(a), within_words: words(a) <= (gt.max_words ?? 1e9), must_not_violations: (gt.must_not_state ?? []).filter((x) => low.includes(String(x).toLowerCase())).length, scoring: 'heuristic numbers/keywords, review manually' };
  } else if (t.category === 'collab') {
    const norm = { worker2: 'coord', worker: 'wrk', reviewer: 'rev', curator: 'cur', restricted: 'qa_r' };
    const runs = Object.entries(answers).map(([k, v]) => ({ who: norm[k] ?? k, run: { final: String(v), _full: [] } }));
    const ids = { coord: hub.agentId('coord'), wrk: hub.agentId('wrk'), rev: hub.agentId('rev'), cur: hub.agentId('cur') };
    const res = [];
    for (const c of t.checks) { try { res.push({ op: c.op, ...(await check(hub, c, runs, hub.state.started ?? 0, ids)) }); } catch (e) { res.push({ op: c.op, ok: false, why: String(e.message) }); } }
    r = { ...r, pass: res.every((x) => x.ok), checks: res.map((x) => `${x.ok ? 'ok' : 'FAIL'} ${x.op}: ${x.why}`) };
  }
  recs.push(r);
}
const file = join(RESULTS, `subagent-${new Date().toISOString().slice(0, 10)}.json`);
const prev = readJson(file, []);
const rec = { at: new Date().toISOString(), target, results: recs, usage };
prev.push(rec); writeJson(file, prev);
const one = (r) => r.category === 'collab' ? `${r.id} ${r.pass ? 'PASS' : 'FAIL'} ${r.checks.filter((c) => c.startsWith('FAIL')).join('; ')}`
  : r.category === 'context_qa' ? `${r.id} exact=${r.exact_match} leak=${r.private_leak}${r.missing?.length ? ` missing=${r.missing}` : ''}`
  : r.category === 'summary' ? `${r.id} coverage=${r.required_coverage} words=${r.words}`
  : r.category === 'entity_merge' ? `${r.id} mention_recall=${r.mention_recall} merge_precision=${r.merge_precision} entities=${r.entities}`
  : r.category === 'contradiction' ? `${r.id} detected=${r.detected} flagged=${r.claims_flagged}/${r.claims}`
  : `${r.id} P=${r.precision} R=${r.recall} F1=${r.f1} flagged=${r.flagged} must_not=${r.must_not_violations?.length} recall_k1=${r.recall_k1} recall_k3=${r.recall_k3}`;
const u = Object.entries(usage).map(([k, v]) => `${k}:${v.calls}calls/${v.result_tokens_est}tok`).join(' ');
console.log(recs.map(one).join(' | ') + (u ? ` || ${u}` : ''));
void BASE;
