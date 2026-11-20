-- migrate: foreign_keys off
-- Hub fixes from the second review (docs/connector.md, "Delivery orders" and "The wake").
-- 1. An item whose PC runs a connector too old for delivery orders waits with the reason connector_too_old. SQLite cannot change a
--    CHECK in place, so task_turns is rebuilt with the five reasons; every row and both indexes are kept (as in 0155).
-- 2. A woken run has its own id (wake_runs.run_id): a report from an earlier run (a late "ended") never ends the run that followed it.
CREATE TABLE task_turns_new (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  team_id         TEXT NOT NULL REFERENCES teams(id),
  phase           TEXT NOT NULL CHECK (phase IN ('queued','work','review')),
  holder_agent_id TEXT NOT NULL REFERENCES agents(id),
  opened_at       INTEGER NOT NULL,
  opened_by_kind  TEXT NOT NULL CHECK (opened_by_kind IN ('agent','admin','system')),
  opened_by_id    TEXT,
  seen_at         INTEGER,
  due_at          INTEGER,
  overdue_at      INTEGER,
  wake_noted_at   INTEGER,
  closed_at       INTEGER,
  close_reason    TEXT CHECK (close_reason IS NULL OR close_reason IN ('acted','reassigned','withdrawn','blocked','cancelled','released','mode_change')),
  delivered_at    INTEGER,
  delivery_reason TEXT CHECK (delivery_reason IS NULL OR delivery_reason IN ('pc_offline','chat_in_use','wake_held','agent_unknown','connector_too_old'))
);
INSERT INTO task_turns_new (id,task_id,team_id,phase,holder_agent_id,opened_at,opened_by_kind,opened_by_id,seen_at,due_at,overdue_at,wake_noted_at,closed_at,close_reason,delivered_at,delivery_reason)
  SELECT id,task_id,team_id,phase,holder_agent_id,opened_at,opened_by_kind,opened_by_id,seen_at,due_at,overdue_at,wake_noted_at,closed_at,close_reason,delivered_at,delivery_reason FROM task_turns;
DROP TABLE task_turns;
ALTER TABLE task_turns_new RENAME TO task_turns;
CREATE INDEX task_turns_holder ON task_turns(holder_agent_id, closed_at);
CREATE UNIQUE INDEX task_turns_open ON task_turns(task_id) WHERE closed_at IS NULL;
ALTER TABLE wake_runs ADD COLUMN run_id TEXT;
