/**
 * Start team (docs/connector.md, "Reason orders"): the operator wakes every member of a running team for one check-in turn.
 * Each member's PC gets a `deliver` order with reason `team_start`, coordinator first; the turn reads its directives, checks
 * its tasks and stops. A paused team is resumed first. The console reads each member's state from `state()`.
 */
import type { Audit, Actor } from '../audit/audit.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Connector } from '../connector/connector.js';
import type { Teams, MemberRow } from './teams.js';

/** Coordinators first, then the other members in the order they joined. */
const ordered = (ms: MemberRow[]) => [...ms.filter((m) => m.role === 'coordinator'), ...ms.filter((m) => m.role !== 'coordinator')];

export class TeamStart {
  constructor(private teams: Teams, private keys: Keys, private connector: Connector, private audit: Audit) {}

  /** One check-in turn per member. Pressing again while a member's order is open gives that same order, not a second turn. */
  start(teamId: string, actor: Actor) {
    const t = this.teams.mustTeam(teamId);
    if (t.status === 'paused') throw new KeyError('paused', 'The team is paused. Resume it first, then start it.');
    if (t.status !== 'running') throw new KeyError('invalid_state', `The team is ${t.status}; only a running team can be started on its PCs.`);
    const members = ordered(this.teams.members(teamId)).map((m) => {
      const r = this.connector.deliverReason(m.agent_id, 'team_start');
      return { agent_id: m.agent_id, label: this.keys.agent(m.agent_id)?.label ?? m.agent_id, role: m.role, ...('why' in r ? { order: null, why: r.why } : { order: r.order, already: r.already }) };
    });
    this.audit.event(actor, 'team.start_turns', { kind: 'team', id: teamId }, { members: members.length, orders: members.filter((m) => m.order && !m.already).length, without_pc: members.filter((m) => !m.order).length });
    return { team_id: teamId, members };
  }

  /** Where each member stands: its PC, its latest Start team order and the wake's latest report. Ids and fixed words only. */
  state(teamId: string) {
    this.teams.mustTeam(teamId);
    return {
      team_id: teamId,
      members: ordered(this.teams.members(teamId)).map((m) => ({
        agent_id: m.agent_id, label: this.keys.agent(m.agent_id)?.label ?? m.agent_id, role: m.role,
        pc_online: this.connector.pcOnlineOf(m.agent_id),
        order: this.connector.reasonOrderOf(m.agent_id, 'team_start'),
        run: this.connector.wakeStateOf(m.agent_id),
      })),
    };
  }
}
