-- Agent feedback (docs/feedback.md): reports about the hub itself, backed by many agents, triaged by the operator.
CREATE TABLE feedback_reports (
  id            TEXT PRIMARY KEY,                 -- fb_…
  kind          TEXT NOT NULL CHECK (kind IN ('bug','limitation','wish')),
  title         TEXT NOT NULL,
  original_title TEXT,                            -- set when the operator edits the title
  tool          TEXT,
  area          TEXT NOT NULL,
  error_code    TEXT,
  tried         TEXT NOT NULL,
  happened      TEXT,
  expected      TEXT,
  workaround    TEXT,
  cost_calls    INTEGER,
  cost_tokens   INTEGER,
  cost_minutes  INTEGER,
  severity      TEXT NOT NULL CHECK (severity IN ('blocking','costly','minor')),
  fingerprint   TEXT NOT NULL,
  title_words   TEXT NOT NULL,                    -- normalised title words, space separated (close-match test)
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','needs_info','accepted','fixed','wont_fix','duplicate','withdrawn')),
  status_note   TEXT,
  guidance      TEXT,
  fixed_in      TEXT,
  duplicate_of  TEXT,
  hidden        INTEGER NOT NULL DEFAULT 0,
  reopen_count  INTEGER NOT NULL DEFAULT 0,
  status_rev    INTEGER NOT NULL DEFAULT 0,       -- bumped on every status change; notices name the revision they describe
  backers       INTEGER NOT NULL DEFAULT 1,       -- distinct agents: the filer and everyone who added a +1, evidence or still_happening
  filer_agent_id TEXT NOT NULL REFERENCES agents(id),
  filer_credential_id TEXT,
  filer_app_credential_id TEXT,
  filer_app    TEXT,
  filer_pc_id  TEXT,
  filer_teams  TEXT NOT NULL DEFAULT '[]',        -- JSON array of team ids at the time of filing
  client_name  TEXT,
  client_version TEXT,
  hub_version  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status_at    INTEGER NOT NULL
);
CREATE INDEX feedback_reports_status ON feedback_reports(status, last_seen_at);
CREATE INDEX feedback_reports_fp ON feedback_reports(fingerprint);
CREATE INDEX feedback_reports_filer ON feedback_reports(filer_agent_id, fingerprint, created_at);
CREATE INDEX feedback_reports_tool ON feedback_reports(tool, error_code);

CREATE TABLE feedback_entries (
  id           TEXT PRIMARY KEY,                  -- fbe_…
  report_id    TEXT NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  origin_report_id TEXT,                          -- the duplicate this entry came from, after a merge
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  credential_id TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('plus_one','evidence','answer','still_happening','withdraw')),
  text         TEXT,
  cost_calls   INTEGER,
  cost_tokens  INTEGER,
  cost_minutes INTEGER,
  hub_version  TEXT,
  app_name     TEXT,
  client_name  TEXT,
  client_version TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX feedback_entries_report ON feedback_entries(report_id, created_at);
CREATE INDEX feedback_entries_origin ON feedback_entries(origin_report_id);
CREATE INDEX feedback_entries_agent ON feedback_entries(agent_id, created_at);
CREATE UNIQUE INDEX feedback_entries_plus_one ON feedback_entries(report_id, agent_id) WHERE kind='plus_one';

CREATE TABLE feedback_links (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  entry_id  TEXT,
  kind      TEXT NOT NULL CHECK (kind IN ('task','path','share')),
  target    TEXT NOT NULL
);
CREATE INDEX feedback_links_report ON feedback_links(report_id);

-- Hub evidence: the filer's calls to the named tool shortly before filing. Arguments are never copied.
CREATE TABLE feedback_calls (
  report_id     TEXT NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  tool          TEXT NOT NULL,
  result        TEXT NOT NULL,
  error_code    TEXT,
  duration_ms   INTEGER NOT NULL,
  result_bytes  INTEGER,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (report_id, invocation_id)
);

CREATE TABLE feedback_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  TEXT NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL,
  actor_id   TEXT,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_history_report ON feedback_history(report_id, id);

-- Retried filings with the same client_report_id return the first outcome.
CREATE TABLE feedback_requests (
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  client_report_id TEXT NOT NULL,
  report_id        TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (agent_id, client_report_id)
);

-- "Known: fb_…" error hints, at most once per agent per report per day.
CREATE TABLE feedback_hints (
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  report_id TEXT NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  hinted_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, report_id)
);

-- A feedback_update notice names its report and the status revision it describes (extends the task notice rule).
ALTER TABLE agent_notices ADD COLUMN ref_feedback_id TEXT;
