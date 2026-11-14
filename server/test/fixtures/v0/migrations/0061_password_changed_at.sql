-- When a user's password was last set (docs/multi-user.md §1.4): on create, on an admin's reset and on the user's own change.
-- NULL for users whose password was set before this column existed; the console then shows no date.

ALTER TABLE admin_users ADD COLUMN password_changed_at INTEGER;
