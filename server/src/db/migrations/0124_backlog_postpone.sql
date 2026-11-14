-- Postponed backlog tasks (docs/specification.md, Task lifecycle, "Postponed"): the operator keeps a backlog task for later.
-- The task stays status 'backlog'; postponed_at is when it was postponed, NULL while it is active. Accept, discard and
-- demote clear it. Additive only: the old image ignores the column and shows a postponed task as an active one.
ALTER TABLE tasks ADD COLUMN postponed_at INTEGER;
-- GET /api/tasks/backlog reads the backlog by list (active or postponed), oldest first.
CREATE INDEX tasks_backlog_list ON tasks(status, postponed_at, created_at) WHERE status = 'backlog';
