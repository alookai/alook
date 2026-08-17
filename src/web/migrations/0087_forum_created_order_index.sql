CREATE INDEX idx_channel_forum_created
ON community_channel(parent_channel_id, created_at DESC, id DESC)
WHERE type = 'thread' AND archived = 0 AND parent_message_id IS NOT NULL;
