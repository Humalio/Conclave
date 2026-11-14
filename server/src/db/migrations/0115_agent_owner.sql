-- Every agent records the console user who owns it (docs/authorization.md#agent-owners). NULL: unowned, as every agent
-- that exists when this runs; the admin claims them in one audited step. Owner enforcement is a setting, off by default.
ALTER TABLE agents ADD COLUMN owner_user_id TEXT REFERENCES admin_users(id);
CREATE INDEX agents_owner ON agents(owner_user_id);
