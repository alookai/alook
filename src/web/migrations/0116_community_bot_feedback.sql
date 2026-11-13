CREATE TABLE community_bot_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT bot_feedback_text_bytes CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 10240)
);
CREATE INDEX idx_bot_feedback_owner_created ON community_bot_feedback(owner_id, created_at);
