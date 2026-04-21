ALTER TABLE message ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
CREATE INDEX idx_message_conversation_status ON message(conversation_id, status);
