-- Conversation map: generic key → conversation mapping
CREATE TABLE IF NOT EXISTS conversation_map (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(key, workspace_id)
);
