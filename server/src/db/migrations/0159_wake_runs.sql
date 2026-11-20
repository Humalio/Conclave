-- The wake (docs/connector.md, "The wake"): the latest run the connector started for each agent, as the connector reports it.
-- One row per agent: its state (running, waiting, paused_usage, needs_approval, ended, stopped), the task and session it works on, and
-- the time of its last activity (numbers only: the console says "No activity for 30 min" from it). Transcripts stay on the PC.
CREATE TABLE wake_runs (
  agent_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  state TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  waiting_on TEXT,
  started_at INTEGER,
  last_activity_at INTEGER,
  resumes_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX wake_runs_machine ON wake_runs(machine_id);
