-- An open question's options can be corrected by its asker or the team's coordinator while it is unanswered
-- (docs/decisions.md, "Correcting the options"). Every version is kept: version 1 is the options as asked, written
-- when the first correction is made, so a question never corrected has no rows here.
CREATE TABLE decision_versions (
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  version      INTEGER NOT NULL,
  options      TEXT NOT NULL CHECK (json_valid(options)),   -- [{key,label,effect}]
  recommended  TEXT,                                         -- an option key
  changed_by   TEXT NOT NULL,                                -- the agent who asked (version 1) or corrected them
  changed_at   INTEGER NOT NULL,
  PRIMARY KEY (decision_id, version)
);
