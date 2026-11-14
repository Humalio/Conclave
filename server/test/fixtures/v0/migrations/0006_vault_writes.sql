-- Phase 4a: vault writes. Current state of each path, content-addressed blobs, revision history,
-- conflicts and the write-intent journal used for crash recovery (design/04, design/07).

CREATE TABLE files (
  id                TEXT PRIMARY KEY,             -- fil_…
  path              TEXT NOT NULL,                -- relative to the vault root, NFC, "/" separated
  current_revision  TEXT,                         -- sha256:…, NULL when deleted
  size              INTEGER, mtime INTEGER,
  is_text           INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX files_path_active ON files(path) WHERE deleted_at IS NULL;
CREATE INDEX files_path ON files(path);

CREATE TABLE blobs (
  hash        TEXT PRIMARY KEY,                   -- sha256:… ; bytes live in DATA_DIR/blobs/<2 hex>/<hex>
  size        INTEGER NOT NULL,
  stored      INTEGER NOT NULL CHECK (stored IN (0,1)),  -- 0 = metadata only (too large)
  created_at  INTEGER NOT NULL
);

CREATE TABLE file_revisions (
  id               TEXT PRIMARY KEY,              -- rev_…
  file_id          TEXT NOT NULL REFERENCES files(id),
  revision         TEXT NOT NULL,                 -- sha256:… or 'tombstone'
  parent_revision  TEXT,
  path_at_revision TEXT NOT NULL,
  op               TEXT NOT NULL CHECK (op IN ('create','update','patch','rename','delete','restore','observe')),
  origin           TEXT NOT NULL CHECK (origin IN ('platform','external_observed','restore','initial_scan')),
  recovered        INTEGER NOT NULL DEFAULT 0,
  agent_id         TEXT,                          -- NULL for external
  credential_id    TEXT,
  admin_id         TEXT,
  size             INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX file_revisions_file_time ON file_revisions(file_id, created_at DESC);
CREATE INDEX file_revisions_time ON file_revisions(created_at DESC);

CREATE TABLE file_conflicts (
  id               TEXT PRIMARY KEY,              -- cfl_…
  file_id          TEXT NOT NULL REFERENCES files(id),
  source           TEXT NOT NULL CHECK (source IN ('platform_cas','external_during_commit','sync_tool')),
  base_revision    TEXT,
  revisions        TEXT NOT NULL CHECK (json_valid(revisions)),  -- [{revision, role}] competing versions, all kept as blobs
  conflict_path    TEXT,                          -- sync-tool conflict copy, if any
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution       TEXT CHECK (resolution IS NULL OR json_valid(resolution)),
  agent_id         TEXT,
  resolved_by_admin TEXT,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX file_conflicts_open ON file_conflicts(status, created_at);

CREATE TABLE write_intents (
  id            TEXT PRIMARY KEY,
  op            TEXT NOT NULL CHECK (op IN ('write','delete','rename')),
  path          TEXT NOT NULL, new_path TEXT,
  base_revision TEXT, new_revision TEXT,
  tmp_name      TEXT,
  agent_id      TEXT, credential_id TEXT, revision_op TEXT, origin TEXT,
  created_at    INTEGER NOT NULL
);
