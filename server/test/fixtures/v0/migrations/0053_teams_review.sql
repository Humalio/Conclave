-- The decision that holds a task's block: an answer lifts only the block its own question set.
-- team.plan is no action anything checks any more: stored grants lose it.
ALTER TABLE tasks ADD COLUMN blocked_by_decision TEXT;
UPDATE tasks SET blocked_by_decision = (
  SELECT d.id FROM decisions d WHERE d.task_id = tasks.id AND d.blocks_task = 1 AND d.status IN ('open','needs_info') ORDER BY d.created_at LIMIT 1
) WHERE status = 'blocked';
UPDATE permission_rules SET actions = (SELECT json_group_array(value) FROM json_each(permission_rules.actions) WHERE value <> 'team.plan')
  WHERE EXISTS (SELECT 1 FROM json_each(permission_rules.actions) WHERE value = 'team.plan');
UPDATE temporary_grants SET actions = (SELECT json_group_array(value) FROM json_each(temporary_grants.actions) WHERE value <> 'team.plan')
  WHERE EXISTS (SELECT 1 FROM json_each(temporary_grants.actions) WHERE value = 'team.plan');
UPDATE access_requests SET actions = (SELECT json_group_array(value) FROM json_each(access_requests.actions) WHERE value <> 'team.plan')
  WHERE EXISTS (SELECT 1 FROM json_each(access_requests.actions) WHERE value = 'team.plan');
CREATE INDEX idx_tasks_team_updated ON tasks(team_id, updated_at DESC, id);
