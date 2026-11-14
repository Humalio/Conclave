-- The restore's config scan (docs/checkout.md §6 step 4): before any folder trust is written, setup.mjs restore lists
-- tracked agent config in each agent folder (.claude/settings.json hooks, .mcp.json, .codex/, tracked CLAUDE.md or
-- AGENTS.md, config in the checkout/<id> diff) and reports it here. A folder with findings stays untrusted until the
-- operator approves it (decision 'approved') or leaves it untrusted ('untrusted'); a folder with none is 'no_findings'.
-- One row per folder of the checkout; rows of an earlier request are ignored (filtered by request_id) and replaced on the next report.

CREATE TABLE checkout_scans (
  checkout_id TEXT NOT NULL REFERENCES checkouts(id),
  folder TEXT NOT NULL,                                 -- the slot folder (a name under the project root)
  request_id TEXT NOT NULL REFERENCES onboarding_requests(id),
  agent_id TEXT REFERENCES agents(id),
  findings_json TEXT NOT NULL,                          -- JSON [{kind, path, detail}], reported by the client (L2)
  findings_sha256 TEXT NOT NULL,                        -- the operator's decision names the findings it saw
  decision TEXT CHECK (decision IN ('approved','untrusted','no_findings')), -- NULL: waiting for the operator
  decided_by TEXT,
  decided_at INTEGER,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (checkout_id, folder)
);
