DROP TABLE IF EXISTS workspace_skill_request;
DROP TABLE IF EXISTS agent_skill_cache;

CREATE TABLE IF NOT EXISTS agent_skill (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'global',
  synced_at TEXT NOT NULL,
  UNIQUE(agent_id, runtime, name)
);

CREATE INDEX IF NOT EXISTS idx_as_agent_runtime ON agent_skill(agent_id, runtime);
