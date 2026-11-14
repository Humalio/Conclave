-- 0001 — Phase 1: identity, keys, policies, notices, audit. Derived from design/07-sqlite-schema.sql v0.3.

CREATE TABLE admin_users (
  id              TEXT PRIMARY KEY,               -- adm_…
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,                  -- scrypt$N$r$p$salt$hash
  totp_secret     TEXT,                           -- base32; NULL = TOTP not enrolled
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

CREATE TABLE admin_sessions (
  id_hash     BLOB PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES admin_users(id),
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,                 -- agent-…
  label         TEXT NOT NULL,                    -- not unique, never used for authz
  project       TEXT,
  model_label   TEXT,
  role          TEXT,
  role_detail   TEXT,
  role_source   TEXT CHECK (role_source IS NULL OR role_source IN ('agent','admin')),
  role_note     TEXT,                             -- agent's own statement when admin set the role
  status_text   TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE machines (
  id          TEXT PRIMARY KEY,                   -- pc-…
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','retired')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE permission_policies (
  id             TEXT PRIMARY KEY,                -- pol_…
  kind           TEXT NOT NULL CHECK (kind IN ('credential','template')),
  name           TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  description    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX permission_policies_template_name ON permission_policies(name) WHERE kind = 'template';

CREATE TABLE permission_rules (
  id             TEXT PRIMARY KEY,                -- rul_…
  policy_id      TEXT NOT NULL REFERENCES permission_policies(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  effect         TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  actions        TEXT NOT NULL CHECK (json_valid(actions)),
  resource       TEXT NOT NULL,
  from_template  TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX permission_rules_policy ON permission_rules(policy_id, position);

CREATE TABLE policy_versions (
  policy_id   TEXT NOT NULL REFERENCES permission_policies(id),
  version     INTEGER NOT NULL,
  rules       TEXT NOT NULL CHECK (json_valid(rules)),
  changed_by  TEXT REFERENCES admin_users(id),
  change_note TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (policy_id, version)
);

CREATE TABLE credentials (
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
  max_live_sessions       INTEGER NOT NULL DEFAULT 20,
  created_at              INTEGER NOT NULL,
  created_by_admin        TEXT REFERENCES admin_users(id),
  first_used_at           INTEGER,
  last_used_at            INTEGER,
  revoked_at              INTEGER,
  CHECK ((kind = 'session_key') = (agent_id IS NOT NULL)),
  CHECK ((kind = 'app_key') = (machine_id IS NOT NULL))
);
CREATE INDEX credentials_agent ON credentials(agent_id);
CREATE INDEX credentials_machine ON credentials(machine_id);

CREATE TABLE session_tokens (
  token_hash            TEXT PRIMARY KEY,         -- sha256 hex
  app_credential_id     TEXT NOT NULL REFERENCES credentials(id),
  session_credential_id TEXT NOT NULL REFERENCES credentials(id),
  notice_acked_seq      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER, revoked_reason TEXT
);
CREATE INDEX session_tokens_session ON session_tokens(session_credential_id);

CREATE TABLE agent_notices (
  id           TEXT PRIMARY KEY,                  -- ntc_…
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (agent_id, seq)
);

CREATE TABLE tool_invocations (
  id              TEXT PRIMARY KEY,               -- inv_…
  credential_id   TEXT,
  app_credential_id TEXT,
  agent_id        TEXT,
  machine_id      TEXT,
  tool            TEXT NOT NULL,
  args_summary    TEXT CHECK (args_summary IS NULL OR json_valid(args_summary)),
  result          TEXT NOT NULL CHECK (result IN ('ok','denied','error','conflict','rate_limited','incident')),
  error_code      TEXT,
  duration_ms     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX tool_invocations_time ON tool_invocations(created_at);
CREATE INDEX tool_invocations_cred_time ON tool_invocations(credential_id, created_at);

CREATE TABLE resource_access_events (
  id               TEXT PRIMARY KEY,
  credential_id    TEXT, agent_id TEXT,
  path             TEXT NOT NULL,
  action           TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  rule_id          TEXT,
  revision         TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX resource_access_events_agent_time ON resource_access_events(agent_id, created_at);

CREATE TABLE authentication_events (
  id            TEXT PRIMARY KEY,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('app_key','session_key','admin')),
  credential_id TEXT, admin_id TEXT,
  key_id_presented TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('success','invalid','unknown','suspended','expired','revoked','mfa_failed','rate_limited')),
  source        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX authentication_events_time ON authentication_events(created_at);

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('admin','agent','system')),
  actor_id     TEXT,
  action       TEXT NOT NULL,
  target_kind  TEXT, target_id TEXT,
  details      TEXT CHECK (details IS NULL OR json_valid(details)),
  created_at   INTEGER NOT NULL
);
CREATE INDEX audit_events_target ON audit_events(target_kind, target_id);

CREATE TABLE security_alerts (
  id           TEXT PRIMARY KEY,
  severity     TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  type         TEXT NOT NULL,
  subject      TEXT,
  details      TEXT CHECK (details IS NULL OR json_valid(details)),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','closed')),
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  INTEGER NOT NULL
);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER policy_versions_no_update BEFORE UPDATE ON policy_versions
  BEGIN SELECT RAISE(ABORT, 'policy_versions is append-only'); END;
