-- A message_read cursor too long to pass back inline is kept here and handed out as a short id (docs/mcp.md,
-- "Calling patterns"). Each row is the per-room delivered positions of one login at one read; message_ack resolves
-- the id only for that login. The hub keeps the newest few per login; retention removes them with the login.
CREATE TABLE message_ack_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL REFERENCES session_tokens(token_hash),
  rooms       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX message_ack_snapshots_token ON message_ack_snapshots(token_hash, id);
