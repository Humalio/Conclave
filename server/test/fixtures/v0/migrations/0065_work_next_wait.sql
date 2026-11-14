-- work_next waits about 25 s for new work when the call names no wait_seconds (docs/mcp.md §5). The shipped playbooks say so.
-- A team's playbook is changed only where it still equals the shipped default for its role, so an operator's edit is kept;
-- the defaults themselves are not operator-editable and always change. The handoff text is built in code (teams.ts).
UPDATE team_roles SET playbook=replace(playbook, 'Your loop: call work_next;', 'Your loop: call work_next (it waits about 25 s for new work);')
  WHERE playbook=(SELECT d.playbook FROM team_role_defaults d WHERE d.role=team_roles.role);
UPDATE team_role_defaults SET playbook=replace(playbook, 'Your loop: call work_next;', 'Your loop: call work_next (it waits about 25 s for new work);');
