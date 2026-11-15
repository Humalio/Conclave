-- The hub's side of the Conclave connector (docs/connector.md): what a connector reports, the versions the operator
-- approves, the PC actions (orders) it fetches, the messages it reports shown, and usage. Every value stays NULL
-- (Unknown) until a connector reports it; the hub never runs anything on a PC by itself.
CREATE TABLE connector_reports (
  machine_id        TEXT PRIMARY KEY REFERENCES machines(id),
  version           TEXT,
  platform          TEXT,
  node              TEXT,
  git               TEXT,
  clients           TEXT NOT NULL DEFAULT '[]',   -- JSON [{client, version}]
  auto_update       INTEGER,                      -- the PC user's local switches; NULL: not reported
  remote_cleanup    INTEGER,
  remove_with_last_hub INTEGER,
  usage_opt_in      INTEGER,
  agents            TEXT NOT NULL DEFAULT '[]',   -- JSON [{agent_id, state}] as the PC reports them
  first_check_in_at INTEGER NOT NULL,
  last_check_in_at  INTEGER NOT NULL
);
CREATE TABLE connector_versions (
  version       TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','refused')),
  first_seen_at INTEGER NOT NULL,
  first_seen_pc TEXT REFERENCES machines(id),
  decided_at    INTEGER,
  decided_by    TEXT
);
CREATE TABLE pc_actions (
  id           TEXT PRIMARY KEY,                  -- pca_…
  machine_id   TEXT NOT NULL REFERENCES machines(id),
  kind         TEXT NOT NULL CHECK (kind IN ('check','restore','update','disconnect')),
  state        TEXT NOT NULL CHECK (state IN ('queued','fetched','done','failed','expired','access_revoked','cleanup_pending','removed','needs_attention')),
  payload      TEXT NOT NULL DEFAULT '{}',        -- typed data only, never a path or a command
  result       TEXT,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  fetched_at   INTEGER,
  finished_at  INTEGER,
  expires_at   INTEGER NOT NULL,
  receipt_key_id   TEXT UNIQUE,                   -- disconnect only: the narrow receipt credential (ah_dsc_<id>_<secret>)
  receipt_verifier TEXT,                         -- an HMAC of the secret only; NULL once retired
  ended_at     INTEGER                            -- disconnect only: Re-enrol PC ended it; until then Reactivate is refused
);
CREATE INDEX pc_actions_machine ON pc_actions(machine_id, created_at);
CREATE TABLE message_shown (
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  shown_seq   INTEGER NOT NULL,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, room_id)
);
CREATE TABLE connector_usage (
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  day         TEXT NOT NULL,                      -- YYYY-MM-DD
  agent_id    TEXT NOT NULL,
  client      TEXT NOT NULL,
  model       TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  sessions    INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, day, agent_id, client, model)
);
