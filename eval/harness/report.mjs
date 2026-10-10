// Builds a report from the local evaluation results.
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RESULTS, ledger, spent, GLOBAL_CAP } from './lib.mjs';

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const J = (n) => (existsSync(join(RESULTS, n)) ? JSON.parse(readFileSync(join(RESULTS, n), 'utf8')) : null);
const pre = J('det-pre.json'), post = J('det-post.json'), bf = J('live-backfill.json'), qa = J('live-qa.json'), base = J('live-baseline.json'), imp = J('live-impact.json'), swp = J('live-swap.json'), col = J('live-collab.json');
const mean = (a) => { a = a.filter((x) => typeof x === 'number'); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const sum = (a, k) => a.reduce((s, x) => s + (x[k] ?? 0), 0);
const fx = (x, d = 3) => (x == null ? 'n/a' : typeof x === 'number' ? String(Math.round(x * 10 ** d) / 10 ** d) : String(x));
const table = (head, rows) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map((r) => `| ${r.map((c) => fx(c)).join(' | ')} |`).join('\n')}\n`;
const L = [];
const h = (t) => L.push(`\n## ${t}\n`);
L.push(`# Agent Hub eval results, ${date}\n`);

h('Run status');
const led = ledger();
L.push(table(['item', 'value'], [
  ['total spend USD', `${spent().toFixed(2)} of ${GLOBAL_CAP}`], ['agent runs', led.length], ['live layer ran', bf || qa || col || imp ? 'yes' : 'NO (see Blockers)'],
  ['backfill', bf ? `coverage ${bf.health_after?.coverage_pct ?? '?'}%, pending ${bf.pending_after}, ${bf.runs.length} Haiku runs, $${fx(bf.spend, 2)}${bf.stopped ? `, stopped: ${bf.stopped}` : ''}` : 'not run']]));
if (!(bf || qa || col || imp)) {
  L.push('\n**Blockers**\n');
  L.push('- `claude -p` reports `Failed to authenticate: OAuth session expired and could not be refreshed` (`claude auth status`: loggedIn false) when started from the harness session, so no model call could be made. Fix: run `claude auth login` (or export `ANTHROPIC_API_KEY`) in the shell that starts the harness, then `node eval/harness/live.mjs all`, then `node eval/harness/report.mjs`.\n- Everything below the deterministic layer is the plumbing verified with `harness/stub-claude.mjs` (no model): fixture, key/team setup, process runner, transcript parsing, check evaluation, ledger and cap.\n');
}

h('Deterministic layer (no model)');
if (pre) {
  const s = pre.summary;
  L.push(table(['metric', 'value'], [
    ['impact candidate recall, path (affected + ok_candidates)', s.impact_candidate_recall_path], ['impact candidate recall, path#section', s.impact_candidate_recall_section],
    ['impact candidate recall, K1 items', s.impact_recall_K1], ['impact candidate recall, K3 items', s.impact_recall_K3], ['impact recall over affected only, path', s.impact_affected_recall],
    ['impact candidate precision, path', s.impact_candidate_precision_path], ['must_not_flag notes among candidates (all 14 tasks)', s.impact_must_not_in_candidates],
    ['graph_impact result tokens / naive vault tokens', s.impact_tokens_vs_naive], ['staleness candidate recall, path', s.staleness_candidate_recall_path], ['staleness candidate recall, path#section', s.staleness_candidate_recall_section],
    ['entity merge name-rule recall (similarNames on canonical vs mention)', s.merge_name_rule_recall], ['keep_apart pairs proposed by name rule / total', `${s.merge_keep_apart_proposed} / ${s.merge_keep_apart_total}`]]));
  L.push('\nImpact per task\n');
  L.push(table(['task', 'cands', 'recall path', 'recall K1', 'recall K3', 'must_not hit', 'tokens', 'naive', 'missed (first 3)'], pre.impact.map((x) => [x.id, x.candidates, x.recall_path, x.recall_k1, x.recall_k3, x.must_not_in_candidates.length, x.tokens, x.naive, x.missed.slice(0, 3).join('; ')])));
  L.push('\nStaleness per task\n');
  L.push(table(['task', 'cands', 'recall path', 'recall section', 'still_correct among cands', 'tokens', 'missed (first 3)'], pre.staleness.map((x) => [x.id, x.candidates, x.recall_path, x.recall_section, `${x.still_correct_in_candidates}/${x.still_correct_total}`, x.tokens, x.missed.slice(0, 3).join('; ')])));
} else L.push('not run');
if (post) {
  const s = post.summary;
  L.push('\ngraph_context without a model (after backfill)\n');
  L.push(table(['metric', 'value'], [['mean pack tokens', s.pack_tokens_mean], ['pack tokens / naive', s.pack_vs_naive], ['all within budget', s.all_within_budget], ['Private leaks (restricted key)', s.private_leaks], ['source recall in pack', s.source_recall_mean], ['answer_must_contain found in pack', s.must_contain_in_pack_mean]]));
}

