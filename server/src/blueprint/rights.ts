/**
 * Who may edit what in a blueprint (docs/blueprint.md §4): the operator edits everything; a coordinator edits
 * inside its team's part and proposes the rest; other members propose, and change findings in their own part. The
 * operator's status moves (agreeing, taking back, deciding) come from one table, kinds.ts `isOperatorAct`. Each op
 * gets a verdict; a batch with any `propose` becomes one proposal, a batch with any `deny` is refused.
 * A team with coordinator_decides_blueprint on lets its coordinator agree FRs and NFRs of its own part directly (`decided`).
 * In a project with one team (`sole`), the project-level items count as that team's own part (FR-PLAN-12).
 * A rule the operator turned on for the team (`rules`, ADR-006) applies a named kind of change that would be a proposal (`rule`).
 * Pure: the caller passes a lookup of live rows, so this runs before anything is written.
 */
import type { Op, ItemRow } from './blueprint.js';
import { KINDS, PAPER_OPEN, RULE_RELEASE_FIELDS, isOperatorAct, type BpRule } from './kinds.js';

export type Verdict = 'apply' | 'propose' | 'deny';
export type BpRole = 'coordinator' | 'member';
export interface RightCtx {
  role: BpRole; teamId: string; row: (key: string) => ItemRow | undefined;
  /** An open re-plan of the caller's part: its coordinator rewrites, re-links and deletes its marked items directly. */
  replan?: { id: string; kinds: string[] } | null;
  /** The team's coordinator_decides_blueprint is on and the caller is its coordinator: agreeing a requirement of the part applies. */
  decides?: boolean;
  /** The caller's team is the project's only one: project-level items (team_id null) are its own part too. */
  sole?: boolean;
  /** The rules that are on for the caller's team in this project (bp_rules, not paused); only its coordinator uses them. */
  rules?: ReadonlySet<BpRule>;
  /**
   * The caller is delegated to a collaborator (docs/authorization.md, delegation): contributor mode narrows every verdict.
   * `since` is when the delegation started: items the agent created after it are its own.
   */
  contributor?: { agentId: string; since: number; delegate: string } | null;
}
/** `decided`: applied only because the operator lets this coordinator agree requirements (audited, in the operator's digest). */
export interface OpRight { verdict: Verdict; why: string; decided?: boolean; rule?: BpRule }

const A: Verdict = 'apply', P: Verdict = 'propose', D: Verdict = 'deny';
const RANK: Record<Verdict, number> = { apply: 0, propose: 1, deny: 2 };
const worst = (...v: Verdict[]): Verdict => v.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), A);
const parse = (s: string | null | undefined): Record<string, unknown> => { try { return s ? JSON.parse(s) as Record<string, unknown> : {}; } catch { return {}; } };

/** The status an item may be edited in by its coordinator; after it, edits are proposals. */
const OPEN_STATUS: Record<string, string> = { fr: 'draft', nfr: 'draft', hypothesis: 'untested', question: 'open' };
/** Status reports are filed with bp_report only, so its cadence, shape and facts cannot be skipped (§7). */
const REPORT_WHY = 'status reports are filed with bp_report (coordinator), not written as items';

/** Combine the verdicts of a batch: the worst wins. */
export function batchVerdict(rights: OpRight[]): Verdict { return worst(...rights.map((r) => r.verdict)); }

/** Whether an item's team is the caller's: its own part, or project level when the team is the project's only one. */
const ours = (team: string | null | undefined, c: RightCtx): boolean => team === c.teamId || (!!c.sole && (team ?? null) === null);

export function opRight(op: Op, c: RightCtx): OpRight {
  const base = baseRight(op, c);
  return c.contributor ? contributorRight(op, c, c.contributor, base) : base;
}

/** The kinds a contributor may create (§4, Contributor column): what it found, argues, asks or fears, under an item it reads. */
const CONTRIB_CREATE = new Set(['finding', 'claim', 'question', 'risk']);
/** The statuses in which a contributor still edits an item it created; a claim follows its paper (planned or drafting). */
const CONTRIB_OPEN = new Set(['draft', 'untested', 'open']);

