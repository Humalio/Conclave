-- Hardware (docs/hardware.md): a PC's optional compute role, the teams it serves, one ordered waiting list per machine,
-- and the flags raised when a holder loses its task or access. The hub coordinates; it never measures the machine.
CREATE TABLE hw_machines (
  machine_id  TEXT PRIMARY KEY REFERENCES machines(id),
  access      TEXT NOT NULL,                       -- SSH alias or access instructions; never a credential
  timezone    TEXT NOT NULL,                       -- IANA name
  windows     TEXT NOT NULL DEFAULT '[]',          -- [{days:['mon',…], from:'HH:MM', to:'HH:MM'}]; [] = any time
  memory_gb   REAL,
  cpus        INTEGER,
  gpu         TEXT,
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE hw_machine_teams (
  machine_id  TEXT NOT NULL REFERENCES hw_machines(machine_id),
  team_id     TEXT NOT NULL REFERENCES teams(id),
  PRIMARY KEY (machine_id, team_id)
);
-- Order is seq; the holder is the one entry with held_since set.
CREATE TABLE hw_queue (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id       TEXT NOT NULL REFERENCES hw_machines(machine_id),
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  team_id          TEXT NOT NULL REFERENCES teams(id),
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  joined_at        INTEGER NOT NULL,
  estimate_minutes INTEGER,
  held_since       INTEGER,
  estimate_until   INTEGER,
  report           TEXT,
  reported_at      INTEGER,
  UNIQUE (machine_id, agent_id)
);
CREATE UNIQUE INDEX hw_queue_one_holder ON hw_queue(machine_id) WHERE held_since IS NOT NULL;
CREATE TABLE hw_flags (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  task_id     TEXT,
  reason      TEXT NOT NULL CHECK (reason IN ('task','access')),
  held_since  INTEGER,
  created_at  INTEGER NOT NULL,
  cleared_at  INTEGER,
  cleared_by  TEXT
);
CREATE INDEX hw_flags_open ON hw_flags(machine_id) WHERE cleared_at IS NULL;
