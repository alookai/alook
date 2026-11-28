CREATE TABLE community_page (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  archive_attachment_id TEXT NOT NULL REFERENCES community_attachment(id) ON DELETE RESTRICT,
  bot_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_community_page_artifact ON community_page(artifact_id);
CREATE UNIQUE INDEX uq_community_page_archive ON community_page(archive_attachment_id);
CREATE INDEX idx_community_page_bot_id ON community_page(bot_id, created_at, id);
CREATE TABLE community_message_page (
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES community_page(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, page_id)
);
CREATE INDEX idx_community_message_page_page ON community_message_page(page_id, message_id);
