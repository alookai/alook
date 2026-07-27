-- Redundant "newest seq in this scope" columns, the seq twin of the existing
-- lastMessageAt cache. They let an unread check be a single-column compare
-- (`lastMessageSeq > lastReadSeq`) instead of joining the message table, the
-- same way `lastMessageAt > lastReadAt` avoided a join before.
--
-- Written alongside lastMessageAt on every message insert (see insertMessageRow).
-- Backfilled here to MAX(seq) per scope so existing channels/DMs are unread-
-- correct immediately; scopes with no messages keep the default 0. The legacy
-- seq=0 sentinel rows (pre-seq migration) contribute 0 to MAX, harmless.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; these statements are NOT idempotent.

ALTER TABLE community_channel ADD COLUMN last_message_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_dm_conversation ADD COLUMN last_message_seq INTEGER NOT NULL DEFAULT 0;

UPDATE community_channel
SET last_message_seq = (
  SELECT COALESCE(MAX(m.seq), 0)
  FROM community_message m
  WHERE m.channel_id = community_channel.id
);

UPDATE community_dm_conversation
SET last_message_seq = (
  SELECT COALESCE(MAX(m.seq), 0)
  FROM community_message m
  WHERE m.dm_conversation_id = community_dm_conversation.id
);
