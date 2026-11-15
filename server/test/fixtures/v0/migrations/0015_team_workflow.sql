-- Workflow options from the ECHO trial (all off by default, so existing teams behave as before).
--   close_on_approve     an approving review closes the task (or hands it to the operator checkpoint) in the same call
--   coordinator_reviews  a coordinator explicitly named as a task's reviewer may review it (never their own work)
--   delivery_mode        'poll': members loop on work_next; leases release silent tasks.
--                        'on_demand': members work when woken; a task's check-in deadline raises an alert and keeps
--                        the assignee; room messages are read with message_read instead of being queued as work.
ALTER TABLE teams ADD COLUMN close_on_approve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN coordinator_reviews INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'poll' CHECK (delivery_mode IN ('poll','on_demand'));
ALTER TABLE teams ADD COLUMN paused_at INTEGER;
-- When an on-demand task passed its check-in deadline without news (cleared by the assignee's next task update).
ALTER TABLE tasks ADD COLUMN overdue_at INTEGER;
-- Task notices name the task and the state they describe; once the task moves on they are no longer delivered.
ALTER TABLE agent_notices ADD COLUMN ref_task_id TEXT;
ALTER TABLE agent_notices ADD COLUMN ref_state TEXT;
