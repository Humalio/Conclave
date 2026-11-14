-- 0003 — Phase 2: links, PC setup, bridge. Separate tables instead of widening the credentials CHECK (see README).

ALTER TABLE agents ADD COLUMN archived_at INTEGER;

ALTER TABLE machines ADD COLUMN os TEXT;
ALTER TABLE machines ADD COLUMN setup_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE machines ADD COLUMN bridge_version TEXT;
ALTER TABLE machines ADD COLUMN bridge_last_seen_at INTEGER;

CREATE TABLE agent_links (
  id            TEXT PRIMARY KEY,                 -- lnk_…
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id   TEXT NOT NULL REFERENCES agents(id),
  kind          TEXT NOT NULL,                    -- works_with | reviews | reports_to | free text
  note          TEXT,
  grants_messaging INTEGER NOT NULL DEFAULT 0 CHECK (grants_messaging IN (0,1)),  -- stored; enforced from Phase 3
  created_by    TEXT REFERENCES admin_users(id),
  created_at    INTEGER NOT NULL,
  removed_at    INTEGER,
  CHECK (from_agent_id <> to_agent_id)
);
CREATE INDEX agent_links_from ON agent_links(from_agent_id) WHERE removed_at IS NULL;
CREATE INDEX agent_links_to ON agent_links(to_agent_id) WHERE removed_at IS NULL;

-- One-time key (ah_set_…) per PC setup; also holds the one-time pairing code.
CREATE TABLE setup_keys (
  id               TEXT PRIMARY KEY,              -- stp_…
  machine_id       TEXT NOT NULL REFERENCES machines(id),
  key_id           TEXT NOT NULL UNIQUE,
  verifier         TEXT NOT NULL,                 -- HMAC-SHA256(pepper, secret)
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,              -- created_at + 1 h
  used_at          INTEGER,                       -- set when setup is done, or the key is replaced
  setup_called_at  INTEGER,
  pairing_hash     TEXT,                          -- sha256 of the pairing code
  pairing_expires_at INTEGER,
  paired_at        INTEGER
);
CREATE INDEX setup_keys_machine ON setup_keys(machine_id, created_at);
CREATE INDEX setup_keys_pairing ON setup_keys(pairing_hash);

CREATE TABLE bridge_keys (
  id            TEXT PRIMARY KEY,                 -- brk_…
  machine_id    TEXT NOT NULL REFERENCES machines(id),
  key_id        TEXT NOT NULL UNIQUE,
  verifier      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX bridge_keys_machine ON bridge_keys(machine_id);

CREATE TABLE machine_folders (
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  path        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  proposed_at INTEGER NOT NULL,
  decided_at  INTEGER,
  PRIMARY KEY (machine_id, path)
);
