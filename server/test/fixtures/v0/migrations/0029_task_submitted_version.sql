-- The task version at which the pending submission was made or last replaced (task_submit), so a reviewer's verdict
-- on an older version is refused once the assignee replaced the submission (docs/specification.md, Review).
ALTER TABLE tasks ADD COLUMN submitted_version INTEGER;
