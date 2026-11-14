-- Team plan: the requirements the goal implies and the milestones that show progress, kept by the coordinator.
CREATE TABLE team_plan_items (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id),
  kind        TEXT NOT NULL CHECK (kind IN ('requirement','milestone')),
  key         TEXT NOT NULL,                 -- short handle, e.g. R1 or M2, unique per team
  title       TEXT NOT NULL,
  detail      TEXT,
  priority    TEXT CHECK (priority IS NULL OR priority IN ('must','should','could')),
  status      TEXT NOT NULL,                 -- requirement: open|met|unclear|dropped; milestone: planned|in_progress|reached|missed|dropped
  criteria    TEXT,                          -- how we know it is met / reached
  evidence    TEXT,                          -- where the result lives
  due_at      INTEGER,                       -- milestones only
  links       TEXT NOT NULL DEFAULT '[]',    -- requirement: keys of the milestones that deliver it
  position    INTEGER NOT NULL,
  updated_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (team_id, key)
);
CREATE INDEX team_plan_items_team ON team_plan_items(team_id, kind, position);
ALTER TABLE teams ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN plan_updated_at INTEGER;
ALTER TABLE teams ADD COLUMN plan_requested_at INTEGER;
ALTER TABLE teams ADD COLUMN plan_request_note TEXT;
-- Requirement and milestone keys a task contributes to.
ALTER TABLE tasks ADD COLUMN plan_refs TEXT NOT NULL DEFAULT '[]';
-- Default playbooks mention the plan (teams that edited their playbooks keep their text).
UPDATE team_role_defaults SET playbook = playbook || ' Keep the team plan current with team_plan_set / team_plan_update: the requirements the goal implies (most important), linked to milestones where possible. If you lack the full picture, ask the workers first, and mark a requirement unclear rather than guess. Link tasks to requirement keys (refs).' WHERE role='coordinator';
UPDATE team_role_defaults SET playbook = playbook || ' The team plan (team_plan) says which requirements your tasks serve.' WHERE role='worker';
