-- Blueprint phase 4b (docs/blueprint.md §6-7, §10 F-04; docs/decisions.md F-34).
-- 1. Report requests per notified team: each team answers for its own part. A project request makes one row per running
--    team of the project; a team status request and a plan review request make one row for that team. bp_report (or
--    team_report) answers the reporting team's open status rows only; a plan write answers its open plan rows.
CREATE TABLE bp_report_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL CHECK (scope IN ('project','team')),
  kind              TEXT NOT NULL CHECK (kind IN ('status','plan')),
  note              TEXT,
  requested_by_kind TEXT NOT NULL,
  requested_by_id   TEXT,
  requested_at      INTEGER NOT NULL,
  answered_at       INTEGER,
  answered_by       TEXT                                   -- the report key (SR-nnn), 'team_report' or 'plan'
);
CREATE INDEX bp_report_requests_open ON bp_report_requests(team_id, kind) WHERE answered_at IS NULL;
CREATE INDEX bp_report_requests_project ON bp_report_requests(project_id, requested_at);
-- Requests still open in the old columns become rows. The project columns were overwritten by the team-plan mirror,
-- so only the team columns are trusted.
INSERT INTO bp_report_requests(project_id,team_id,scope,kind,note,requested_by_kind,requested_at)
  SELECT project_id, id, 'team', 'status', status_request_note, 'operator', status_requested_at FROM teams WHERE status_requested_at IS NOT NULL;
INSERT INTO bp_report_requests(project_id,team_id,scope,kind,note,requested_by_kind,requested_at)
  SELECT project_id, id, 'team', 'plan', plan_request_note, 'operator', plan_requested_at FROM teams WHERE plan_requested_at IS NOT NULL;

-- 2. Blocked tasks remember the status they were blocked from, so task_unblock (and a settled team_ask) restores it.
ALTER TABLE tasks ADD COLUMN blocked_from TEXT;
