-- Checkout and handouts (docs/checkout.md §3): one move of one team to another provider, OS user or PC.
-- Every state change is a guarded UPDATE ... WHERE id=? AND status=?. Handout bodies hold local facts only (no secret,
-- no copy of hub data) and are purged to NULL once consumed or removed.

-- status: collecting -> ready -> rendered -> restoring -> restored, or cancelled / expired before restored.
CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,                                  -- cko_...
  team_id TEXT NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL CHECK (status IN ('collecting','ready','rendered','restoring','restored','cancelled','expired')),
  source_machine_id TEXT REFERENCES machines(id),       -- the PC the team runs on (from its onboarding request), if known
  target_machine_id TEXT REFERENCES machines(id),       -- set at render
  request_id TEXT REFERENCES onboarding_requests(id),   -- the checkout onboarding request created at render
  choices TEXT,                                         -- JSON from render: target, rotate_agent_keys, per agent {provider, model, permissions}
  handout_hashes TEXT,                                  -- JSON {agent_id: sha256}, stored at render
  paused_team INTEGER NOT NULL DEFAULT 0,               -- 1 when this checkout paused the team at ready (and so lifts the pause)
  missing TEXT NOT NULL DEFAULT '[]',                   -- JSON agent ids whose handout the hub built at ready (no notes, work left on the source)
  end_reason TEXT,                                      -- cancel note, 'team_ended', 'expired'
  requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER,
  rendered_at INTEGER,
  restoring_at INTEGER,
  restored_at INTEGER,
  ended_at INTEGER,                                     -- cancelled or expired
  expires_at INTEGER NOT NULL,                          -- 48 h after start, reset at render
  overdue_at INTEGER                                    -- set once when it passed expires_at while restoring (an Attention item)
);
CREATE INDEX checkouts_team ON checkouts(team_id, status);
CREATE INDEX checkouts_due ON checkouts(status, expires_at);
-- One open checkout per team.
CREATE UNIQUE INDEX checkouts_one_open ON checkouts(team_id) WHERE status IN ('collecting','ready','rendered','restoring');

-- status: requested -> checkpointing -> merged -> written -> consumed, or removed (cancel, expiry).
CREATE TABLE handouts (
  id TEXT PRIMARY KEY,                                  -- hnd_...
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('requested','checkpointing','merged','written','consumed','removed')),
  source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','hub')), -- 'hub': built at ready from the slot and agent row
  report TEXT,                                          -- the agent's latest checkpoint report (merged: commits, worktrees, clean, leftovers)
  body TEXT,                                            -- JSON local facts, at most 8 000 characters; NULL once consumed or removed
  version INTEGER NOT NULL DEFAULT 0,                   -- bumped on each write or replace
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checkpointing_at INTEGER,
  merged_at INTEGER,
  written_at INTEGER,
  consumed_at INTEGER,
  removed_at INTEGER,
  new_credential_id TEXT REFERENCES credentials(id),
  UNIQUE (checkout_id, agent_id)
);
CREATE INDEX handouts_agent ON handouts(agent_id, status);
