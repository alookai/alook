-- Add context_key column to agent_task_queue for unified session resumption
ALTER TABLE agent_task_queue ADD COLUMN context_key TEXT;
