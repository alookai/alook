CREATE TABLE community_page (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_community_page_artifact ON community_page(artifact_id);
CREATE UNIQUE INDEX uq_community_page_message ON community_page(message_id);
CREATE INDEX idx_community_page_bot_id ON community_page(bot_id);