/**
 * Contributor mode (blueprint.md §4, Contributor column): it reads, creates findings, claims, questions and risks, and
 * edits what it created during this delegation while that is still open; every other change is a proposal, and status
 * moves, deleting, ownership and project-level items are refused. It is a limit on top of the role's row: it can only
 * turn an apply into a propose or a deny, never the reverse.
 */
function contributorRight(op: Op, c: RightCtx, k: NonNullable<RightCtx['contributor']>, base: OpRight): OpRight {
  if (base.verdict === D) return base;
  const deny = (why: string): OpRight => ({ verdict: D, why: `contributor mode (for ${k.delegate}): ${why}` });
  const propose = (why: string): OpRight => base.verdict === P ? base : { verdict: P, why: `contributor mode (for ${k.delegate}): ${why}; it goes to the operator as a proposal` };
  // An item in this write (no author yet) is the agent's own; an existing one only if it created it during this delegation.
  const mine = (r: ItemRow | undefined) => !!r && (r.created_by_kind === undefined || (r.created_by_kind === 'agent' && r.created_by_id === k.agentId && r.created_at >= k.since));
  const open = (r: ItemRow) => r.kind === 'claim' ? r.status === 'draft' && PAPER_OPEN.includes(c.row(r.parent_key ?? '')?.status ?? '') : r.status === null || CONTRIB_OPEN.has(r.status);
  if (op.op === 'remove') return deny(`deleting ${op.key} is not a contributor's`);
  if (op.op === 'link' || op.op === 'unlink') {
    const from = c.row(op.from);
    return from && mine(from) && open(from) ? base : propose(`${op.op} from ${op.from}, which it did not create during this delegation`);
  }
  return itemContributorRight(op as Extract<Op, { op: 'upsert' | 'move' }>, c, mine, open, deny, propose, base);
}

function itemContributorRight(op: Extract<Op, { op: 'upsert' | 'move' }>, c: RightCtx, mine: (r: ItemRow | undefined) => boolean, open: (r: ItemRow) => boolean,
  deny: (why: string) => OpRight, propose: (why: string) => OpRight, base: OpRight): OpRight {
  const cur = c.row(op.key);
  const kind = op.op === 'move' ? cur?.kind : op.kind;
  const parentKey = op.parent_key === undefined ? (cur?.parent_key ?? null) : op.parent_key;
  const parent = parentKey ? c.row(parentKey) : undefined;
  const team = parent ? parent.team_id : (op.op === 'upsert' && op.team_id !== undefined ? op.team_id : (cur?.team_id ?? null));
  if ((team ?? null) === null && !c.sole) return deny(`${op.key} is project-level, in no team's part`);
  if (op.op === 'upsert' && cur && op.team_id !== undefined && op.team_id !== cur.team_id) return deny(`moving ${op.key} to another team is the operator's`);
  const was = cur ? cur.status : (KINDS[kind ?? '']?.statuses?.[0] ?? null);
  if (op.op === 'upsert' && op.status !== undefined && op.status !== was) return deny(`moving ${op.key} to ${op.status} is not a contributor's`);
  if (!cur) return CONTRIB_CREATE.has(kind ?? '') ? base : propose(`a new ${kind} is not a contributor's`);
  return mine(cur) && open(cur) ? base : propose(`${op.key} was not created by this agent during the delegation, or is no longer open`);
}

