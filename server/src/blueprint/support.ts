/**
 * Claim support and paper readiness (docs/blueprint.md §2.4), computed on read and never stored. Pure functions: the
 * service passes the claim's evidence items, so the rule lives in one place.
 *
 * Which evidence counts as decided is still the operator's call (fork D2, §12). For now it is "decided evidence only":
 * a confirmed hypothesis, a finding of medium or high confidence, a verified FR/NFR, a passing AC. Change `decided` alone.
 *
 * Only `evidence` links count toward support. `studies` (paper → hypothesis) is planned coverage: it finds the papers
 * about a hypothesis (papersForHypothesis, below) and never changes a claim's support or a paper's readiness. The same
 * file holds the research workspace's other matching rules: which papers a milestone delivers, which findings are a
 * hypothesis's results and which tasks are its experiment runs.
 */

export type Support = 'contradicted' | 'unsupported' | 'weak' | 'supported';
export interface EvidenceItem { kind: string; key: string; status: string | null; fields: Record<string, unknown> }

/** Evidence that speaks against the claim. */
export function contradicts(e: EvidenceItem): boolean {
  if (e.kind === 'hypothesis') return e.status === 'refuted';
  if (e.kind === 'fr' || e.kind === 'nfr') return e.status === 'dropped';
  if (e.kind === 'ac') return e.status === 'failing';
  return false;
}

/** Decided evidence (D2: "decided evidence only"); everything else that is not contradicting is undecided. */
export function decided(e: EvidenceItem): boolean {
  if (e.kind === 'hypothesis') return e.status === 'confirmed';
  if (e.kind === 'finding') return e.fields['confidence'] === 'medium' || e.fields['confidence'] === 'high';
  if (e.kind === 'fr' || e.kind === 'nfr') return e.status === 'verified';
  if (e.kind === 'ac') return e.status === 'passing';
  return false;
}

/** Worst first: contradicted, unsupported (no evidence), weak (only undecided evidence), supported. */
export function claimSupport(evidence: readonly EvidenceItem[]): Support {
  if (evidence.some(contradicts)) return 'contradicted';
  if (evidence.length === 0) return 'unsupported';
  return evidence.some(decided) ? 'supported' : 'weak';
}

export interface ClaimState { key: string; status: string | null; support: Support }
/** A paper is ready to write when every claim that is not cut is supported; `holding` lists the ones that are not. */
export function paperReadiness(claims: readonly ClaimState[]): { ready: boolean; supported: number; total: number; holding: ClaimState[] } {
  const kept = claims.filter((c) => c.status !== 'cut');
  const holding = kept.filter((c) => c.support !== 'supported');
  return { ready: kept.length > 0 && holding.length === 0, supported: kept.length - holding.length, total: kept.length, holding };
}

// ───── research workspace (docs/blueprint.md §2.4, §9) ─────

/** Why a paper is on a filtered list: it studies the hypothesis, a claim of it cites the hypothesis as evidence, or a milestone delivers it. */
export type MatchReason = { kind: 'studies'; hypothesis: string } | { kind: 'evidence'; claim: string; hypothesis: string } | { kind: 'delivers'; milestone: string };
export interface LinkLike { from_key: string; to_key: string; rel: string }
export interface ClaimLike { key: string; parent: string | null; status: string | null }

/** The reason in the operator's words: "Studies H-L1-02", "PAP-1/C2 cites H-L1-02 as evidence", "Delivered by M2". */
export const reasonText = (r: MatchReason): string =>
  r.kind === 'studies' ? `Studies ${r.hypothesis}` : r.kind === 'evidence' ? `${r.claim} cites ${r.hypothesis} as evidence` : `Delivered by ${r.milestone}`;

/** Merge reasons per paper key, keeping the first-seen order of papers and of reasons, and never one reason twice. */
function byPaper(pairs: readonly [string, MatchReason][]): Map<string, MatchReason[]> {
  const out = new Map<string, MatchReason[]>();
  for (const [paper, r] of pairs) {
    const L = out.get(paper) ?? out.set(paper, []).get(paper)!;
    if (!L.some((x) => reasonText(x) === reasonText(r))) L.push(r);
  }
  return out;
}

/**
 * The papers about one hypothesis, each once by paper key with every reason: it `studies` the hypothesis, or one of its
 * claims that is not cut has the hypothesis as `evidence`. A planned paper with no claims is found through `studies`
 * alone. `papers` are the live paper keys; links and claims are the project's live ones.
 */
export function papersForHypothesis(hypothesis: string, papers: Iterable<string>, links: readonly LinkLike[], claims: readonly ClaimLike[]): Map<string, MatchReason[]> {
  const live = new Set(papers), claimOf = new Map(claims.filter((c) => c.status !== 'cut').map((c) => [c.key, c]));
  const pairs: [string, MatchReason][] = [];
  for (const l of links) {
    if (l.to_key !== hypothesis) continue;
    if (l.rel === 'studies' && live.has(l.from_key)) pairs.push([l.from_key, { kind: 'studies', hypothesis }]);
  }
  for (const l of links) {
    if (l.rel !== 'evidence' || l.from_key !== hypothesis) continue;
    const c = claimOf.get(l.to_key);
    if (c?.parent && live.has(c.parent)) pairs.push([c.parent, { kind: 'evidence', claim: c.key, hypothesis }]);
  }
  return byPaper(pairs);
}

/** The papers a milestone delivers (`milestone → delivers → paper`), each once, with the reason. */
export function papersForMilestone(milestone: string, papers: Iterable<string>, links: readonly LinkLike[]): Map<string, MatchReason[]> {
  const live = new Set(papers);
  return byPaper(links.filter((l) => l.rel === 'delivers' && l.from_key === milestone && live.has(l.to_key)).map((l) => [l.to_key, { kind: 'delivers', milestone }]));
}

/**
 * The findings that are a hypothesis's results: those linked to it as `evidence`. A finding belongs to its line, so the
 * other findings of the same line are not results of this hypothesis.
 */
export function resultsOf(hypothesis: string, links: readonly LinkLike[]): string[] {
  return [...new Set(links.filter((l) => l.rel === 'evidence' && l.to_key === hypothesis).map((l) => l.from_key))];
}

/** The tag a team puts on a task to mark it as an experiment run of the hypotheses it names in its refs. */
export const RUN_TAG = 'run';
/** A task is a run of a hypothesis only when the team says so: the `run` tag and the hypothesis in its refs. */
export const isRun = (t: { tags: readonly string[]; refs: readonly string[] }, hypothesis: string): boolean => t.tags.includes(RUN_TAG) && t.refs.includes(hypothesis);
