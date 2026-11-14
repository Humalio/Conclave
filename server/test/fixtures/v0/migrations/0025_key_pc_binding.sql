-- PC binding of session keys (docs/onboarding.md#pc-binding-of-session-keys). bound_machine_id names the one PC a
-- session key may log in from (through an app key on that PC); NULL means free (any permitted PC). Existing keys stay free.
ALTER TABLE credentials ADD COLUMN bound_machine_id TEXT REFERENCES machines(id);
