-- Indexes for lookups the code review (10 Nov 2026) found running as table scans.
-- Blob clean-up: each blob is checked against revisions, current files and write intents.
CREATE INDEX IF NOT EXISTS file_revisions_revision ON file_revisions(revision);
CREATE INDEX IF NOT EXISTS file_revisions_parent ON file_revisions(parent_revision);
CREATE INDEX IF NOT EXISTS files_current_revision ON files(current_revision);
CREATE INDEX IF NOT EXISTS write_intents_base ON write_intents(base_revision);
CREATE INDEX IF NOT EXISTS write_intents_new ON write_intents(new_revision);
-- Work queue de-duplication and stale-item lookups.
CREATE INDEX IF NOT EXISTS work_items_ref ON work_items(agent_id, kind, ref_id);
-- Live-login counts per app key, and the key view's calls through an app key.
CREATE INDEX IF NOT EXISTS session_tokens_app ON session_tokens(app_credential_id);
CREATE INDEX IF NOT EXISTS tool_invocations_app_time ON tool_invocations(app_credential_id, created_at);
-- Login carry-over copies an agent's read positions.
CREATE INDEX IF NOT EXISTS message_delivery_cursors_agent ON message_delivery_cursors(agent_id, room_id);
-- Telemetry and agent views read calls per agent over time.
CREATE INDEX IF NOT EXISTS tool_invocations_agent_time ON tool_invocations(agent_id, created_at);
-- Alert de-duplication looks up an open alert of one type for one subject.
CREATE INDEX IF NOT EXISTS security_alerts_dedupe ON security_alerts(type, subject, status);
-- Pruning of finished curator results.
CREATE INDEX IF NOT EXISTS kg_job_results_time ON kg_job_results(created_at);
-- Pruning of old notices.
CREATE INDEX IF NOT EXISTS agent_notices_time ON agent_notices(created_at);
