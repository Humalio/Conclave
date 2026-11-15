-- Agent status from the hub's own records (docs/dashboard-ux.md, "Agent status"): connected_at is the agent's first call
-- after signing in, last_active_at its latest. The helper's own calls (session_login, session_whoami), such as the setup
-- login test, set neither, so an agent set up but never started shows "Not connected yet".
ALTER TABLE agents ADD COLUMN connected_at INTEGER;
ALTER TABLE agents ADD COLUMN last_active_at INTEGER;
-- Agents that already worked keep their history, from the call log the hub still holds.
UPDATE agents SET connected_at=(SELECT MIN(created_at) FROM tool_invocations i WHERE i.agent_id=agents.id AND i.tool NOT IN ('session_login','session_whoami')),
  last_active_at=(SELECT MAX(created_at) FROM tool_invocations i WHERE i.agent_id=agents.id AND i.tool NOT IN ('session_login','session_whoami'));
