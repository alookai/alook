CREATE INDEX idx_task_queue_workspace_active ON agent_task_queue(workspace_id, status, agent_id)
  WHERE status IN ('queued', 'dispatched', 'running');
