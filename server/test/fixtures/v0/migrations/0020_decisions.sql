-- Decisions (docs/decisions.md): a team member asks the operator a question, optionally blocking a task until the
-- answer. The answered questions are the team's decision log.
CREATE TABLE decisions (
  id             TEXT PRIMARY KEY,                -- dec_…
  team_id        TEXT NOT NULL REFERENCES teams(id),
  task_id        TEXT REFERENCES tasks(id),       -- the task it blocks until answered, if any
  blocks_task    INTEGER NOT NULL DEFAULT 0,      -- 1 while the task is blocked by this question
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  credential_id  TEXT,
  question       TEXT NOT NULL,
  context        TEXT,
  options        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options)),  -- [{key,label,effect}]
  recommended    TEXT,                            -- an option key
  refs           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(refs)),     -- plan keys (R1, M2)
  needed_by      INTEGER,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','needs_info','answered','declined','withdrawn')),
  info_note      TEXT,                            -- what the operator asked for (needs_info)
  answer_option  TEXT,
  answer_text    TEXT,
  answered_by    TEXT,                            -- admin id
  answered_at    INTEGER,
  log_revision   TEXT,                            -- the vault revision the answer was written to, when mirrored
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX decisions_team ON decisions(team_id, status, created_at);
CREATE INDEX decisions_open ON decisions(status, created_at);
CREATE INDEX decisions_task ON decisions(task_id, status);
CREATE INDEX decisions_agent ON decisions(agent_id, status);

-- Optional: a vault note the answered decisions are appended to (for example the team's "Decisions log.md").
ALTER TABLE teams ADD COLUMN decision_log_path TEXT;

-- Playbooks: ask the operator through the hub instead of writing the question into a block reason or a note.
UPDATE team_role_defaults SET playbook = playbook || ' When you need a decision from the operator, ask with team_ask (question, options, your recommendation, the task it blocks); the answer comes back as a notice. Do not only write the question into a block reason or a note: there it cannot be answered.'
  WHERE role IN ('coordinator', 'worker');
-- Teams that already exist keep their own copy of the playbooks: add the same sentence there.
UPDATE team_roles SET playbook = playbook || ' When you need a decision from the operator, ask with team_ask (question, options, your recommendation, the task it blocks); the answer comes back as a notice.'
  WHERE role IN ('coordinator', 'worker') AND playbook NOT LIKE '%team_ask%';
