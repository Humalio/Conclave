/**
 * Directive reach as SQL (docs/directives.md): the same rule as Directives.applies(), for queries that cannot call it,
 * such as the notice settlers in keys.ts. A directive is in force for an agent when it is active, the agent is not
 * archived, its scope covers the agent, and no active exemption keeps it off the agent's id, one of its live teams or
 * the project of one of its live teams. A live team is one not done or stopped; membership counts while removed_at is
 * unset. A project is a Blueprint project id, matched through teams.project_id (docs/directives.md#project-reach); the
 * agent's own project label plays no part. While owner enforcement is on, only eligible memberships put an agent in a
 * project's scope: its owner is an active admin, or the owner's grant on the project delegates that team (eligibleSql).
 * A project exemption is an exclusion and takes in every live member, eligible or not.
 * Kept free of imports so keys.ts can use it without an import cycle.
 * directive-exemptions.test.ts checks that it agrees with applies().
 */

/** The agent (alias `ag`) is a current member of a live team that matches `cond` (on m = team_members, t = teams). */
const liveMember = (ag: string, cond: string) =>
  `EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.agent_id=${ag}.id AND m.removed_at IS NULL AND t.status NOT IN ('done','stopped') AND ${cond})`;

/**
 * The membership (t = teams) counts toward the agent's projects (docs/directives.md#project-reach): owner enforcement is
 * off, or the agent's owner is an active, unexpired console user who is an admin or whose grant on the team's project
 * delegates the team. The same rule as OwnerScope's team work and Directives.resolver()'s eligible().
 */
const eligibleSql = (ag: string) => `(NOT (EXISTS (SELECT 1 FROM system_settings s WHERE s.key='agent_owner.claim')
      AND EXISTS (SELECT 1 FROM system_settings s WHERE s.key='agent_owner.enforcement' AND s.value='true'))
    OR EXISTS (SELECT 1 FROM admin_users u WHERE u.id=${ag}.owner_user_id AND u.status='active'
      AND (u.expires_at IS NULL OR u.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))
      AND (u.role='admin' OR EXISTS (SELECT 1 FROM user_project_grants g, json_each(COALESCE(NULLIF(g.delegation, ''), '{}'), '$.teams') j
        WHERE g.user_id=u.id AND g.project_id=t.project_id AND j.value=t.id))))`;

/** SQL condition: directive row `d` is in force for agent row `ag` (both already joined by the caller). */
export const inForceSql = (d: string, ag: string): string => `(${d}.status='active' AND ${ag}.archived_at IS NULL AND ${ag}.status<>'archived'
  AND (${d}.scope_kind='hub'
    OR (${d}.scope_kind='project' AND ${liveMember(ag, `t.project_id=${d}.scope_ref AND ${eligibleSql(ag)}`)})
    OR (${d}.scope_kind='agent' AND ${d}.scope_ref=${ag}.id)
    OR (${d}.scope_kind='team' AND ${liveMember(ag, `m.team_id=${d}.scope_ref`)})
    OR (${d}.scope_kind='role' AND ${liveMember(ag, `m.team_id || '|' || m.role=${d}.scope_ref`)}))
  AND NOT EXISTS (SELECT 1 FROM directive_exemptions x WHERE x.directive_id=${d}.id AND x.removed_at IS NULL AND (
    (x.target_kind='agent' AND x.target_ref=${ag}.id)
    OR (x.target_kind='project' AND ${liveMember(ag, 't.project_id=x.target_ref')})
    OR (x.target_kind='team' AND ${liveMember(ag, 'm.team_id=x.target_ref')}))))`;
