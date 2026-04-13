-- Drop the unused work_dir column from agent_task_queue.
-- Deploy code changes first (server/CLI no longer read/write this column),
-- then run this migration.
ALTER TABLE agent_task_queue DROP COLUMN work_dir;
