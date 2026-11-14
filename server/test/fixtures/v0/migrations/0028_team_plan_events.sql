-- The plan's history for the team's Objective screen (docs/dashboard-ux.md, Objective): each plan update by the
-- coordinator (what was added, removed or changed) and each review request by the operator, with its note.
CREATE TABLE team_plan_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('update', 'review_request')),
  actor_kind TEXT NOT NULL,
  actor_id   TEXT,
  version    INTEGER,
  items      INTEGER,
  added      TEXT NOT NULL DEFAULT '[]',
  removed    TEXT NOT NULL DEFAULT '[]',
  changed    TEXT NOT NULL DEFAULT '[]',
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_team_plan_events ON team_plan_events(team_id, created_at);
