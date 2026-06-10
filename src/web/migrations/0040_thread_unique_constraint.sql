-- Prevent duplicate threads for the same parent message within a workspace.
-- SQLite treats NULLs as distinct, so non-thread conversations are unaffected.
CREATE UNIQUE INDEX uq_conversation_parent_message
  ON conversation (parent_message_id, workspace_id)
  WHERE parent_message_id IS NOT NULL;
