-- Blueprint phase 6b: "Start over" (re-plan) for a whole project or one team's part (docs/blueprint.md §4, §6, §8).
-- A re-plan keeps a snapshot (the export as it was, and the rows it may restore), marks the items it reset, and is
-- finished by one proposal of type `replan` that the operator applies or rejects as a whole, or cancelled (restored).
CREATE TABLE bp_replans (
  id              TEXT PRIMARY KEY,                       -- bpr_…
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id         TEXT REFERENCES teams(id) ON DELETE SET NULL,  -- NULL: the whole project
  kinds           TEXT NOT NULL CHECK (json_valid(kinds)),       -- the kinds it reset
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','cancelled')),
  snapshot        TEXT NOT NULL,                          -- export.md before any change
  saved           TEXT NOT NULL CHECK (json_valid(saved)),        -- the reset items' rows and their links, to restore on cancel
  base_version    INTEGER NOT NULL,                       -- the project version before the reset
  source          TEXT NOT NULL DEFAULT 'operator' CHECK (source IN ('operator','import')),
  opened_by_kind  TEXT NOT NULL,
  opened_by_id    TEXT,
  opened_at       INTEGER NOT NULL,
  closed_by       TEXT,
  closed_at       INTEGER,
  close_note      TEXT
);
CREATE INDEX bp_replans_project ON bp_replans(project_id, status);

ALTER TABLE bp_items ADD COLUMN replan_id TEXT;
ALTER TABLE bp_proposals ADD COLUMN type TEXT NOT NULL DEFAULT 'ops' CHECK (type IN ('ops','replan'));
ALTER TABLE bp_proposals ADD COLUMN replan_id TEXT;
