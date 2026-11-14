-- Later (docs/dashboard-ux.md "Attention words", SPEC-ATTENTION-05): one viewer setting one Needs you row aside, kept in
-- the dismissals table. For Later, `record` is the row's id and `episode` its version, so "until it changes" is the same
-- key mismatch a dismissal uses. `until` is the chosen end (NULL: until it changes); either way it ends 7 days after
-- `dismissed_at`. The decision still waits for everyone; only this viewer's surfaces hide it.
ALTER TABLE attention_dismissals ADD COLUMN kind TEXT NOT NULL DEFAULT 'dismiss' CHECK (kind IN ('dismiss','later'));
ALTER TABLE attention_dismissals ADD COLUMN until INTEGER;
