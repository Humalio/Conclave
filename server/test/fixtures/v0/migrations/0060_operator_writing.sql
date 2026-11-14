-- Agents write for the operator (src/mcp/writing.ts): status report bullets are plain sentences, not bare item keys.
-- Existing teams keep their own playbook copies, so the phrase is replaced in both tables.
UPDATE team_roles SET playbook=replace(playbook, 'with item keys instead of prose', 'each a plain sentence the operator takes in at a glance');
UPDATE team_role_defaults SET playbook=replace(playbook, 'with item keys instead of prose', 'each a plain sentence the operator takes in at a glance');
