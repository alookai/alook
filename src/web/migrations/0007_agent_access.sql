CREATE TABLE agent_access (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, workspace_id, user_id),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_access_agent_ws ON agent_access(agent_id, workspace_id);
CREATE INDEX idx_agent_access_user ON agent_access(user_id);
