-- The hub's own order kind "deliver" (docs/connector.md, "Delivery orders"): ids only, made by the hub when an item waits on an agent of a PC.
CREATE TABLE pc_actions_new (
  id           TEXT PRIMARY KEY,
  machine_id   TEXT NOT NULL REFERENCES machines(id),
  kind         TEXT NOT NULL CHECK (kind IN ('check','restore','update','disconnect','deliver')),
  state        TEXT NOT NULL CHECK (state IN ('queued','fetched','done','failed','expired','access_revoked','cleanup_pending','removed','needs_attention')),
  payload      TEXT NOT NULL DEFAULT '{}',
  result       TEXT,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  fetched_at   INTEGER,
  finished_at  INTEGER,
  expires_at   INTEGER NOT NULL,
  receipt_key_id   TEXT UNIQUE,
  receipt_verifier TEXT,
  ended_at     INTEGER
);
INSERT INTO pc_actions_new SELECT id,machine_id,kind,state,payload,result,created_at,created_by,fetched_at,finished_at,expires_at,receipt_key_id,receipt_verifier,ended_at FROM pc_actions;
DROP TABLE pc_actions;
ALTER TABLE pc_actions_new RENAME TO pc_actions;
CREATE INDEX pc_actions_machine ON pc_actions(machine_id, created_at);
