-- Migration: Remove content, input, output columns from task_message
-- These columns are now stored in R2 (task-messages/{taskId}.json)
--
-- DEPLOYMENT ORDER:
-- 1. Deploy dual-write code (writes both D1 full + R2/KV)
-- 2. Run batch migration script (scripts/migrate-task-messages-to-r2.ts)
-- 3. Verify R2 data integrity
-- 4. Apply THIS migration to drop columns from D1
-- 5. Deploy schema update (remove columns from Drizzle schema)

CREATE TABLE task_message_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  call_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO task_message_new (id, task_id, seq, type, tool, call_id, created_at)
  SELECT id, task_id, seq, type, tool, call_id, created_at FROM task_message;

DROP TABLE task_message;
ALTER TABLE task_message_new RENAME TO task_message;

CREATE INDEX idx_task_message_task_seq ON task_message(task_id, seq);
CREATE INDEX idx_task_message_task_created ON task_message(task_id, created_at);
