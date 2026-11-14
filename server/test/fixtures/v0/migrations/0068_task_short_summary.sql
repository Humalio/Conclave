-- "In short" (docs/mcp.md, Task summary): a plain-text summary of a task, at most 280 characters, that the coordinator
-- sets with task_create or task_update. The console shows it above the task's progress; null means the hub makes one
-- from the first sentences of the description. Not the assignee's submission summary (tasks.summary).
ALTER TABLE tasks ADD COLUMN short_summary TEXT;
