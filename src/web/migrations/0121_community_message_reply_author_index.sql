CREATE INDEX idx_community_message_channel_reply_author ON "community_message" ("channel_id", "reply_to_id", "author_id") WHERE "reply_to_id" IS NOT NULL;
