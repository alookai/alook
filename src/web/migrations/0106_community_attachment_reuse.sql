CREATE TABLE community_attachment_rebuild (
  id TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  thumbnail_r2_key TEXT,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
INSERT INTO community_attachment_rebuild
  SELECT id, uploader_id, r2_key, thumbnail_r2_key, filename, content_type, size, width, height, created_at
  FROM community_attachment;
CREATE TABLE community_attachment_links_backfill (
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  position INTEGER NOT NULL
);
INSERT INTO community_attachment_links_backfill
  SELECT message_id, id, COALESCE(position, 0)
  FROM community_attachment WHERE message_id IS NOT NULL;
DROP TABLE community_attachment;
ALTER TABLE community_attachment_rebuild RENAME TO community_attachment;
CREATE INDEX idx_attachment_uploader ON community_attachment(uploader_id);
CREATE INDEX idx_attachment_r2_key ON community_attachment(r2_key);
CREATE INDEX idx_attachment_thumbnail_r2_key ON community_attachment(thumbnail_r2_key);
CREATE TABLE community_message_attachment (
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES community_attachment(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, attachment_id),
  UNIQUE (message_id, position)
);
CREATE INDEX idx_message_attachment_file ON community_message_attachment(attachment_id, message_id);
INSERT INTO community_message_attachment SELECT * FROM community_attachment_links_backfill;
DROP TABLE community_attachment_links_backfill;
CREATE TRIGGER delete_attachment_last_message_reference
AFTER DELETE ON community_message_attachment
BEGIN
  DELETE FROM community_attachment
  WHERE id = OLD.attachment_id
    AND NOT EXISTS (
      SELECT 1 FROM community_message_attachment WHERE attachment_id = OLD.attachment_id
    );
END;
