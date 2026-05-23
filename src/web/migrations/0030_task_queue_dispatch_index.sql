-- Composite index for failStaleDispatchedTasks sweep query.
-- The existing idx_task_queue_workspace_active covers (workspaceId, status, agentId)
-- but lacks dispatched_at for the range scan used in the stale-dispatch check.
CREATE INDEX IF NOT EXISTS idx_task_queue_workspace_status_dispatched
  ON agent_task_queue(workspace_id, status, dispatched_at);
