-- Team status: every coordinator team_report is kept as the team's status report, newest first.
-- The administrator can ask for a fresh one; the request stays open until the next report.
CREATE TABLE team_status_reports (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id),
  agent_id    TEXT REFERENCES agents(id),
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX team_status_reports_team ON team_status_reports(team_id, created_at DESC);
ALTER TABLE teams ADD COLUMN status_requested_at INTEGER;
ALTER TABLE teams ADD COLUMN status_request_note TEXT;
