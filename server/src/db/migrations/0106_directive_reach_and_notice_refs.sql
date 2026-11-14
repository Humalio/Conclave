-- Directive reach (docs/directives.md): a directive is in force for the agents its scope covers minus the agents an
-- active exemption keeps it off (one agent, the members of a live team, or the agents of a project label). An
-- exemption makes no directive version; removing one sets removed_at, the row stays as history.
CREATE TABLE directive_exemptions (
  id           TEXT PRIMARY KEY,                   -- dex_…
  directive_id TEXT NOT NULL REFERENCES directives(id),
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('agent','team','project')),
  target_ref   TEXT NOT NULL,
  note         TEXT,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  removed_by   TEXT,
  removed_at   INTEGER
);
CREATE UNIQUE INDEX directive_exemptions_active ON directive_exemptions(directive_id, target_kind, target_ref) WHERE removed_at IS NULL;
CREATE INDEX directive_exemptions_dir ON directive_exemptions(directive_id);
-- An agent notice names what it is about in one shape (task, feedback, directive, directive_stop), so it can stop being
-- delivered once the agent did what it asked. Task and feedback notices are backfilled from their old columns, which
-- stay (and are still written) for one release. Directive notices sent before carry no ref.
ALTER TABLE agent_notices ADD COLUMN ref_kind TEXT;
ALTER TABLE agent_notices ADD COLUMN ref_id TEXT;
UPDATE agent_notices SET ref_kind = 'task', ref_id = ref_task_id WHERE ref_task_id IS NOT NULL;
UPDATE agent_notices SET ref_kind = 'feedback', ref_id = ref_feedback_id WHERE ref_feedback_id IS NOT NULL;
-- When each agent last called directives_read: a "stop following it" notice settles on the next read.
CREATE TABLE directive_reads (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  read_at  INTEGER NOT NULL
);
