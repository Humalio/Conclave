-- Directive categories and tags (docs/directives.md#categories-and-tags). The category comes from a fixed list the hub
-- knows (NULL: none yet); tags are a JSON array of short lowercase words. proposed_category is what the reporting
-- agent suggested in directives_report; it becomes the category only when the operator confirms it in review.
-- directive_versions keeps the category and tags each version was saved with.
ALTER TABLE directives ADD COLUMN category TEXT CHECK (category IS NULL OR category IN ('access','communication','tokens','reporting','sources','process','tooling'));
ALTER TABLE directives ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE directives ADD COLUMN proposed_category TEXT CHECK (proposed_category IS NULL OR proposed_category IN ('access','communication','tokens','reporting','sources','process','tooling'));
ALTER TABLE directive_versions ADD COLUMN category TEXT;
ALTER TABLE directive_versions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
CREATE INDEX directives_category ON directives(status, category);
