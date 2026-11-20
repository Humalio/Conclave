/** MCP tools for shared compute machines (docs/hardware.md): hw_list, hw_join, hw_report, hw_leave. */
import { z } from 'zod';
import type { Hardware } from '../hardware/hardware.js';

type Out = { text: string; data: Record<string, unknown> };
type Reg = (name: string, description: string, shape: z.ZodRawShape, needsToken: boolean, fn: (ctx: any, a: any) => Promise<Out>) => void;

const MACHINE = z.string().min(1).max(100).describe('The machine\'s name or id, as hw_list shows it.');
const MINUTES = z.number().int().min(1).max(10_080);

export function registerHardwareTools(reg: Reg, hw: Hardware): void {
  reg('hw_list', 'Shared compute machines your teams may use: how to reach each one (an SSH alias or instructions; credentials stay on your PC), its time zone and opening hours (open now and until when, or the next window), whether the operator paused it, your teams\' daily hours left and when they reset, the memory, CPU and GPU limits the operator declared, who holds it and who is waiting. The machine goes to the next eligible entry only while it is open, not paused, and the entry\'s team has hours left. The hub records what holders report and never measures the machine. Other teams\' entries show without names or tasks.', {}, true, async (ctx) => {
    const r = hw.list(ctx.session.agent.id);
    return { text: r.text, data: r.data };
  });

  reg('hw_join', 'Join a machine\'s ordered waiting list for one of your tasks (assigned, in progress or changes requested, in a team the machine serves). The first eligible entry holds the machine: while it is open and not paused, and its team has hours left today (and at least the estimate). You may join while it is closed or paused and wait; a join is refused when your team has no hours left today, with the reset time. You get a notice when you hold it, and 10 minutes before its window or your team\'s hours end. Being on the list grants no access to the machine. estimate_minutes: how long you expect to need it once you hold it.', {
    machine: MACHINE, task_id: z.string().min(1).max(100), estimate_minutes: MINUTES.optional(),
  }, true, async (ctx, a) => {
    const r = hw.join(ctx.session.agent.id, a.machine, a.task_id, a.estimate_minutes ?? null);
    return {
      text: r.holder ? `You hold ${r.machine} now. Stay within the limits hw_list shows, report progress with hw_report, and call hw_leave when you are done or stop.`
        : `You are on ${r.machine}'s waiting list, number ${r.line} in line${r.why ? `, and nobody holds it because ${r.why}` : ''}. You get a notice when you hold it; until then, do not use the machine.`,
      data: { machine: r.machine, holder: r.holder, position: r.position, line: r.line, waiting_because: r.why || null },
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
