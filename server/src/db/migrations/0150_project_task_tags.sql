-- A project's fixed list of task tags (docs/specification.md, "Task tags"): a JSON array of {tag, name}, at most 7, set in
-- Project settings. An empty list means free tags (at most 2 per task), as before.
ALTER TABLE projects ADD COLUMN task_tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(task_tags));
