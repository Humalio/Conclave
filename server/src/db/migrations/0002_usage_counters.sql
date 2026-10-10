-- Persisted counters (rate limits, guardrails). Survive restarts.
CREATE TABLE usage_counters (
  scope        TEXT NOT NULL,
  metric       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, metric, window_start)
);