function baseRight(op: Op, c: RightCtx): OpRight {
  if (c.replan && c.role === 'coordinator' && replanAllows(op, c, c.replan)) return { verdict: A, why: '' };
  const member = c.role === 'member';
  if (op.op === 'remove' && c.row(op.key)?.kind === 'report') return { verdict: D, why: REPORT_WHY };
  if (op.op === 'remove') return member ? { verdict: D, why: `deleting ${op.key} is the operator's` } : { verdict: P, why: `deleting ${op.key} needs the operator` };
  if (op.op === 'link' || op.op === 'unlink') return linkRight(op, c);
  if (op.op === 'move') {
    const cur = c.row(op.key);
    if (!cur) return { verdict: A, why: '' }; // the write reports the missing item
    return upsertRight({ op: 'upsert', kind: cur.kind, key: op.key, ...(op.parent_key === undefined ? {} : { parent_key: op.parent_key }), ...(op.position === undefined ? {} : { position: op.position }) }, c);
  }
  return upsertRight(op as Extract<Op, { op: 'upsert' }>, c);
}

function upsertRight(op: Extract<Op, { op: 'upsert' }>, c: RightCtx): OpRight {
  const member = c.role === 'member';
  const kind = op.kind, spec = KINDS[kind];
  if (!spec) return { verdict: A, why: '' }; // the write reports the unknown kind
  const cur = typeof op.key === 'string' && !op.key.endsWith('*') ? c.row(op.key) : undefined;
  const parentKey = op.parent_key === undefined ? (cur?.parent_key ?? null) : op.parent_key;
  const parent = parentKey ? c.row(parentKey) : undefined;
  const team = parent ? parent.team_id : (op.team_id === undefined ? (cur?.team_id ?? null) : op.team_id);
  const own = ours(team, c) && (!cur || ours(cur.team_id, c));
  const teamChange = !!cur && op.team_id !== undefined && op.team_id !== cur.team_id && !parent;

  const was = cur ? cur.status : (spec.statuses?.[0] ?? null);
  const to = op.status === undefined ? was : op.status;
  const moved = to !== was;
  const act = isOperatorAct(kind, was, to);
  const curFields = cur ? parse(cur.fields) : {};
  const changedFields = Object.keys(op.fields ?? {}).filter((k) => JSON.stringify((op.fields ?? {})[k] ?? null) !== JSON.stringify(curFields[k] ?? null));
  const evidence = changedFields.includes('evidence');
  const text = !cur || (op.title !== undefined && op.title.trim() !== cur.title) || (op.body !== undefined && op.body !== cur.body)
    || (op.parent_key !== undefined && op.parent_key !== cur.parent_key) || (op.position !== undefined && op.position !== cur.position)
    || changedFields.some((k) => k !== 'evidence');
  const k = `${op.key}`;
  const r = (verdict: Verdict, why: string): OpRight => ({ verdict, why: verdict === A ? '' : why });
  // Outside references only (§4): a coordinator changes them on its own part's items whatever their status. Archived
  // items are refused before rights (blueprint.ts refuseArchived); reports stay bp_report's.
  const refsOnly = !!cur && changedFields.length > 0 && changedFields.every((f) => f === 'external') && !moved && !teamChange
    && (op.title === undefined || op.title.trim() === cur.title) && (op.body === undefined || op.body === cur.body)
    && (op.parent_key === undefined || op.parent_key === cur.parent_key) && (op.position === undefined || op.position === cur.position);
  if (refsOnly && !member && own && kind !== 'report') return r(A, '');

  switch (kind) {
    case 'summary': case 'stakeholder': case 'architecture': case 'term': case 'reference':
      return member ? r(D, `${kind} items are the operator's`) : r(P, `${kind} items need the operator`);
    case 'module': case 'line':
      if (member) return r(D, `tracks are set by the operator`);
      if (!cur) return r(P, `opening ${kind} ${k} needs the operator`);
      if (teamChange || !own) return r(P, `${k} is not in your team's part, or changes owner`);
      return r(A, '');
    case 'fr': case 'nfr': case 'hypothesis': case 'question': {
      if (member) return moved ? r(D, `as a member you cannot move ${k} to ${to}`) : r(P, `${k}: members propose`);
      if (!own) {
        if (moved && !act) return r(D, `${k} is outside your team's part; its status is its owner's`);
        if (evidence) return r(D, `${k} is outside your team's part; its evidence is its owner's`);
        return r(P, `${k} is outside your team's part`);
      }
      const open = OPEN_STATUS[kind]!;
      // Agreeing (draft or dropped → agreed, built or verified), never taking back, and no edit of an already settled text.
      if (c.decides && act && (kind === 'fr' || kind === 'nfr') && (was === 'draft' || was === 'dropped') && !(text && was !== open)) return { verdict: A, why: '', decided: true };
      const why = !act ? `${k} is ${was}; editing it needs the operator`
        : was === 'draft' || was === 'dropped' ? `agreeing ${k} (${was} → ${to}) is the operator's` : `taking ${k} back from ${was} (→ ${to}) is the operator's`;
      return r(worst(text && was !== open ? P : A, act ? P : A), why);
    }
    case 'ac': {
      if (member) return moved ? r(D, `as a member you cannot move ${k} to ${to}`) : r(P, `${k}: members propose`);
      if (!own) return moved || evidence ? r(D, `${k} is outside your team's part`) : r(P, `${k} is outside your team's part`);
      return r(text && parent?.status !== 'draft' ? P : A, `${parentKey} is ${parent?.status}; editing its criteria needs the operator`);
    }
    case 'finding':
      if (member) return own ? r(A, '') : r(P, `${k} is in another team's line`);
      return own ? r(A, '') : r(P, `${k} is outside your team's part`);
    case 'paper': {
      if (member) return r(D, 'papers are written by the coordinator and the operator');
      if (!own || teamChange) return r(P, `${k} is outside your team's part, or changes owner`);
      const editable = PAPER_OPEN.includes(was ?? '');
      if (act) return r(P, `moving ${k} to ${to} is the operator's`);
      return r(text && !editable ? P : A, `${k} is ${was}; editing it needs the operator`);
    }
    case 'claim': {
      if (member) return r(P, `${k}: members propose`);
      if (!own) return r(P, `${k} is outside your team's part`);
      return r(PAPER_OPEN.includes(parent?.status ?? '') ? A : P, `${parentKey} is ${parent?.status}; its claims need the operator`);
    }
    case 'decision':
      if (member) return r(D, 'decisions are added by the coordinator');
      if (act || was !== 'proposed') return r(P, `accepting, rejecting or changing a settled decision (${k}) is the operator's`);
      return r(A, '');
    case 'milestone': case 'release':
      if (member) return r(D, `${kind}s are the coordinator's and the operator's`);
      if (!own) return r(P, `${k} is outside your team's part`);
      if (!cur || text) {
        // The Release notes rule: creating a release and writing its title, body, notes (and version when created) apply.
        // Anything else on it (a date, a new parent or place) keeps the op a proposal, so the whole write is one.
        const fieldsOk = (cur ? changedFields : Object.keys(op.fields ?? {})).every((f) => f === 'notes' || (!cur && RULE_RELEASE_FIELDS.includes(f)));
        const placeOk = cur ? (op.parent_key === undefined || op.parent_key === cur.parent_key) && (op.position === undefined || op.position === cur.position) : !parentKey;
        if (kind === 'release' && c.role === 'coordinator' && c.rules?.has('release_notes') && fieldsOk && placeOk) return { verdict: A, why: '', rule: 'release_notes' };
        return r(P, `${kind} dates, scope and text need the operator; status is yours`);
      }
      return r(A, '');
    case 'risk': case 'issue':
      if (member) return r(P, `${k}: members propose`);
      return own ? r(A, '') : r(P, `${k} is outside your team's part (give team_id to file it in yours)`);
    case 'report': // only bp_report (with its cadence and the hub's facts) writes reports
      return r(D, REPORT_WHY);
    default:
      return member ? r(D, `${kind} items are the operator's`) : r(P, `${kind} items need the operator`);
  }
}

