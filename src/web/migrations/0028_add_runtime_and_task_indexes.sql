-- Add missing indexes for agent_runtime and agent_task_queue tables
-- Fixes D1 query timeouts on high-frequency daemon poll and runtime sweep paths

-- agent_runtime: fast lookup by (workspace_id, daemon_id) for daemon task polling
-- The existing unique constraint on (workspace_id, daemon_id, provider) doesn't
-- efficiently cover queries filtering only by workspace_id + daemon_id.
CREATE INDEX IF NOT EXISTS idx_agent_runtime_workspace_daemon
  ON agent_runtime(workspace_id, daemon_id);

-- agent_task_queue: covers failStaleKillTasks() sweep query filtering by
-- (workspace_id, type, status) during GET /api/runtimes
CREATE INDEX IF NOT EXISTS idx_task_queue_workspace_type_status
  ON agent_task_queue(workspace_id, type, status);
