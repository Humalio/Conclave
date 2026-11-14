-- Multi-user MU1 (docs/multi-user.md §1, §6): console users with a role, project grants, team deciders, restricted
-- vault folders, project vault roots, one-use setup links, and the audit actor's role.

-- Users: the table keeps its name; existing rows are admins.
ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','member'));
ALTER TABLE admin_users ADD COLUMN display_name TEXT;
ALTER TABLE admin_users ADD COLUMN external INTEGER NOT NULL DEFAULT 0 CHECK (external IN (0,1));
ALTER TABLE admin_users ADD COLUMN org TEXT;
ALTER TABLE admin_users ADD COLUMN expires_at INTEGER;                 -- NULL: no expiry
ALTER TABLE admin_users ADD COLUMN totp_required INTEGER NOT NULL DEFAULT 0 CHECK (totp_required IN (0,1));
ALTER TABLE admin_users ADD COLUMN created_by TEXT REFERENCES admin_users(id);
ALTER TABLE admin_users ADD COLUMN expired_at INTEGER;                 -- when expiry was enforced (audited once)
ALTER TABLE admin_users ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1 CHECK (password_set IN (0,1)); -- 0 until the setup link is used

-- A one-use setup link: the user sets their own password (and TOTP when required). Only the token's hash is kept.
CREATE TABLE user_setup_links (
  token_hash   TEXT PRIMARY KEY,                       -- sha256 hex of the token
  user_id      TEXT NOT NULL REFERENCES admin_users(id),
  created_by   TEXT REFERENCES admin_users(id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                       -- created_at + 72 h
  used_at      INTEGER,
  revoked_at   INTEGER,                                -- a newer link replaced it
  totp_secret  TEXT                                    -- pending secret shown on the setup page when TOTP is required
);
CREATE INDEX user_setup_links_user ON user_setup_links(user_id);

-- What a member may see, per project; no row means the project does not exist for that user.
CREATE TABLE user_project_grants (
  user_id       TEXT NOT NULL REFERENCES admin_users(id),
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  components    TEXT NOT NULL DEFAULT '["blueprint"]' CHECK (json_valid(components)),
  vault_folders TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(vault_folders)),
  may_export    INTEGER NOT NULL DEFAULT 0 CHECK (may_export IN (0,1)),
  granted_by    TEXT REFERENCES admin_users(id),
  granted_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

-- Who decides for a team (§1.3); an empty list means the admin decides. Routing is MU3.
CREATE TABLE team_deciders (
  team_id   TEXT NOT NULL REFERENCES teams(id),
  user_id   TEXT NOT NULL REFERENCES admin_users(id),
  added_by  TEXT REFERENCES admin_users(id),
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- Restricted vault folders (§1.2): never inside a member grant unless named, never for an external user.
CREATE TABLE vault_folder_flags (
  path        TEXT PRIMARY KEY,                        -- vault-relative folder, with leading and trailing slash
  restricted  INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0,1)),
  set_by      TEXT REFERENCES admin_users(id),
  set_at      INTEGER NOT NULL
);

-- Folders the admin assigns to a project; an empty list means the default /Projects/<name>/.
ALTER TABLE projects ADD COLUMN vault_roots TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(vault_roots));

-- The audit actor's role for console users (admin or member). actor_kind stays 'admin' for every console user:
-- audit_events is append-only and its CHECK on actor_kind cannot change without rewriting the trail.
ALTER TABLE audit_events ADD COLUMN actor_role TEXT CHECK (actor_role IS NULL OR actor_role IN ('admin','member'));
