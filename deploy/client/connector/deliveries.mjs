/**
 * Delivery orders on the PC (docs/connector.md, "Delivery orders"). The hub's `deliver` order says that items wait on one of
 * this PC's agents. Until the wake ships on a platform, the connector cannot start that agent's session; it keeps what
 * waits here, shows it on its local screen, and the folder's prompt hook shows one fixed line at the agent's next prompt
 * (never on Stop). A line carries only fixed words and counts: never an id or any text of the item.
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite } from './paths.mjs';

/** Fixed words for each kind of item that needs a turn. */
export const NOTICE_WORDS = {
  task_assigned: ['task assigned to you', 'tasks assigned to you'],
  changes_requested: ['task sent back with changes', 'tasks sent back with changes'],
  review_requested: ['review asked of you', 'reviews asked of you'],
  decision: ['decision answered', 'decisions answered'],
  task_accepted: ['backlog task accepted', 'backlog tasks accepted'],
  team_resumed: ['team resumed', 'team resumed'],
  message: ['message', 'messages'],
  plan_request: ['plan or refinement asked', 'plans or refinements asked'],
  task_approved: ['task approved', 'tasks approved'],
  task_blocked: ['task blocked', 'tasks blocked'],
  decision_asked: ['operator question asked', 'operator questions asked'],
};
const pathOf = (home, hubKey) => join(home, 'deliveries', `${createHash('sha256').update(hubKey).digest('hex').slice(0, 24)}.json`);

/** Remembers the items of a delivered order for its agent. Returns how many are waiting for that agent. */
export function recordDelivery(home, hubKey, order, now = Date.now()) {
  const p = pathOf(home, hubKey), d = readJson(p, { agents: {} }) ?? { agents: {} };
  const list = Array.isArray(d.agents?.[order.payload.agent_id]) ? d.agents[order.payload.agent_id] : [];
  for (const i of order.payload.items) list.push({ notice: i.notice, at: now });
  d.agents = { ...d.agents, [order.payload.agent_id]: list.slice(-40) };
  atomicWrite(p, JSON.stringify(d) + '\n');
  return list.length;
}
/** What waits for each agent of this hub: `{agent_id: [{notice, at}]}`. */
export function waiting(home, hubKey) { return readJson(pathOf(home, hubKey), { agents: {} })?.agents ?? {}; }
/** The items for one agent, removed: the prompt hook shows them once. */
export function takeFor(home, hubKey, agentId) {
  const p = pathOf(home, hubKey), d = readJson(p, { agents: {} }) ?? { agents: {} };
  const list = Array.isArray(d.agents?.[agentId]) ? d.agents[agentId] : [];
  if (list.length) { delete d.agents[agentId]; atomicWrite(p, JSON.stringify(d) + '\n'); }
  return list;
}
/** The line for items `[{notice}]`, or null: fixed words and counts only. */
export function deliveryLine(items) {
  const counts = new Map();
  for (const i of items ?? []) if (Object.hasOwn(NOTICE_WORDS, i?.notice)) counts.set(i.notice, (counts.get(i.notice) ?? 0) + 1);
  if (!counts.size) return null;
  const parts = [...counts].map(([k, n]) => `${n} ${NOTICE_WORDS[k][n === 1 ? 0 : 1]}`);
  return `Conclave: waiting for you: ${parts.join('; ')}. Check \`task_list\` and \`message_read\`.`;
}

/** This installation's id, made once: the hub tells a second installation using the same app key from the first (docs/connector.md, "The push stream"). */
export function installationId(home) {
  const p = join(home, 'installation.json');
  const d = readJson(p, null);
  if (typeof d?.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(d.id)) return d.id;
  const id = createHash('sha256').update(`${home}|${process.pid}|${Date.now()}|${Math.random()}`).digest('base64url').slice(0, 22);
  atomicWrite(p, JSON.stringify({ id }) + '\n');
  return id;
}
