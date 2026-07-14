-- Backfill: seed participant rows for existing THREADS.
-- See plans/nested-membership-model.md (Phase D).
--
-- Before the nested-membership model, every parent-channel member was notified
-- of thread activity. Now only participants are. Without this backfill, ongoing
-- threads would notify nobody on deploy. Seed each thread's participant set
-- from the people who demonstrably engaged with it:
--   - distinct authors of messages IN the thread (they "spoke"),
--   - the thread's creator,
--   - the author of the message the thread was started from (parent message).
--
-- All tagged source='spoke' (the closest existing signal; the distinction only
-- matters for future joins, not for who-gets-notified). Idempotent via
-- INSERT OR IGNORE on uq_thread_participant. `hex(randomblob(16))` = row id.

-- 1. Message authors in the thread.
INSERT OR IGNORE INTO community_thread_participant (id, thread_channel_id, user_id, source, added_at)
SELECT DISTINCT
  lower(hex(randomblob(16))),
  t.id,
  m.author_id,
  'spoke',
  t.created_at
FROM community_channel AS t
JOIN community_message AS m ON m.channel_id = t.id
WHERE t.type = 'thread';

-- 2. Thread creator (may not have posted in it).
INSERT OR IGNORE INTO community_thread_participant (id, thread_channel_id, user_id, source, added_at)
SELECT
  lower(hex(randomblob(16))),
  t.id,
  t.creator_id,
  'spoke',
  t.created_at
FROM community_channel AS t
WHERE t.type = 'thread' AND t.creator_id IS NOT NULL;

-- 3. Author of the parent message the thread hangs off.
INSERT OR IGNORE INTO community_thread_participant (id, thread_channel_id, user_id, source, added_at)
SELECT
  lower(hex(randomblob(16))),
  t.id,
  pm.author_id,
  'spoke',
  t.created_at
FROM community_channel AS t
JOIN community_message AS pm ON pm.id = t.parent_message_id
WHERE t.type = 'thread' AND t.parent_message_id IS NOT NULL;
