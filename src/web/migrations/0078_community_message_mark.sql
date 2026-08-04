-- Per-user private message bookmark ("mark"), powering the Marked inbox tab
-- (Gus /Gus/uiux #306). Unlike community_pin, which is channel-shared, a mark is
-- keyed by the marking USER and visible only to them. No denormalized seq: the
-- marked-list read joins community_message for the jump key (community_message.seq),
-- exactly as the pins route does. channel_id is stored for the cascade and the
-- phase-2 per-channel markedIds read (the inline glyph, cut from phase-1 per Gus
-- #992); the INDEX(user_id, channel_id) that read needs is deferred with it.
--
-- UNIQUE(user_id, message_id) makes the toggle idempotent: mark-again is an
-- onConflictDoNothing no-op, not a duplicate row. message_id is globally unique,
-- so channel_id is not part of the uniqueness key. All three FKs cascade on
-- delete so a removed user / channel / message takes its marks with it.
CREATE TABLE community_message_mark (
  id         TEXT PRIMARY KEY NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_mark_user_message
  ON community_message_mark(user_id, message_id);

-- Marked-list read: this user's marks, newest-first.
CREATE INDEX idx_mark_user_created
  ON community_message_mark(user_id, created_at);
