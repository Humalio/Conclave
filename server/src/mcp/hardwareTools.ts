/** MCP tools for shared compute machines (docs/hardware.md): hw_list, hw_join, hw_report, hw_leave. */
import { z } from 'zod';
import type { Hardware } from '../hardware/hardware.js';

type Out = { text: string; data: Record<string, unknown> };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;

const MACHINE = z.string().min(1).max(100).describe('The machine\'s name or id, as hw_list shows it.');
const MINUTES = z.number().int().min(1).max(10_080);

export function registerHardwareTools(reg: Reg, hw: Hardware): void {
  reg('hw_list', 'Shared compute machines your teams may use: how to reach each one (an SSH alias or instructions; credentials stay on your PC), its time zone and scheduled windows, the memory, CPU and GPU limits the operator declared, who holds it and who is waiting. The hub coordinates only: it records what holders report and never measures the machine. Other teams\' entries show without names or tasks.', {}, true, async (ctx) => {
    const r = hw.list(ctx.session.agent.id);
    return { text: r.text, data: r.data };
  });

  reg('hw_join', 'Join a machine\'s ordered waiting list for one of your tasks (assigned, in progress or changes requested, in a team the machine serves). The first entry holds the machine; if nobody does, you hold it at once, otherwise you get a notice when your turn comes. Being on the list grants no access to the machine. estimate_minutes: how long you expect to need it once you hold it.', {
    machine: MACHINE, task_id: z.string().min(1).max(100), estimate_minutes: MINUTES.optional(),
  }, true, async (ctx, a) => {
    const r = hw.join(ctx.session.agent.id, a.machine, a.task_id, a.estimate_minutes ?? null);
    return {
      text: r.holder ? `You hold ${r.machine} now. Stay within the limits hw_list shows, report progress with hw_report, and call hw_leave when you are done or stop.`
        : `You are on ${r.machine}'s waiting list, number ${r.position - 1} in line. You get a notice when you hold it; until then, do not use the machine.`,
      data: { machine: r.machine, holder: r.holder, position: r.position },
    };
  });

  reg('hw_report', 'Holder only: report your progress on the machine you hold (up to 500 characters) and, optionally, a new estimate of the minutes until you finish. The operator sees your last report and estimated finish.', {
    machine: MACHINE, progress: z.string().min(1).max(500), estimate_minutes: MINUTES.optional(),
  }, true, async (ctx, a) => {
    const r = hw.report(ctx.session.agent.id, a.machine, a.progress, a.estimate_minutes ?? null);
    return { text: `Report recorded for ${r.machine}${r.estimate_until ? `; estimated finish ${new Date(r.estimate_until).toISOString()}` : ''}.`, data: { machine: r.machine, estimate_until: r.estimate_until } };
  });

  reg('hw_leave', 'Leave a machine\'s waiting list, or release it if you hold it: outcome "done" when the work is finished, "cancelled" when you stopped or no longer need it. The next entry then holds the machine.', {
    machine: MACHINE, outcome: z.enum(['done', 'cancelled']), note: z.string().max(500).optional(),
  }, true, async (ctx, a) => {
    const r = hw.leave(ctx.session.agent.id, a.machine, a.outcome, a.note?.trim() || null);
    return { text: `You left ${r.machine}'s list (${a.outcome}).${r.moved_up ? ' The next agent in line now holds it.' : ''}`, data: { machine: r.machine, outcome: a.outcome, moved_up: r.moved_up } };
  });
}
