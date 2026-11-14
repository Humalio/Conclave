-- Project Blueprint & Execution, phase 1 (docs/blueprint.md §2, §3): projects own the blueprint, teams own parts of it.
-- Existing team plans, plan events and status reports are copied into each team's own project by the blueprint service
-- at startup (src/blueprint/blueprint.ts, backfill), so keys and the reverse milestone links are mapped in one place.
-- Until the phase 3 shims, team_plan_* tools keep writing the old tables and the service mirrors each change.

CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,                -- prj_…
  key                 TEXT NOT NULL UNIQUE,            -- 2–8 capitals, e.g. CNV
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('implementation','research')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  version             INTEGER NOT NULL DEFAULT 0,      -- bumps on every applied write
  created_by_kind     TEXT NOT NULL,                   -- operator | agent | import | system
  created_by_id       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  report_requested_at INTEGER,
  report_request_note TEXT
);

-- The project a team belongs to; null until the service gives it one (backfill or first plan write).
ALTER TABLE teams ADD COLUMN project_id TEXT REFERENCES projects(id);

CREATE TABLE bp_items (
  id               TEXT PRIMARY KEY,                     -- bpi_…, immutable
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,                        -- checked per kind in the service
  key              TEXT NOT NULL,                        -- unique per project, never reused (deleted rows keep it)
  parent_key       TEXT,                                 -- module or line it sits in; the FR of an AC
  title            TEXT NOT NULL,
  body             TEXT,
  fields           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
  status           TEXT,
  team_id          TEXT REFERENCES teams(id) ON DELETE SET NULL,  -- the owning team's part; null = project level
  position         INTEGER NOT NULL DEFAULT 0,
  rev              INTEGER NOT NULL DEFAULT 1,
  origin           TEXT,                                 -- 'team_plan' while a legacy plan item or report is mirrored
  origin_id        TEXT,                                 -- team_plan_items.id or team_status_reports.id
  created_by_kind  TEXT NOT NULL,
  created_by_id    TEXT,
  created_at       INTEGER NOT NULL,
  updated_by_kind  TEXT NOT NULL,
  updated_by_id    TEXT,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  UNIQUE (project_id, key)
);
CREATE INDEX bp_items_project ON bp_items(project_id, kind, position);
CREATE INDEX bp_items_parent ON bp_items(project_id, parent_key);
CREATE UNIQUE INDEX bp_items_origin ON bp_items(origin_id) WHERE origin_id IS NOT NULL;

CREATE TABLE bp_links (
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_key         TEXT NOT NULL,
  to_key           TEXT NOT NULL,
  rel              TEXT NOT NULL CHECK (rel IN ('delivers','ships','governs','supersedes','threatens','blocks','evidence')),
  created_by_kind  TEXT NOT NULL,
  created_by_id    TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, from_key, to_key, rel)
);
CREATE INDEX bp_links_to ON bp_links(project_id, to_key);

CREATE TABLE bp_revisions (
  item_id      TEXT NOT NULL REFERENCES bp_items(id) ON DELETE CASCADE,
  rev          INTEGER NOT NULL,
  snapshot     TEXT NOT NULL CHECK (json_valid(snapshot)),
  actor_kind   TEXT NOT NULL,
  actor_id     TEXT,
  at           INTEGER NOT NULL,
  change_note  TEXT,
  PRIMARY KEY (item_id, rev)
);

-- One row per applied write (the successor of team_plan_events, which the backfill copies in).
CREATE TABLE bp_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id      TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('update','review_request')),
  version      INTEGER,
  actor_kind   TEXT NOT NULL,
  actor_id     TEXT,
  items        INTEGER,
  added        TEXT NOT NULL DEFAULT '[]',
  removed      TEXT NOT NULL DEFAULT '[]',
  changed      TEXT NOT NULL DEFAULT '[]',
  moves        TEXT NOT NULL DEFAULT '[]',
  note         TEXT,
  proposal_id  TEXT,
  legacy_id    INTEGER UNIQUE,                         -- team_plan_events.id it was copied from
  created_at   INTEGER NOT NULL
);
CREATE INDEX bp_events_project ON bp_events(project_id, created_at);

-- Writes an agent may not apply directly (phase 2 applies, rejects and marks them stale).
CREATE TABLE bp_proposals (
  id            TEXT PRIMARY KEY,                       -- bpp_…
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
  agent_id      TEXT REFERENCES agents(id),
  ops           TEXT NOT NULL CHECK (json_valid(ops)),
  base_version  INTEGER NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','rejected','withdrawn','stale')),
  decided_by    TEXT,
  decided_at    INTEGER,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX bp_proposals_project ON bp_proposals(project_id, status);
