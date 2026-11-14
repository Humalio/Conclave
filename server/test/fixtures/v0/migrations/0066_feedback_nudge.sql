-- End-of-task feedback nudge (docs/feedback.md "Nudging agents without spam"): a per-team setting, off by default.
-- When on, the task_submit and team_complete results carry one line inviting the agent to file what slowed it down.
ALTER TABLE teams ADD COLUMN feedback_nudge INTEGER NOT NULL DEFAULT 0;
