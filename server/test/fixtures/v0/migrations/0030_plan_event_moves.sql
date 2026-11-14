-- Status moves in a plan update (docs/dashboard-ux.md, Work in motion): [{key, status, was}] for each existing item whose
-- status changed, so the Home feed can say "MH-M2 missed" rather than only which keys changed.
ALTER TABLE team_plan_events ADD COLUMN moves TEXT NOT NULL DEFAULT '[]';
