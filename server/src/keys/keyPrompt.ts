/**
 * Key prompts (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key): the text the console shows for a new,
 * rotated or reissued session key. For a key with a known PC it carries a single-use pickup code and the steps to swap it
 * for the key on that PC; for a free key with no PC, the raw key (the one accepted exception, docs/threat-model.md).
 * Built only from what the hub knows (the key's variable, its PC, the client of the request that made it), never a guess.
 */

/** The console's tool groups (public/app.js TG), in its order: name and tool patterns; the last one takes the rest. */
export const TOOL_GROUPS: [string, string[] | null][] = [
  ['Files', ['file_*']], ['Messages', ['message_*', 'agent_list']], ['Rooms', ['room_*']], ['Teams and tasks', ['team_*', 'work_*', 'task_*']],
  ['Shares', ['share_*']], ['Channels', ['channel_*']], ['Knowledge graph', ['graph_*']], ['Access and setup', ['access_*', 'setup_*']], ['Other', null],
];
export const toolGroup = (t: string): string =>
  (TOOL_GROUPS.find(([, g]) => g && g.some((p) => (p.endsWith('*') ? t.startsWith(p.slice(0, -1)) : t === p))) ?? TOOL_GROUPS.at(-1)!)[0];

const list = (names: string[]): string => names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const orList = (names: string[]): string => names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;

/**
 * The prompt's last line, from the key's effective tools: the groups with at least one allowed tool, then the groups with
 * none. "Other" holds the login tools, so it is always on the first list.
 */
export function toolsLine(tools: { tool: string; allowed: boolean }[]): string {
  const may = new Set<string>(), seen = new Set<string>();
  for (const t of tools) { const g = toolGroup(t.tool); seen.add(g); if (t.allowed) may.add(g); }
  const order = TOOL_GROUPS.map(([g]) => g);
  const yes = order.filter((g) => may.has(g)), no = order.filter((g) => seen.has(g) && !may.has(g));
  return `This key may use ${yes.length ? `${list(yes)} tools` : 'no tools'}.${no.length ? ` It may not use ${orList(no)}.` : ''}`;
}

export type PromptClient = 'codex' | 'claude_code' | 'unknown';
/** The client of the request that made the key, from its `client.app`; anything else is unknown. */
export function clientOf(app: string | null | undefined): PromptClient {
  if (!app) return 'unknown';
  if (/codex/i.test(app)) return 'codex';
  if (/claude/i.test(app)) return 'claude_code';
  return 'unknown';
}

const CHAT_WARNING = 'Do not paste this prompt, or the key it gives, into a chat with a person or another agent.';

export interface PickupPrompt {
  hubUrl: string; setupSha256: string | null; code: string; expiresAt: number; pc: string; sessionVar: string;
  agent: string; client: PromptClient; folder?: string | null; tools: string; reason: 'new' | 'rotated' | 'reissued';
  /** Through a registered relay (docs/relay.md): hubUrl is then the relay's origin, and the prompt names its CA and release base. */
  relay?: { name: string; origin: string; ca_sha256: string; release_base: string };
}

/** The prompt for a key with a known PC: the pickup code and the steps, never the key, never session_login. */
export function pickupPrompt(p: PickupPrompt): string {
  const what = p.reason === 'new' ? 'a new Conclave session key' : p.reason === 'rotated' ? 'the rotated Conclave session key' : 'a fresh Conclave session key';
  const restart = `Then restart the agent's client on ${p.pc}, so its session starts again with the new key. If the session shows no hub tools, run \`conclave check\` in the agent's folder${p.folder ? ` (${p.folder})` : ''} and report its output.`;
  const expires = new Date(p.expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return [
    `Install ${what} for the agent "${p.agent}" on this PC (${p.pc}).`,
    '',
    `Hub: ${p.hubUrl}`,
    ...(p.relay ? [`Through relay "${p.relay.name}". Relay CA certificate SHA-256: ${p.relay.ca_sha256}`, `Release base (signed connector updates): ${p.relay.release_base}`] : []),
    `Key pickup code (single use, works only on ${p.pc}, until ${expires}): ${p.code}`,
    `The Conclave connector on ${p.pc} keeps the key in its own key file, for the agent's entry ${p.sessionVar}. The agent never reads it.`,
    '',
    'Rules: never print, log or commit the key or this code; never write the key into a file inside a repository. ' + CHAT_WARNING,
    '',
    'Steps:',
    `1. Give the code to the connector on ${p.pc} as docs/connector.md describes ("Collecting a rotated key"). It swaps the code for the key and stores it; nothing prints it.`,
    `2. ${restart}`,
    '',
    p.tools,
  ].join('\n');
}

/** The fallback for a free key with no PC: the raw key, shown once, with the chat warning. */
export function secretPrompt(p: { secret: string; agent: string; tools: string; reason: 'new' | 'rotated' | 'reissued' }): string {
  const what = p.reason === 'new' ? 'A new Conclave session key' : p.reason === 'rotated' ? 'The rotated Conclave session key' : 'A fresh Conclave session key';
  return [
    `${what} for the agent "${p.agent}". This key is not bound to a PC, so it is shown here once.`,
    '',
    `Key: ${p.secret}`,
    '',
    'Give it to the Conclave connector on the agent\'s PC (docs/connector.md: it keeps the key in its own key file), then restart the agent\'s client. The agent itself never reads the key or calls session_login.',
    'Never print, log or commit the key, and never write it into a file inside a repository. ' + CHAT_WARNING,
    '',
    p.tools,
  ].join('\n');
}
