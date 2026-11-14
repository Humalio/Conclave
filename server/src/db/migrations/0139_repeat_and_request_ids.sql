-- work_next marks a repeat (docs/mcp.md): the login (session token hash) an unconfirmed item was last handed to.
ALTER TABLE work_items ADD COLUMN delivered_token TEXT;

-- task_submit / task_review request ids: a retry with the same id returns the first result while the task is still at
-- the version that call left it at. Kept about 24 hours (REQUEST_KEEP_MS), pruned on write.
CREATE TABLE task_requests (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('submit','review')),
  request_id    TEXT NOT NULL,
  version_after INTEGER NOT NULL,
  result        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, agent_id, action, request_id)
);
CREATE INDEX task_requests_created ON task_requests(created_at);
