-- Project Blueprint, phase 3 (docs/blueprint.md §5): the version each item last changed at, so bp_read {since_version}
-- returns only what changed (the team-plan mirror writes no event, so events alone cannot say). Existing items count as
-- changed at their project's current version: a reader who read before this migration sees them once more.
ALTER TABLE bp_items ADD COLUMN changed_version INTEGER;
UPDATE bp_items SET changed_version = (SELECT version FROM projects p WHERE p.id = bp_items.project_id);
CREATE INDEX bp_items_changed ON bp_items(project_id, changed_version);