const qaRows = (r) => (r?.tasks ?? []).filter((x) => !x.error);
const agg = (r) => { const t = qaRows(r); return { n: t.length, exact: mean(t.map((x) => +x.exact_match)), sem: mean(t.map((x) => (x.semantic_correct == null ? null : +x.semantic_correct))), leaks: t.filter((x) => x.private_leak).length, src: mean(t.map((x) => x.source_recall)), pack: mean(t.map((x) => x.pack_tokens)),
  readTok: mean(t.map((x) => x.tool_out_tokens)), calls: mean(t.map((x) => x.tool_calls)), cost: mean(t.map((x) => x.cost)), total: sum(t, 'cost'), outTok: mean(t.map((x) => x.out_tokens)), secs: mean(t.map((x) => x.seconds)) }; };

h('context_qa: graph tools vs file-tools baseline (Sonnet)');
if (qa) {
  const a = agg(qa), b = base ? agg(base) : null;
  L.push(table(['metric', 'graph', 'baseline (file tools only)'], [
    ['tasks run', a.n, b?.n], ['exact match (must_contain / must_not)', a.exact, b?.exact], ['semantic correctness (Sonnet judge)', a.sem, b?.sem], ['Private leaks (hard fail)', a.leaks, b?.leaks], ['source recall', a.src, b?.src],
    ['mean graph_context pack tokens', a.pack, 'n/a'], ['mean tool-result tokens read by the agent', a.readTok, b?.readTok], ['mean tool calls', a.calls, b?.calls], ['mean cost USD', a.cost, b?.cost], ['total cost USD', a.total, b?.total], ['mean seconds', a.secs, b?.secs]]));
  L.push('\nPer task\n');
  L.push(table(['task', 'key', 'graph exact', 'graph semantic', 'graph tool tokens', 'graph $', 'base exact', 'base semantic', 'base tool tokens', 'base $', 'best case', 'naive'],
    qaRows(qa).map((x) => { const y = qaRows(base).find((z) => z.id === x.id); return [x.id, x.key, x.exact_match, x.semantic_correct, x.tool_out_tokens, x.cost, y?.exact_match, y?.semantic_correct, y?.tool_out_tokens, y?.cost, x.best_case_tokens_est, x.naive_tokens_est]; })));
} else L.push('not run');

