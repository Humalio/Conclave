-- Preserve every proposer, including repeated invalidations, for independent review.
CREATE TABLE kg_invalidation_proposers (claim_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (claim_id, agent_id));
INSERT OR IGNORE INTO kg_invalidation_proposers SELECT e.value, f.raised_by FROM kg_flags f, json_each(f.evidence_claims) e WHERE f.raised_by IS NOT NULL AND f.raised_by<>'hub';
-- Durable generated output must remain safe after permission changes and under any app cap.
UPDATE tasks SET title='Review knowledge flag', description='A knowledge flag requires review. Use graph_stale for details permitted by your current access.' WHERE id IN (SELECT task_id FROM kg_flags WHERE task_id IS NOT NULL);
UPDATE tasks SET title='Review entity merge', description='An entity merge requires review by an authorized reviewer.' WHERE id IN (SELECT task_id FROM kg_merge_proposals WHERE task_id IS NOT NULL);
UPDATE agent_notices SET body='Knowledge work needs attention. Use graph_stale or task_list for details permitted by your current access.' WHERE kind='knowledge_flag' OR (kind='task_open' AND (body LIKE '%stale%' OR body LIKE '%contradiction%' OR body LIKE '%merge%'));
UPDATE agent_notices SET body='Knowledge work needs attention. Use graph_stale or task_list for details permitted by your current access.' WHERE EXISTS (SELECT 1 FROM kg_flags f WHERE (f.task_id IS NOT NULL AND instr(agent_notices.body,f.task_id)>0) OR instr(agent_notices.body,f.id)>0) OR EXISTS (SELECT 1 FROM kg_merge_proposals m WHERE (m.task_id IS NOT NULL AND instr(agent_notices.body,m.task_id)>0) OR instr(agent_notices.body,m.id)>0);
-- Old community summaries included entity labels without recording their source dependencies.
DELETE FROM kg_summaries WHERE scope='community';
-- Rebuild old entity payload snapshots using current permissions before delivering them again.
UPDATE kg_jobs SET state='queued', leased_by=NULL, lease_until=NULL, input_json=NULL, batch_of=NULL WHERE type IN ('entity_merge','summarize_community') AND state IN ('queued','leased');
