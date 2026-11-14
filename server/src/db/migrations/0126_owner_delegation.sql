-- Owner enforcement (docs/authorization.md#owner-enforcement). A grant's agent delegation: the teams of the granted
-- project where the person's agents may do team work, and the vault folders they may read or contribute in. A new or
-- existing grant delegates nothing. A task records the owner of the agent that created it, so work handed over by
-- another owner's agent is trusted only up to that owner's grant. NULL: an admin or the console created it, or it predates owners.
ALTER TABLE user_project_grants ADD COLUMN delegation TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(delegation));
ALTER TABLE tasks ADD COLUMN origin_owner_id TEXT REFERENCES admin_users(id);
