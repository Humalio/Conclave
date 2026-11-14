-- One restore path with authorship from the backup (docs/blueprint.md §4.2).
-- bp_items.attributed_to: the author an export file claims for a restored item whose writer the hub could not verify,
-- as JSON {kind, id}. Attribution only: trust is worked out from created_by and updated_by, never from this column.
-- bp_restores: each applied restore, by its digest (the hub's hash of the text, scope, backup and maps) and the
-- version it was checked against, so a retry of the same restore returns its first result and writes nothing.
-- Additive only: the old image still runs on this schema (it ignores the new column and table).
ALTER TABLE bp_items ADD COLUMN attributed_to TEXT;
CREATE TABLE bp_restores (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  digest TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, digest, base_version)
);
