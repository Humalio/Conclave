-- An administrator can hide a finished task from the team board. The task, its events and its
-- results stay; agents still list it. NULL means shown.
ALTER TABLE tasks ADD COLUMN dismissed_at INTEGER;
