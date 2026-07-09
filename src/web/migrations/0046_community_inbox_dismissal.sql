-- Migration: community_inbox_dismissal
-- Tracks events the user has hard-dismissed from the inbox "For You" tab.

CREATE TABLE community_inbox_dismissal (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  dismissed_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_inbox_dismissal_user_event
  ON community_inbox_dismissal(user_id, event_key);

CREATE INDEX idx_inbox_dismissal_user
  ON community_inbox_dismissal(user_id);
