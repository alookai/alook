CREATE TABLE IF NOT EXISTS agent_skill (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agent(id) ON DELETE CASCADE,
  runtime TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL,
  UNIQUE(workspace_id, runtime, name, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_as_workspace_runtime ON agent_skill(workspace_id, runtime);
CREATE INDEX IF NOT EXISTS idx_as_agent_runtime ON agent_skill(agent_id, runtime);
