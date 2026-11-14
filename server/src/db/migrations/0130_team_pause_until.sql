-- A team pause with an end time (docs/specification.md, Task turns and deadlines: Pause). paused_until: when the hub
-- resumes the team by itself, NULL for no end time. paused_note: the reason a person gave, shown as "Paused until … · reason";
-- paused_reason keeps saying who paused it ('admin', 'coordinator', 'limit:<metric>', 'checkout:<id>').
ALTER TABLE teams ADD COLUMN paused_until INTEGER;
ALTER TABLE teams ADD COLUMN paused_note TEXT;
