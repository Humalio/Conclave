import type { Db } from '../db/db.js';
import { randomToken } from '../util/crypto.js';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';

export interface Link { id: string; from_agent_id: string; to_agent_id: string; kind: string; note: string | null; grants_messaging: boolean; created_by: string | null; created_at: number }
type Row = Omit<Link, 'grants_messaging'> & { grants_messaging: number; removed_at: number | null };
const out = (r: Row): Link => ({ id: r.id, from_agent_id: r.from_agent_id, to_agent_id: r.to_agent_id, kind: r.kind, note: r.note, grants_messaging: r.grants_messaging === 1, created_by: r.created_by, created_at: r.created_at });

export class Links {
  constructor(private readonly db: Db, private readonly keys: Keys, private readonly audit: Audit) {}
  list(agentId?: string): Link[] {
    const rows = agentId ? this.db.prepare('SELECT * FROM agent_links WHERE removed_at IS NULL AND (from_agent_id=? OR to_agent_id=?) ORDER BY created_at').all(agentId, agentId)
      : this.db.prepare('SELECT * FROM agent_links WHERE removed_at IS NULL ORDER BY created_at').all();
    return (rows as unknown as Row[]).map(out);
  }
  get(id: string): Link {
    const r = this.db.prepare('SELECT * FROM agent_links WHERE id=? AND removed_at IS NULL').get(id) as unknown as Row | undefined;
    if (!r) throw new KeyError('not_found', 'link not found');
    return out(r);
  }
  create(o: { from: string; to: string; kind: string; note?: string | null; grantsMessaging?: boolean }, actor: Actor): Link {
    if (o.from === o.to) throw new KeyError('invalid_argument', 'an agent cannot link to itself');
    const a = this.keys.agent(o.from), b = this.keys.agent(o.to);
    if (!a || !b) throw new KeyError('not_found', 'agent not found');
    if (this.db.prepare('SELECT 1 FROM agent_links WHERE removed_at IS NULL AND from_agent_id=? AND to_agent_id=? AND kind=?').get(o.from, o.to, o.kind)) throw new KeyError('conflict', 'this link already exists');
    const id = `lnk_${randomToken(10)}`;
    this.db.prepare('INSERT INTO agent_links(id,from_agent_id,to_agent_id,kind,note,grants_messaging,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, o.from, o.to, o.kind, o.note ?? null, o.grantsMessaging ? 1 : 0, actor.kind === 'admin' ? actor.id : null, Date.now());
    this.audit.event(actor, 'link.create', { kind: 'link', id }, { from: o.from, to: o.to, kind: o.kind });
    this.keys.notify(a.id, 'link_added', `The administrator linked you to ${b.label} (${b.id}): ${o.kind}.`);
    this.keys.notify(b.id, 'link_added', `The administrator linked ${a.label} (${a.id}) to you: ${o.kind}.`);
    return this.get(id);
  }
  update(id: string, p: { kind?: string; note?: string | null; grantsMessaging?: boolean }, actor: Actor): Link {
    const l = this.get(id);
    this.db.prepare('UPDATE agent_links SET kind=?, note=?, grants_messaging=? WHERE id=?').run(p.kind ?? l.kind, p.note === undefined ? l.note : p.note, (p.grantsMessaging ?? l.grants_messaging) ? 1 : 0, id);
    this.audit.event(actor, 'link.update', { kind: 'link', id }, p);
    return this.get(id);
  }
  remove(id: string, actor: Actor): void {
    const l = this.get(id);
    this.db.prepare('UPDATE agent_links SET removed_at=? WHERE id=?').run(Date.now(), id);
    this.audit.event(actor, 'link.remove', { kind: 'link', id });
    for (const [x, y] of [[l.from_agent_id, l.to_agent_id], [l.to_agent_id, l.from_agent_id]] as const) {
      const o = this.keys.agent(y);
      if (o) this.keys.notify(x, 'link_removed', `Your link to ${o.label} (${o.id}) (${l.kind}) was removed by the administrator.`);
    }
  }
  /** For session_whoami: who I am linked to. */
  forAgent(agentId: string) {
    return this.list(agentId).map((l) => {
      const other = this.keys.agent(l.from_agent_id === agentId ? l.to_agent_id : l.from_agent_id)!;
      return { id: l.id, kind: l.kind, direction: l.from_agent_id === agentId ? 'outgoing' : 'incoming', agent_id: other.id, label: other.label, role: other.role, note: l.note };
    });
  }
}
