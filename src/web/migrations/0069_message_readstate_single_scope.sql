-- Community schema unification (3/5): collapse message + read_state to channel_id.
-- See plans/community-schema-unification.md.
--
-- community_message.dm_conversation_id and .flags are dropped; channel_id
-- becomes the sole (and now NOT NULL) scope. DM messages get
-- channel_id = COALESCE(channel_id, dm_conversation_id) — the DM's channel row
-- (created in 0068) shares the DM's id. The channel/dm XOR CHECK is removed.
-- community_read_state loses dm_conversation_id the same way and gains a plain
-- unique (user_id, channel_id).
--
-- Deferred FKs preserve every dependent across the message rebuild: bot approval
-- cards (dm_message_id), reactions, pins, mentions, attachments, and the self
-- friendship_id back-ref. Message + read_state ids are PRESERVED.
--
-- FTS: community_message_fts triggers were dropped by 0045's DROP TABLE
-- community_message and never recreated — the table is already dead/unsynced
-- (search uses content LIKE, not MATCH). The rebuild fires no triggers and none
-- are recreated. The dead table is dropped below.

PRAGMA defer_foreign_keys=ON;

-- 1. Rebuild community_message: drop dm_conversation_id + flags, no CHECK,
--    channel_id NOT NULL, ids preserved.
CREATE TABLE community_message_new (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'default',
  mention_type TEXT,
  reply_to_id TEXT,
  embeds TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  friendship_id TEXT REFERENCES community_friendship(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

INSERT INTO community_message_new (
  id, channel_id, author_id, content, type, mention_type, reply_to_id,
  embeds, seq, friendship_id, created_at
)
SELECT
  id, COALESCE(channel_id, dm_conversation_id), author_id, content, type,
  mention_type, reply_to_id, embeds, seq, friendship_id, created_at
FROM community_message;

-- Row-count guard: preserve every message (decision #1 = preserve data).
CREATE TABLE _message_backfill_check (dummy INTEGER);
CREATE TRIGGER _message_backfill_check_trg
  BEFORE INSERT ON _message_backfill_check
  WHEN (SELECT COUNT(*) FROM community_message) != (SELECT COUNT(*) FROM community_message_new)
BEGIN
  SELECT RAISE(ABORT, 'community_message backfill row loss');
END;
INSERT INTO _message_backfill_check (dummy) VALUES (1);
DROP TRIGGER _message_backfill_check_trg;
DROP TABLE _message_backfill_check;

DROP TABLE community_message;
ALTER TABLE community_message_new RENAME TO community_message;

CREATE INDEX idx_message_channel_created ON community_message(channel_id, created_at);
CREATE INDEX idx_message_channel_mention_created ON community_message(channel_id, mention_type, created_at);
CREATE UNIQUE INDEX uq_community_message_channel_seq
  ON community_message(channel_id, seq)
  WHERE seq > 0;
CREATE INDEX idx_message_friendship
  ON community_message(friendship_id)
  WHERE friendship_id IS NOT NULL;

-- 2. Rebuild community_read_state: drop dm_conversation_id, channel_id NOT NULL,
--    plain unique (user_id, channel_id), ids preserved.
CREATE TABLE community_read_state_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL,
  last_read_message_id TEXT,
  last_read_seq INTEGER NOT NULL DEFAULT 0
);

INSERT INTO community_read_state_new (
  id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq
)
SELECT
  id, user_id, COALESCE(channel_id, dm_conversation_id), last_read_at,
  last_read_message_id, last_read_seq
FROM community_read_state;

-- Row-count guard.
CREATE TABLE _read_state_backfill_check (dummy INTEGER);
CREATE TRIGGER _read_state_backfill_check_trg
  BEFORE INSERT ON _read_state_backfill_check
  WHEN (SELECT COUNT(*) FROM community_read_state) != (SELECT COUNT(*) FROM community_read_state_new)
BEGIN
  SELECT RAISE(ABORT, 'community_read_state backfill row loss');
END;
INSERT INTO _read_state_backfill_check (dummy) VALUES (1);
DROP TRIGGER _read_state_backfill_check_trg;
DROP TABLE _read_state_backfill_check;

DROP TABLE community_read_state;
ALTER TABLE community_read_state_new RENAME TO community_read_state;

CREATE INDEX idx_read_state_user ON community_read_state(user_id);
CREATE UNIQUE INDEX idx_read_state_user_channel ON community_read_state(user_id, channel_id);

-- 3. Only community_message.dm_conversation_id and
--    community_read_state.dm_conversation_id FK'd community_dm_conversation
--    (attachment.target_id is NOT an FK). Both are gone, so drop the table.
DROP TABLE community_dm_conversation;

-- 4. Drop the dead FTS table (its triggers died with 0045; search uses LIKE).
DROP TABLE IF EXISTS community_message_fts;
