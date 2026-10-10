-- Phase 4b: shares, data channels (metadata only; relayed bytes never touch the disk), new work item kinds.

-- Widen work_items.kind (SQLite cannot alter a CHECK): rebuild the table.
CREATE TABLE work_items_new (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  team_id      TEXT REFERENCES teams(id),
  kind         TEXT NOT NULL CHECK (kind IN ('notice','review_requested','changes_requested','task_assigned','message','channel_offer','share_feedback','channel_event')),
  priority     INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
  ref_id       TEXT NOT NULL,
  trust        TEXT NOT NULL CHECK (trust IN ('L0','L1','L2')),
  created_at   INTEGER NOT NULL,
  last_delivered_at INTEGER,
  delivery_count INTEGER NOT NULL DEFAULT 0,
  acked_at     INTEGER
);
INSERT INTO work_items_new SELECT id,agent_id,team_id,kind,priority,ref_id,trust,created_at,last_delivered_at,delivery_count,acked_at FROM work_items;
DROP TABLE work_items;
ALTER TABLE work_items_new RENAME TO work_items;
CREATE INDEX work_items_pending ON work_items(agent_id, priority, created_at) WHERE acked_at IS NULL;

CREATE TABLE shares (
  id            TEXT PRIMARY KEY,                 -- shr_…
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  author_credential_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','revoked')),
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE share_recipients (
  share_id      TEXT NOT NULL REFERENCES shares(id),
  target        TEXT NOT NULL,                    -- agent:<id> | team:<id> | room:<id>
  PRIMARY KEY (share_id, target)
);
CREATE TABLE share_versions (
  share_id      TEXT NOT NULL REFERENCES shares(id),
  version       INTEGER NOT NULL,
  note          TEXT,
  manifest      TEXT NOT NULL CHECK (json_valid(manifest)),  -- [{path, blob_hash, size, is_text, stored}]
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  upload_kind   TEXT NOT NULL CHECK (upload_kind IN ('inline','channel','bridge')),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (share_id, version)
);
CREATE TABLE share_feedback (
  id            TEXT PRIMARY KEY,                 -- fbk_…
  share_id      TEXT NOT NULL REFERENCES shares(id),
  version       INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('comment','suggestion')),
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  path          TEXT, line INTEGER,
  mapped_version INTEGER, mapped_line INTEGER,
  outdated      INTEGER NOT NULL DEFAULT 0 CHECK (outdated IN (0,1)),
  body          TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','dismissed')),
  resolved_note TEXT, resolved_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX share_feedback_share ON share_feedback(share_id, version);
CREATE TABLE share_promotions (
  id            TEXT PRIMARY KEY,
  share_id      TEXT NOT NULL, version INTEGER NOT NULL,
  path          TEXT NOT NULL, vault_path TEXT NOT NULL,
  result        TEXT NOT NULL, revision TEXT,
  author_agent_id TEXT NOT NULL, promoted_by_agent_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE data_channels (
  id              TEXT PRIMARY KEY,               -- chn_…
  from_agent_id   TEXT NOT NULL REFERENCES agents(id),
  from_credential_id TEXT NOT NULL,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('agent','vault','share')),
  target          TEXT NOT NULL,
  to_agent_id     TEXT REFERENCES agents(id),
  to_credential_id TEXT,
  direction       TEXT NOT NULL DEFAULT 'send' CHECK (direction IN ('send','download')),
  mode            TEXT NOT NULL DEFAULT 'inline' CHECK (mode IN ('inline','bridge')),
  from_local_path TEXT, to_local_path TEXT,
  from_machine_id TEXT, to_machine_id TEXT,
  framing         TEXT NOT NULL DEFAULT 'raw' CHECK (framing IN ('raw','tar')),
  share_path      TEXT,                           -- inline/raw upload into a share: the file's path in the share
  confirmed_offset INTEGER NOT NULL DEFAULT 0,    -- consumer side resume point
  received_offset  INTEGER NOT NULL DEFAULT 0,    -- producer side resume point (agent relay: reset to confirmed on restart)
  purpose         TEXT,
  size            INTEGER,                        -- NULL until known (bridge mode)
  sha256          TEXT,
  sender_sha      TEXT, receiver_sha TEXT,
  sender_done     INTEGER NOT NULL DEFAULT 0, receiver_done INTEGER NOT NULL DEFAULT 0,
  base_revision   TEXT,
  status          TEXT NOT NULL CHECK (status IN ('offered','open','done','expired','closed','failed')),
  failure_reason  TEXT,
  result          TEXT CHECK (result IS NULL OR json_valid(result)),
  bytes_moved     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  started_at      INTEGER, finished_at INTEGER
);
CREATE INDEX data_channels_to ON data_channels(to_agent_id, status);
CREATE INDEX data_channels_from ON data_channels(from_agent_id, status);
CREATE INDEX data_channels_open ON data_channels(status) WHERE status IN ('offered','open');