/**
 * During a re-plan, inside its own part the coordinator may rewrite, re-link and delete the items marked with
 * the open re-plan, and create items of the re-plan's kinds (they join it). Requirements stay draft or dropped: agreeing
 * them is approving the re-plan. Anything else falls through to the normal rights.
 */
function replanAllows(op: Op, c: RightCtx, rp: { id: string; kinds: string[] }): boolean {
  const mine = (r: ItemRow | undefined) => !!r && ours(r.team_id, c);
  const marked = (r: ItemRow | undefined) => mine(r) && r!.replan_id === rp.id;
  if (op.op === 'remove') return marked(c.row(op.key));
  if (op.op === 'link' || op.op === 'unlink') {
    const from = c.row(op.from), to = c.row(op.to);
    return mine(from) && mine(to) && (marked(from) || marked(to));
  }
  return replanItemAllows(op as Extract<Op, { op: 'upsert' | 'move' }>, c, rp, mine, marked);
}
function replanItemAllows(op: Extract<Op, { op: 'upsert' | 'move' }>, c: RightCtx, rp: { id: string; kinds: string[] }, mine: (r: ItemRow | undefined) => boolean, marked: (r: ItemRow | undefined) => boolean): boolean {
  const cur = typeof op.key === 'string' && !op.key.endsWith('*') ? c.row(op.key) : undefined;
  const kind = op.op === 'move' ? cur?.kind : op.kind;
  if (!kind) return false;
  const parentKey = op.parent_key === undefined ? (cur?.parent_key ?? null) : op.parent_key;
  const parent = parentKey ? c.row(parentKey) : undefined;
  if (parentKey && !mine(parent)) return false;
  const teamGiven = op.op === 'upsert' && op.team_id !== undefined;
  if (cur) {
    if (!marked(cur) || (teamGiven && !ours((op as { team_id?: string | null }).team_id, c))) return false;
  } else {
    const team = parent ? parent.team_id : (teamGiven ? (op as { team_id?: string | null }).team_id : null);
    if (!ours(team, c) || !rp.kinds.includes(kind)) return false;
  }
  const status = op.op === 'upsert' ? op.status : undefined;
  if ((kind === 'fr' || kind === 'nfr') && status !== undefined && status !== 'draft' && status !== 'dropped') return false;
  return true;
}

