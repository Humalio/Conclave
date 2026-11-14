-- Phase 5: access requests, temporary grants, bridge commit step, retention indexes.
CREATE TABLE access_requests (
  id               TEXT PRIMARY KEY,              -- acr_…
  credential_id    TEXT NOT NULL REFERENCES credentials(id),
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  actions          TEXT NOT NULL CHECK (json_valid(actions)),
  resource         TEXT NOT NULL,
  justification    TEXT NOT NULL,
  requested_duration_s INTEGER,
  task_ref         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','partially_approved','denied','expired','withdrawn')),
  decided_by       TEXT REFERENCES admin_users(id),
  decision_note    TEXT,
  decided_at       INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX access_requests_pending ON access_requests(status, created_at);
CREATE INDEX access_requests_cred ON access_requests(credential_id, created_at);

CREATE TABLE temporary_grants (
  id              TEXT PRIMARY KEY,               -- tgr_…
  credential_id   TEXT NOT NULL REFERENCES credentials(id),
  effect          TEXT NOT NULL DEFAULT 'allow' CHECK (effect = 'allow'),
  actions         TEXT NOT NULL CHECK (json_valid(actions)),
  resource        TEXT NOT NULL,
  resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('path','agent','room','tool','team','share','channel')),
  not_before      INTEGER NOT NULL,
  not_after       INTEGER NOT NULL CHECK (not_after > not_before),
  access_request_id TEXT REFERENCES access_requests(id),
  granted_by      TEXT NOT NULL REFERENCES admin_users(id),
  revoked_at      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX temporary_grants_active ON temporary_grants(credential_id, not_after) WHERE revoked_at IS NULL;

-- Bridge receive: the session is told "done" only after the receiving bridge confirmed unpack/rename.
ALTER TABLE data_channels ADD COLUMN receiver_committed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX shares_status ON shares(status, updated_at);
CREATE INDEX data_channels_finished ON data_channels(status, finished_at);
