-- Relays (docs/relay.md, hub side): a relay is a machine that passes requests on to this hub for PCs that cannot reach it directly.
-- Each registered relay has its own secret (only its verifier is kept), the origin PCs reach it at, and its CA fingerprint.
-- Removing a relay deletes the row: its origin is no longer allowed and its secret no longer verifies.
CREATE TABLE relays (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL UNIQUE,
  ca_sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL UNIQUE,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  last_seen_at INTEGER,
  last_seen_ip TEXT
);
