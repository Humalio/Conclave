-- Task attachments (docs/specification.md, Tasks and Shares): a task's brief and submission files live in hub-made shares
-- bound to the task. Only the hub creates one (task_id, task_role); its readers follow the task, not a recipient list.
-- Every existing share keeps task_id NULL and reads as before. Each version records who added it and, for a copy, the
-- share version it was copied from (share:<id>@v<n>).
ALTER TABLE shares ADD COLUMN task_id TEXT REFERENCES tasks(id);
ALTER TABLE shares ADD COLUMN task_role TEXT CHECK (task_role IS NULL OR task_role IN ('brief','submission'));
CREATE UNIQUE INDEX shares_task_role ON shares(task_id, task_role) WHERE task_id IS NOT NULL;
ALTER TABLE share_versions ADD COLUMN added_by TEXT;
ALTER TABLE share_versions ADD COLUMN copied_from TEXT;
