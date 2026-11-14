-- Key prompts (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key). A session key's variable in keys.env
-- (credentials.session_var: the onboarding slot's, or one derived from the agent's name for a console key on a PC; kept
-- through rotation), and the single-use pickup codes that carry a new key to its PC instead of the key itself. Only the
-- code's hash is kept; the key's secret is made at pickup, so the hub never holds it. Adding a column and a table loses
-- nothing: every existing row keeps its values and session_var starts empty (the hub fills it the next time it needs it).
ALTER TABLE credentials ADD COLUMN session_var TEXT;
CREATE TABLE key_pickups (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  session_var TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','used','void')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by_admin TEXT
);
CREATE INDEX key_pickups_credential ON key_pickups(credential_id, status);
