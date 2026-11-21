-- migrate: foreign_keys off
-- Key handover (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc): a request the hub files
-- itself for one PC and app key. Adds the kind 'rotate', the handover marker and its 24-hour expiry; SQLite cannot change a
-- CHECK in place, so the table is rebuilt; no row changes. A rotation stages each new secret's verifier on its slot at pickup,
-- and the check-in remembers the app key the PC's connector last used, which is the key a handover is bound to.
CREATE TABLE onboarding_requests_new (
  id TEXT PRIMARY KEY,
  app_credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  kind TEXT NOT NULL CHECK (kind IN ('new_team','add_agents','checkout','vault_agent','rotate')),
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
  filed TEXT NOT NULL DEFAULT '[]',
  source_set TEXT,
  handover TEXT CHECK (handover IN ('rotate','recruit')),
  expires_at INTEGER
);
INSERT INTO onboarding_requests_new(id,app_credential_id,machine_id,kind,state,version,body,approved_body,warnings,operator_note,edits,team_id,start_when_set_up,pickup_id,pickup_issues,pickup_allowed,transport,filed_at,updated_at,waiting_since,decided_at,collected_at,proposal_id,approved_version,filed,source_set)
  SELECT id,app_credential_id,machine_id,kind,state,version,body,approved_body,warnings,operator_note,edits,team_id,start_when_set_up,pickup_id,pickup_issues,pickup_allowed,transport,filed_at,updated_at,waiting_since,decided_at,collected_at,proposal_id,approved_version,filed,source_set FROM onboarding_requests;
DROP TABLE onboarding_requests;
ALTER TABLE onboarding_requests_new RENAME TO onboarding_requests;
CREATE INDEX onboarding_requests_key ON onboarding_requests(app_credential_id, state);
CREATE INDEX onboarding_requests_state ON onboarding_requests(state, filed_at);
CREATE INDEX onboarding_requests_handover ON onboarding_requests(handover, state) WHERE handover IS NOT NULL;
ALTER TABLE onboarding_slots ADD COLUMN staged_key_id TEXT;
ALTER TABLE onboarding_slots ADD COLUMN staged_verifier TEXT;
ALTER TABLE connector_reports ADD COLUMN app_credential_id TEXT;