const cur = (r) => { const t = (r?.tasks ?? []).filter((x) => !x.error); return t; };
const catRows = (r, cat) => cur(r).filter((x) => x.category === cat);
h('Curator runs: impact and staleness (Haiku)');
if (imp) {
  const I = catRows(imp, 'impact'), S = catRows(imp, 'staleness');
  L.push(table(['metric', 'impact', 'staleness'], [
    ['tasks', I.length, S.length], ['flag precision', mean(I.map((x) => x.precision)), mean(S.map((x) => x.precision))], ['flag recall (path#section, verdict)', mean(I.map((x) => x.recall)), mean(S.map((x) => x.recall))],
    ['F1', mean(I.map((x) => x.f1)), mean(S.map((x) => x.f1))], ['recall, path only', mean(I.map((x) => x.recall_path)), mean(S.map((x) => x.recall_path))], ['recall K1 items', mean(I.map((x) => x.recall_k1)), 'n/a'], ['recall K3 items', mean(I.map((x) => x.recall_k3)), 'n/a'],
    ['must_not / still_correct flagged', sum(I.map((x) => ({ n: x.must_not_violations.length })), 'n'), sum(S.map((x) => ({ n: x.must_not_violations.length })), 'n')], ['ok_candidates flagged (false positives)', sum(I, 'ok_flagged'), 'n/a'],
    ['mean curator cost USD / task', mean(I.map((x) => x.cost)), mean(S.map((x) => x.cost))], ['mean curator tokens (in+out, uncached) / task', mean(I.map((x) => x.curator_tokens)), mean(S.map((x) => x.curator_tokens))]]));
  L.push('\nPer task\n');
  L.push(table(['task', 'flagged', 'precision', 'recall', 'F1', 'cost', 'jobs', 'missed (first 3)'], cur(imp).map((x) => [x.id, x.flagged, x.precision, x.recall, x.f1, x.cost, Object.entries(x.jobs ?? {}).map(([k, v]) => `${k}=${v}`).join(' '), x.missed.slice(0, 3).join('; ')])));
} else L.push('not run');
h('Entity merge (after backfill, from the hub entity table)');
if (bf?.entities) { const e = bf.entities; L.push(table(['metric', 'value'], [['entities in hub', e.entities], ['mention recall (resolved to canonical)', e.mention_recall], ['merge precision (keep_apart pairs not merged)', e.merge_precision], ['keep_apart pairs checkable / merged', `${e.keep_apart_checked} / ${e.keep_apart_merged}`]])); } else L.push('not run');
h('Curator swap: Sonnet on the impact + staleness subset');
if (swp && imp) {
  const ids = cur(swp).map((x) => x.id);
  const pick = (r, id) => cur(r).find((x) => x.id === id);
  L.push(table(['task', 'Haiku F1', 'Sonnet F1', 'Haiku recall', 'Sonnet recall', 'Haiku $', 'Sonnet $'], ids.map((id) => [id, pick(imp, id)?.f1, pick(swp, id)?.f1, pick(imp, id)?.recall, pick(swp, id)?.recall, pick(imp, id)?.cost, pick(swp, id)?.cost])));
  L.push(`\nmean F1 Haiku ${fx(mean(ids.map((i) => pick(imp, i)?.f1)))} vs Sonnet ${fx(mean(cur(swp).map((x) => x.f1)))}; cost per task Haiku ${fx(mean(ids.map((i) => pick(imp, i)?.cost)))} vs Sonnet ${fx(mean(cur(swp).map((x) => x.cost)))}\n`);
} else L.push('not run');

