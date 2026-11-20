-- Hardware step 2 (docs/hardware.md#measuring): the connector on a compute machine measures the whole machine's CPU, memory
-- and GPU use, with the machine user's opt-in. Raw samples are kept 7 days; per-hold and per-day summaries 400 days, without
-- a foreign key to the machine, so they outlive its removal.
ALTER TABLE hw_machines ADD COLUMN shared_with_people INTEGER NOT NULL DEFAULT 0;
-- The opt-in as the connector last reported it in its check-in, beside usage_opt_in: NULL unknown, 0 off, 1 on.
ALTER TABLE connector_reports ADD COLUMN hardware_opt_in INTEGER;
-- Which declared limit an over-limit flag is about: memory or cpus.
ALTER TABLE hw_flags ADD COLUMN detail TEXT CHECK (detail IS NULL OR detail IN ('memory','cpus'));

CREATE TABLE hw_samples (
  machine_id   TEXT NOT NULL,
  at           INTEGER NOT NULL,
  cpu_pct      REAL NOT NULL,
  cpu_count    INTEGER,
  mem_used_gb  REAL NOT NULL,
  mem_total_gb REAL NOT NULL,
  -- JSON array, one object per GPU: {util_pct, mem_used_gb, mem_total_gb}. Numbers only.
  gpus         TEXT NOT NULL DEFAULT '[]',
  hold_seq     INTEGER,
  PRIMARY KEY (machine_id, at)
);
CREATE INDEX hw_samples_at ON hw_samples(at);

-- One row per hold that had samples: the machine's average and peak use during the hold, and the running state of the
-- over-limit check (since when each limit has been exceeded without a break).
CREATE TABLE hw_hold_use (
  hold_seq        INTEGER PRIMARY KEY,
  machine_id      TEXT NOT NULL,
  n               INTEGER NOT NULL DEFAULT 0,
  first_at        INTEGER NOT NULL,
  last_at         INTEGER NOT NULL,
  cpu_sum         REAL NOT NULL DEFAULT 0,
  cpu_peak        REAL NOT NULL DEFAULT 0,
  -- CPUs in use at the peak (cpu % times the machine's CPU count), for the CPU limit.
  cpus_peak       REAL,
  mem_sum         REAL NOT NULL DEFAULT 0,
  mem_peak        REAL NOT NULL DEFAULT 0,
  gpu_n           INTEGER NOT NULL DEFAULT 0,
  gpu_sum         REAL NOT NULL DEFAULT 0,
  gpu_peak        REAL NOT NULL DEFAULT 0,
  gpu_mem_peak    REAL NOT NULL DEFAULT 0,
  mem_over_since  INTEGER,
  cpu_over_since  INTEGER
);
CREATE INDEX hw_hold_use_machine ON hw_hold_use(machine_id, last_at);

-- Per machine, local day (the machine's timezone) and whether someone held it: sums and peaks, for the analysis and
-- "Use with no holder" over periods longer than the raw samples are kept.
CREATE TABLE hw_use_days (
  machine_id   TEXT NOT NULL,
  date         TEXT NOT NULL,
  held         INTEGER NOT NULL CHECK (held IN (0,1)),
  n            INTEGER NOT NULL DEFAULT 0,
  cpu_sum      REAL NOT NULL DEFAULT 0,
  cpu_peak     REAL NOT NULL DEFAULT 0,
  mem_sum      REAL NOT NULL DEFAULT 0,
  mem_peak     REAL NOT NULL DEFAULT 0,
  gpu_n        INTEGER NOT NULL DEFAULT 0,
  gpu_sum      REAL NOT NULL DEFAULT 0,
  gpu_peak     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, date, held)
);
