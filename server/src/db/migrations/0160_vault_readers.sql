-- Vault sync, hub side (docs/vault-sync.md): the readers that mirror part of the vault, and the vault's change feed.
-- A reader is a teamless agent with one PC-bound session key; its scope is that key's ordinary policy rules.
CREATE TABLE vault_readers (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  name TEXT NOT NULL,
  owner_user_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','paused','removed')),
  code_verifier TEXT UNIQUE,
  code_status TEXT NOT NULL DEFAULT 'unused' CHECK (code_status IN ('unused','issued','confirmed','revoked')),
  code_nonce_hash TEXT,
  code_issues INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER
);
CREATE UNIQUE INDEX vault_readers_credential ON vault_readers(credential_id);
CREATE INDEX vault_readers_machine ON vault_readers(machine_id, state);

-- Every vault revision, in order: hub writes, renames and deletes, and what the hub sees from outside.
-- A reader never sees seq: it holds an encrypted cursor that carries it.
CREATE TABLE vault_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('put','delete','rename')),
  path TEXT NOT NULL,
  old_path TEXT,
  revision TEXT,
  origin TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX vault_changes_created ON vault_changes(created_at);
