/** MCP tools for directives (docs/directives.md): directives_list, directives_read, directive_ack, directives_report. */
import { z } from 'zod';
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
  reg('directives_read', 'Read the text of your directives in force (L0), one by id or all. Then confirm each with directive_ack.', { id: z.string().max(100).optional() }, true, async (ctx, a) => {
    const L = run(() => dirs.read(me(ctx), a.id));
    return { text: L.map((d) => `## ${d.title} (${d.id} v${d.version}, for ${dirs.scopeLabel(d)})\n${d.body}`).join('\n\n') || 'No directives in force for you.',
      data: { trust: 'L0', directives: L.map((d) => ({ id: d.id, title: d.title, version: d.version, scope: dirs.scopeLabel(d), category: d.category, tags: d.tags, text: d.body, acked_version: d.acked_version })) } };
  });
  reg('directive_ack', 'Confirm you read the current version of a directive, so the operator can see you follow it.', { id: z.string().max(100), version: z.number().int().min(1) }, true, async (ctx, a) => {
    const r = run(() => dirs.ack(me(ctx), a.id, a.version));
    return { text: `Confirmed ${r.id} v${r.version}.`, data: r };
  });
  reg('directives_report', 'Register a rule you follow that is not a hub directive yet (a rules file, a prompt section, an instruction from chat). It becomes a directive in force for you at once; the operator may later revise, merge or retire it, and you get a notice if so. Once per rule; reporting the same title again updates it. You may propose a category; the operator confirms or changes it.', {
    title: z.string().min(1).max(120), source: z.string().max(500).optional().describe('Where it lives: a file path, a prompt, "chat with Bruno, 6 Nov"'),
    summary: z.string().min(1).max(1000).describe('What it asks you to do, in a few lines'), text: z.string().max(20000).optional().describe('The rule\'s own text, if you have it'),
    category: z.enum(CATEGORY_IDS).optional().describe(`Your proposed category, one of: ${catList}. The operator confirms it when reviewing.`),
  }, true, async (ctx, a) => {
    const r = run(() => dirs.report(me(ctx), a));
    return { text: `Registered as directive ${r.directive_id} v${r.version}, in force for you.${r.proposed_category ? ` Proposed category: ${categoryLabel(r.proposed_category)}.` : ''} The operator may revise it later.`, data: { directive_id: r.directive_id, version: r.version, report_id: r.id, proposed_category: r.proposed_category } };
  });
}
