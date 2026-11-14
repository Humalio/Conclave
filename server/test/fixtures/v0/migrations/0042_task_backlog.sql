-- migrate: foreign_keys off
-- Task backlog (task_rccuivx4jxcup75r): a task an agent creates lands in `backlog` until the operator accepts it (open)
-- or discards it (`discarded`, a terminal status kept for history); the operator may also demote an open task back.
-- projects.task_intake: backlog (the default, also for existing projects) or open (task_create opens tasks as before).
-- tasks.operator_request_*: a coordinator's task_create with operator_request {source} opens the task directly on the
-- operator's relayed request (L1, like relayed team_ask answers); kept so the console can say so.
-- The status CHECK changes, so the tasks table is rebuilt (SQLite's documented procedure: foreign keys off for this
-- migration, checked with foreign_key_check before it commits). Existing tasks keep their status and columns.
ALTER TABLE projects ADD COLUMN task_intake TEXT NOT NULL DEFAULT 'backlog' CHECK (task_intake IN ('backlog', 'open'));

CREATE TABLE tasks_new (
  id              TEXT PRIMARY KEY,
  room_id         TEXT REFERENCES rooms(id),
  team_id         TEXT REFERENCES teams(id),
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('backlog','open','assigned','in_progress','in_review','approved','changes_requested','blocked','done','cancelled','discarded')),
  review_rounds   INTEGER NOT NULL DEFAULT 0,
  claimable       INTEGER NOT NULL DEFAULT 0 CHECK (claimable IN (0,1)),
  assignee_agent_id TEXT REFERENCES agents(id),
  reviewer_agent_id TEXT REFERENCES agents(id),
  lease_expires_at INTEGER,
  progress_until  INTEGER,
  share_id        TEXT, share_version INTEGER,
  summary         TEXT,
  review_comments TEXT,
  blocked_reason  TEXT,
  approval_requested INTEGER NOT NULL DEFAULT 0,
  created_by_agent TEXT REFERENCES agents(id),
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  dismissed_at    INTEGER,
  overdue_at      INTEGER,
  plan_refs       TEXT NOT NULL DEFAULT '[]',
  submitted_version INTEGER,
  blocked_from    TEXT,
  review          TEXT NOT NULL DEFAULT 'required' CHECK (review IN ('required', 'none')),
  operator_request_source TEXT,                       -- where the operator asked for it ("chat with operator")
  operator_request_by     TEXT REFERENCES agents(id), -- the coordinator who relayed the request
  operator_request_at     INTEGER,
  CHECK (room_id IS NOT NULL OR team_id IS NOT NULL),
  CHECK (reviewer_agent_id IS NULL OR assignee_agent_id IS NULL OR reviewer_agent_id <> assignee_agent_id)
);
INSERT INTO tasks_new (id, room_id, team_id, title, description, status, review_rounds, claimable, assignee_agent_id, reviewer_agent_id,
  lease_expires_at, progress_until, share_id, share_version, summary, review_comments, blocked_reason, approval_requested, created_by_agent,
  version, created_at, updated_at, dismissed_at, overdue_at, plan_refs, submitted_version, blocked_from, review)
SELECT id, room_id, team_id, title, description, status, review_rounds, claimable, assignee_agent_id, reviewer_agent_id,
  lease_expires_at, progress_until, share_id, share_version, summary, review_comments, blocked_reason, approval_requested, created_by_agent,
  version, created_at, updated_at, dismissed_at, overdue_at, plan_refs, submitted_version, blocked_from, review
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX tasks_assignee ON tasks(assignee_agent_id, status);
CREATE INDEX tasks_team_status ON tasks(team_id, status);
CREATE INDEX tasks_lease ON tasks(lease_expires_at) WHERE lease_expires_at IS NOT NULL;
