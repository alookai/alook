CREATE TABLE message_flag (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, user_id)
);

CREATE INDEX idx_message_flag_ws_user_created ON message_flag(workspace_id, user_id, created_at);
CREATE INDEX idx_message_flag_message_user ON message_flag(message_id, user_id);
