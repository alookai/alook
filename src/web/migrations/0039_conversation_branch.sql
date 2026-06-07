CREATE TABLE IF NOT EXISTS conversation_branch (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  parent_conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  branch_conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  root_message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  fork_source_task_id TEXT,
  fork_source_session_id TEXT,
  created_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, parent_conversation_id, root_message_id),
  UNIQUE(branch_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_branch_parent
  ON conversation_branch(workspace_id, parent_conversation_id);
