-- One new link relation, paper → studies → hypothesis (docs/blueprint.md §2.3): a planned paper names the hypotheses it
-- sets out to report on before it has claims. SQLite cannot change a CHECK in place, so bp_links is rebuilt with the
-- relation added and its rows and index kept. No table references bp_links, so foreign keys stay on.
CREATE TABLE bp_links_new (
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_key         TEXT NOT NULL,
  to_key           TEXT NOT NULL,
  rel              TEXT NOT NULL CHECK (rel IN ('delivers','ships','governs','supersedes','threatens','blocks','evidence','studies')),
  created_by_kind  TEXT NOT NULL,
  created_by_id    TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, from_key, to_key, rel)
);
INSERT INTO bp_links_new(project_id,from_key,to_key,rel,created_by_kind,created_by_id,created_at)
  SELECT project_id,from_key,to_key,rel,created_by_kind,created_by_id,created_at FROM bp_links;
DROP TABLE bp_links;
ALTER TABLE bp_links_new RENAME TO bp_links;
CREATE INDEX bp_links_to ON bp_links(project_id, to_key);
