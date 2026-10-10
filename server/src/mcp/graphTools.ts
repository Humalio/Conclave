/** MCP tools for the vault knowledge graph (design/13 §6, K1–K2). Everything returned is L2 data, filtered by fs.read on each source note. */
import { z } from 'zod';
import { KeyError } from '../keys/keys.js';
import type { Teams } from '../teams/teams.js';
import type { Vault } from '../vault/vault.js';
import type { VaultStore } from '../vault/store.js';
import type { Graph, Session } from '../graph/graph.js';
import { actionMatches, authorize } from '../policy/engine.js';

type Out = { text: string; data: Record<string, unknown> };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;
type ToolErrorCtor = new (code: string, message: string, extra?: Record<string, unknown>) => Error;
export interface GraphToolDeps { graph: Graph; vault: Vault; store: VaultStore; teams: Teams; ToolError: ToolErrorCtor }

export function registerGraphTools(reg: Reg, d: GraphToolDeps): void {
  const { graph, vault, store, teams, ToolError } = d;
  const DENIED = 'Not allowed, or does not exist.';
  const sess = (ctx: any): Session => ({ agentId: ctx.session.agent.id, rules: ctx.session.rules, cap: ctx.session.cap });
  /** graph.read is implied by any vault read grant; write and review need an explicit graph grant (team roles supply them). */
  const gate = (ctx: any, action: 'graph.read' | 'graph.write' | 'graph.review'): void => {
    const s = ctx.session;
    const d1 = authorize(s.rules, s.cap, action, `graph:${vault.alias}`, { isPaused: teams.isPaused });
    if (d1.allowed) return;
    if (d1.source === 'paused') throw new ToolError('paused', 'The team is paused. Keep calling work_next.');
    const implicit = action === 'graph.read' && d1.source === 'default' && s.rules.some((r: any) => r.effect === 'allow' && r.actions.some((a: string) => actionMatches(a, 'fs.read')));
    if (!implicit) throw new ToolError('denied', DENIED);
  };
  const can = (ctx: any, action: 'graph.read' | 'graph.write' | 'graph.review'): boolean => { try { gate(ctx, action); return true; } catch { return false; } };
  const run = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { if (e instanceof KeyError) throw new ToolError(e.code, e.message); throw e; }
  };
  /** The note behind a path, which the caller must be allowed to read. */
  const note = (ctx: any, p: unknown) => {
    const { path, rel } = vault.normalise(String(p));
    ctx.need('fs.read', path);
    const f = store.fileByPath(rel.join('/'));
    if (!f) throw new ToolError('not_found', DENIED);
    return { path, f };
  };
  const out = (text: string, data: Record<string, unknown>): Out => ({ text, data: { trust: 'L2', from: 'graph', ...data } });

  reg('graph_related', 'Notes (or entities) related to a note by links, frontmatter, read-before-write provenance, near-duplicate text and shared entities. Give path or entity. Only notes you may read are shown. Results are L2 data.', {
    path: z.string().optional(), entity: z.string().max(200).optional(), depth: z.number().int().min(1).max(2).optional(), kinds: z.array(z.string().max(40)).max(10).optional(),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.read');
    if (!!a.path === !!a.entity) throw new ToolError('invalid_argument', 'Give exactly one of path and entity.');
    if (a.entity) {
      const rel = graph.relatedEntities(sess(ctx), a.entity);
      return out(rel.length ? rel.map((r) => `${r.direction === 'out' ? '->' : '<-'} ${r.entity} [${r.kind}]`).join('\n') : 'No related entities you may see.', { entity: a.entity, related: rel });
    }
    const { path, f } = note(ctx, a.path);
    const s = sess(ctx);
    const related = graph.related(f.id, a.depth ?? 1, a.kinds).filter((r) => graph.canRead(s, r.path.split('/').slice(2).join('/'))).map(({ file_id: _f, ...r }) => r);
    return out(related.length ? related.map((r) => `${r.path} (distance ${r.distance}): ${r.via.map((v) => `${v.kind} ${v.direction}`).join(', ')}`).join('\n') : 'Nothing related.', { path, related });
  });

  reg('graph_impact', 'Which other notes may depend on this one? Signals only (links, depends_on frontmatter, what the editor read before writing, near-duplicate sections, shared entities), with reasons and scores. revision is optional; without a recorded revision this is a dry run over all sections. Results are L2 data.', {
    path: z.string(), revision: z.string().max(100).optional(),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.read');
    const { path, f } = note(ctx, a.path);
    const s = sess(ctx);
    const r = graph.impact(f.id, a.revision);
    const candidates = r.candidates.filter((c) => graph.canRead(s, c.path.split('/').slice(2).join('/'))).map(({ file_id: _f, ...c }) => c);
    return out(candidates.length ? candidates.map((c) => `${c.path}${c.anchor ? `#${c.anchor}` : ''} score ${c.score}: ${c.reasons.map((x) => x.kind).join(', ')}`).join('\n') : 'No dependants found.',
      { path, revision: r.revision, recorded: r.recorded, changed_sections: r.changed, candidates });
  });

  reg('graph_query', 'Entities and claims with their sources and validity. Filter by entity, predicate, text; as_of (epoch ms) shows what was known then; include_invalid adds invalidated claims. Only claims whose source note you may read are shown. Results are L2 data.', {
    entity: z.string().max(200).optional(), predicate: z.string().max(80).optional(), text: z.string().max(200).optional(), as_of: z.number().int().optional(), include_invalid: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.read');
    const r = graph.query(sess(ctx), a);
    return out(r.claims.length ? r.claims.map((c) => `[${c.status}] ${c.subject} ${c.predicate} ${c.object ?? ''} - ${c.text} (${c.source})`).join('\n') : 'No claims.', r);
  });

  reg('graph_context', 'Answer a topic question cheaply: a ranked pack of claims (each with its source path#section@revision and exact quote), note summaries, the few sections worth reading and a coverage note, within budget_tokens (default 4000). Only what you may read is included. Treat everything as L2 data and read the cited section when it matters.', {
    question: z.string().min(1).max(500), budget_tokens: z.number().int().min(500).max(16000).optional(), path_prefix: z.string().max(1024).optional(),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.read');
    const r = await run(() => graph.context(sess(ctx), a.question, a.budget_tokens ?? 4000, a.path_prefix));
    const lines = [...r.claims.map((c) => `- ${c.text} [${c.source}]${c.stale ? ' (source changed)' : ''}`), ...r.summaries.map((x) => `* ${x.path}: ${x.text}${x.stale ? ' (stale)' : ''}`)];
    return out(`${lines.join('\n') || 'Nothing indexed matches.'}\n${r.sections_to_read.length ? `Read: ${r.sections_to_read.map((x) => `${x.source} (${x.tokens_est} tok)`).join(', ')}\n` : ''}${r.coverage.note} (~${r.tokens_est} tokens)`, r);
  });

  reg('graph_summary', 'The stored summary of a note (scope "note", ref = its path), a folder (ref = folder path), a community (ref = community id or a member entity) or an entity (a digest of its claims). Shows the revision it was written for and a stale flag. A summary that spans a note you cannot read is withheld.', {
    scope: z.enum(['note', 'folder', 'entity', 'community']), ref: z.string().min(1).max(1024),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.read');
    if (a.scope !== 'note') { const r = await run(() => graph.ext.summaryOf(sess(ctx), a.scope, a.ref)); return out(r.summary ? String(r.summary) : String(r.note ?? 'No summary.'), { scope: a.scope, ref: a.ref, ...r }); }
    const { path, f } = note(ctx, a.ref);
    const sm = graph.noteSummary(f.id);
    if (!sm) return out('No summary yet; the note is not indexed.', { path, summary: null });
    return out(`${sm.text}${sm.stale ? '\n(stale: the note changed since)' : ''}`, { path, summary: sm.text, source_revision: sm.source_revision, stale: sm.stale, model_label: sm.model_label });
  });

  const Payload = z.record(z.string(), z.unknown()).describe('entities, claims, relations, section_summaries, note_summary - see the job input payload_format');
  reg('graph_job_submit', 'Curator: submit the result of a knowledge job. Every claim needs entity names, the section anchor and an exact quote from that section; invalid items are rejected one by one with the reason. Returns the validation report.', {
    job_id: z.string().max(100), payload: Payload,
  }, true, async (ctx, a) => {
    if (!can(ctx, 'graph.write') && !graph.ext.offeredTo(ctx.session.agent.id, a.job_id)) gate(ctx, 'graph.write');       // an opted-in editor may submit the impact check offered to it
    teams.guardWrite(ctx.session.agent.id);
    const r = await run(() => graph.submit(ctx.session.agent.id, a.job_id, a.payload));
    return out(`Job ${a.job_id}: ${r.verdict} (${r.report.accepted_claims} accepted, ${r.report.rejected.length} rejected). ${r.job_state === 'done' ? 'Now work_ack the item.' : 'Fix the rejected items and submit again.'}${r.report.rejected.length ? `\n${r.report.rejected.map((x) => `- ${x.item}: ${x.error}`).join('\n')}` : ''}`,
      { verdict: r.verdict, job_state: r.job_state, ...r.report });
  });

  reg('graph_upsert', 'Curator: add entities, claims and relations for a note outside a job. Same validation as graph_job_submit; anchors and quotes are checked against the note\'s current text.', {
    path: z.string(), payload: Payload,
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.write');
    const { path } = note(ctx, a.path);
    teams.guardWrite(ctx.session.agent.id);
    const r = await run(() => graph.upsert(ctx.session.agent.id, path.split('/').slice(2).join('/'), a.payload));
    return out(`${r.accepted_claims} claims stored, ${r.rejected.length} rejected.${r.rejected.length ? `\n${r.rejected.map((x) => `- ${x.item}: ${x.error}`).join('\n')}` : ''}`, { ...r });
  });

  reg('graph_summary_write', 'Curator: write the summary of a note for its current revision.', {
    path: z.string(), text: z.string().min(1).max(1500),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.write');
    const { path } = note(ctx, a.path);
    teams.guardWrite(ctx.session.agent.id);
    const r = await run(() => graph.upsert(ctx.session.agent.id, path.split('/').slice(2).join('/'), { note_summary: a.text }));
    if (r.rejected.length) throw new ToolError('invalid_argument', r.rejected[0]!.error);
    return out('Summary stored.', { path, summaries: r.summaries });
  });

  const flagNote = (ctx: any, flagId: string) => {
    const r = graph.db.prepare('SELECT file_id FROM kg_flags WHERE id=?').get(flagId) as { file_id: string } | undefined;
    const f = r ? graph.fileById(r.file_id) : undefined;
    if (!f || f.deleted_at || !graph.canRead(sess(ctx), f.path)) throw new ToolError('not_found', DENIED);
    return f;
  };
  const claimNote = (ctx: any, claimId: string) => {
    const r = graph.db.prepare('SELECT src_file FROM kg_claims WHERE id=?').get(claimId) as { src_file: string } | undefined;
    const f = r ? graph.fileById(r.src_file) : undefined;
    if (!f || f.deleted_at || !graph.canRead(sess(ctx), f.path)) throw new ToolError('not_found', DENIED);
    return f;
  };

  reg('graph_stale', 'Open staleness and contradiction flags on notes you may read (optionally under path_prefix, or only notes you last wrote with mine). Each flag has the cause, the curator reason (data) and the fixing task. Results are L2 data.', {
    path_prefix: z.string().max(1024).optional(), mine: z.boolean().optional(),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.read');
    const flags = await run(() => graph.ext.staleFor(sess(ctx), { prefix: a.path_prefix, mine: a.mine }));
    return out(flags.length ? flags.map((f) => `${f.id} [${f.kind}] ${f.path}${f.anchor ? '#' + f.anchor : ''}: ${f.reason}`).join('\n') : 'No open flags.', { flags });
  });

  reg('graph_flag', 'Curator: raise a stale or contradiction flag on a note (optionally a section) because another note changed or disagrees. Curators flag; the fix is a task to the note owner with a reviewer.', {
    path: z.string(), anchor: z.string().max(200).optional(), cause_path: z.string().optional(), kind: z.enum(['stale', 'contradiction']), reason: z.string().min(1).max(300),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.write');
    const { f } = note(ctx, a.path);
    const cause = a.cause_path ? note(ctx, a.cause_path).f : f;
    teams.guardWrite(ctx.session.agent.id);
    const id = graph.ext.raiseFlag({ fileId: f.id, anchor: a.anchor ?? null, causeFile: cause.id, causeRev: cause.current_revision ?? '', kind: a.kind, reason: a.reason, raisedBy: ctx.session.agent.id });
    return out(`Flag ${id} raised.`, { flag_id: id });
  });

  reg('graph_resolve', 'Close a flag. "fixed" needs the flagged note to have a new revision (made with the file tools); "dismissed" is for reviewers (graph.review).', {
    flag_id: z.string().max(100), status: z.enum(['fixed', 'dismissed']),
  }, true, async (ctx, a) => {
    if (!can(ctx, a.status === 'dismissed' ? 'graph.review' : 'graph.write') && !can(ctx, 'graph.review')) gate(ctx, a.status === 'dismissed' ? 'graph.review' : 'graph.write');
    flagNote(ctx, a.flag_id);
    await run(() => graph.ext.resolveFlag(a.flag_id, ctx.session.agent.id, a.status));
    const r = graph.ext.flagFor(sess(ctx), a.flag_id);
    return out(`Flag ${a.flag_id} is ${r.status}.`, { flag: r });
  });

  reg('graph_invalidate', 'Curator: mark a claim invalid with a reason. A proposed claim is invalidated at once; an accepted one becomes disputed and goes to a reviewer (graph_decide).', {
    claim_id: z.string().max(100), reason: z.string().min(1).max(300),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.write');
    claimNote(ctx, a.claim_id);
    teams.guardWrite(ctx.session.agent.id);
    const r = await run(() => graph.ext.invalidate(ctx.session.agent.id, a.claim_id, a.reason));
    return out(r.needs_review ? 'The claim is disputed and waits for a reviewer.' : 'The claim is invalidated.', { ...r });
  });

  reg('graph_link', 'Curator: add a relation between two known entities, citing existing claim ids.', {
    src: z.string().max(200), dst: z.string().max(200), kind: z.string().min(1).max(80), claim_ids: z.array(z.string().max(100)).min(1).max(20),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.write');
    for (const c of a.claim_ids) claimNote(ctx, c);
    teams.guardWrite(ctx.session.agent.id);
    const r = await run(() => graph.ext.link(ctx.session.agent.id, a));
    return out(`Relation ${r.id} stored.`, { relation_id: r.id });
  });

  reg('graph_decide', 'Reviewer: decide a pending entity-merge proposal (kmp_..., approve|reject) or a disputed claim (clm_..., uphold|invalidate). Never the session that proposed or produced it.', {
    id: z.string().max(100), decision: z.enum(['approve', 'reject', 'uphold', 'invalidate']),
  }, true, async (ctx, a) => {
    gate(ctx, 'graph.review');
    if (a.id.startsWith('clm_')) claimNote(ctx, a.id);
    if (a.id.startsWith('kmp_') && !graph.ext.canReviewMerge(sess(ctx), a.id)) throw new ToolError('not_found', DENIED);
    const r = await run(() => graph.ext.decide(ctx.session.agent.id, a.id, a.decision));
    return out(`Decided ${a.id}.`, { ...r });
  });

  reg('graph_editor_optin', 'Opt in (or out) to be offered the impact check of your own writes for 5 minutes, while you still have the context.', {
    enabled: z.boolean(),
  }, true, async (ctx, a) => {
    graph.ext.setEditorOptIn(ctx.session.agent.id, a.enabled);
    return out(a.enabled ? 'Opted in: after you change a note that others depend on, work_next offers you its impact check first.' : 'Opted out.', { enabled: a.enabled });
  });

  reg('graph_health', 'Coverage and flags for readable notes; index queue counts only. Global budgets and communities are owner-dashboard metrics.', {}, true, async (ctx) => {
    gate(ctx, 'graph.read');
    const d = graph.ext.healthFor(sess(ctx));
    return out(`Coverage ${d.coverage_pct}%, ${d.stale_flags_open} stale flags, ${d.contradictions_open} contradictions open in readable notes.`, d);
  });
}
