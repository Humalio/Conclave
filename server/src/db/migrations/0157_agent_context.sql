-- How full each agent's context is (design "the connector delivers work" 3c): the latest numbers a PC reported on its
-- check-in, under the PC user's usage opt-in. Numbers and a model id only, never message text. One row per agent.
CREATE TABLE agent_context (
  agent_id       TEXT PRIMARY KEY REFERENCES agents(id),
  machine_id     TEXT NOT NULL REFERENCES machines(id),
  source         TEXT NOT NULL CHECK (source IN ('connector','chat')),
  client         TEXT NOT NULL,
  model          TEXT NOT NULL,
  context_tokens INTEGER NOT NULL,
  window_tokens  INTEGER,
  turn_tokens    INTEGER NOT NULL,
  compacted_at   INTEGER,
  compacts       INTEGER NOT NULL DEFAULT 0,
  read_at        INTEGER,
  reported_at    INTEGER NOT NULL
);
CREATE INDEX agent_context_machine ON agent_context(machine_id);
