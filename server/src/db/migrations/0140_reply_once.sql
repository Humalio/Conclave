-- Replies send each thing once (docs/mcp.md, "Replies and notices"). A login may ask for compact replies (the text block is
-- the structured JSON alone); each notice rides inline on one reply of a login, then only its count does, until
-- session_ack. notice_delivered_seq is the login's delivery cursor next to its acknowledgement cursor, and
-- agent_notices.delivered_at is when a notice first reached any login of its agent, so the console Inbox can show
-- delivered and confirmed apart. Adding columns loses nothing: existing logins are not compact and have delivered nothing
-- yet, so their pending notices are delivered once more; existing notices show no delivery time.
ALTER TABLE session_tokens ADD COLUMN compact INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_tokens ADD COLUMN notice_delivered_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_notices ADD COLUMN delivered_at INTEGER;
