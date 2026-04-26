CREATE INDEX idx_task_queue_agent_history ON agent_task_queue (agent_id, workspace_id, created_at);
