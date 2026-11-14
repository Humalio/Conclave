-- A person's write in the console (docs/vault.md "People writing in the vault") names its author: the kind
-- (operator or collaborator) and the console user id. Both are kept on the revision and on the write intent, so a
-- write recovered after a crash keeps its author. NULL for agents' writes, external changes and older rows.
ALTER TABLE file_revisions ADD COLUMN author_kind TEXT CHECK (author_kind IS NULL OR author_kind IN ('operator','collaborator'));
ALTER TABLE file_revisions ADD COLUMN user_id TEXT;
ALTER TABLE write_intents ADD COLUMN author_kind TEXT CHECK (author_kind IS NULL OR author_kind IN ('operator','collaborator'));
ALTER TABLE write_intents ADD COLUMN user_id TEXT;
