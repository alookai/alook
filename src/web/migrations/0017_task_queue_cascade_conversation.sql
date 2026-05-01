-- Rebuild agent_task_queue to add ON DELETE CASCADE on conversation_id FK.
-- Without this, deleting a channel (which deletes its conversations) fails
-- because agent_task_queue rows still reference the conversation.

PRAGMA foreign_keys = OFF;

CREATE TABLE agent_task_queue_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL REFERENCES agent_runtime(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'user_dm_message',
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  context TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  dispatched_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  context_key TEXT,
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agent(id, workspace_id) ON DELETE CASCADE
);

INSERT INTO agent_task_queue_new SELECT * FROM agent_task_queue;

DROP TABLE agent_task_queue;

ALTER TABLE agent_task_queue_new RENAME TO agent_task_queue;

CREATE INDEX idx_task_queue_pending
  ON agent_task_queue(agent_id, status)
  WHERE status IN ('queued', 'dispatched');

CREATE INDEX idx_task_queue_workspace_active
  ON agent_task_queue(workspace_id, status, agent_id)
  WHERE status IN ('queued', 'dispatched', 'running');

CREATE INDEX idx_task_queue_agent_history
  ON agent_task_queue(agent_id, workspace_id, created_at);

PRAGMA foreign_keys = ON;
