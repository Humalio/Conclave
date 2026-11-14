// Deterministic layer: no model. `node det.mjs pre` (unindexed hub: impact/staleness candidates, merge name rules)
// `node det.mjs post` (after backfill: graph_context pack size, leaks, source recall, tokens vs naive).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Hub } from './hub.mjs';
import { tasksOf, tok, SERVER, RESULTS, writeJson, readJson } from './lib.mjs';

const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/ /g, '-');
const strip = (p) => p.replace(/^\/vault\//, '');
const f3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const f1 = (p, r) => (p + r ? (2 * p * r) / (p + r) : 0);

/** Recall of GT items among hub candidates, at path level and path+section level. */
function candidateScore(cands, items) {
  const paths = new Set(cands.map((c) => strip(c.path)));
  const secs = new Set(cands.map((c) => `${strip(c.path)}#${c.anchor ?? ''}`));
  const out = items.map((i) => ({ path: i.path, section: i.section, detect: i.detect ?? null, path_hit: paths.has(i.path),
    section_hit: secs.has(`${i.path}#${slug(i.section || '')}`) || (!i.section && paths.has(i.path)) }));
  return out;
}

export async function detPre(hub) {
  const res = { impact: [], staleness: [], merge: [] };
  const qa = () => hub.session('qa');
  for (const t of tasksOf('impact')) {
    await hub.restore();
    await hub.applySetup(t.setup);
    const s = await qa();
    const r = await s.call('graph_impact', { path: `/vault/${t.changed.path}` });
    await s.close();
    const cands = r.data?.candidates ?? [];
    const gt = t.ground_truth;
    const items = [...(gt.affected ?? []), ...(gt.ok_candidates ?? [])];
    const sc = candidateScore(cands, items);
    const mn = new Set((gt.must_not_flag ?? []).map((x) => x.path));
    res.impact.push({ id: t.id, candidates: cands.length, tokens: tok(r.text) + tok(r.data ?? ''), naive: t.cost.naive_tokens_est, best_case: t.cost.best_case_tokens_est,
      recall_path: f3(avg(sc.map((x) => +x.path_hit))), recall_section: f3(avg(sc.map((x) => +x.section_hit))),
      recall_k1: f3(avg(sc.filter((x) => x.detect === 'K1').map((x) => +x.path_hit))), recall_k3: f3(avg(sc.filter((x) => x.detect === 'K3').map((x) => +x.path_hit))),
      affected_recall: f3(avg(sc.slice(0, (gt.affected ?? []).length).map((x) => +x.path_hit))),
      precision_path: f3(cands.length ? new Set(cands.map((c) => strip(c.path)).filter((p) => items.some((i) => i.path === p))).size / new Set(cands.map((c) => strip(c.path))).size : null),
      must_not_in_candidates: cands.filter((c) => mn.has(strip(c.path))).map((c) => strip(c.path)), missed: sc.filter((x) => !x.path_hit).map((x) => `${x.path}#${x.section}`) });
  }
  for (const t of tasksOf('staleness')) {
    await hub.restore();
    await hub.applySetup(t.setup);
    const s = await qa();
    const changed = [...new Set(t.setup.map((o) => o.path))];
    const seen = new Map();
    let tokens = 0;
    for (const p of changed) {
      const r = await s.call('graph_impact', { path: `/vault/${p}` });
      tokens += tok(r.text) + tok(r.data ?? '');
      for (const c of r.data?.candidates ?? []) seen.set(`${strip(c.path)}#${c.anchor ?? ''}`, c);
    }
    await s.close();
    const cands = [...seen.values()];
    const gt = t.ground_truth;
    const sc = candidateScore(cands, gt.stale ?? []);
    const stillHit = candidateScore(cands, gt.still_correct ?? []);
    res.staleness.push({ id: t.id, candidates: cands.length, tokens, naive: t.cost.naive_tokens_est, recall_path: f3(avg(sc.map((x) => +x.path_hit))), recall_section: f3(avg(sc.map((x) => +x.section_hit))),
      still_correct_in_candidates: stillHit.filter((x) => x.path_hit).length, still_correct_total: (gt.still_correct ?? []).length, missed: sc.filter((x) => !x.path_hit).map((x) => `${x.path}#${x.section}`) });
  }
  // entity merge: name rules only (no entities exist before curators run). similarNames/lookAlike are the hub's own functions.
  const { similarNames, lookAlike } = await import(pathToFileURL(join(SERVER, 'dist', 'graph', 'kg2.js')).href);
  const nameOf = (p) => p.split('/').pop().replace(/\.md$/, '');
  const clean = (x) => x.replace(/\[\[([^\]|\\]*)(?:\\?\|([^\]]*))?\]\]/g, (_, a, b) => b ?? a).replace(/["']/g, '');
  for (const t of tasksOf('entity_merge')) {
    let mentions = 0, hits = 0, apartBad = 0, apart = 0;
    for (const g of t.ground_truth.merge) for (const m of g.mentions) { mentions++; if (similarNames(nameOf(g.canonical), clean(m.text))) hits++; }
    for (const k of t.ground_truth.keep_apart ?? []) {
      apart++;
      const a = { name: nameOf(k.a.path), type: null }, b = { name: nameOf(k.b.path), type: null };
      if (similarNames(a.name, b.name) && !lookAlike(a, b)) apartBad++;
    }
    res.merge.push({ id: t.id, mentions, name_rule_hits: hits, recall: f3(mentions ? hits / mentions : null), keep_apart: apart, keep_apart_proposed: apartBad });
  }
  const sum = (a, k) => a.reduce((s, x) => s + (x[k] ?? 0), 0);
  res.summary = {
    impact_candidate_recall_path: f3(avg(res.impact.map((x) => x.recall_path))), impact_candidate_recall_section: f3(avg(res.impact.map((x) => x.recall_section))),
    impact_recall_K1: f3(avg(res.impact.map((x) => x.recall_k1).filter((x) => x != null))), impact_recall_K3: f3(avg(res.impact.map((x) => x.recall_k3).filter((x) => x != null))),
    impact_affected_recall: f3(avg(res.impact.map((x) => x.affected_recall))), impact_candidate_precision_path: f3(avg(res.impact.map((x) => x.precision_path).filter((x) => x != null))),
    impact_must_not_in_candidates: sum(res.impact.map((x) => ({ n: x.must_not_in_candidates.length })), 'n'),
    impact_tokens_vs_naive: f3(sum(res.impact, 'tokens') / sum(res.impact, 'naive')),
    staleness_candidate_recall_path: f3(avg(res.staleness.map((x) => x.recall_path))), staleness_candidate_recall_section: f3(avg(res.staleness.map((x) => x.recall_section))),
    merge_name_rule_recall: f3(sum(res.merge, 'name_rule_hits') / sum(res.merge, 'mentions')), merge_keep_apart_proposed: sum(res.merge, 'keep_apart_proposed'), merge_keep_apart_total: sum(res.merge, 'keep_apart'),
  };
  return res;
}

export async function detPost(hub) {
  const res = { qa: [] };
  const sessions = { full: await hub.session('qa'), restricted: await hub.session('qa_r') };
  for (const t of tasksOf('context_qa')) {
    const gt = t.ground_truth;
    const s = sessions[gt.key];
    const r = await s.call('graph_context', { question: t.prompt, budget_tokens: gt.budget_tokens });
    const text = r.text + JSON.stringify(r.data ?? '');
    const srcs = (gt.sources ?? []).map((x) => x.path);
    const have = srcs.filter((p) => text.includes(p));
    const forb = (gt.forbidden_sources ?? []);
    res.qa.push({ id: t.id, key: gt.key, pack_tokens: tok(r.text), reported_tokens: r.data?.tokens_est ?? null, budget: gt.budget_tokens, within_budget: tok(r.text) <= gt.budget_tokens,
      naive: t.cost.naive_tokens_est, best_case: t.cost.best_case_tokens_est, source_recall: srcs.length ? f3(have.length / srcs.length) : null,
      must_contain_in_pack: (gt.answer_must_contain ?? []).length ? f3((gt.answer_must_contain.filter((x) => text.toLowerCase().includes(x.toLowerCase())).length) / gt.answer_must_contain.length) : null,
      private_leak: gt.key === 'restricted' ? (/Private\//.test(text) || forb.some((p) => text.includes(p)) || (gt.answer_must_not_contain ?? []).some((x) => text.includes(x))) : false,
      pack_text_head: r.text.slice(0, 200) });
  }
  for (const s of Object.values(sessions)) await s.close();
  const q = res.qa;
  res.summary = { pack_tokens_mean: Math.round(avg(q.map((x) => x.pack_tokens))), pack_vs_naive: f3(q.reduce((s, x) => s + x.pack_tokens, 0) / q.reduce((s, x) => s + x.naive, 0)),
    all_within_budget: q.every((x) => x.within_budget), private_leaks: q.filter((x) => x.private_leak).length, source_recall_mean: f3(avg(q.map((x) => x.source_recall).filter((x) => x != null))),
    must_contain_in_pack_mean: f3(avg(q.map((x) => x.must_contain_in_pack).filter((x) => x != null))) };
  return res;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? 'pre';
  const hub = new Hub();
  if (mode === 'pre') {
    hub.build();
    await hub.fresh();
    await hub.snapshot();
    const r = await detPre(hub);
    writeJson(join(RESULTS, 'det-pre.json'), r);
    console.log(JSON.stringify(r.summary, null, 1));
    await hub.stop();
  } else {
    await hub.start();
    const r = await detPost(hub);
    writeJson(join(RESULTS, 'det-post.json'), r);
    console.log(JSON.stringify(r.summary, null, 1));
    await hub.stop();
  }
}
