-- The vault folder "99 Conclave/" (docs/vault.md): the hub's read-only Markdown copies of its records, and the deferred purge
-- of handout bodies (docs/checkout.md §3, D63).

-- Every page the hub wrote there, by path: what it copies and the revision it last wrote. It belongs to no reset part, so
-- pages and their paths outlive the records they copy (a new team with an old team's name gets " (2)").
CREATE TABLE mirror_files (
  path        TEXT PRIMARY KEY,                       -- vault-relative, e.g. "99 Conclave/README.md"
  kind        TEXT NOT NULL CHECK (kind IN ('readme','team','session','checkout','handout','reviews','decisions')),
  ref_id      TEXT NOT NULL,                          -- the record the page copies (team, team:agent, checkout, handout, team:YYYY-MM)
  ref_version INTEGER,                                -- handout pages: the handout version the page was built from
  revision    TEXT NOT NULL,                          -- sha256:… of the text the hub last wrote
  written_at  INTEGER NOT NULL
);
CREATE INDEX mirror_files_ref ON mirror_files(kind, ref_id);

-- When a handout body may be cleared: set where the body used to be cleared at once (resume, restored, finish, cancel or
-- expiry). The purge clears it once the handout's page holds this version, or 7 days after this time at the latest.
ALTER TABLE handouts ADD COLUMN purge_due INTEGER;

-- 99 Conclave/ is a restricted folder: console members see it only when it is granted to them by name. The hub re-adds
-- this row at boot if it is missing.
INSERT OR IGNORE INTO vault_folder_flags(path, restricted, set_by, set_at) VALUES ('/99 Conclave/', 1, NULL, 0);
