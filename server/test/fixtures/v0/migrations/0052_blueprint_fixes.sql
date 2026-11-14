-- Blueprint request records and event indexes (docs/blueprint.md §6, §7).
--   * bp_report_requests is the one record of open status and plan requests, so the copies on teams and projects go:
--     teams.status_requested_at, status_request_note, plan_requested_at, plan_request_note; projects.report_requested_at,
--     report_request_note. 0034 copied the open team requests into rows, and every request since opens a row.
--   * teams.plan_version and plan_updated_at: the team plan lives in the project blueprint, whose version counts writes.
--   * bp_events gets indexes for the team page's plan history (team_id) and the work feed (created_at).

CREATE INDEX bp_events_team ON bp_events(team_id, created_at);
CREATE INDEX bp_events_created ON bp_events(created_at);

ALTER TABLE teams DROP COLUMN status_requested_at;
ALTER TABLE teams DROP COLUMN status_request_note;
ALTER TABLE teams DROP COLUMN plan_requested_at;
ALTER TABLE teams DROP COLUMN plan_request_note;
ALTER TABLE teams DROP COLUMN plan_version;
ALTER TABLE teams DROP COLUMN plan_updated_at;

ALTER TABLE projects DROP COLUMN report_requested_at;
ALTER TABLE projects DROP COLUMN report_request_note;
