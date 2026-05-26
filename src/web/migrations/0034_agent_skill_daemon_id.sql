-- Add daemon_id column to agent_skill for multi-daemon isolation
ALTER TABLE agent_skill ADD COLUMN daemon_id TEXT;

-- Drop old unique constraint and add new one with daemon_id dimension
DROP INDEX IF EXISTS agent_skill_ws_runtime_name_agent;
CREATE UNIQUE INDEX agent_skill_ws_runtime_name_agent_daemon ON agent_skill(workspace_id, runtime, name, agent_id, daemon_id);
