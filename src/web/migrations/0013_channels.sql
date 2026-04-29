CREATE TABLE channel (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, name)
);
CREATE INDEX idx_channel_workspace ON channel(workspace_id);

ALTER TABLE conversation ADD COLUMN channel TEXT NOT NULL DEFAULT 'default';
