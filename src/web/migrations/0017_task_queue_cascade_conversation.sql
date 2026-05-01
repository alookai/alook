-- Rebuild agent_task_queue to fix FK cascade behavior:
-- 1. conversation_id: ON DELETE CASCADE — deleting a channel (which cascades
--    to its conversations) no longer fails due to dangling task references.
-- 2. workspace_id: ON DELETE CASCADE — same logic for workspace deletion.
-- 3. runtime_id: ON DELETE CASCADE — matches existing app-level behavior
--    (deleteRuntimesByDaemonId already deletes associated tasks).

PRAGMA foreign_keys = OFF;

-- Clean up orphaned task rows that reference deleted parents
DELETE FROM agent_task_queue WHERE runtime_id NOT IN (SELECT id FROM agent_runtime);
DELETE FROM agent_task_queue WHERE workspace_id NOT IN (SELECT id FROM workspace);
DELETE FROM agent_task_queue WHERE conversation_id NOT IN (SELECT id FROM conversation);

CREATE TABLE agent_task_queue_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
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

PRAGMA foreign_key_check;
