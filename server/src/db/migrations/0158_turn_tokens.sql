-- Turn tokens (docs/connector.md, "Isolation levels"): a short-lived, narrower session token the connector asks for on behalf of one agent's run.
-- scope 'login' is every token so far; 'turn' is never slid by use (only the connector's renewal extends it) and cannot touch keys or access.
ALTER TABLE session_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'login';
ALTER TABLE session_tokens ADD COLUMN run_ref TEXT;
CREATE INDEX session_tokens_turn ON session_tokens(session_credential_id, scope);
-- The isolation level a PC's connector reports at check-in: 'standard' or 'hardened', and where its key file is protected.
ALTER TABLE connector_reports ADD COLUMN isolation TEXT;
ALTER TABLE connector_reports ADD COLUMN key_store TEXT;
