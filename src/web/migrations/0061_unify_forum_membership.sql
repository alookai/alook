-- Unify forum/forum_post membership with channel/thread.
-- See plans/unify-forum-forumpost-channel-thread.md.
--
-- Model change: a `forum` now owns its access roster like a text channel, and a
-- `forum_post` INHERITS that roster (it is the NOTIFY dimension, like a thread),
-- rather than each post being its own access unit. This reverses the DIRECTION
-- of 0059 (which copied a forum's members DOWN onto each post): we now merge
-- post rosters UP into the forum and drop the post-level access rows.
--
-- Access only WIDENS (a post's added members + post creators become forum-wide);
-- no one loses access. Participant (notify) rows are the new panel + notify
-- source for a post, so we also backfill them for existing posts that predate
-- participant enrollment.
--
-- All statements are idempotent (INSERT OR IGNORE against the unique indexes;
-- DELETE is naturally idempotent). `hex(randomblob(16))` = a fresh row id.

-- 1. Merge each private forum_post's explicit member rows UP into its parent
--    forum. Restricted to posts under a PRIVATE forum (a public forum has no
--    roster). Copies only EXPLICIT rows — admins/creator are re-derived at query
--    time, never stored.
INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, added_by, added_at)
SELECT
  lower(hex(randomblob(16))),
  forum.id,
  pm.user_id,
  pm.added_by,
  pm.added_at
FROM community_channel AS post
JOIN community_channel AS forum ON forum.id = post.parent_channel_id
JOIN community_category AS cat ON cat.id = forum.category_id AND cat.private = 1
JOIN community_channel_member AS pm ON pm.channel_id = post.id
WHERE post.type = 'forum_post';

-- 2. Merge each private forum_post's CREATOR up into the parent forum roster.
--    Old-model forum access was granted to a post creator via `creatorId` (see
--    isMemberOfAnyChildPost), but a post creator was only ever enrolled as a
--    PARTICIPANT, never as a channel_member row — so without this a post author
--    who isn't the forum creator would lose access to their own post.
INSERT OR IGNORE INTO community_channel_member (id, channel_id, user_id, added_by, added_at)
SELECT
  lower(hex(randomblob(16))),
  forum.id,
  post.creator_id,
  post.creator_id,
  post.created_at
FROM community_channel AS post
JOIN community_channel AS forum ON forum.id = post.parent_channel_id
JOIN community_category AS cat ON cat.id = forum.category_id AND cat.private = 1
WHERE post.type = 'forum_post' AND post.creator_id IS NOT NULL;

-- 3. Backfill participant (notify) rows for existing forum_posts — 0060 only
--    covered type='thread'. A post's panel AND notify set are now its
--    participants, so a post predating enrollment would otherwise render an empty
--    panel and notify nobody. Seed from the people who demonstrably belong:
--      (a) distinct authors of messages in the post ("spoke"),
--      (b) the post creator,
--      (c) the post's soon-to-be-deleted explicit members (so pre-existing
--          access members keep getting notified even if they never spoke).
--    All tagged 'spoke' — the distinction only matters for future joins.

-- 3a. Message authors in the post.
INSERT OR IGNORE INTO community_thread_participant (id, thread_channel_id, user_id, source, added_at)
SELECT DISTINCT
  lower(hex(randomblob(16))),
  p.id,
  m.author_id,
  'spoke',
  p.created_at
FROM community_channel AS p
JOIN community_message AS m ON m.channel_id = p.id
WHERE p.type = 'forum_post';

-- 3b. Post creator (may not have posted).
INSERT OR IGNORE INTO community_thread_participant (id, thread_channel_id, user_id, source, added_at)
SELECT
  lower(hex(randomblob(16))),
  p.id,
  p.creator_id,
  'spoke',
  p.created_at
FROM community_channel AS p
WHERE p.type = 'forum_post' AND p.creator_id IS NOT NULL;

-- 3c. The post's explicit access members (about to be deleted in step 4).
INSERT OR IGNORE INTO community_thread_participant (id, thread_channel_id, user_id, source, added_at)
SELECT
  lower(hex(randomblob(16))),
  p.id,
  cm.user_id,
  'spoke',
  cm.added_at
FROM community_channel AS p
JOIN community_channel_member AS cm ON cm.channel_id = p.id
WHERE p.type = 'forum_post';

-- 4. Drop all forum_post access rows — a post no longer owns an access roster
--    (it inherits its forum). Their participant rows (the new notify source)
--    were preserved/backfilled above.
DELETE FROM community_channel_member
WHERE channel_id IN (SELECT id FROM community_channel WHERE type = 'forum_post');
