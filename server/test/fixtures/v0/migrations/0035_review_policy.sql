-- Review policy (task_kmare7of5enpsp5s): whether a task needs review is decided per project and per task.
-- projects.review_policy: required (every task is reviewed, as before), per_task (the task creator decides), none (no
-- review unless a task asks for it). tasks.review: required or none, defaulting from the policy when the task is created.
-- A task with review none goes from in_progress straight to approved on submit, audited; self-review stays forbidden.
ALTER TABLE projects ADD COLUMN review_policy TEXT NOT NULL DEFAULT 'required' CHECK (review_policy IN ('required', 'per_task', 'none'));
ALTER TABLE tasks ADD COLUMN review TEXT NOT NULL DEFAULT 'required' CHECK (review IN ('required', 'none'));
