-- Decider routing (docs/multi-user.md §1.3, MU3). team_deciders exists since 0040; this adds what routing needs.
-- teams.request_ceiling: the per-team ceiling for access requests a decider may approve (decision D1), as JSON
--   {actions, folders, max_s}; NULL means the default (read and write under the project's vault roots, at most 7 days).
-- access_requests.team_id: the team the request is routed to, resolved when the agent asks (task_ref, else the agent's
--   only running team); NULL routes it to the admin.
-- decisions.escalated_at: when a question routed to deciders passed needed_by, or 24 h with no answer, and became an
--   admin attention item.
ALTER TABLE teams ADD COLUMN request_ceiling TEXT;
ALTER TABLE access_requests ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE decisions ADD COLUMN escalated_at INTEGER;
