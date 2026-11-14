-- migrate: foreign_keys off
-- The default limit of live logins per PC key is 100, not 20 (docs/onboarding.md#the-app-key-and-its-onboarding-capability).
-- SQLite cannot change a column default in place, so credentials is rebuilt with the new default; every row is copied as it is,
-- except that an app key still at exactly 20 (the old default) moves to 100. Any other value (60, 5, 100 ...) was chosen and stays.
CREATE TABLE credentials_new (
  id                      TEXT PRIMARY KEY,       -- crd_…
  kind                    TEXT NOT NULL CHECK (kind IN ('app_key','session_key')),
  agent_id                TEXT REFERENCES agents(id),
  machine_id              TEXT REFERENCES machines(id),
  app_name                TEXT,
  label                   TEXT NOT NULL,
  key_id                  TEXT NOT NULL UNIQUE,   -- public part
  verifier                TEXT NOT NULL,          -- HMAC-SHA256(pepper, secret), hex
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  status_reason           TEXT,
  expires_at              INTEGER,
  replaces_credential_id  TEXT REFERENCES credentials(id),
  policy_id               TEXT NOT NULL UNIQUE REFERENCES permission_policies(id),
  max_live_sessions       INTEGER NOT NULL DEFAULT 100,
  created_at              INTEGER NOT NULL,
  created_by_admin        TEXT REFERENCES admin_users(id),
  first_used_at           INTEGER,
  last_used_at            INTEGER,
  revoked_at              INTEGER, bound_machine_id TEXT REFERENCES machines(id), onboarding_enabled_at INTEGER, succession TEXT CHECK (succession IN ('superseded_pending','suspended')), other_user_checkout TEXT,
  CHECK ((kind = 'session_key') = (agent_id IS NOT NULL)),
  CHECK ((kind = 'app_key') = (machine_id IS NOT NULL))
);
INSERT INTO credentials_new(id,kind,agent_id,machine_id,app_name,label,key_id,verifier,status,status_reason,expires_at,replaces_credential_id,policy_id,max_live_sessions,created_at,created_by_admin,first_used_at,last_used_at,revoked_at,bound_machine_id,onboarding_enabled_at,succession,other_user_checkout)
  SELECT id,kind,agent_id,machine_id,app_name,label,key_id,verifier,status,status_reason,expires_at,replaces_credential_id,policy_id,
         CASE WHEN kind='app_key' AND max_live_sessions=20 THEN 100 ELSE max_live_sessions END,
         created_at,created_by_admin,first_used_at,last_used_at,revoked_at,bound_machine_id,onboarding_enabled_at,succession,other_user_checkout FROM credentials;
DROP TABLE credentials;
ALTER TABLE credentials_new RENAME TO credentials;
CREATE INDEX credentials_agent ON credentials(agent_id);
CREATE INDEX credentials_machine ON credentials(machine_id);
