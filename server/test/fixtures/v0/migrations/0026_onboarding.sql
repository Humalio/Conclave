-- One-prompt onboarding (docs/onboarding.md): enrolment codes, requests, approval slots, the onboarding capability on an
-- app key, the PC's chosen MCP transport and a team's project. Secrets are never stored: codes and keys keep only verifiers.
ALTER TABLE credentials ADD COLUMN onboarding_enabled_at INTEGER;
ALTER TABLE machines ADD COLUMN mcp_transport TEXT CHECK (mcp_transport IN ('https','http'));
ALTER TABLE teams ADD COLUMN project TEXT;

-- Single-use enrolment code: swapped once for the PC's app key secret. status: unused -> issued (secret handed out, can be
-- reissued with the same nonce) -> confirmed; revoked by the operator or by Re-enrol PC. No expiry (Bruno, 12 Nov).
CREATE TABLE enrolment_codes (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  app_credential_id TEXT NOT NULL REFERENCES credentials(id),
  verifier TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','issued','confirmed','revoked')),
  nonce_hash TEXT,
  issues INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  confirmed_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX enrolment_codes_machine ON enrolment_codes(machine_id, status);

CREATE TABLE onboarding_requests (
  id TEXT PRIMARY KEY,
  app_credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  kind TEXT NOT NULL CHECK (kind IN ('new_team','add_agents')),
  state TEXT NOT NULL CHECK (state IN ('submitted','needs_changes','approved','collected','denied','withdrawn','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,                 -- the request as filed or last amended (L2, written by a model)
  approved_body TEXT,                 -- the request after the operator's edits
  warnings TEXT NOT NULL DEFAULT '[]',
  operator_note TEXT,
  edits TEXT NOT NULL DEFAULT '[]',   -- the operator's edits as a diff, returned with the status
  team_id TEXT REFERENCES teams(id),
  start_when_set_up INTEGER NOT NULL DEFAULT 1,
  pickup_id TEXT,                     -- the latest issue; confirm accepts only this one
  pickup_issues INTEGER NOT NULL DEFAULT 0,
  pickup_allowed INTEGER NOT NULL DEFAULT 3,
  transport TEXT,
  filed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  waiting_since INTEGER NOT NULL,
  decided_at INTEGER,
  collected_at INTEGER
);
CREATE INDEX onboarding_requests_key ON onboarding_requests(app_credential_id, state);
CREATE INDEX onboarding_requests_state ON onboarding_requests(state, filed_at);

-- The request's history for the console: filed, amended, edits, decisions, pickups. Details hold no secrets.
CREATE TABLE onboarding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES onboarding_requests(id),
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX onboarding_events_request ON onboarding_events(request_id, id);

-- One row per approved agent. Keys are created at pickup, never at approval; credential_id names the latest issued key.
CREATE TABLE onboarding_slots (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES onboarding_requests(id),
  slot TEXT NOT NULL,                 -- <role> or <role>_<n>, the key the approval names
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL,                 -- the request's role name (playbook role)
  team_role TEXT NOT NULL CHECK (team_role IN ('coordinator','worker','reviewer','stakeholder')),
  label TEXT NOT NULL,
  session_var TEXT NOT NULL,
  folder TEXT NOT NULL,
  bound INTEGER NOT NULL DEFAULT 1,
  template_id TEXT REFERENCES permission_policies(id),
  ceiling TEXT NOT NULL,              -- snapshot of the ceiling rules applied at pickup
  credential_id TEXT REFERENCES credentials(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','issued','confirmed','closed')),
  created_at INTEGER NOT NULL,
  UNIQUE (request_id, slot)
);
CREATE INDEX onboarding_slots_request ON onboarding_slots(request_id);
