-- Console users (docs/multi-user.md §1.3, §1.4) and the reads behind their views:
--   * admin_users.totp_last_step: the last 30-second step a user's code was accepted for. A code counts only for a later
--     step, so each code works once.
--   * An admin is never external. Admins marked external become plain admins; their 2FA requirement stays.
--   * An admin is never a team's decider. Rows left by a promotion are removed (the admin decides as the admin).
--   * A decider's request list reads the requests of their teams: an index on team_id.
--   * The work feed reads task events by time: an index on created_at (0052 adds the one on bp_events).

ALTER TABLE admin_users ADD COLUMN totp_last_step INTEGER;

UPDATE admin_users SET external=0, totp_required=1 WHERE role='admin' AND external=1;

DELETE FROM team_deciders WHERE user_id IN (SELECT id FROM admin_users WHERE role='admin');

CREATE INDEX IF NOT EXISTS access_requests_team ON access_requests(team_id, created_at);
CREATE INDEX IF NOT EXISTS task_events_created ON task_events(created_at);
