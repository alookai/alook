DROP TABLE IF EXISTS workspace_skill_request;

CREATE TABLE IF NOT EXISTS agent_skill_cache (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT NOT NULL,
  UNIQUE(agent_id, runtime)
);

CREATE INDEX IF NOT EXISTS idx_asc_agent ON agent_skill_cache(agent_id, runtime);
