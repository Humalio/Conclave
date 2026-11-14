-- Attention words (docs/dashboard-ux.md "Attention words"): a viewer's dismissal of one For awareness row, keyed by
-- viewer, record and episode, so it persists across refresh and devices and a new episode of the same record shows
-- again. A dismissal changes nothing else: the record, its status, any alert and the audit trail stay as they are.
CREATE TABLE attention_dismissals (
  user_id      TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  record       TEXT NOT NULL,                  -- the source record, e.g. member:<team>:<agent>, milestone:<project>:M2
  episode      TEXT NOT NULL,                  -- what defines this occurrence, e.g. the due date and status
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, record, episode)
);
-- Stall warnings are off by default per team, missed milestones off per project; each setting applies to every
-- attention surface (For awareness, team badges).
ALTER TABLE teams ADD COLUMN stall_warnings INTEGER NOT NULL DEFAULT 0 CHECK (stall_warnings IN (0,1));
ALTER TABLE projects ADD COLUMN missed_warnings INTEGER NOT NULL DEFAULT 0 CHECK (missed_warnings IN (0,1));
