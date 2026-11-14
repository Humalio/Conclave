-- The operator assigns a feedback report to one agent (docs/feedback.md#assigning-a-report). The assignee may read the
-- report's summary, the operator's note and guidance, even when the report is hidden or feedback is set to own-only; the
-- filer's private detail stays private.
ALTER TABLE feedback_reports ADD COLUMN assigned_agent_id TEXT REFERENCES agents(id);
ALTER TABLE feedback_reports ADD COLUMN assigned_at INTEGER;
ALTER TABLE feedback_reports ADD COLUMN assigned_note TEXT;
CREATE INDEX idx_feedback_assigned ON feedback_reports(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
