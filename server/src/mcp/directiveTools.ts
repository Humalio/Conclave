/** MCP tools for directives (docs/directives.md): directives_list, directives_read, directive_ack, directives_report. */
import { z } from 'zod';
import { KeyError } from '../keys/keys.js';
import type { Directives } from '../directives/directives.js';

type Out = { text: string; data: Record<string, unknown> };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;
type ToolErrorCtor = new (code: string, message: string, extra?: Record<string, unknown>) => Error;

export function registerDirectiveTools(reg: Reg, dirs: Directives, ToolError: ToolErrorCtor): void {
  const run = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof KeyError) throw new ToolError(e.code, e.message); throw e; } };
  const me = (ctx: any): string => ctx.session.agent.id;

  reg('directives_list', 'The operator\'s standing directives in force for you (L0: follow them), most specific first: id, title, version, scope, and whether you read the current version.', {}, true, async (ctx) => {
    const L = run(() => dirs.summaryFor(me(ctx)));
    return { text: L.length ? L.map((d) => `${d.id} v${d.version} "${d.title}" (${d.scope}) ${d.read === 'current' ? 'read' : d.read === 'outdated' ? 'CHANGED since you read it' : 'NOT READ'}`).join('\n') : 'No directives in force for you.', data: { trust: 'L0', directives: L } };
  });
  reg('directives_read', 'Read the text of your directives in force (L0), one by id or all. Then confirm each with directive_ack.', { id: z.string().max(100).optional() }, true, async (ctx, a) => {
    const L = run(() => dirs.read(me(ctx), a.id));
    return { text: L.map((d) => `## ${d.title} (${d.id} v${d.version}, for ${dirs.scopeLabel(d)})\n${d.body}`).join('\n\n') || 'No directives in force for you.',
      data: { trust: 'L0', directives: L.map((d) => ({ id: d.id, title: d.title, version: d.version, scope: dirs.scopeLabel(d), text: d.body, acked_version: d.acked_version })) } };
  });
  reg('directive_ack', 'Confirm you read the current version of a directive, so the operator can see you follow it.', { id: z.string().max(100), version: z.number().int().min(1) }, true, async (ctx, a) => {
    const r = run(() => dirs.ack(me(ctx), a.id, a.version));
    return { text: `Confirmed ${r.id} v${r.version}.`, data: r };
  });
  reg('directives_report', 'Register a rule you follow that is not a hub directive yet (a rules file, a prompt section, an instruction from chat). It becomes a directive in force for you at once; the operator may later revise, merge or retire it, and you get a notice if so. Once per rule; reporting the same title again updates it.', {
    title: z.string().min(1).max(120), source: z.string().max(500).optional().describe('Where it lives: a file path, a prompt, "chat with Bruno, 6 Nov"'),
    summary: z.string().min(1).max(1000).describe('What it asks you to do, in a few lines'), text: z.string().max(20000).optional().describe('The rule\'s own text, if you have it'),
  }, true, async (ctx, a) => {
    const r = run(() => dirs.report(me(ctx), a));
    return { text: `Registered as directive ${r.directive_id} v${r.version}, in force for you. The operator may revise it later.`, data: { directive_id: r.directive_id, version: r.version, report_id: r.id } };
  });
}
