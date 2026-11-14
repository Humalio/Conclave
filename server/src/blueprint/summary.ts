/**
 * The section 2 summary's two named lists (docs/blueprint.md §6.1, `decide` and `risk`): which items of the requirements
 * and research section wait on a decision, and which are at risk, with the reason in fixed words. One function reads the
 * project once, so a count and the list it opens (browse.ts) are built from the same sets. Read-only; the wording holds
 * keys, numbers and days only, never a writer's text (a question's `asked_to` stays in the row's fields).
 */
import type { Db } from '../db/db.js';
import { isOpen, RETIRED, milestoneLate } from './kinds.js';
import { questionSince } from './coverage.js';

const DAY = 86_400_000;
export type WhyCode = 'you' | 'team' | 'asked' | 'issue' | 'failing' | 'late' | 'threat';
export interface Why { code: WhyCode; text: string; tone: 'bad' | 'warn' | '' }
export interface Verdict {
  /** Why the item waits on a decision, and who: you (0), the team (1) or someone else (2). */
  decide: Why[]; rank: 0 | 1 | 2; since: number;
  /** Why it is at risk (empty when it is not). */
  risk: Why[];
  /** For a question: the open items it blocks, and whether it is overdue. */
  blocks: string[]; overdue: boolean;
}
export interface Summary { verdicts: Map<string, Verdict>; decide: string[]; risk: string[] }

interface Row { key: string; kind: string; status: string | null; parent_key: string | null; fields: string; created_at: number; updated_at: number }
const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };
const plural = (n: number, w: string, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const TARGETS = new Set(['fr', 'nfr', 'hypothesis']);
const retired = (kind: string, status: string | null) => !!status && !!RETIRED[kind]?.includes(status);

/**
 * The summary of a project's section 2. `decide` is ordered (waiting on you first, then the team, then others, oldest
 * first); `risk` holds what is at risk and not already in `decide`, in the Blueprint's own order.
 */
export function summarize(db: Db, projectId: string, research: boolean, now = Date.now()): Summary {
  const rows = db.prepare('SELECT key, kind, status, parent_key, fields, created_at, updated_at FROM bp_items WHERE project_id=? AND deleted_at IS NULL AND archived=0 ORDER BY kind, position, key').all(projectId) as unknown as Row[];
  const links = db.prepare("SELECT from_key, to_key, rel FROM bp_links WHERE project_id=? AND rel IN ('blocks','delivers','threatens','evidence')").all(projectId) as { from_key: string; to_key: string; rel: string }[];
  const by = new Map(rows.map((r) => [r.key, { ...r, f: parse(r.fields) }]));
  const into = new Map<string, { from: string; rel: string }[]>();
  for (const l of links) (into.get(l.to_key) ?? into.set(l.to_key, []).get(l.to_key)!).push({ from: l.from_key, rel: l.rel });
  const failing = new Map<string, number>();
  for (const r of rows) if (r.kind === 'ac' && r.status === 'failing' && r.parent_key) failing.set(r.parent_key, (failing.get(r.parent_key) ?? 0) + 1);
  // What each open question or issue blocks: only open items count, as in the Questions view.
  const blocksOf = new Map<string, string[]>();
  for (const l of links) if (l.rel === 'blocks') { const t = by.get(l.to_key); if (t && isOpen(t.kind, t.status)) (blocksOf.get(l.from_key) ?? blocksOf.set(l.from_key, []).get(l.from_key)!).push(l.to_key); }

  const verdicts = new Map<string, Verdict>();
  const put = (key: string, since: number): Verdict => verdicts.get(key) ?? (verdicts.set(key, { decide: [], rank: 2, since, risk: [], blocks: [], overdue: false }), verdicts.get(key)!);
  const wait = (v: Verdict, rank: 0 | 1 | 2, w: Why) => { v.rank = (v.decide.length ? Math.min(v.rank, rank) : rank) as 0 | 1 | 2; v.decide.push(w); };

  for (const it of by.values()) {
    if (it.kind === 'question' && it.status === 'open') {
      const blocks = blocksOf.get(it.key) ?? [];
      if (!blocks.length) continue;
      const since = questionSince({ fields: it.f, created_at: it.created_at });
      const asked = typeof it.f['asked_to'] === 'string' && it.f['asked_to'].trim() !== '';
      const days = Math.floor((now - since) / DAY), overdue = !research && asked && now - since > 14 * DAY;
      const v = put(it.key, since); v.blocks = blocks; v.overdue = overdue;
      wait(v, 2, { code: 'asked', text: asked ? plural(days, 'day') : 'not asked yet', tone: overdue ? 'warn' : '' });
      continue;
    }
    if (!TARGETS.has(it.kind) || retired(it.kind, it.status)) continue;
    const v = put(it.key, it.updated_at);
    if ((it.kind === 'fr' || it.kind === 'nfr') && it.f['unclear'] === true) wait(v, 0, { code: 'you', text: 'Waiting on you', tone: 'warn' });
    if (it.kind === 'hypothesis') {
      const found = (into.get(it.key) ?? []).filter((l) => l.rel === 'evidence' && by.get(l.from)?.kind === 'finding' && ['medium', 'high'].includes(String(by.get(l.from)?.f['confidence']))).length;
      if (it.status === 'inconclusive') wait(v, 1, { code: 'team', text: 'Inconclusive: retest, reframe or drop', tone: 'warn' });
      else if (it.status === 'testing' && found) wait(v, 1, { code: 'team', text: `${plural(found, 'finding')}, no verdict`, tone: 'warn' });
    }
    for (const l of into.get(it.key) ?? []) {
      const s = by.get(l.from);
      if (l.rel === 'blocks' && s?.kind === 'issue' && s.status === 'open' && isOpen(it.kind, it.status)) wait(v, 2, { code: 'issue', text: `Waiting on ${s.key}`, tone: 'warn' });
    }
    // At risk: only what is not yet verified or decided.
    const live = it.kind === 'hypothesis' ? ['untested', 'testing', 'inconclusive'].includes(String(it.status)) : it.status !== 'verified';
    if (!live) continue;
    const n = failing.get(it.key) ?? 0;
    if (n) v.risk.push({ code: 'failing', text: `${plural(n, 'criterion', 'criteria')} failing`, tone: 'bad' });
    for (const l of into.get(it.key) ?? []) {
      const s = by.get(l.from);
      if (!s) continue;
      if (l.rel === 'delivers' && s.kind === 'milestone') {
        const late = milestoneLate({ status: s.status, target_at: s.f['target_at'] }, now);
        if (late) v.risk.push({ code: 'late', text: late.state === 'missed' ? `${s.key} missed` : `${s.key} overdue by ${plural(late.days, 'day')}`, tone: 'warn' });
      } else if (l.rel === 'threatens' && s.kind === 'risk' && s.status === 'open' && (s.f['likelihood'] === 'high' || s.f['impact'] === 'high')) {
        v.risk.push({ code: 'threat', text: `Threatened by ${s.key}`, tone: 'warn' });
      }
    }
  }
  const decide = [...verdicts.entries()].filter(([, v]) => v.decide.length).sort(([ka, a], [kb, b]) => a.rank - b.rank || a.since - b.since || ka.localeCompare(kb)).map(([k]) => k);
  const risk = [...verdicts.entries()].filter(([, v]) => v.risk.length && !v.decide.length).map(([k]) => k);
  return { verdicts, decide, risk };
}
