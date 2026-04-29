CREATE TABLE IF NOT EXISTS workspace_file_request (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  request_type TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '.',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wfr_workspace_status ON workspace_file_request(workspace_id, status);
