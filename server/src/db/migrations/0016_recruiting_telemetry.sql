-- Recruiting: a coordinator may add agents to its team within an envelope the administrator sets per team.
--   recruiting           'off' (default) | 'propose' (the administrator approves each new agent) | 'auto' (within the envelope)
--   recruit_max          most recruited agents the team may hold at once
--   recruit_roles        JSON list of roles a recruit may take (never coordinator)
--   recruit_template_id  the permission template every recruit gets: its ceiling (never more than the coordinator holds)
--   recruit_days         lifetime of a recruit's session key
ALTER TABLE teams ADD COLUMN recruiting TEXT NOT NULL DEFAULT 'off' CHECK (recruiting IN ('off','propose','auto'));
ALTER TABLE teams ADD COLUMN recruit_max INTEGER NOT NULL DEFAULT 4;
ALTER TABLE teams ADD COLUMN recruit_roles TEXT NOT NULL DEFAULT '["worker","reviewer","stakeholder"]';
ALTER TABLE teams ADD COLUMN recruit_template_id TEXT REFERENCES permission_policies(id);
ALTER TABLE teams ADD COLUMN recruit_days INTEGER NOT NULL DEFAULT 7;
-- Which team and coordinator recruited an agent (NULL for agents the administrator created).
ALTER TABLE agents ADD COLUMN recruited_team_id TEXT;
ALTER TABLE agents ADD COLUMN recruited_by TEXT;
CREATE TABLE recruit_requests (
  id            TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id),
  requested_by  TEXT NOT NULL REFERENCES agents(id),
  label         TEXT NOT NULL,
  role          TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied','cancelled')),
  note          TEXT,
  agent_id      TEXT REFERENCES agents(id),
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX recruit_requests_team ON recruit_requests(team_id, status);
-- Telemetry: size of each tool answer, a proxy for the context the hub adds to an agent (about 4 bytes per token).
ALTER TABLE tool_invocations ADD COLUMN result_bytes INTEGER;
