-- Project Blueprint, phase 2 (docs/blueprint.md §2.6, §4): rights and proposals.
-- A proposal remembers the revision of every item it touches (null for one that did not exist), so applying it can tell
-- whether the blueprint moved under it and mark it stale instead of overwriting someone else's change.
ALTER TABLE bp_proposals ADD COLUMN revs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(revs));
CREATE INDEX bp_proposals_agent ON bp_proposals(agent_id, status);

-- team_ask {decision: true}: the answer becomes a decision entry (ADR) in the team's project; bp_key names it.
ALTER TABLE decisions ADD COLUMN make_decision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN bp_key TEXT;
