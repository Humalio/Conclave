-- A reported rule is a suggestion to the reporter's team (docs/directives.md#suggestions-from-agents): the team it was
-- filed for, and the category the agent proposed. Both NULL on reports made before.
ALTER TABLE directive_reports ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE directive_reports ADD COLUMN category TEXT;