h('Collaboration tasks (ground truth from hub DB / vault)');
if (col) {
  L.push(table(['task', 'result', 'reason (failed checks first)', 'hub tool calls', 'agent tokens out', 'cost USD'], col.tasks.map((t) => [t.id, t.pass ? 'PASS' : 'FAIL', t.error ?? [...t.checks.filter((c) => !c.ok), ...t.checks.filter((c) => c.ok)].map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.op}: ${c.why}`).join(' / '), t.hub_tool_calls, sum(t.agents ?? [], 'output_tokens'), t.cost])));
  L.push(`\npass ${col.tasks.filter((t) => t.pass).length}/${col.tasks.length}${col.stopped ? `; stopped: ${col.stopped}` : ''}\n`);
} else L.push('not run. The eight collaboration tasks are defined in `eval/tools/collab.json`.');

h('Failures with hub-side cause');
const fails = [];
for (const t of col?.tasks ?? []) if (!t.pass) fails.push([t.id, 'collab', t.error ?? t.checks.filter((c) => !c.ok).map((c) => c.why).join('; '), (t.hub_tools ?? []).filter((x) => /error|denied|conflict|rate/.test(x)).join(' ')]);
for (const t of qaRows(qa)) if (!t.exact_match || t.semantic_correct === false || t.private_leak) fails.push([t.id, 'qa/graph', `exact ${t.exact_match} semantic ${t.semantic_correct} leak ${t.private_leak}; pack ${t.pack_tokens}; source recall ${t.source_recall}`, t.judge_reason]);
for (const t of cur(imp)) if ((t.recall ?? 0) < 0.5 || (t.must_not_violations ?? []).length) fails.push([t.id, 'curator', `recall ${t.recall}; must_not ${t.must_not_violations.join(',')}`, `jobs ${Object.entries(t.jobs ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`]);
L.push(fails.length ? table(['task', 'layer', 'what failed', 'hub-side evidence'], fails) : 'none recorded');

h('Agent feedback');
const fb = [];
const take = (label, f) => { if (f?.text) fb.push({ label, text: f.text }); };
for (const r of bf?.runs ?? []) take(r.label, r.feedback);
for (const r of [qa, base, imp, swp]) for (const t of r?.tasks ?? []) take(`${r === base ? 'baseline' : r === qa ? 'qa' : r === imp ? 'curator' : 'swap'}/${t.id}`, t.feedback);
for (const t of col?.tasks ?? []) for (const a of t.agents ?? []) take(`collab/${t.id}/${a.who}`, a.feedback);
const bullets = [];
for (const f of fb) for (const line of f.text.split('\n')) { const s = line.replace(/^[\s*\-•\d.)]+/, '').trim(); if (s.length > 3) bullets.push({ s, label: f.label }); }
const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9_ ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
const jac = (a, b) => { const i = [...a].filter((x) => b.has(x)).length; return i / (a.size + b.size - i || 1); };
const groups = [];
for (const b of bullets) { const w = words(b.s); const g = groups.find((x) => jac(x.w, w) >= 0.4); if (g) { g.agents.add(b.label); g.n++; } else groups.push({ s: b.s, w, agents: new Set([b.label]), n: 1 }); }
const tags = (s) => [/token|bulk|size|large|verbose|too many|extra call|call|batch|redundan|duplicate/i.test(s) && 'efficient', /wrong|miss|unclear|ambig|incorrect|accura|fail|error|cannot|can't|no way|confus|stale/i.test(s) && 'effective', /slow|wait|poll|latency|round.?trip|idle|delay|fast|timeout/i.test(s) && 'fast'].filter(Boolean).join(', ') || 'untagged';
if (groups.length) L.push(table(['item', 'agents mentioning', 'tag'], groups.sort((a, b) => b.agents.size - a.agents.size).slice(0, 40).map((g) => [g.s, g.agents.size, tags(g.s)])));
else L.push('no feedback collected (no live agent run completed). Raw answers are saved per run under `feedback` in the local `results/live-*.json`.');

h('Top hub problems found');
L.push(table(['#', 'problem', 'evidence'], [
  [1, 'Creating a new note never queues an impact_check (K3 only fires for already-known notes), so staleness tasks that start from a new superseding decision (stale-01, ...) get no staleness check', 'stale-01 after setup: jobs index_note=143, impact_check=0 (harness smoke run); impact-01 queues impact_check=1'],
  [2, 'graph_impact candidates miss K3-only dependants (restated facts without links) by design, and bring many unrelated notes via weak signals', `det: K3 recall ${fx(pre?.summary.impact_recall_K3)}, candidate precision ${fx(pre?.summary.impact_candidate_precision_path)}`],
  [3, 'graph_impact returns note-level candidates (empty anchor) for most hits, so section-level routing is lost', `det: path recall ${fx(pre?.summary.impact_candidate_recall_path)} vs section recall ${fx(pre?.summary.impact_candidate_recall_section)}`],
  [4, 'Initial scan creates no index jobs; coverage needs a file_read per note (lazy), so a new hub answers graph_context with nothing until someone reads each note', 'fresh hub: coverage none=144, queued=142 only after the harness read every note'],
  [5, 'Team roles are single-valued: a coordinator cannot also be the task reviewer, so "A creates, B works, A reviews" needs a third agent', 'checkReviewer requires role reviewer; ROLE_ACTIONS has no overlap']]));

writeFileSync(join(RESULTS, `${date}.md`), L.join('\n'));
console.log('wrote', join(RESULTS, `${date}.md`));
