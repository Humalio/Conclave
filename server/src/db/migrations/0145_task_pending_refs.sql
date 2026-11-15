-- Task refs to Blueprint items that an open proposal of the task's own team writes (docs/blueprint.md §2.3): kept apart
-- from plan_refs until the proposal closes. Applied, they move to plan_refs; rejected, withdrawn or stale, they are dropped.
ALTER TABLE tasks ADD COLUMN pending_refs TEXT NOT NULL DEFAULT '[]';
