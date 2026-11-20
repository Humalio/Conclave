-- Delegate one agent to a collaborator (docs/checkout.md §9 F1): a checkout whose unit is one agent of a team. The
-- delegate is a person (a console member) recorded on the checkout; the target is an ordinary PC from the admin's list,
-- an existing one or a new one by name. Every existing checkout is a team checkout and reads as before.
ALTER TABLE checkouts ADD COLUMN scope TEXT NOT NULL DEFAULT 'team' CHECK (scope IN ('team','agent'));
ALTER TABLE checkouts ADD COLUMN agent_id TEXT REFERENCES agents(id);
-- The person who runs the agent while delegated: their grant is a ceiling on the agent from confirm until Take back.
ALTER TABLE checkouts ADD COLUMN delegate_user_id TEXT REFERENCES admin_users(id);
-- The render the admin chose (target PC, provider choices; no secret). The hub renders it when the delegate opens the
-- prompt in their own console, so the enrolment code's 30 minutes count from then.
ALTER TABLE checkouts ADD COLUMN delegate_render TEXT;
ALTER TABLE checkouts ADD COLUMN prompt_opened_at INTEGER;
-- A new PC: the delegate says it is theirs (or not) before the admin may approve it. Reset at every render.
ALTER TABLE checkouts ADD COLUMN pc_confirmed_at INTEGER;
ALTER TABLE checkouts ADD COLUMN pc_refused_at INTEGER;
-- The delegation ended: Take back, a later checkout of the agent that restored, or (delegate is the admin) at once.
ALTER TABLE checkouts ADD COLUMN released_at INTEGER;
ALTER TABLE checkouts ADD COLUMN released_by TEXT;
ALTER TABLE checkouts ADD COLUMN release_reason TEXT;
-- Contributor mode's drafts folder ("/05 Papers/P1/contrib/Astra/"): the admin's explicit folder grant for the delegate,
-- Contribute on that folder only, made at Delegate and removed at Take back. Null: the agent writes nothing in the vault.
ALTER TABLE checkouts ADD COLUMN drafts_path TEXT;
-- One open checkout per team (team scope) and per agent (agent scope); the two refuse each other in code.
DROP INDEX checkouts_one_open;
CREATE UNIQUE INDEX checkouts_one_open ON checkouts(team_id) WHERE scope='team' AND status IN ('collecting','ready','rendered','restoring');
CREATE UNIQUE INDEX checkouts_one_open_agent ON checkouts(agent_id) WHERE scope='agent' AND status IN ('collecting','ready','rendered','restoring');
CREATE INDEX checkouts_agent ON checkouts(agent_id, status);
-- The member is away (one-agent checkout, from ready until it resumes): the lease, stall and overdue sweeps skip it, its
-- reviews go to a replacement reviewer (or wait for it) and new assignments go to others.
ALTER TABLE team_members ADD COLUMN away_until INTEGER;
