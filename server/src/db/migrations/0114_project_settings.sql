-- Project settings (docs/blueprint.md §3): an explicit single-team choice, and an ecosystem as an optional parent link,
-- one level deep. The service refuses these with a plain explanation first; the triggers keep them true for every
-- write path, so two onboarding approvals at the same moment cannot both put a second team into a single-team project.
ALTER TABLE projects ADD COLUMN single_team INTEGER NOT NULL DEFAULT 0 CHECK (single_team IN (0, 1));
ALTER TABLE projects ADD COLUMN parent_id TEXT REFERENCES projects(id);
CREATE INDEX projects_parent ON projects(parent_id) WHERE parent_id IS NOT NULL;

-- A contributing team is one that is not stopped.
CREATE TRIGGER teams_single_team_insert BEFORE INSERT ON teams
WHEN NEW.project_id IS NOT NULL AND NEW.status <> 'stopped'
  AND (SELECT single_team FROM projects WHERE id = NEW.project_id) = 1
  AND EXISTS (SELECT 1 FROM teams WHERE project_id = NEW.project_id AND status <> 'stopped')
BEGIN SELECT RAISE(ABORT, 'single_team: this project accepts one team'); END;

CREATE TRIGGER teams_single_team_update BEFORE UPDATE OF project_id, status ON teams
WHEN NEW.project_id IS NOT NULL AND NEW.status <> 'stopped'
  AND (OLD.project_id IS NOT NEW.project_id OR OLD.status = 'stopped')
  AND (SELECT single_team FROM projects WHERE id = NEW.project_id) = 1
  AND EXISTS (SELECT 1 FROM teams WHERE project_id = NEW.project_id AND status <> 'stopped' AND id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'single_team: this project accepts one team'); END;

-- An ecosystem (a project with children) has no teams of its own.
CREATE TRIGGER teams_ecosystem_insert BEFORE INSERT ON teams
WHEN NEW.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects WHERE parent_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'ecosystem: an ecosystem has no teams of its own'); END;

CREATE TRIGGER teams_ecosystem_update BEFORE UPDATE OF project_id ON teams
WHEN NEW.project_id IS NOT NULL AND OLD.project_id IS NOT NEW.project_id AND EXISTS (SELECT 1 FROM projects WHERE parent_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'ecosystem: an ecosystem has no teams of its own'); END;

CREATE TRIGGER projects_single_team_on BEFORE UPDATE OF single_team ON projects
WHEN NEW.single_team = 1 AND OLD.single_team = 0
  AND (SELECT COUNT(*) FROM teams WHERE project_id = NEW.id AND status <> 'stopped') > 1
BEGIN SELECT RAISE(ABORT, 'single_team: several teams contribute to this project'); END;

-- One level deep: never its own parent, a parent has no parent and no teams, a project with children has no parent.
CREATE TRIGGER projects_parent_check BEFORE UPDATE OF parent_id ON projects
WHEN NEW.parent_id IS NOT NULL AND (
  NEW.parent_id = NEW.id
  OR (SELECT parent_id FROM projects WHERE id = NEW.parent_id) IS NOT NULL
  OR EXISTS (SELECT 1 FROM projects WHERE parent_id = NEW.id)
  OR EXISTS (SELECT 1 FROM teams WHERE project_id = NEW.parent_id))
BEGIN SELECT RAISE(ABORT, 'ecosystem: one level deep, never its own parent, and an ecosystem has no teams'); END;

CREATE TRIGGER projects_parent_insert BEFORE INSERT ON projects
WHEN NEW.parent_id IS NOT NULL AND (
  (SELECT parent_id FROM projects WHERE id = NEW.parent_id) IS NOT NULL
  OR EXISTS (SELECT 1 FROM teams WHERE project_id = NEW.parent_id))
BEGIN SELECT RAISE(ABORT, 'ecosystem: one level deep, and an ecosystem has no teams'); END;
