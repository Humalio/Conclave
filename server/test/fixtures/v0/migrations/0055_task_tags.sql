-- Task tags (docs/specification.md, task lifecycle): what the creator files a task under, a JSON array of short lowercase
-- words (at most 8, each 1-24 characters; the directives tag model). The creator or a coordinator edits them while the
-- task is in the backlog, the operator on any task. task_list and the admin task lists filter by one tag.

ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
