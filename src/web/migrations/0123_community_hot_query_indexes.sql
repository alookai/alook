-- Non-partial composite index for parameterized seq point lookups and unread range scans
-- (migration 0052's unique index is partial WHERE seq > 0, which SQLite cannot use for seq = ? or seq > COALESCE(...))
CREATE INDEX IF NOT EXISTS idx_message_channel_seq ON "community_message" ("channel_id", "seq");

-- Composite index for channel/thread membership lookups filtered by (channel_id, relation)
CREATE INDEX IF NOT EXISTS idx_channel_member_channel_relation_user ON "community_channel_member" ("channel_id", "relation", "user_id");

-- Composite index for SQL reaction aggregation and per-emoji cursor pagination
CREATE INDEX IF NOT EXISTS idx_reaction_message_emoji_created ON "community_reaction" ("message_id", "emoji", "created_at", "user_id");
