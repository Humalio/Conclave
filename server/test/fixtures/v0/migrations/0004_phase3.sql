-- 0004 — Phase 3: rooms, messages, per-login delivery cursors (design/07 Mesh; teams/tasks arrive later).

CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,                 -- room_…
  kind          TEXT NOT NULL CHECK (kind IN ('direct','group','team')),
  team_id       TEXT,
  name          TEXT,
  direct_key    TEXT UNIQUE,                      -- 'agent-a|agent-b' sorted, for direct rooms
  created_by_agent TEXT REFERENCES agents(id),
  created_by_admin TEXT REFERENCES admin_users(id),
  last_seq      INTEGER NOT NULL DEFAULT 0,
  archived_at   INTEGER,
  retention_days INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);

CREATE TABLE room_memberships (
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member','observer')),
  joined_at   INTEGER NOT NULL,
  expires_at  INTEGER,
  left_at     INTEGER,
  invited_by  TEXT
);
CREATE UNIQUE INDEX room_memberships_agent ON room_memberships(room_id, agent_id) WHERE left_at IS NULL;
CREATE INDEX room_memberships_by_agent ON room_memberships(agent_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,             -- msg_…
  room_id           TEXT NOT NULL REFERENCES rooms(id),
  seq               INTEGER NOT NULL,
  sender_agent_id   TEXT REFERENCES agents(id),
  sender_credential_id TEXT REFERENCES credentials(id),
  client_msg_id     TEXT,
  kind              TEXT NOT NULL DEFAULT 'text'
                    CHECK (kind IN ('text','proposal','agreement','review_request','task_update','system')),
  body              TEXT NOT NULL,
  payload           TEXT CHECK (payload IS NULL OR json_valid(payload)),
  reply_to          TEXT REFERENCES messages(id),
  size_bytes        INTEGER NOT NULL CHECK (size_bytes <= 65536),
  created_at        INTEGER NOT NULL,
  redacted_at       INTEGER,
  UNIQUE (room_id, seq),
  CHECK ((sender_agent_id IS NULL) = (kind = 'system'))
);
CREATE UNIQUE INDEX messages_idempotency ON messages(sender_credential_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL AND sender_credential_id IS NOT NULL;
CREATE INDEX messages_created ON messages(created_at);

-- Cursor per login (session token) and room.
CREATE TABLE message_delivery_cursors (
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  token_hash      TEXT NOT NULL REFERENCES session_tokens(token_hash),
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  delivered_seq   INTEGER NOT NULL DEFAULT 0,
  acked_seq       INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (token_hash, room_id)
);
