/** Emergency lockdown scopes (F7). Flags live in system_settings and survive restarts; admins are never affected. */
import type { Db } from '../db/db.js';
import { KeyError } from '../keys/keys.js';

export type LockKind = 'writes' | 'vault' | 'agent' | 'pc' | 'team';
export const LOCK_KINDS: LockKind[] = ['writes', 'vault', 'agent', 'pc', 'team'];

/** Tools that change state. A lockdown on the agent, its PC or all writes refuses these; reads and work_next stay open. */
export const WRITE_TOOLS = new Set(['file_create', 'file_update', 'file_patch', 'file_rename', 'file_delete', 'file_restore',
  'message_send', 'room_create', 'room_join', 'room_leave', 'room_invite',
  'share_create', 'share_upload', 'share_comment', 'share_suggest', 'share_resolve', 'share_promote', 'share_close',
  'channel_open', 'channel_accept', 'channel_send', 'channel_close',
  'task_create', 'task_update', 'task_assign', 'task_claim', 'task_start', 'task_progress', 'task_submit', 'task_review', 'task_complete', 'task_block', 'task_cancel',
  'team_report', 'team_complete', 'graph_job_submit', 'graph_upsert', 'graph_summary_write']);
/** Tools that write into the vault. */
export const VAULT_WRITE_TOOLS = new Set(['file_create', 'file_update', 'file_patch', 'file_rename', 'file_delete', 'file_restore', 'share_promote']);

const key = (kind: LockKind, id?: string) => kind === 'writes' ? 'emergency.writes_disabled' : `emergency.${kind}_disabled.${id}`;

export class Lockdown {
  constructor(private readonly db: Db, private readonly vaultAlias: string) {}

  private get(k: string): boolean {
    const r = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(k) as { value: string } | undefined;
    return r ? JSON.parse(r.value) === true : false;
  }
  set(kind: LockKind, id: string | undefined, on: boolean, _adminId: string | null): void {
    if (kind !== 'writes' && !id) throw new KeyError('invalid_argument', `${kind} lockdown needs an id`);
    const k = key(kind, id);
    if (on) this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(k, 'true', Date.now());
    else this.db.prepare('DELETE FROM system_settings WHERE key=?').run(k);
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
    if (WRITE_TOOLS.has(tool)) {
      if (this.writes()) return 'All agent writes are disabled by the administrator (lockdown).';
      if (agentId && this.agent(agentId)) return 'This agent is locked down by the administrator.';
      if (this.pc(machineId)) return 'This PC is locked down by the administrator.';
    }
    if (VAULT_WRITE_TOOLS.has(tool) && this.vault()) return 'The vault is locked down by the administrator.';
    return null;
  }
}
