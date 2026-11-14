/** MCP tools for directives (docs/directives.md): directives_list, directives_read, directives_report. */
import { z } from 'zod';
import { forOperator } from './writing.js';
import { KeyError } from '../keys/keys.js';
import { CATEGORIES, CATEGORY_IDS, categoryLabel, type Directives } from '../directives/directives.js';

type Out = { text: string; data: Record<string, unknown> };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;
type ToolErrorCtor = new (code: string, message: string, extra?: Record<string, unknown>) => Error;

export function registerDirectiveTools(reg: Reg, dirs: Directives, ToolError: ToolErrorCtor): void {
  const run = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof KeyError) throw new ToolError(e.code, e.message); throw e; } };
  const me = (ctx: any): string => ctx.session.agent.id;

  const catList = CATEGORIES.map(([k, l]) => `${k} (${l})`).join(', ');
  reg('directives_list', 'The operator\'s standing directives in force for you (L0: follow them), most specific first: id, title, version, scope, category, tags, and whether you read the current version. Filter by category or tag.', {
    category: z.enum([...CATEGORY_IDS, 'none']).optional().describe(`One of: ${catList}; "none" for directives without one`),
    tag: z.string().max(32).optional().describe('Only directives with this tag'),
  }, true, async (ctx, a) => {
    const L = run(() => dirs.summaryFor(me(ctx), { category: a.category, tag: a.tag }));
    const line = (d: typeof L[number]) => `${d.id} v${d.version} "${d.title}" (${d.scope}${d.category ? `; ${categoryLabel(d.category)}` : ''}${d.tags.length ? `; #${d.tags.join(' #')}` : ''}) ${d.read === 'current' ? 'read' : d.read === 'outdated' ? 'CHANGED since you read it' : 'NOT READ'}`;
    return { text: L.length ? L.map(line).join('\n') : a.category || a.tag ? 'No directives in force for you match this filter.' : 'No directives in force for you.', data: { trust: 'L0', directives: L } };
  });
  reg('directives_read', 'Read the text of your directives in force (L0), one by id or all, most specific first: when two disagree, the one with the lower precedence number wins (agent > role > team > project > hub). unread: true returns only those you have not read at their current version; ack: true confirms every returned directive in the same call, so the operator can see you follow it.', {
    id: z.string().max(100).optional(),
    unread: z.boolean().optional().describe('Only directives you have not read at their current version'),
    ack: z.boolean().optional().describe('Confirm every returned directive at its current version'),
  }, true, async (ctx, a) => {
    const L = run(() => dirs.read(me(ctx), a.id, { unread: a.unread, ack: a.ack }));
    const none = a.unread ? 'No unread directives in force for you.' : 'No directives in force for you.';
    const head = L.length > 1 ? 'Most specific first: when two disagree, the lower precedence number wins.\n\n' : '';
    return { text: L.length ? head + L.map((d) => `## ${d.precedence}. ${d.title} (${d.id} v${d.version}, for ${dirs.scopeLabel(d)})\n${d.body}`).join('\n\n') + (a.ack ? `\n\nConfirmed ${L.length} directive${L.length === 1 ? '' : 's'}.` : '') : none,
      data: { trust: 'L0', directives: L.map((d) => ({ id: d.id, title: d.title, version: d.version, precedence: d.precedence, scope_kind: d.scope_kind, scope: dirs.scopeLabel(d), category: d.category, tags: d.tags, text: d.body, acked_version: d.acked_version })),
        ...(a.ack ? { acked: L.map((d) => ({ id: d.id, version: d.version })) } : {}) } };
  });
  reg('directives_report', 'Suggest a rule you follow that is not a hub directive yet (a rules file, a prompt section, an instruction from chat). It goes to your team as a suggestion for the operator, who adopts it as a directive or tells you to stop; you get a notice either way. It is ignored when a directive in force for you already says the same thing. Once per rule; reporting the same title again updates your suggestion. You may propose a category; the operator confirms or changes it.', {
    title: z.string().min(1).max(120).describe(forOperator('The rule in a few words.')), source: z.string().max(500).optional().describe('Where it lives: a file path, a prompt, "chat with Bruno, 6 Nov"'),
    summary: z.string().min(1).max(1000).describe(forOperator('What it asks you to do, in a few lines.')), text: z.string().max(20000).optional().describe('The rule\'s own text, if you have it'),
    category: z.enum(CATEGORY_IDS).optional().describe(`Your proposed category, one of: ${catList}. The operator confirms it when reviewing.`),
  }, true, async (ctx, a) => {
    const r = run(() => dirs.report(me(ctx), a));
    if (r.known) return { text: `Already a rule: directive ${r.known.id} ("${r.known.title}", v${r.known.version}) says this. Follow the hub's version: directives_read {id: "${r.known.id}", ack: true}.`, data: { status: 'known', report_id: r.id, directive_id: r.known.id, version: r.known.version } };
    return { text: `Suggested to ${r.team_label ? `team "${r.team_label}"` : 'the operator'} as "${r.title}".${r.category ? ` Proposed category: ${categoryLabel(r.category)}.` : ''} Keep following it until the operator decides; you get a notice then.`, data: { status: 'open', report_id: r.id, team_id: r.team_id, proposed_category: r.category } };
  });
}
