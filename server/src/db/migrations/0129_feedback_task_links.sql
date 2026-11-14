-- Feedback reports linked to the tasks that fix them (docs/feedback.md#linked-tasks). A coordinator links them from
-- task_create or task_update, the operator from the console. When every counted linked task is approved and done, the hub
-- closes an accepted report as fixed after the current hub version, and undoes that close if a linked task stops counting
-- as done. linked_by_kind/linked_by_id: who made the link (a coordinator may remove only its own).
CREATE TABLE feedback_task_links (
  report_id      TEXT NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  linked_by_kind TEXT NOT NULL CHECK (linked_by_kind IN ('admin','agent')),
  linked_by_id   TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (report_id, task_id)
);
CREATE INDEX idx_feedback_task_links_task ON feedback_task_links(task_id);

-- closed_by_task: the hub closed the report (status fixed) because its linked tasks were done.
-- closed_from: the status to return to if that close is undone. fixed_after: the hub version the fix comes after.
ALTER TABLE feedback_reports ADD COLUMN closed_by_task INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback_reports ADD COLUMN closed_from TEXT;
ALTER TABLE feedback_reports ADD COLUMN fixed_after TEXT;
