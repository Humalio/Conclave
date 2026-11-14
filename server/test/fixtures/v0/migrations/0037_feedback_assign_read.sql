-- An assignment counts as read only once the assignee calls feedback_read on the report after it was assigned
-- (docs/feedback.md). Acknowledging the feedback_assigned notice does not set it.
ALTER TABLE feedback_reports ADD COLUMN assigned_read_at INTEGER;
