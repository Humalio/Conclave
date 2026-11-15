/**
 * The Claude Code hook (docs/connector.md, "The folder hook"): `conclave hook --folder <agent folder>`, run by Claude
 * Code when a prompt is submitted and when a session starts. It adds the one reminder line as context and nothing else.
 *
 * - It only ever adds context. It never prints a `decision`, a `continue` or a `stopReason`, so it can never block a prompt
 *   or hold a turn open; any other event (above all Stop, where printed context makes Claude Code continue the turn) gets
 *   no output at all.
 * - It has a short time limit and does nothing on any failure: a hub that is down, slow or refuses, a folder that is not
 *   registered, a key that is gone, or input it does not understand all end in no output and exit code 0.
 * - It runs only in a registered agent folder (the folder is resolved from the connector's own registry), and it is
 *   installed only there, in the folder's project settings (`entries.mjs`), never in the user's own settings.
 * - It tells the hub the lines it showed, so the console can say "Shown to the session (reported by the PC)".
 */
import { resolveContext, signIn } from './context.mjs';
import { request } from './hubclient.mjs';
import { reminderLine } from './reminder.mjs';
import { HOOK_EVENTS } from './entries.mjs';

export const HOOK_TIMEOUT_MS = 3500;

const auth = (ctx) => ({ Authorization: `Bearer ${ctx.appKey}` });

/** The hub's counts for the agent, or null. Never throws. */
export async function fetchCounts(ctx, agentId, timeoutMs) {
  try {
    const r = await request(ctx.hub, 'POST', '/connector/v1/messages/unread', { body: { agent_id: agentId }, headers: auth(ctx), timeoutMs });
    return r.status === 200 && r.json && typeof r.json === 'object' ? r.json : null;
  } catch { return null; }
}

/** Reports the highest message of each room as shown (the line named it). Never throws. */
export async function reportShown(ctx, agentId, rooms, timeoutMs) {
  const list = Array.isArray(rooms) ? rooms.slice(0, 20) : [];
  await Promise.all(list.map(async (r) => {
    if (typeof r?.room_id !== 'string' || !Number.isSafeInteger(r?.top_seq)) return;
    try { await request(ctx.hub, 'POST', '/connector/v1/messages/shown', { body: { agent_id: agentId, room_id: r.room_id, seq: r.top_seq }, headers: auth(ctx), timeoutMs }); } catch { /* the line was still shown */ }
  }));
}

/**
 * The reminder line for an agent folder, or null (nothing waits, or any failure). `report` says the line is about to be
 * shown, so the PC reports it. Used by the hook and by `conclave reminder`.
 */
export async function lineFor(home, folder, { timeoutMs = HOOK_TIMEOUT_MS, report = true } = {}) {
  try {
    const ctx = resolveContext(home, folder);
    if (!ctx.ok) return null;
    const s = await signIn(home, ctx);
    if (!s.ok || !s.agentId) return null;
    const counts = await fetchCounts(ctx, s.agentId, timeoutMs);
    const line = reminderLine(counts);
    if (line && report && counts.total > 0) await reportShown(ctx, s.agentId, counts.rooms, timeoutMs);
    return line;
  } catch { return null; }
}

/**
 * What the hook prints for the hook input `stdin` (Claude Code's JSON), or null for no output. Resolves within
 * `timeoutMs` whatever the hub does.
 */
export async function runHook(home, folder, stdin, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  let event = null;
  try { event = JSON.parse(stdin)?.hook_event_name ?? null; } catch { return null; }
  if (!HOOK_EVENTS.includes(event)) return null; // Stop and every other event: no output, ever
  let timer;
  const line = await Promise.race([
    lineFor(home, folder, { timeoutMs }),
    new Promise((res) => { timer = setTimeout(() => res(null), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return line ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: line } }) : null;
}
