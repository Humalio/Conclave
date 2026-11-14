-- A task that lapsed from its holder (docs/specification.md "Task turns and deadlines"): when a polling member is silent
-- past its lease, release() returns each task it holds to open and records here who it lapsed from, when, and the status
-- it held. That agent may take it back with task_claim within 24 hours, in that status. Any move out of open (an
-- assignment, a claim, a cancellation, a block) clears the three.
ALTER TABLE tasks ADD COLUMN lapsed_from TEXT;
ALTER TABLE tasks ADD COLUMN lapsed_at INTEGER;
ALTER TABLE tasks ADD COLUMN lapsed_status TEXT;
