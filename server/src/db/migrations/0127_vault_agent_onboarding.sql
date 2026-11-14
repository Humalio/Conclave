-- migrate: foreign_keys off
-- A vault-only onboarding request (docs/onboarding.md#a-vault-agent): one teamless agent within its owner's folder
-- grants. SQLite cannot change a CHECK in place, so the table is rebuilt with the new kind; no row changes.
CREATE TABLE onboarding_requests_new (
  id TEXT PRIMARY KEY,
  app_credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  kind TEXT NOT NULL CHECK (kind IN ('new_team','add_agents','checkout','vault_agent')),
  state TEXT NOT NULL CHECK (state IN ('submitted','needs_changes','approved','collected','denied','withdrawn','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  approved_body TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  operator_note TEXT,
  edits TEXT NOT NULL DEFAULT '[]',
  team_id TEXT REFERENCES teams(id),
  start_when_set_up INTEGER NOT NULL DEFAULT 1,
  pickup_id TEXT,
  pickup_issues INTEGER NOT NULL DEFAULT 0,
  pickup_allowed INTEGER NOT NULL DEFAULT 3,
  transport TEXT,
  filed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  waiting_since INTEGER NOT NULL,
  decided_at INTEGER,
  collected_at INTEGER,
  proposal_id TEXT,
  approved_version INTEGER,
  filed TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO onboarding_requests_new(id,app_credential_id,machine_id,kind,state,version,body,approved_body,warnings,operator_note,edits,team_id,start_when_set_up,pickup_id,pickup_issues,pickup_allowed,transport,filed_at,updated_at,waiting_since,decided_at,collected_at,proposal_id,approved_version,filed)
  SELECT id,app_credential_id,machine_id,kind,state,version,body,approved_body,warnings,operator_note,edits,team_id,start_when_set_up,pickup_id,pickup_issues,pickup_allowed,transport,filed_at,updated_at,waiting_since,decided_at,collected_at,proposal_id,approved_version,filed FROM onboarding_requests;
DROP TABLE onboarding_requests;
ALTER TABLE onboarding_requests_new RENAME TO onboarding_requests;
CREATE INDEX onboarding_requests_key ON onboarding_requests(app_credential_id, state);
CREATE INDEX onboarding_requests_state ON onboarding_requests(state, filed_at);