function linkRight(op: Extract<Op, { op: 'link' | 'unlink' }>, c: RightCtx): OpRight {
  const member = c.role === 'member';
  const from = c.row(op.from), to = c.row(op.to);
  if (!from || !to) return { verdict: A, why: '' }; // the write reports the missing item
  const what = `${op.op} ${op.from} ${op.rel} ${op.to}`;
  switch (op.rel) {
    case 'evidence': // evidence is a write on the item it bears on; citing another team's item needs no rights on it
      if (!ours(to.team_id, c)) return { verdict: D, why: `${op.to} is outside your team's part; its evidence is its owner's` };
      return member ? { verdict: P, why: `${what}: members propose evidence` } : { verdict: A, why: '' };
    case 'delivers': case 'ships':
      return member ? { verdict: D, why: `${what}: scope is the coordinator's and the operator's` } : { verdict: P, why: `${what}: scope needs the operator` };
    case 'governs': case 'supersedes':
      if (member) return { verdict: D, why: `${what}: decisions are added by the coordinator` };
      return from.status === 'proposed' && op.rel === 'governs' ? { verdict: A, why: '' } : { verdict: P, why: `${what} changes a settled decision` };
    case 'studies': // planned coverage is part of the paper: its coordinator links it while the paper is planned or drafting
      if (member) return { verdict: D, why: `${what}: papers are the coordinator's` };
      if (!ours(from.team_id, c)) return { verdict: P, why: `${what}: ${op.from} is outside your team's part` };
      return PAPER_OPEN.includes(from.status ?? '') ? { verdict: A, why: '' } : { verdict: P, why: `${what}: ${op.from} has left planned or drafting` };
    case 'threatens': case 'blocks':
      if (member || !ours(from.team_id, c)) return { verdict: P, why: `${what}: ${member ? 'members propose' : `${op.from} is outside your team's part`}` };
      return { verdict: A, why: '' };
    default:
      return { verdict: member ? D : P, why: `${what} needs the operator` };
  }
}
