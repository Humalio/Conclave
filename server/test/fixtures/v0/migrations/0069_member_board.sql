-- Members can see the task board (docs/multi-user.md §1.2): a per-project operator switch, off by default. When on, every
-- member with a grant on the project reads the team task board (read only) through GET /api/projects/:id/board.
ALTER TABLE projects ADD COLUMN member_board INTEGER NOT NULL DEFAULT 0 CHECK (member_board IN (0, 1));
