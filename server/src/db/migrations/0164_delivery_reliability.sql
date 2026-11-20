-- Delivery reliability (docs/connector.md, "Delivery orders"): a fetched order is handed out again until its result arrives (handed_at),
-- an agent message inside the wake window is held until the window ends (release_at), and the agent and the reason of a delivery order
-- are columns the hub filters on instead of reading the payload of every row. Plus the index the expiry and retention scans use.
ALTER TABLE pc_actions ADD COLUMN agent_id TEXT;
ALTER TABLE pc_actions ADD COLUMN order_reason TEXT;
ALTER TABLE pc_actions ADD COLUMN release_at INTEGER;
ALTER TABLE pc_actions ADD COLUMN handed_at INTEGER;
UPDATE pc_actions SET agent_id=json_extract(payload,'$.agent_id'), order_reason=json_extract(payload,'$.reason') WHERE kind='deliver';
CREATE INDEX pc_actions_kind_state ON pc_actions(kind, state);
CREATE INDEX pc_actions_agent ON pc_actions(agent_id) WHERE agent_id IS NOT NULL;
