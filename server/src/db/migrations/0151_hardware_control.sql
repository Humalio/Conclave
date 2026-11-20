-- Hardware control (docs/hardware.md): enforced opening hours, daily allowances per team, pausing a machine, one flags
-- table with a kind, and the history of holds that the allowances, What ran and the analysis count from.
ALTER TABLE hw_machines ADD COLUMN paused_at INTEGER;
ALTER TABLE hw_machines ADD COLUMN paused_by TEXT;
-- Hours per local day in the machine's timezone; NULL: no daily limit.
ALTER TABLE hw_machine_teams ADD COLUMN daily_hours REAL;
-- The 10-minute notices already sent to the holder: the window end (epoch ms) and the local day of the allowance.
ALTER TABLE hw_queue ADD COLUMN warned_window INTEGER;
ALTER TABLE hw_queue ADD COLUMN warned_day TEXT;

-- One row per entry that became holder; seq is its hw_queue seq. It outlives the entry and the compute role.
CREATE TABLE hw_holds (
  seq          INTEGER PRIMARY KEY,
  machine_id   TEXT NOT NULL REFERENCES machines(id),
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  team_id      TEXT NOT NULL,
  task_id      TEXT,
  joined_at    INTEGER NOT NULL,
  held_since   INTEGER NOT NULL,
  ended_at     INTEGER,
  ended        TEXT CHECK (ended IS NULL OR ended IN ('done','cancelled','removed','task','access','unregistered')),
  report       TEXT,
  reported_at  INTEGER
);
CREATE INDEX hw_holds_machine ON hw_holds(machine_id, held_since);
CREATE INDEX hw_holds_team ON hw_holds(machine_id, team_id, held_since);
INSERT INTO hw_holds(seq, machine_id, agent_id, team_id, task_id, joined_at, held_since, report, reported_at)
  SELECT seq, machine_id, agent_id, team_id, task_id, joined_at, held_since, report, reported_at FROM hw_queue WHERE held_since IS NOT NULL;

-- Flags get a kind; the reason stays for a lost holder (task or access). At most one flag per hold and kind.
CREATE TABLE hw_flags_new (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  task_id     TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('lost','window','allowance','limit')),
  reason      TEXT CHECK (reason IS NULL OR reason IN ('task','access')),
  hold_seq    INTEGER,
  held_since  INTEGER,
  created_at  INTEGER NOT NULL,
  cleared_at  INTEGER,
  cleared_by  TEXT
);
INSERT INTO hw_flags_new(id, machine_id, agent_id, task_id, kind, reason, hold_seq, held_since, created_at, cleared_at, cleared_by)
  SELECT id, machine_id, agent_id, task_id, 'lost', reason, NULL, held_since, created_at, cleared_at, cleared_by FROM hw_flags;
DROP TABLE hw_flags;
ALTER TABLE hw_flags_new RENAME TO hw_flags;
CREATE INDEX hw_flags_open ON hw_flags(machine_id) WHERE cleared_at IS NULL;
CREATE UNIQUE INDEX hw_flags_one ON hw_flags(hold_seq, kind) WHERE hold_seq IS NOT NULL;
