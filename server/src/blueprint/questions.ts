/**
 * The Questions view (docs/blueprint.md §6, §9): every question of a part or project with what the console needs to group
 * it, read from what the hub already stores (the question fields and the `blocks` and `evidence` links). It adds no kind
 * and no status. Overdue uses the one rule Coverage uses (`questionSince`), and is never set in a research project.
 */
import type { Item, LinkRow } from './blueprint.js';
import { isOpen } from './kinds.js';
import { questionSince } from './coverage.js';

const DAY = 86_400_000;
export const QUESTION_STATUS = ['open', 'answered', 'dropped', 'all'] as const;
export type QuestionStatus = (typeof QUESTION_STATUS)[number];

export interface QuestionRow {
  key: string; kind: 'question' | 'issue'; title: string; status: string | null; team_id: string | null; parent: string | null;
  purpose: string | null; asked_to: string | null; asked_at: number | null; since: number; overdue: boolean;
  /** not_asked (no asked_to) or asked while open; otherwise the status. */
  stage: string;
  /** The open items this one blocks. */
  blocks: string[];
  /** Findings linked to it as evidence. */
  findings: number;
  criteria: string | null; line: string | null; mode: string | null;
  /** The latest of its own update and its newest evidence link. */
  activity: number;
  hint?: 'blocks nothing';
}
export interface Questions {
  research: boolean;
  counts: Record<QuestionStatus, number>;
  items: QuestionRow[];
  /** Open issues that block an open item, in the same shape. */
  blocking: QuestionRow[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * `items` is the part (or the whole project) to list; `all` every live item of the project and `links` all its links, so a
 * question that blocks an item in another part still says what waits on it.
 */
export function questions(items: Item[], all: Item[], links: LinkRow[], research: boolean, status: QuestionStatus = 'open', now = Date.now()): Questions {
  const live = new Map(all.map((i) => [i.key, i]));
  const blocksOf = new Map<string, string[]>(), evidence = new Map<string, number[]>();
  for (const l of links) {
    if (l.rel === 'blocks') {
      const t = live.get(l.to_key);
      if (t && isOpen(t.kind, t.status)) (blocksOf.get(l.from_key) ?? blocksOf.set(l.from_key, []).get(l.from_key)!).push(l.to_key);
    } else if (l.rel === 'evidence' && live.get(l.from_key)?.kind === 'finding') {
      (evidence.get(l.to_key) ?? evidence.set(l.to_key, []).get(l.to_key)!).push(l.created_at);
    }
  }
  // Modules with open requirements, for the "blocks nothing" hint on their questions.
  const busy = new Set(all.filter((i) => (i.kind === 'fr' || i.kind === 'nfr') && isOpen(i.kind, i.status) && i.parent_key).map((i) => i.parent_key!));
  const row = (i: Item): QuestionRow => {
    const parent = i.parent_key ? live.get(i.parent_key) : undefined;
    const line = parent?.kind === 'line' ? parent : undefined;
    const mode = line ? str(line.fields['mode']) : null;
    const asked = str(i.fields['asked_to']), at = typeof i.fields['asked_at'] === 'number' ? (i.fields['asked_at'] as number) : null;
    const since = questionSince(i), ev = evidence.get(i.key) ?? [], blocks = blocksOf.get(i.key) ?? [];
    const open = i.status === 'open';
    return {
      key: i.key, kind: i.kind === 'issue' ? 'issue' : 'question', title: i.title, status: i.status, team_id: i.team_id, parent: i.parent_key,
      purpose: str(i.fields['purpose']), asked_to: asked, asked_at: at, since,
      overdue: !research && open && !!asked && now - since > 14 * DAY,
      stage: open ? (asked ? 'asked' : 'not_asked') : String(i.status),
      blocks, findings: ev.length,
      criteria: mode === 'validate' ? str(i.fields['criteria']) : null, line: line?.key ?? null, mode,
      activity: Math.max(i.updated_at, ...ev),
      ...(open && !blocks.length && parent?.kind === 'module' && busy.has(parent.key) ? { hint: 'blocks nothing' as const } : {}),
    };
  };
  const Q = items.filter((i) => i.kind === 'question');
  const counts = { open: 0, answered: 0, dropped: 0, all: Q.length } as Record<QuestionStatus, number>;
  for (const i of Q) if (i.status === 'open' || i.status === 'answered' || i.status === 'dropped') counts[i.status]++;
  const pick = Q.filter((i) => status === 'all' || i.status === status).map(row);
  // Research reads newest activity first; a software project oldest waiting first, so the longest wait leads its group.
  pick.sort(research ? (a, b) => b.activity - a.activity || a.key.localeCompare(b.key) : (a, b) => a.since - b.since || a.key.localeCompare(b.key));
  const blocking = items.filter((i) => i.kind === 'issue' && isOpen(i.kind, i.status) && blocksOf.get(i.key)?.length).map(row).sort((a, b) => a.since - b.since);
  return { research, counts, items: pick, blocking };
}

/** How many open issues and questions block an open item: the report fact and the For awareness row. */
export function blockingCount(q: Questions): number {
  return q.blocking.length + q.items.filter((i) => i.status === 'open' && i.blocks.length).length;
}
