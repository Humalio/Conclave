-- migrate:foreign-keys-off
-- Checkout keys and render (docs/checkout.md §5, §10 phase 2). Checkout migrations take 0050 and up.
--   * onboarding_requests.kind gains 'checkout': render creates a pre-built request on the target PC, with one slot per
--     agent, so pickup and confirm are the onboarding ones. SQLite cannot alter a CHECK, so the table is rebuilt
--     (foreign keys off while it runs; the runner checks them all before commit).
--   * credentials.succession: a session key whose successor was issued by a checkout. 'superseded_pending': the successor is
--     not confirmed and the old key works as before. 'suspended': the successor was confirmed; the old key cannot log in
--     and its tokens are suspended (not revoked), so cancel or expiry can reinstate them. Revoked at restored.
--   * credentials.other_user_checkout: a second app key render created for another OS user on a known PC (the checkout
--     id). It belongs to that user, so it is never taken as the PC's own onboarding key for a later move.
--   * session_tokens.suspended_at / suspended_by: a token suspended by a checkout (its id), reinstated by clearing it;
--     its expiry moves on by the time it was suspended, so it gets back only the idle time it had left.
--   * enrolment_codes.expires_at: render-issued codes (new PC, another OS user) expire 30 minutes after render, issued
--     ones too (a retry with the nonce is refused once expired).
--     enrolled_from: the address that enrolled, shown with the new-PC approval.

CREATE TABLE onboarding_requests_new (
  id TEXT PRIMARY KEY,
  app_credential_id TEXT NOT NULL REFERENCES credentials(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  kind TEXT NOT NULL CHECK (kind IN ('new_team','add_agents','checkout')),
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
  collected_at INTEGER
);
INSERT INTO onboarding_requests_new(id,app_credential_id,machine_id,kind,state,version,body,approved_body,warnings,operator_note,edits,team_id,start_when_set_up,pickup_id,pickup_issues,pickup_allowed,transport,filed_at,updated_at,waiting_since,decided_at,collected_at)
  SELECT id,app_credential_id,machine_id,kind,state,version,body,approved_body,warnings,operator_note,edits,team_id,start_when_set_up,pickup_id,pickup_issues,pickup_allowed,transport,filed_at,updated_at,waiting_since,decided_at,collected_at FROM onboarding_requests;
DROP TABLE onboarding_requests;
ALTER TABLE onboarding_requests_new RENAME TO onboarding_requests;
CREATE INDEX onboarding_requests_key ON onboarding_requests(app_credential_id, state);
CREATE INDEX onboarding_requests_state ON onboarding_requests(state, filed_at);

ALTER TABLE credentials ADD COLUMN succession TEXT CHECK (succession IN ('superseded_pending','suspended'));
ALTER TABLE credentials ADD COLUMN other_user_checkout TEXT;
ALTER TABLE session_tokens ADD COLUMN suspended_at INTEGER;
ALTER TABLE session_tokens ADD COLUMN suspended_by TEXT;
ALTER TABLE enrolment_codes ADD COLUMN expires_at INTEGER;
ALTER TABLE enrolment_codes ADD COLUMN enrolled_from TEXT;
CREATE INDEX checkouts_request ON checkouts(request_id);
