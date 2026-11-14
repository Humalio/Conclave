-- A team's coordinator may agree requirements in its own Blueprint part when the operator turns this on (docs/blueprint.md §4).
ALTER TABLE teams ADD COLUMN coordinator_decides_blueprint INTEGER NOT NULL DEFAULT 0;
-- The keys a coordinator agreed under that setting in this write (JSON array), so Work in motion can say so; NULL otherwise.
ALTER TABLE bp_events ADD COLUMN decided TEXT CHECK (decided IS NULL OR json_valid(decided));
