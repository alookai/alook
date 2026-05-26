-- Add daemon_id column to agent_skill for multi-daemon isolation
ALTER TABLE agent_skill ADD COLUMN daemon_id TEXT;

-- Clean up existing global skills (daemon_id is NULL); daemons will re-sync within 60s
DELETE FROM agent_skill WHERE agent_id IS NULL;

-- Drop old unique constraint and add new one with daemon_id dimension
DROP INDEX IF EXISTS agent_skill_ws_runtime_name_agent;
CREATE UNIQUE INDEX agent_skill_ws_runtime_name_agent_daemon ON agent_skill(workspace_id, runtime, name, agent_id, daemon_id);
