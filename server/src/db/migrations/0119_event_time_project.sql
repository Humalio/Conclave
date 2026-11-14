-- Keys are per project (docs/blueprint.md §3): two projects may both have an M14, and a team can move to another project.
-- Task history and operator questions therefore record their project when they are written, and task events also record
-- the task's blueprint refs as [{key, id}] with each item's immutable id. Rows written before this migration keep NULL:
-- their project is not known for certain, so readers fall back to the team's current project and never to another one.
-- Additive only: the old image still runs on this schema (it ignores the new columns).
ALTER TABLE task_events ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE task_events ADD COLUMN refs TEXT;
ALTER TABLE decisions ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX idx_task_events_project ON task_events(project_id, created_at);
