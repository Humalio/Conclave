-- Usage per agent and per team (docs/connector.md, "Usage and cost"): the connector also reports turns. NULL: a row from a
-- connector that did not report them (Unknown, never 0). The index serves the agent and team views, which read across PCs.
ALTER TABLE connector_usage ADD COLUMN turns INTEGER;
CREATE INDEX connector_usage_agent ON connector_usage(agent_id, day);
