/**
 * What a new team arrives with besides its goal (docs/directives.md#from-onboarding, docs/onboarding.md): the two
 * standard directives from the hub template, the requirements its request proposes, and the check that keeps rules out
 * of the goal.
 */

/** Bounds of one requirement in a request (docs/onboarding.md#the-request). */
export const REQ_TITLE_MAX = 200, REQ_TEXT_MAX = 2000, REQ_AC_MAX = 300, REQ_ACS_MAX = 10;
export const NFR_CATEGORIES = ['perf', 'sec', 'rel', 'use', 'ops'] as const;
export type NfrCategory = typeof NFR_CATEGORIES[number];
/**
 * A requirement the team should meet, as the onboarding agent found it. L2 text: at approval the kept ones go into the
 * team's Blueprint part as one proposal for the operator, never applied by the approval itself.
 */
export interface RequirementIn { kind: 'fr' | 'nfr'; title: string; text: string; category?: NfrCategory; acs?: string[]; module?: string }

/**
 * Where the requirements or the research brief come from (docs/onboarding.md#setup-progress): a source that exists (its
 * reference is information for the team, never a permission to fetch it), the coordinator, or the operator.
 */
export const SOURCE_FROM = ['existing', 'coordinator', 'operator'] as const;
export type SourceFrom = typeof SOURCE_FROM[number];
export interface SourceIn { from: SourceFrom; ref?: string; note?: string }
export const REF_MAX = 400, NOTE_MAX = 500, BRIEF_TEXT_MAX = 2000;

/** The research brief, typed (docs/onboarding.md#the-request): lines with hypotheses and questions, and papers. */
export const LINES_MAX = 10, PER_LINE_MAX = 10, PAPERS_MAX = 20, AUTHORS_MAX = 20;
export const LOCAL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,19}$/;
export const PAPER_STATUSES = ['planned', 'drafting', 'submitted', 'accepted', 'published'] as const;
export const PAPER_TYPES = ['paper', 'preprint', 'report', 'thesis'] as const;
export interface HypothesisIn { id: string; title: string; criteria?: string }
export interface QuestionIn { title: string; criteria?: string }
export interface LineIn { id: string; title: string; mode: 'validate' | 'explore'; question?: string; owner?: string; hypotheses?: HypothesisIn[]; questions?: QuestionIn[] }
export interface PaperIn { title: string; status: typeof PAPER_STATUSES[number]; venue?: string; type?: typeof PAPER_TYPES[number]; manuscript?: string; authors?: string[]; owner?: string; hypotheses?: string[] }
export interface ResearchIn { lines: LineIn[]; papers: PaperIn[] }
/** How many typed records a request carries: the requirements limit counts them all together. */
export const recordCount = (reqs: readonly RequirementIn[] | undefined, r: ResearchIn | undefined): number =>
  (reqs?.length ?? 0) + (r ? r.lines.reduce((n, l) => n + 1 + (l.hypotheses?.length ?? 0) + (l.questions?.length ?? 0), 0) + r.papers.length : 0);

/** One item the approval put into its proposal, with the scope it was meant for (team: in the team's part). */
export interface FiledItem { key: string; kind: string; title: string; scope: 'team' | 'project'; owner?: string }

/**
 * The setup record's progress (docs/onboarding.md#setup-progress), derived from the answers, the proposal's status and
 * content: how many live items the team's part holds beyond its own track item, as the hub counted them.
 */
export interface SetupView {
  source: SourceIn | null; proposal: { id: string; status: string } | null; items: number;
  state: 'not_asked' | 'from_source' | 'coordinator_derives' | 'operator_supplies' | 'in_review' | 'done' | 'returned';
  responsible: 'coordinator' | 'operator' | null; next: string;
}
export function setupOf(source: SourceIn | null, proposal: { id: string; status: string } | null, items: number, content = 0): SetupView {
  const owner = source?.from === 'operator' ? 'operator' : 'coordinator';
  const base = { source, proposal, items };
  if (proposal?.status === 'open') return { ...base, state: 'in_review', responsible: 'operator', next: 'Review the proposal in the Blueprint.' };
  if (proposal?.status === 'applied') return { ...base, state: 'done', responsible: null, next: 'Done: the team plans from its part.' };
  if (proposal) return { ...base, state: 'returned', responsible: owner, next: `The proposal was ${proposal.status}: correct the content and propose it again.` };
  // No proposal, but the part already has content (a team set up before the proposal step): nothing is left to do.
  if (content > 0) return { ...base, state: 'done', responsible: null, next: `Done: the team plans from its part (${content} ${content === 1 ? 'item' : 'items'}).` };
  if (!source) return { ...base, state: 'not_asked', responsible: 'operator', next: 'Set where the requirements or the brief come from.' };
  if (source.from === 'existing') return { ...base, state: 'from_source', responsible: 'coordinator', next: `Read the source at ${source.ref} with the access the team has, and propose the requirements or brief.` };
  if (source.from === 'coordinator') return { ...base, state: 'coordinator_derives', responsible: 'coordinator', next: 'Derive the requirements or brief from the goal and propose them.' };
  return { ...base, state: 'operator_supplies', responsible: 'operator', next: 'Supply the requirements or the brief.' };
}

