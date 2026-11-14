-- Key collection (docs/onboarding.md#collect-on-a-pc-the-codex-wake-picks-up-a-routine-rotation): a routine rotation of a
-- key that has logged in can be armed for the Codex wake on its PC instead of a key prompt. A collection names the key,
-- its PC and variable, the one app key that may collect it and the wake instance expected to; it holds no code and no
-- secret (the key is made at pickup). The polls are the wakes' heartbeats per app key, variable, instance and address,
-- kept 30 days, from which the hub offers Collect and spots a second collector. Two new tables lose nothing: every
-- existing row keeps its values.
CREATE TABLE key_collections (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  session_var TEXT NOT NULL,
  app_credential_id TEXT NOT NULL REFERENCES credentials(id),
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','collected','confirmed','signed_in','void','expired','failed')),
  outcome TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  picked_at INTEGER,
  confirmed_at INTEGER,
  signed_in_at INTEGER,
  ended_at INTEGER,
  conflict_at INTEGER,
  created_by_admin TEXT
);
CREATE INDEX key_collections_credential ON key_collections(credential_id, status);
CREATE INDEX key_collections_var ON key_collections(machine_id, session_var, status);
CREATE TABLE key_collect_polls (
  app_credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  session_var TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  source TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (app_credential_id, session_var, instance_id, source)
);
CREATE INDEX key_collect_polls_var ON key_collect_polls(machine_id, session_var, last_at);
