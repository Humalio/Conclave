-- Status-report archive (docs/blueprint.md §6, §7): a project keeps reports_per_project reports live (default 500); older
-- ones get archived=1. Live reads, the card and the summary skip archived rows; the Markdown export includes them.
-- Archived rows stay in bp_items, so keys are never reused and nothing is lost.
ALTER TABLE bp_items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX bp_items_reports ON bp_items(project_id, kind, archived, created_at);
