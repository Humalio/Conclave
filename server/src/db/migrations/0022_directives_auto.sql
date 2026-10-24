-- Directives agents report are registered at once (docs/directives.md): reported_by names the agent, and reviewed_at
-- stays NULL until the operator keeps, edits or merges it. Directives the operator wrote count as reviewed.
ALTER TABLE directives ADD COLUMN reported_by TEXT;
ALTER TABLE directives ADD COLUMN reviewed_at INTEGER;
UPDATE directives SET reviewed_at = updated_at WHERE reviewed_at IS NULL;
CREATE INDEX directives_review ON directives(status, reviewed_at);
