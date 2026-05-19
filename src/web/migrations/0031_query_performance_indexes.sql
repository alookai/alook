-- Performance indexes for hot-path queries identified via audit
-- Targets: daemon poll, inbox unread, conversation listing, stale task sweep

-- 1. agent_runtime: queries filter by (daemon_id, workspace_id) but existing index
--    idx_agent_runtime_workspace_daemon is (workspace_id, daemon_id) — wrong leading column
--    for getRuntimeIdsByDaemon / deleteRuntimesByDaemonId which filter daemon_id first.
CREATE INDEX IF NOT EXISTS idx_agent_runtime_daemon_workspace
  ON agent_runtime(daemon_id, workspace_id);

-- 2. agent_task_queue: inbox queries filter by
--    (workspace_id, status IN ('completed','failed'), type, completed_at DESC)
--    with parent_task_id IS NULL and trace_id IS NOT NULL.
--    No existing index efficiently covers this access pattern.
CREATE INDEX IF NOT EXISTS idx_task_queue_inbox
  ON agent_task_queue(workspace_id, status, completed_at);

-- 3. conversation: queries filter (workspace_id, user_id) without agent_id.
--    The existing idx_conversation_agent_lookup starts with (workspace_id, agent_id, ...)
--    so it cannot serve listConversations(workspace_id, userId) efficiently.
CREATE INDEX IF NOT EXISTS idx_conversation_ws_user
  ON conversation(workspace_id, user_id, created_at);
