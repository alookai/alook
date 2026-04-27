CREATE TABLE IF NOT EXISTS meeting_session (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  meeting_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  from_email TEXT,
  is_whitelisted INTEGER NOT NULL DEFAULT 1,
  participants TEXT NOT NULL DEFAULT '[]',
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  transcript_r2_key TEXT,
  summary TEXT,
  error TEXT,
  worker_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meeting_session_agent_ws ON meeting_session(agent_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_meeting_session_status ON meeting_session(status);