/** The bounds of a standard directive's wording, as for any directive the operator writes at approval. */
export const STD_TITLE_MAX = 120, STD_TEXT_MAX = 2000;
export type StandardKey = 'who_decides' | 'operator_only';
export interface StandardDirective { key: StandardKey; title: string; text: string; category: 'process' | 'access' }

/** The hub template: every new team gets both, in the operator's wording for that team (docs/directives.md#from-onboarding). */
export const STANDARD_DIRECTIVES: readonly StandardDirective[] = [
  { key: 'who_decides', title: 'Who decides', category: 'process',
    text: 'The team coordinator decides the team\'s work, from the team goal and the specification: what comes next, in what order, who does it, and when reviewed work is ready. Bring questions and decisions to the coordinator. Only what "What stays with the operator" lists goes to the operator.' },
  { key: 'operator_only', title: 'What stays with the operator', category: 'access',
    text: [
      'These stay with the operator, a person: ask with `team_ask` and wait for the answer.',
      '- pushing or publishing anything;',
      '- deleting data, or restoring a backup;',
      '- editing the database by hand;',
      '- keys, certificates and security settings;',
      '- installing software;',
      '- approving onboarding requests;',
      '- changing the team goal or the specification.',
    ].join('\n') },
];

/**
 * The standard directives with the operator's wording where given. Both are always created: an entry may reword one,
 * never drop it. Returns the problems instead of throwing, like the request's own validation.
 */
export function standardFor(edits: unknown): { list: StandardDirective[]; problems: { field: string; rule: string }[] } {
  const problems: { field: string; rule: string }[] = [];
  const out = STANDARD_DIRECTIVES.map((d) => ({ ...d }));
  if (edits === undefined) return { list: out, problems };
  if (!Array.isArray(edits) || edits.length > STANDARD_DIRECTIVES.length) return { list: out, problems: [{ field: 'edits.standard', rule: `0–${STANDARD_DIRECTIVES.length} entries {key, title, text}` }] };
  for (const [i, e] of edits.entries()) {
    const x = (e ?? {}) as Record<string, unknown>, f = `edits.standard[${i}]`;
    const d = out.find((s) => s.key === x.key);
    if (!d) { problems.push({ field: `${f}.key`, rule: STANDARD_DIRECTIVES.map((s) => s.key).join(' or ') }); continue; }
    for (const k of Object.keys(x)) if (!['key', 'title', 'text'].includes(k)) problems.push({ field: `${f}.${k}`, rule: 'unknown field' });
    if (x.title !== undefined) {
      const t = typeof x.title === 'string' ? x.title.trim() : '';
      if (!t || t.length > STD_TITLE_MAX || /[\r\n]/.test(t)) problems.push({ field: `${f}.title`, rule: `1–${STD_TITLE_MAX} characters, one line` }); else d.title = t;
    }
    if (x.text !== undefined) {
      const t = typeof x.text === 'string' ? x.text.trim() : '';
      if (!t || t.length > STD_TEXT_MAX) problems.push({ field: `${f}.text`, rule: `1–${STD_TEXT_MAX} characters` }); else d.text = t;
    }
  }
  return { list: out, problems };
}

/**
 * A goal that reads like a list of rules: two or more list lines, or three or more rule words. Only a warning: the
 * filing agent moves the rules to `rules`, where the operator can keep them as directives.
 */
export function goalHasRules(goal: string): boolean {
  const lines = goal.split(/\r?\n/).filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;
  const words = (goal.match(/\b(?:never|always|must|do not|don't)\b/gi) ?? []).length;
  return lines >= 2 || words >= 3;
}
