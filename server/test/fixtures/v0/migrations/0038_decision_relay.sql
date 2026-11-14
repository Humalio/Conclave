-- Relayed answers (docs/decisions.md#relayed-answers): the operator often answers a team_ask outside the hub (in chat).
-- The asking team's coordinator records that answer with team_ask_update; it is kept as relayed (L1) until the operator
-- confirms it (L0) or overturns it with an answer of their own.
ALTER TABLE decisions ADD COLUMN relayed_by TEXT REFERENCES agents(id);  -- the coordinator who relayed it
ALTER TABLE decisions ADD COLUMN relayed_source TEXT;                    -- where the operator gave it ("chat with operator")
ALTER TABLE decisions ADD COLUMN relayed_option TEXT;                    -- the relayed answer, kept after an overturn
ALTER TABLE decisions ADD COLUMN relayed_text TEXT;
ALTER TABLE decisions ADD COLUMN relayed_at INTEGER;
ALTER TABLE decisions ADD COLUMN relay_state TEXT CHECK (relay_state IN ('pending','confirmed','overturned'));
ALTER TABLE decisions ADD COLUMN relay_settled_at INTEGER;               -- when the operator confirmed or overturned it
