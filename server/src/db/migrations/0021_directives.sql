-- Directives (docs/directives.md): the operator's standing rules as hub records, with a scope, a version, who has
-- read which version, and the rules agents report following that the hub does not know yet.
CREATE TABLE directives (
  id          TEXT PRIMARY KEY,                    -- dir_…
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('hub','project','team','role','agent')),
  scope_ref   TEXT,                                -- project name, team id, "<team id>|<role>", agent id; NULL for hub
  version     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  source      TEXT,                                -- where it came from (a file path, "console"), for the record
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX directives_scope ON directives(status, scope_kind, scope_ref);

CREATE TABLE directive_versions (
  directive_id TEXT NOT NULL REFERENCES directives(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  scope_kind   TEXT NOT NULL,
  scope_ref    TEXT,
  change_note  TEXT,
  changed_by   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (directive_id, version)
);

CREATE TABLE directive_acks (
  directive_id TEXT NOT NULL REFERENCES directives(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  version      INTEGER NOT NULL,
  acked_at     INTEGER NOT NULL,
  PRIMARY KEY (directive_id, agent_id)
);

CREATE TABLE directive_reports (
  id           TEXT PRIMARY KEY,                   -- drp_…
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  title        TEXT NOT NULL,
  source       TEXT,
  summary      TEXT NOT NULL,
  text         TEXT,                               -- the rule's own text, when the agent can send it
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','adopted','retired','known')),
  directive_id TEXT REFERENCES directives(id),
  note         TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE INDEX directive_reports_status ON directive_reports(status, created_at);
CREATE INDEX directive_reports_agent ON directive_reports(agent_id, status);
