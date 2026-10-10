-- Preserve prior ownership after expiry/reassignment so stale submissions get an
-- actionable error without exposing jobs to agents that never held them.
CREATE TABLE kg_job_expirations (
  job_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  expired_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, agent_id)
);
CREATE INDEX kg_jobs_pending_order ON kg_jobs(state, priority, created_at, id);
