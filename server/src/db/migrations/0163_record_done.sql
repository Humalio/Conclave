-- Past work recorded as done (task_create record_done, or the operator's "Record past work"): who recorded it and when.
-- Such a task skipped review: it never counts toward a requirement's tasks or as evidence, and carries no files.
ALTER TABLE tasks ADD COLUMN recorded_by_kind TEXT CHECK (recorded_by_kind IS NULL OR recorded_by_kind IN ('admin','agent'));
ALTER TABLE tasks ADD COLUMN recorded_by_id TEXT;
ALTER TABLE tasks ADD COLUMN recorded_at INTEGER;
-- A task that fixes an earlier, done task of the same project (task_create / task_update fixes).
ALTER TABLE tasks ADD COLUMN fixes_task_id TEXT REFERENCES tasks(id);
CREATE INDEX tasks_fixes ON tasks(fixes_task_id) WHERE fixes_task_id IS NOT NULL;
-- Whether the team's coordinators may record past work as done. Off by default: it skips the required review.
ALTER TABLE teams ADD COLUMN coordinator_records_done INTEGER NOT NULL DEFAULT 0;
