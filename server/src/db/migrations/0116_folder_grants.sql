-- Folder grants (docs/multi-user.md §1.2a): specific vault folders shared with a person, with no project. Read by
-- default; Contribute lets the person create and revise notes there. delegation: what the person's agents may do there.
CREATE TABLE user_folder_grants (
  user_id     TEXT NOT NULL REFERENCES admin_users(id),
  path        TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'read' CHECK (mode IN ('read','contribute')),
  may_export  INTEGER NOT NULL DEFAULT 0 CHECK (may_export IN (0,1)),
  delegation  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(delegation)),
  granted_by  TEXT REFERENCES admin_users(id),
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, path)
);
