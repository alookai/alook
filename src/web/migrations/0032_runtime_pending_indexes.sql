-- Performance indexes for poll hot-path queries (D1 insights analysis 2026-05-20)
-- Targets: listPendingTasksByRuntimes, countRunningTasks, inbox unread count

-- 1. listPendingTasksByRuntimes: 310K calls/day, scans 60-87 rows/call
--    Filters: workspace_id + runtime_id IN (?) + status IN ('queued','dispatched')
--    No existing index covers runtime_id for this access pattern.
CREATE INDEX IF NOT EXISTS idx_task_queue_runtime_pending
  ON agent_task_queue(workspace_id, runtime_id, status)
  WHERE status IN ('queued', 'dispatched');

-- 2. countRunningTasks: 931 calls/day, scans 858 rows/call (24ms avg)
--    Filters: agent_id + workspace_id + status IN ('dispatched','running')
--    Existing idx_task_queue_pending covers ('queued','dispatched') but not 'running'.
CREATE INDEX IF NOT EXISTS idx_task_queue_agent_running
  ON agent_task_queue(agent_id, workspace_id, status)
  WHERE status IN ('dispatched', 'running');

-- 3. getUnreadCount (inbox badge): 8K calls/day, scans 884 rows/call
--    Filters: workspace_id + status IN ('completed','failed') + parent_task_id IS NULL
--    Existing idx_task_queue_inbox is (workspace_id, status, completed_at) without
--    the conversation_id needed for COUNT(DISTINCT conversation_id).
CREATE INDEX IF NOT EXISTS idx_task_queue_inbox_convo
  ON agent_task_queue(workspace_id, status, conversation_id, completed_at)
  WHERE status IN ('completed', 'failed') AND parent_task_id IS NULL;
