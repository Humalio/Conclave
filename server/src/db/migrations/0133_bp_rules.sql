-- Blueprint rules the operator turns on (docs/blueprint.md §4 Rules, ADR-006): a named kind of change one team of a project
-- applies without a proposal. The kinds are a fixed list in the hub (kinds.ts BP_RULES); the list holds release_notes only.
-- A row is a rule that is on or paused for that team; turning it off deletes the row (the audit log keeps every change).
CREATE TABLE bp_rules (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL CHECK (rule IN ('release_notes')),
  state      TEXT NOT NULL CHECK (state IN ('on', 'paused')),
  on_since   INTEGER NOT NULL,            -- when it was last turned on (a pause keeps it)
  set_by     TEXT,                        -- the console user who last changed it
  set_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, team_id, rule)
);
-- The rule that applied a write and the keys it covered ({"rule": "release_notes", "keys": ["REL-1.4"]}); NULL otherwise.
ALTER TABLE bp_events ADD COLUMN rule TEXT CHECK (rule IS NULL OR json_valid(rule));
CREATE INDEX bp_events_rule ON bp_events(project_id, team_id, created_at) WHERE rule IS NOT NULL;
