-- 0010 — Knowledge graph K3–K5 (design/13): flags with tasks, editor opt-in, tags, reputation, merges, batching, offers.

ALTER TABLE kg_flags ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kg_flags ADD COLUMN resolved_at INTEGER;
ALTER TABLE kg_flags ADD COLUMN task_id TEXT;
ALTER TABLE kg_flags ADD COLUMN file_rev TEXT;        -- revision of the flagged note when the flag was raised
ALTER TABLE kg_flags ADD COLUMN raised_by TEXT;       -- agent id, or 'hub'
ALTER TABLE kg_flags ADD COLUMN job_id TEXT;
CREATE INDEX kg_flags_open ON kg_flags(status, file_id);

ALTER TABLE kg_jobs ADD COLUMN offered_until INTEGER;
ALTER TABLE kg_jobs ADD COLUMN exclude_agent TEXT;    -- independence: never leased to the producing session
ALTER TABLE kg_jobs ADD COLUMN batch_of TEXT;         -- small notes packed into one delivered item

ALTER TABLE kg_entities ADD COLUMN merged_into TEXT;

CREATE TABLE kg_editor_optin (agent_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE kg_tags (file_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (file_id, tag));
CREATE INDEX kg_tags_tag ON kg_tags(tag);
CREATE TABLE kg_reputation (
  kind TEXT NOT NULL CHECK (kind IN ('label','agent')), ref TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0, disagreed INTEGER NOT NULL DEFAULT 0, restricted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, ref)
);
CREATE TABLE kg_merge_proposals (
  id TEXT PRIMARY KEY, keep_id TEXT NOT NULL, drop_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','merged','rejected')),
  reason TEXT, job_id TEXT, task_id TEXT, proposed_by TEXT, decided_by TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE kg_keepapart (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
