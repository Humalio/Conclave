/** Emergency lockdown scopes (F7). Flags live in system_settings and survive restarts; admins are never affected. */
import type { Db } from '../db/db.js';
import { KeyError } from '../keys/keys.js';

export type LockKind = 'writes' | 'vault' | 'agent' | 'pc' | 'team';
export const LOCK_KINDS: LockKind[] = ['writes', 'vault', 'agent', 'pc', 'team'];

/**
 * Tools a lockdown leaves open: reads, the session's own housekeeping (login, ack, describe), asking for access,
 * and the PC setup handshake. Everything else counts as a write, so a tool added later is locked down by default
 * instead of being forgotten.
 */
export const OPEN_TOOLS = new Set(['session_login', 'session_help', 'session_logout', 'session_whoami', 'session_describe', 'session_ack',
  'setup_pc', 'setup_status', 'access_list', 'access_request', 'access_status', 'access_check',
  'agent_list', 'message_read', 'message_ack', 'message_history', 'room_list', 'team_info', 'work_next', 'work_ack', 'task_list',
  'file_list', 'file_read', 'file_stat', 'file_search', 'file_download', 'file_history', 'file_diff', 'file_conflicts',
  'share_list', 'share_info', 'share_read', 'share_diff', 'share_feedback', 'share_download', 'channel_list', 'channel_receive', 'channel_status',
  'feedback_find', 'feedback_read', 'team_decisions', 'bp_read', 'bp_proposals', 'directives_list', 'directives_read', 'graph_related', 'graph_impact', 'graph_query', 'graph_context', 'graph_summary', 'graph_stale', 'graph_health', 'checkout_status']);
/** Does this tool change shared state? A lockdown on the agent, its PC or all writes refuses these. */
export const isWriteTool = (tool: string): boolean => !OPEN_TOOLS.has(tool);
/** Tools that write into the vault. */
export const VAULT_WRITE_TOOLS = new Set(['file_create', 'file_update', 'file_patch', 'file_rename', 'file_delete', 'file_restore', 'share_promote']);

const key = (kind: LockKind, id?: string) => kind === 'writes' ? 'emergency.writes_disabled' : `emergency.${kind}_disabled.${id}`;

export class Lockdown {
  constructor(private readonly db: Db, private readonly vaultAlias: string) {}
  /** Set in app.ts: a scope was lifted that had been on since `since`, so the teams restart the leases it held (Teams.holdLifted). */
  /** Set in app.ts: a lockdown went on (a PC's push stream closes). */
  onSet?: (kind: LockKind, id: string | undefined) => void;
  onLift?: (kind: LockKind, id: string | undefined, since: number) => void;

  private get(k: string): boolean {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(k) as { value: string } | undefined;
    return r ? JSON.parse(r.value) === true : false;
  }
  set(kind: LockKind, id: string | undefined, on: boolean, _adminId: string | null): void {
    if (kind !== 'writes' && !id) throw new KeyError('invalid_argument', `${kind} lockdown needs an id`);
    const k = key(kind, id);
    if (on) this.onSet?.(kind, id);
    if (on) this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(k, 'true', Date.now());
    else {
      const was = this.db.prepare("SELECT updated_at FROM system_settings WHERE key=? AND value='true'").get(k) as { updated_at: number } | undefined;
      this.db.prepare('DELETE FROM system_settings WHERE key=?').run(k);
      if (was) this.onLift?.(kind, id, was.updated_at);
    }
  }
  writes(): boolean { return this.get('emergency.writes_disabled'); }
  vault(): boolean { return this.get(key('vault', this.vaultAlias)); }
  agent(id: string): boolean { return this.get(key('agent', id)); }
  pc(id: string | null): boolean { return !!id && this.get(key('pc', id)); }
  team(id: string): boolean { return this.get(key('team', id)); }

  /** Active scopes, for the console. */
  list(): { writes_disabled: boolean; vaults: string[]; agents: string[]; pcs: string[]; teams: string[] } {
    const rows = this.db.prepare("SELECT key FROM system_settings WHERE key LIKE 'emergency.%_disabled.%' AND value='true'").all() as { key: string }[];
    const of = (k: string) => rows.map((r) => r.key).filter((s) => s.startsWith(`emergency.${k}_disabled.`)).map((s) => s.slice(`emergency.${k}_disabled.`.length));
    return { writes_disabled: this.writes(), vaults: of('vault'), agents: of('agent'), pcs: of('pc'), teams: of('team') };
  }

  /** Why this tool call must be refused for this caller, or null. */
  blocks(tool: string, agentId: string | null, machineId: string | null): string | null {
    if (isWriteTool(tool)) {
      if (this.writes()) return 'All agent writes are disabled by the administrator (lockdown).';
      if (agentId && this.agent(agentId)) return 'This agent is locked down by the administrator.';
      if (this.pc(machineId)) return 'This PC is locked down by the administrator.';
    }
    if (VAULT_WRITE_TOOLS.has(tool) && this.vault()) return 'The vault is locked down by the administrator.';
    return null;
  }
}
