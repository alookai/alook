-- Add thread support: a thread is a conversation linked to a parent message
ALTER TABLE conversation ADD COLUMN parent_message_id TEXT;
ALTER TABLE conversation ADD COLUMN thread_title TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_conversation_thread ON conversation (parent_message_id)
  WHERE parent_message_id IS NOT NULL;
