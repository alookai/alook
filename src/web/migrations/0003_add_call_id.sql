-- Add call_id column to task_message for pairing tool-use with tool-result.
ALTER TABLE task_message ADD COLUMN call_id TEXT NOT NULL DEFAULT '';
